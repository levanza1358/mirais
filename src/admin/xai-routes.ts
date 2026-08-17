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
import { checkXaiFarmDependencies, installXaiFarmBrowser, installXaiFarmMissingDependencies, type XaiFarmDependencyStatus } from "../../scripts/xfarm/index";
import { readXaiFarmLogs, writeXaiFarmLog, clearXaiFarmLogs } from "./xaiFarmLog";

let farmStopRequested = false;
let farmActiveCount = 0;
let farmTotal = 0;
let farmDone = 0;
let farmSucceeded = 0;
let farmFailed = 0;
let farmStartedAt: number | null = null;

/** Cooldown between account sign-ups to avoid xAI sign-up rate limiting. */
const FARM_ACCOUNT_COOLDOWN_MS = Number(process.env.XAI_FARM_COOLDOWN_MS ?? 5 * 60 * 1000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FarmInstallStatus {
  status: "idle" | "running" | "success" | "error";
  progress: number;
  stage: string;
  error?: string;
  checks?: XaiFarmDependencyStatus[];
}

let farmInstallStatus: FarmInstallStatus = { status: "idle", progress: 0, stage: "Ready" };

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
            providers.updateAccountOAuth(existing.id, {
              authKind: "oauth",
              refreshToken: tokens.refresh_token,
              expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
            });
            return { status: "updated", accountId: existing.id, email: emailResult.email };
          }

          const account = providers.addAccount(providerId, {
            label: emailResult.email ?? `xai-${Date.now()}`,
            apiKey: tokens.access_token,
          });
          providers.updateAccountOAuth(account.id, {
            authKind: "oauth",
            refreshToken: tokens.refresh_token,
            expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
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

    .get("/farm/logs", async () => ({ entries: await readXaiFarmLogs() }))

    .post("/farm/logs/clear", async () => {
      await clearXaiFarmLogs();
      return { ok: true };
    })

    .post("/farm/install-browser", async () => {
      const result = await installXaiFarmBrowser();
      if (!result.success) throw new AdminError(400, result.error ?? "Camoufox installation failed");
      return { success: true };
    })

    .post("/farm/install-missing", async () => {
      if (farmInstallStatus.status === "running") throw new AdminError(409, "Dependency installation is already running");
      const imapSettings = settings.getJson<XaiImapSettings>("xai_imap");
      const configured = Boolean(imapSettings?.enabled && imapSettings.gmail_username && imapSettings.gmail_app_password);
      farmInstallStatus = { status: "running", progress: 0, stage: "Starting installation" };
      void installXaiFarmMissingDependencies(configured, (progress, stage) => {
        farmInstallStatus = { status: "running", progress, stage };
      }).then((result) => {
        farmInstallStatus = result.success
          ? { status: "success", progress: 100, stage: "Installation complete", checks: result.checks }
          : { status: "error", progress: farmInstallStatus.progress, stage: "Installation failed", error: result.error, checks: result.checks };
      }).catch((error: unknown) => {
        farmInstallStatus = {
          status: "error",
          progress: farmInstallStatus.progress,
          stage: "Installation failed",
          error: error instanceof Error ? error.message : String(error),
        };
      });
      return farmInstallStatus;
    })

    .get("/farm/install-status", () => farmInstallStatus)

    .post("/farm", async ({ body }) => {
      const input = body as { providerId?: string; count?: number; concurrency?: number };
      const { providerId } = input;
      const count = Math.max(1, Math.floor(Number(input.count ?? 1)));
      const concurrency = Math.max(1, Math.floor(Number(input.concurrency ?? 1)));
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

      farmStopRequested = false;
      farmActiveCount = count;
      farmTotal = count;
      farmDone = 0;
      farmSucceeded = 0;
      farmFailed = 0;
      farmStartedAt = Date.now();
      const runOne = async (): Promise<{ email: string; accountId: string }> => {
        if (farmStopRequested) throw new Error("stopped");
        await writeXaiFarmLog({ level: "info", message: "Starting account operation" });
        const result = (await farmXaiAccount(imapSettings)) as XaiAccountToken;
        farmDone += 1;
        if (farmStopRequested) {
          await writeXaiFarmLog({ level: "info", message: "Account operation stopped", email: result.email });
          farmFailed += 1;
          throw new Error("stopped");
        }
        if (!result.success) {
          await writeXaiFarmLog({ level: "error", message: result.error ?? "Account operation failed", email: result.email });
          farmFailed += 1;
          throw new Error(result.error ?? "Farm failed");
        }
        if (!result.accessToken) {
          await writeXaiFarmLog({ level: "error", message: "Operation completed without an access token", email: result.email });
          farmFailed += 1;
          throw new Error("Farm completed but no access token returned");
        }
        const account = providers.addAccount(providerId, {
          label: result.email ?? `xai-farm-${Date.now()}`,
          apiKey: result.accessToken,
        });
        providers.updateAccountOAuth(account.id, {
          authKind: "oauth",
          refreshToken: result.refreshToken,
          expiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : null,
        });
        await writeXaiFarmLog({ level: "success", message: "Account saved to provider", email: result.email });
        farmSucceeded += 1;
        return { email: result.email ?? "unknown", accountId: account.id };
      };

      const accounts: Array<{ email: string; accountId: string }> = [];
      const errors: string[] = [];
      let next = 0;
      const worker = async () => {
        while (next < count && !farmStopRequested) {
          const index = next;
          next += 1;
          // Wait before every account after the first so xAI's sign-up rate
          // limit does not reject back-to-back registrations.
          if (index > 0 && !farmStopRequested) {
            const waitMs = FARM_ACCOUNT_COOLDOWN_MS;
            await writeXaiFarmLog({ level: "info", message: `Cooldown ${Math.round(waitMs / 1000)}s before the next account` });
            const started = Date.now();
            while (Date.now() - started < waitMs && !farmStopRequested) {
              await sleep(1000);
            }
          }
          if (farmStopRequested) break;
          try {
            accounts.push(await runOne());
          } catch (error) {
            if ((error instanceof Error ? error.message : String(error)) !== "stopped") {
              errors.push(error instanceof Error ? error.message : String(error));
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
      farmActiveCount = 0;
      farmStopRequested = false;
      farmStartedAt = null;

      if (providers.listModels(providerId).length === 0) {
        for (const model of XAI_MODELS) providers.upsertModel(providerId, model, { displayName: model });
      }

      return { ok: errors.length === 0, requested: count, concurrency, succeeded: accounts.length, failed: errors.length, accounts, errors };
    })

    .post("/farm/stop", async () => {
      farmStopRequested = true;
      await writeXaiFarmLog({ level: "info", message: "Stop requested — finishing the in-flight account, then halting" });
      return { ok: true, active: farmActiveCount };
    })

    .get("/farm/status", async () => ({
      active: farmActiveCount,
      stopRequested: farmStopRequested,
      total: farmTotal,
      done: farmDone,
      succeeded: farmSucceeded,
      failed: farmFailed,
      running: farmActiveCount > 0 && !farmStopRequested,
      stopped: farmActiveCount > 0 && farmStopRequested,
      startedAt: farmStartedAt,
    }))

    .post("/add-apikey", async ({ body }) => {
      const { providerId, apiKey, label } = body as { providerId?: string; apiKey?: string; label?: string };
      if (!providerId || typeof providerId !== "string") throw new AdminError(400, "providerId is required");
      if (!apiKey || typeof apiKey !== "string") throw new AdminError(400, "apiKey is required");
      if (!apiKey.startsWith("xai-")) throw new AdminError(400, "Invalid API key format. xAI API keys start with 'xai-'");

      const provider = providers.get(providerId);
      if (!provider) throw new AdminError(404, "Provider not found");
      if (provider.type !== "xai") throw new AdminError(400, "Provider is not xAI type");

      // Check if already exists
      const accounts = providers.listAccounts(providerId);
      const existing = accounts.find((a) => a.api_key === apiKey);
      if (existing) {
        return { status: "exists", accountId: existing.id, label: existing.label };
      }

      // Add account with API key (NOT OAuth)
      const account = providers.addAccount(providerId, {
        label: label ?? `apikey-${apiKey.slice(-6)}`,
        apiKey,
      });

      // auth_kind defaults to NULL (API key auth), not 'oauth'
      // This means it will use https://api.x.ai/v1 endpoint instead of cli-chat-proxy.grok.com

      return {
        status: "created",
        accountId: account.id,
        label: account.label,
        note: "API key accounts use api.x.ai endpoint (not affected by Grok CLI 426 error)",
      };
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
