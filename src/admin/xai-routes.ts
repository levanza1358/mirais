/**
 * xAI (Grok) provider routes — OAuth Device Code Flow + Farm mode.
 */
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { ProvidersRepo } from "../store/repos/providers";
import { SettingsRepo } from "../store/repos/settings";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";
import {
  startDeviceFlow,
  pollForToken,
  validateAccessToken,
  farmXaiAccount,
  XAI_MODELS,
  XAI_BASE_URL,
  type XaiImapSettings,
} from "./xai-oauth";
import { checkXaiFarmDependencies, installXaiFarmBrowser } from "../../scripts/xfarm/index";

interface XaiAccountToken {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  email?: string;
  success?: boolean;
  error?: string;
}

export function xaiAdminRoutes(db: Database) {
  const providers = new ProvidersRepo(db);
  const settings = new SettingsRepo(db);

  return new Elysia({ prefix: "/api/xai" })
    .post("/device-code", async () => {
      try {
        const flow = await startDeviceFlow();
        return {
          deviceCode: flow.deviceCode,
          userCode: flow.userCode,
          verificationUrl: flow.verificationUrl,
          expiresIn: flow.expiresIn,
          interval: flow.interval,
        };
      } catch (err) {
        if (err instanceof AdminError) throw err;
        log.error("xAI device code failed", { error: err instanceof Error ? err.message : String(err) });
        throw new AdminError(500, `Failed to start device flow: ${err instanceof Error ? err.message : String(err)}`);
      }
    })

    .post("/poll-token", async ({ body }) => {
      const { deviceCode, providerId } = body as { deviceCode?: string; providerId?: string };
      if (!deviceCode || typeof deviceCode !== "string") throw new AdminError(400, "deviceCode is required");

      try {
        const tokens = await pollForToken(deviceCode);
        const emailResult = await validateAccessToken(tokens.access_token);

        if (providerId && typeof providerId === "string") {
          const provider = providers.get(providerId);
          if (!provider) throw new AdminError(404, "Provider not found");
          if (provider.type !== "xai") throw new AdminError(400, "Provider is not xAI type");

          const accounts = providers.listAccounts(providerId);
          const existing = accounts.find((a) => a.api_key === tokens.access_token);
          if (existing) {
            providers.updateAccount(existing.id, { apiKey: tokens.access_token, label: emailResult.email ?? existing.label });
            return { status: "updated", accountId: existing.id, email: emailResult.email };
          }

          const account = providers.addAccount(providerId, {
            label: emailResult.email ?? `xai-${Date.now()}`,
            apiKey: tokens.access_token,
          });
          if (providers.listModels(providerId).length === 0) {
            for (const model of XAI_MODELS) providers.upsertModel(providerId, model, { displayName: model });
          }
          return { status: "created", accountId: account.id, email: emailResult.email };
        }

        return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresIn: tokens.expires_in, email: emailResult.email };
      } catch (err) {
        if (err instanceof AdminError) throw err;
        log.error("xAI token poll failed", { error: err instanceof Error ? err.message : String(err) });
        throw new AdminError(500, `Token poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })

    .get("/farm/check", async () => {
      const imapSettings = settings.getJson<XaiImapSettings>("xai_imap");
      const configured = Boolean(imapSettings?.enabled && imapSettings.gmail_username && imapSettings.gmail_app_password);
      return checkXaiFarmDependencies(configured);
    })

    .post("/farm/install-browser", async () => {
      const result = await installXaiFarmBrowser();
      if (!result.success) throw new AdminError(400, result.error ?? "Camoufox installation failed");
      return { success: true };
    })

    .post("/farm", async ({ body }) => {
      const input = body as { providerId?: string; count?: number; concurrency?: number };
      const { providerId } = input;
      const count = Math.max(1, Math.min(50, Number(input.count ?? 1)));
      const concurrency = Math.max(1, Math.min(10, Number(input.concurrency ?? 1)));
      if (!providerId || typeof providerId !== "string") throw new AdminError(400, "providerId is required");

      const provider = providers.get(providerId);
      if (!provider) throw new AdminError(404, "Provider not found");
      if (provider.type !== "xai") throw new AdminError(400, "Provider is not xAI type");

      const imapSettings = settings.getJson<XaiImapSettings>("xai_imap");
      if (!imapSettings?.enabled) throw new AdminError(400, "xAI farming is not enabled. Enable it in Settings → XAI IMAP Settings.");
      if (!imapSettings.gmail_username || !imapSettings.gmail_app_password) {
        throw new AdminError(400, "Gmail credentials not configured. Set Gmail username and App Password in Settings → XAI IMAP Settings.");
      }

      const deps = await checkXaiFarmDependencies(true);
      if (!deps.ok) throw new AdminError(400, `Missing dependencies: ${deps.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}`);

      const runOne = async (): Promise<{ email: string; accountId: string }> => {
        const result = (await farmXaiAccount(imapSettings)) as XaiAccountToken;
        if (!result.success) throw new Error(result.error ?? "Farm failed");
        if (!result.accessToken) throw new Error("Farm completed but no access token returned");
        const account = providers.addAccount(providerId, {
          label: result.email ?? `xai-farm-${Date.now()}`,
          apiKey: result.accessToken,
        });
        return { email: result.email ?? "unknown", accountId: account.id };
      };

      const accounts: Array<{ email: string; accountId: string }> = [];
      const errors: string[] = [];
      let next = 0;
      const worker = async () => {
        while (next < count) {
          next += 1;
          try {
            accounts.push(await runOne());
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));

      if (providers.listModels(providerId).length === 0) {
        for (const model of XAI_MODELS) providers.upsertModel(providerId, model, { displayName: model });
      }

      return { ok: errors.length === 0, requested: count, concurrency, succeeded: accounts.length, failed: errors.length, accounts, errors };
    })

    .post("/refresh", async () => {
      throw new AdminError(501, "Token refresh not yet implemented — re-authenticate via device flow");
    })

    .get("/models", async ({ query }) => {
      const accountId = query.accountId;
      if (!accountId) throw new AdminError(400, "accountId query parameter is required");

      let account = null;
      for (const p of providers.list()) {
        if (p.type !== "xai") continue;
        account = providers.listAccounts(p.id).find((a) => a.id === accountId);
        if (account) break;
      }
      if (!account) throw new AdminError(404, "Account not found");

      try {
        const res = await fetch(`${XAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${account.api_key}` } });
        if (!res.ok) throw new AdminError(res.status, `Failed to fetch models: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json() as { data?: Array<{ id: string }> };
        return { models: data.data?.map((m) => m.id) ?? XAI_MODELS };
      } catch (err) {
        if (err instanceof AdminError) throw err;
        throw new AdminError(500, `Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}
