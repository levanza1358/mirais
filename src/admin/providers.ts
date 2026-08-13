import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { ProvidersRepo } from "../store/repos/providers";
import { LogsRepo } from "../store/repos/logs";
import { SettingsRepo } from "../store/repos/settings";
import { providerCreateSchema, providerUpdateSchema, accountCreateSchema, accountBulkCreateSchema, accountUpdateSchema, providerModelUpdateSchema, upstreamModelsResponseSchema } from "../shared/schemas";
import type { z } from "zod";
import { AdminError } from "../shared/errors";
import { baseUrlFor, upstreamFormat } from "../proxy/router";
import { codexHeaders, codexQuotaDetail, codexRequestBody, codexUrl, ensureFreshToken, fetchCodeBuddyUsage, fetchCodexModels, fetchCodexUsage, isCodexQuotaExhausted, isOAuthAccount, resetCodexBankedUsage, attemptCodeBuddyCheckin } from "../proxy/codex";
import { ensureFreshXaiToken, xaiHeaders } from "../proxy/xai";
import { fetchXaiUsage } from "../proxy/xai-usage";
import { checkCodexProviderQuota, fetchCodexProviderModels, testCodexProviderModel } from "./codex-provider";
import { fetchXaiModels, testXaiModel } from "./xai-provider";
import { resolveModelMeta } from "../proxy/modelMeta";
import { keepModel, type ModelSyncMode } from "../proxy/modelFilter";
import { log } from "../utils/logger";
import { SseParser } from "../proxy/translator/stream";
import { CODEBUDDY_MODELS, isCodeBuddyProviderType, readCodeBuddyPreviewFromSse, requestCodeBuddyChat } from "./codebuddy-provider";

function isRateLimitDetail(detail: string | undefined): boolean {
  if (!detail) return false;
  return /(rate limit|quota|429|exhausted|capacity|stream must be set to true|usage limit has been reached|limit has been reached)/i.test(detail);
}

function mask(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function extractTestPreviewFromOpenAiPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim().slice(0, 220) : undefined;
}

function extractTestPreviewFromAnthropicPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const blocks = (payload as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => (block.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return text ? text.slice(0, 220) : undefined;
}

function extractTestPreviewFromCodexPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const output = (payload as { output?: Array<{ type?: string; text?: string; content?: Array<{ type?: string; text?: string }> }> }).output;
  if (!Array.isArray(output)) return undefined;
  const text = output
    .flatMap((item) => {
      const direct = item?.type === "output_text" && typeof item.text === "string" ? [item.text] : [];
      const nested = Array.isArray(item?.content)
        ? item.content
            .filter((part) => part?.type === "output_text" && typeof part.text === "string")
            .map((part) => part.text ?? "")
        : [];
      return [...direct, ...nested];
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return text ? text.slice(0, 220) : undefined;
}

function inferCapabilitiesFromPreview(preview: string | undefined): string[] {
  if (!preview) return [];
  const lower = preview.toLowerCase();
  const caps = new Set<string>();
  if (/reason|reasoning|think/.test(lower)) caps.add("reasoning");
  if (/tool|function/.test(lower)) caps.add("tools");
  if (/json/.test(lower)) caps.add("json");
  if (/vision|image/.test(lower)) caps.add("vision");
  return [...caps];
}

async function readCodexPreviewFromSse(body: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
        if (!ev.data || ev.data === "[DONE]") continue;
        try {
          const payload = JSON.parse(ev.data) as {
            type?: string;
            delta?: string;
            output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
            item?: { type?: string; content?: Array<{ type?: string; text?: string }> };
          };
          if (typeof payload.delta === "string") {
            text += payload.delta;
          }
          const chunks = [
            ...(Array.isArray(payload.output) ? payload.output : []),
            ...(payload.item ? [payload.item] : []),
          ];
          for (const chunk of chunks) {
            if (!Array.isArray(chunk?.content)) continue;
            text += chunk.content
              .filter((part) => part?.type === "output_text" && typeof part.text === "string")
              .map((part) => part.text ?? "")
              .join("");
          }
          if (text.trim().length >= 32) break;
        } catch {
          // ignore malformed chunks
        }
      }
      if (text.trim().length >= 32) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 220) : undefined;
}

export function providerRoutes(db: Database) {
  const repo = new ProvidersRepo(db);
  const logs = new LogsRepo(db);
  const settings = new SettingsRepo(db);

  async function warmupAccount(p: ReturnType<ProvidersRepo["get"]>, account: ReturnType<ProvidersRepo["getAccount"]>) {
    const provider = p!;
    const acc = account!;
    const started = Date.now();
    let result: { account_id: string; account: string; ok: boolean; status: number; latency_ms: number; detail?: string };
    try {
      if (isCodeBuddyProviderType(provider.type)) {
        const res = await requestCodeBuddyChat(
          provider,
          acc,
          (CODEBUDDY_MODELS[provider.type] ?? ["glm-5.2"])[0] ?? "glm-5.2",
          "Reply with exactly: warmup ok",
          16,
        );
        result = {
          account_id: acc.id,
          ok: res.ok,
          status: res.status,
          latency_ms: Date.now() - started,
          account: acc.label,
          detail: res.ok ? "CodeBuddy chat warmup ok" : `HTTP ${res.status}`,
        };
      } else if (provider.type === "xai" && acc.auth_kind === "oauth") {
        const accessToken = await ensureFreshXaiToken(repo, acc);
        // This endpoint requires the same account-specific identity headers as a
        // proxied Grok CLI request (not merely an OAuth bearer token).
        const res = await fetch("https://cli-chat-proxy.grok.com/v1/models", {
          headers: xaiHeaders(accessToken, false, undefined, acc),
          signal: AbortSignal.timeout(20_000),
        });

        // Handle 426 Upgrade Required (Grok CLI version enforcement)
        if (res.status === 426) {
          const errorText = await res.text().catch(() => "");
          const isVersionError = errorText.includes("version") || errorText.includes("upgrade") || errorText.includes("outdated");
          result = {
            account_id: acc.id,
            ok: false,
            status: 426,
            latency_ms: Date.now() - started,
            account: acc.label,
            detail: isVersionError
              ? "Grok CLI 426: Version enforcement active. OAuth endpoint blocked. Use API key instead."
              : `HTTP 426: ${errorText.slice(0, 200)}`,
          };
        } else {
          result = {
            account_id: acc.id,
            ok: res.ok,
            status: res.status,
            latency_ms: Date.now() - started,
            account: acc.label,
            detail: res.ok ? "Grok CLI login active" : `HTTP ${res.status}`,
          };
        }
      } else if (isOAuthAccount(acc)) {
        const { usage, exhausted: quotaExhausted } = await checkCodexProviderQuota(repo, acc);
        result = {
          account_id: acc.id,
          ok: !quotaExhausted,
          status: quotaExhausted ? 429 : 200,
          latency_ms: Date.now() - started,
          account: acc.label,
          detail: codexQuotaDetail(usage),
        };
      } else {
        const base = baseUrlFor(provider);
        const headers: Record<string, string> = provider.type === "anthropic"
          ? { "x-api-key": acc.api_key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${acc.api_key}` };
        const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) });
        result = {
          account_id: acc.id,
          ok: res.ok,
          status: res.status,
          latency_ms: Date.now() - started,
          account: acc.label,
          detail: res.ok ? undefined : `HTTP ${res.status}`,
        };
      }
    } catch (err) {
      result = {
        account_id: acc.id,
        ok: false,
        status: 0,
        latency_ms: Date.now() - started,
        account: acc.label,
        detail: err instanceof Error
          ? `${err.message}${err.cause instanceof Error && err.cause.message ? `: ${err.cause.message}` : ""}`
          : String(err),
      };
    }

    const warmupStatus = result.ok ? "healthy" : (result.status === 429 || isRateLimitDetail(result.detail) ? "rate_limited" : "failing");
    repo.updateAccount(acc.id, {
      lastWarmupAt: new Date().toISOString(),
      lastWarmupStatus: warmupStatus,
      lastWarmupLatencyMs: result.latency_ms,
      lastWarmupDetail: result.detail ?? null,
    });

    logs.insert({
      keyId: null,
      endpoint: "/providers/warmup",
      requestedModel: `${provider.name}:${acc.label}`,
      provider: provider.name,
      model: null,
      attempts: 1,
      status: result.ok ? "success" : "error",
      httpStatus: result.status,
      error: result.ok ? null : (result.detail ?? null),
      inputTokens: null,
      outputTokens: null,
      latencyMs: result.latency_ms,
      tokensSaved: 0,
      requestBody: `Warmup check for account ${acc.label}`,
      responseBody: result.ok ? `OK (${result.latency_ms}ms)` : `ERROR: ${result.detail ?? `HTTP ${result.status}`}`,
      kind: "warmup",
    });

    return result;
  }

  return new Elysia({ prefix: "/api/providers" })
    .get("/", () =>
      repo.list().map((p) => ({
        ...p,
        base_url_effective: baseUrlFor(p),
        accounts: repo.listAccounts(p.id).map((a) => ({ ...a, api_key: mask(a.api_key) })),
        models: repo.listModels(p.id),
      })),
    )
    .post("/", ({ body }) => {
      const parsed = providerCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      if (repo.getByName(parsed.data.name)) throw new AdminError(409, `Provider '${parsed.data.name}' already exists`);
      const p = repo.create(parsed.data);
      log.info("provider created", { name: p.name, type: p.type });
      return p;
    })
    .patch("/:id", ({ params, body }) => {
      const parsed = providerUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const p = repo.update(params.id, parsed.data);
      if (!p) throw new AdminError(404, "Provider not found");
      return p;
    })
    .delete("/:id", ({ params }) => {
      repo.remove(params.id);
      return { ok: true };
    })
    // ── accounts ──
    .post("/:id/accounts", ({ params, body }) => {
      if (!repo.get(params.id)) throw new AdminError(404, "Provider not found");
      const parsed = accountCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const a = repo.addAccount(params.id, parsed.data);
      log.info("account added", { provider: params.id, label: a.label });
      return { ...a, api_key: mask(a.api_key) };
    })
    .post("/:id/accounts/bulk", ({ params, body }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      const parsed = accountBulkCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const existing = new Set(repo.listAccounts(p.id).map((a) => a.api_key));
      const seen = new Set<string>();
      const prefix = parsed.data.labelPrefix ?? p.name;
      let added = 0;
      let skipped = 0;
      for (const raw of parsed.data.apiKeys) {
        const apiKey = raw.trim();
        if (!apiKey || seen.has(apiKey) || existing.has(apiKey)) { skipped += 1; continue; }
        seen.add(apiKey);
        const label = `${prefix}-${repo.listAccounts(p.id).length + 1}`;
        repo.addAccount(p.id, { label, apiKey });
        added += 1;
      }
      log.info("accounts bulk added", { provider: p.name, added, skipped });
      return { added, skipped };
    })
    .delete("/:id/accounts", ({ params }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      const removed = repo.removeAllAccounts(p.id);
      log.info("accounts bulk removed", { provider: p.name, removed });
      return { ok: true, removed };
    })
    .patch("/accounts/:accId", ({ params, body }) => {
      const parsed = accountUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const a = repo.updateAccount(params.accId, parsed.data);
      if (!a) throw new AdminError(404, "Account not found");
      return { ...a, api_key: mask(a.api_key) };
    })
    .delete("/accounts/:accId", ({ params }) => {
      repo.removeAccount(params.accId);
      return { ok: true };
    })
    .post("/:id/warmup", async ({ params }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      const accounts = repo.listAccounts(p.id).filter((a) => a.enabled);
      if (!accounts.length) throw new AdminError(400, "No enabled accounts to warm up");

      const results: Array<{ account: string; ok: boolean; status: number; latency_ms: number; detail?: string }> = [];

      for (const account of accounts) {
        results.push(await warmupAccount(p, account));
      }

      return {
        provider: p.name,
        total: results.length,
        success: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      };
    })
    .post("/:id/warmup/stream", ({ params, set }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      const accounts = repo.listAccounts(p.id).filter((account) => account.enabled);
      if (!accounts.length) throw new AdminError(400, "No enabled accounts to warm up");

      set.headers["content-type"] = "text/event-stream; charset=utf-8";
      set.headers["cache-control"] = "no-cache";
      set.headers.connection = "keep-alive";

      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          let success = 0;
          let failed = 0;
          send("start", { provider: p.name, total: accounts.length });

          for (let index = 0; index < accounts.length; index += 1) {
            const account = accounts[index]!;
            send("account_start", { account_id: account.id, account: account.label, current: index + 1, total: accounts.length });
            const result = await warmupAccount(p, account);
            if (result.ok) success += 1;
            else failed += 1;
            send("account_result", { ...result, current: index + 1, total: accounts.length });
          }

          send("complete", { provider: p.name, total: accounts.length, success, failed });
          controller.close();
        },
      });
    })
    // ── per-account usage (from request logs) ──
    .get("/:id/accounts/usage", ({ params }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      return logs.usageByAccount(p.name);
    })
    // ── provider-level quota summary (aggregated across all accounts) ──
    .get("/:id/quota", async ({ params }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      const accounts = repo.listAccounts(p.id);
      if (!accounts.length) return { total_credits: null, unlimited: null, accounts_with_quota: 0, accounts_total: 0, accounts_free: 0, free_remaining_pct: null };

      let totalCredits: number | null = null;
      let hasUnlimited = false;
      let accountsWithQuota = 0;
      let accountsFree = 0;
      let freeRemainingSum = 0;

      for (const account of accounts) {
        try {
          // ── CodeBuddy providers: use CodeBuddy-specific usage API ──
          if (p.type === "codebuddy-global" || p.type === "codebuddy-cn") {
            const snap = await fetchCodeBuddyUsage(account, baseUrlFor(p));
            const credits = snap.quotas?.Credits;
            if (!credits || credits.total <= 0) continue;
            totalCredits = (totalCredits ?? 0) + credits.remaining;
            accountsWithQuota += 1;
            continue;
          }

          // ── xAI: use Grok CLI billing endpoint ──
          if (p.type === "xai") {
            // Only OAuth xAI accounts have a billing endpoint
            if (account.auth_kind !== "oauth") continue;
            // Refresh token first if needed
            const accessToken = await ensureFreshXaiToken(repo, account);
            const accountWithFreshToken = { ...account, api_key: accessToken };
            const snap = await fetchXaiUsage(accountWithFreshToken);
            // Aggregate remaining credits across all quota rows
            if (snap.quotas && Object.keys(snap.quotas).length > 0) {
              let accountCredits = 0;
              for (const row of Object.values(snap.quotas)) {
                if (row.unlimited) {
                  hasUnlimited = true;
                  accountCredits = 0;
                  break;
                }
                accountCredits += row.total - row.used;
              }
              if (!hasUnlimited) {
                totalCredits = (totalCredits ?? 0) + accountCredits;
              }
              accountsWithQuota += 1;
            }
            continue;
          }

          // ── Non-OAuth (API-key) providers: no quota endpoint ──
          if (!isOAuthAccount(account)) continue;

          // ── OpenAI / Codex OAuth: WHAM usage API ──
          const { usage } = await checkCodexProviderQuota(repo, account);
          const credits = usage?.credits;
          if (!credits) continue;

          if (credits.unlimited) {
            hasUnlimited = true;
            accountsWithQuota += 1;
            continue;
          }

          if (typeof credits.balance === "number") {
            totalCredits = (totalCredits ?? 0) + credits.balance;
            accountsWithQuota += 1;
          } else if (credits.has_credits === false) {
            // Free plan — track remaining percent from primary window
            accountsFree += 1;
            const remaining = usage?.primary?.remaining_percent;
            if (typeof remaining === "number") freeRemainingSum += remaining;
          }
        } catch {
          // skip accounts that fail quota check
        }
      }

      return {
        total_credits: hasUnlimited ? null : totalCredits,
        unlimited: hasUnlimited ? true : (accountsWithQuota > 0 ? false : null),
        accounts_with_quota: accountsWithQuota,
        accounts_total: accounts.length,
        accounts_free: accountsFree,
        free_remaining_pct: accountsFree > 0 ? Math.round(freeRemainingSum / accountsFree) : null,
      };
    })
    // ── per-account ChatGPT/Codex quota (OAuth accounts only) ──
    .get("/accounts/:accId/codex-quota", async ({ params }) => {
      const account = repo.getAccount(params.accId);
      if (!account) throw new AdminError(404, "Account not found");
      const provider = repo.get(account.provider_id);
      if (!provider) throw new AdminError(404, "Provider not found");
      if (provider.type === "codebuddy-global" || provider.type === "codebuddy-cn") {
        return fetchCodeBuddyUsage(account, baseUrlFor(provider));
      }
      if (provider.type === "xai") {
        if (account.auth_kind !== "oauth") throw new AdminError(400, "Quota is only available for OAuth xAI accounts");
        const accessToken = await ensureFreshXaiToken(repo, account);
        return fetchXaiUsage({ ...account, api_key: accessToken });
      }
      if (!isOAuthAccount(account)) throw new AdminError(400, "Quota is only available for OAuth accounts");
      return (await checkCodexProviderQuota(repo, account)).usage;
    })
    .post("/accounts/:accId/codex-quota/reset", async ({ params }) => {
      const account = repo.getAccount(params.accId);
      if (!account) throw new AdminError(404, "Account not found");
      if (!isOAuthAccount(account)) throw new AdminError(400, "Quota reset is only available for OAuth accounts");
      const accessToken = await ensureFreshToken(repo, account);
      return resetCodexBankedUsage(account, accessToken);
    })
    // ── models ──
    .get("/:id/models", ({ params }) => {
      if (!repo.get(params.id)) throw new AdminError(404, "Provider not found");
      return repo.listModels(params.id);
    })
    .put("/:id/models/:modelId", ({ params, body }) => {
      if (!repo.get(params.id)) throw new AdminError(404, "Provider not found");
      const parsed = providerModelUpdateSchema.safeParse(body ?? {});
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid model payload");
      const modelId = decodeURIComponent(params.modelId).trim();
      if (!modelId || modelId.length > 1024) throw new AdminError(400, "Invalid model ID");
      repo.upsertModel(params.id, modelId, parsed.data);
      return { ok: true };
    })
    .delete("/:id/models/:modelId", ({ params }) => {
      repo.removeModel(params.id, decodeURIComponent(params.modelId));
      return { ok: true };
    })
    // ── connectivity test ──
    .post("/:id/test", async ({ params }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      const accounts = repo.listAccounts(p.id).filter((a) => a.enabled);
      if (!accounts.length) throw new AdminError(400, "No enabled account to test with");
      // Prefer healthy accounts, fall back to untested, skip known-failing
      const healthyFirst = [...accounts].sort((a, b) => {
        const aScore = a.last_warmup_status === "healthy" ? 0 : a.last_warmup_status == null ? 1 : 2;
        const bScore = b.last_warmup_status === "healthy" ? 0 : b.last_warmup_status == null ? 1 : 2;
        return aScore - bScore;
      });
      const account = healthyFirst[0]!;
      const started = Date.now();
      try {
        if (isCodeBuddyProviderType(p.type)) {
          const res = await requestCodeBuddyChat(
            p, account, (CODEBUDDY_MODELS[p.type] ?? ["glm-5.2"])[0] ?? "glm-5.2", "Reply with exactly: connection ok", 16,
          );
          return {
            ok: res.ok,
            status: res.status,
            latency_ms: Date.now() - started,
            account: account.label,
            detail: res.ok ? "CodeBuddy endpoint live" : `HTTP ${res.status}`,
          };
        }
        // OAuth accounts: the ChatGPT backend has no /models endpoint — a
        // successful token refresh proves the connection is alive.
        if (isOAuthAccount(account)) {
          await ensureFreshToken(repo, account);
          return {
            ok: true,
            status: 200,
            latency_ms: Date.now() - started,
            account: account.label,
            detail: "ChatGPT login active",
          };
        }
        const base = baseUrlFor(p);
        const headers = { Authorization: `Bearer ${account.api_key}` };
        const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) });
        return {
          ok: res.ok,
          status: res.status,
          latency_ms: Date.now() - started,
          account: account.label,
          detail: res.ok ? undefined : `HTTP ${res.status}`,
        };
      } catch (err) {
        return {
          ok: false,
          latency_ms: Date.now() - started,
          account: account.label,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    })
    // ── per-model test: tiny chat completion against the upstream ──
    .post("/:id/models/:modelId/test", async ({ params }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      const allAccounts = repo.listAccounts(p.id).filter((a) => a.enabled);
      if (!allAccounts.length) throw new AdminError(400, "No enabled account to test with");
      // Prefer healthy accounts, fall back to untested, skip known-failing
      const accounts = [...allAccounts].sort((a, b) => {
        const aScore = a.last_warmup_status === "healthy" ? 0 : a.last_warmup_status == null ? 1 : 2;
        const bScore = b.last_warmup_status === "healthy" ? 0 : b.last_warmup_status == null ? 1 : 2;
        return aScore - bScore;
      });
      const modelId = decodeURIComponent(params.modelId);
      const started = Date.now();
      const testPrompt = "Reply in one short sentence: say hi, state your model name, and mention your knowledge cutoff date if known.";
      const writeTestLog = (result: { ok: boolean; status: number; latency_ms: number; detail?: string; preview_text?: string }) => {
        logs.insert({
          keyId: null,
          endpoint: `/providers/${params.id}/models/${encodeURIComponent(modelId)}/test`,
          requestedModel: modelId,
          provider: p.name,
          model: modelId,
          attempts: 1,
          status: result.ok ? "success" : "error",
          httpStatus: result.status,
          error: result.ok ? null : (result.detail ?? null),
          inputTokens: null,
          outputTokens: null,
          latencyMs: result.latency_ms,
          tokensSaved: 0,
          requestBody: testPrompt,
          responseBody: result.ok
            ? `OK (${result.latency_ms}ms)${result.preview_text ? ` — ${result.preview_text}` : ""}`
            : `ERROR: ${result.detail ?? `HTTP ${result.status}`}`,
          kind: "test",
        });
      };
      try {
        let res: Response | null = null;
        let usedAccount = accounts[0]!;
        let preview_text: string | undefined;
        if (p.type === "xai" && accounts[0]!.auth_kind === "oauth") {
          const xaiResult = await testXaiModel(repo, usedAccount, modelId, testPrompt);
          res = xaiResult.response;
          preview_text = xaiResult.previewText;
        } else if (isOAuthAccount(accounts[0]!)) {
          let lastRateLimited: { res: Response; account: typeof usedAccount } | null = null;
          for (const account of accounts) {
            usedAccount = account;
            const accessToken = await ensureFreshToken(repo, account);
            res = await fetch(codexUrl("/responses"), {
              method: "POST",
              headers: codexHeaders(account, accessToken, true),
              body: JSON.stringify(codexRequestBody({ model: modelId, messages: [{ role: "user", content: testPrompt }], stream: true }, modelId, true)),
              signal: AbortSignal.timeout(30_000),
            });
            if (res.ok) break;
            const failureText = (await res.clone().text()).slice(0, 300);
            let failureDetail: string | undefined;
            try {
              const j = JSON.parse(failureText) as { error?: { message?: string }; message?: string };
              failureDetail = j.error?.message ?? j.message ?? failureText ?? `HTTP ${res.status}`;
            } catch {
              failureDetail = `HTTP ${res.status}`;
            }
            if (isRateLimitDetail(failureDetail) || /model is not supported when using Codex/i.test(failureDetail ?? "")) {
              lastRateLimited = { res, account };
              continue;
            }
            break;
          }
          if (!res && lastRateLimited) {
            res = lastRateLimited.res;
            usedAccount = lastRateLimited.account;
          }
        } else if (isCodeBuddyProviderType(p.type)) {
          for (const account of accounts) {
            usedAccount = account;
            res = await requestCodeBuddyChat(p, account, modelId, testPrompt, 64);
            if (res.ok) break;
            // Retry with next account on rate-limit or auth/server errors
            if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) continue;
            break;
          }
        } else if (upstreamFormat(p) === "anthropic") {
        const account = accounts[0]!;
          res = await fetch(`${baseUrlFor(p)}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": account.api_key,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: modelId,
              max_tokens: 48,
              messages: [{ role: "user", content: testPrompt }],
            }),
            signal: AbortSignal.timeout(30_000),
          });
        } else {
          const account = accounts[0]!;
          res = await fetch(`${baseUrlFor(p)}/chat/completions`, {
            method: "POST",
            headers: p.type === "xai"
              ? {
                "content-type": "application/json",
                Authorization: `Bearer ${account.api_key}`,
                "User-Agent": "xai-grok-cli",
                "x-grok-client-version": "0.2.103",
                "x-grok-client-identifier": "grok-shell",
              }
              : {
                "content-type": "application/json",
                Authorization: `Bearer ${account.api_key}`,
              },
            body: JSON.stringify({
              model: modelId,
              max_tokens: 48,
              messages: [{ role: "user", content: testPrompt }],
            }),
            signal: AbortSignal.timeout(30_000),
          });
        }
        if (!res) throw new AdminError(500, "Model test did not produce a response");
        const latency = Date.now() - started;
        let detail: string | undefined;
        let context_length: number | null = null;
        let max_output_tokens: number | null = null;
        let capabilities: string[] | undefined;
        if (!res.ok) {
          const text = (await res.text()).slice(0, 300);
          try {
            const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
            detail = j.error?.message ?? j.message ?? text ?? `HTTP ${res.status}`;
          } catch {
            detail = `HTTP ${res.status}`;
          }
        } else {
          try {
            if (isCodeBuddyProviderType(p.type)) {
              preview_text = res.body ? await readCodeBuddyPreviewFromSse(res.body) : undefined;
            } else if (p.type === "xai" && usedAccount.auth_kind === "oauth") {
              // The xAI helper already consumed the Grok Responses SSE stream.
            } else if (isOAuthAccount(usedAccount)) {
              preview_text = res.body ? await readCodexPreviewFromSse(res.body) : undefined;
            } else {
              const payload = await res.json();
              preview_text = upstreamFormat(p) === "anthropic"
                ? extractTestPreviewFromAnthropicPayload(payload)
                : extractTestPreviewFromOpenAiPayload(payload);
            }
            const meta = resolveModelMeta(modelId, { contextLength: null, maxOutputTokens: null, capabilities: inferCapabilitiesFromPreview(preview_text) });
            context_length = meta?.contextLength ?? null;
            max_output_tokens = meta?.maxOutputTokens ?? null;
            capabilities = meta?.capabilities ?? [];
          } catch {
            preview_text = undefined;
          }
        }
        const successResult = { ok: res.ok, status: res.status, latency_ms: latency, model: modelId, account: usedAccount.label, detail, preview_text, context_length, max_output_tokens, capabilities };
        writeTestLog({ ok: successResult.ok, status: successResult.status, latency_ms: successResult.latency_ms, detail: successResult.detail, preview_text: successResult.preview_text });
        return successResult;
      } catch (err) {
        const errorResult = {
          ok: false,
          status: 0,
          latency_ms: Date.now() - started,
          model: modelId,
          detail: err instanceof Error ? err.message : String(err),
          preview_text: undefined,
          context_length: null,
          max_output_tokens: null,
          capabilities: [],
        };
        writeTestLog({ ok: false, status: 0, latency_ms: errorResult.latency_ms, detail: errorResult.detail });
        return errorResult;
      }
    })
    // ── model sync ──
    .post("/:id/sync", async ({ params }) => {
      const p = repo.get(params.id);
      if (!p) throw new AdminError(404, "Provider not found");
      const accounts = repo.listAccounts(p.id).filter((a) => a.enabled && a.last_warmup_status === "healthy");
      if (!accounts.length) throw new AdminError(400, "No healthy account to sync with. Run account warmup first.");
      const account = accounts[0]!;

      if (isCodeBuddyProviderType(p.type)) {
        const mode = (settings.getJson<ModelSyncMode>("model_sync_mode") ?? "curated") as ModelSyncMode;
        const syncedModels = (CODEBUDDY_MODELS[p.type] ?? [])
          .filter((id) => keepModel(id, mode))
          .map((id) => {
            const meta = resolveModelMeta(id, { contextLength: null, maxOutputTokens: null, capabilities: null });
            return {
              id,
              contextLength: meta?.contextLength ?? null,
              maxOutputTokens: meta?.maxOutputTokens ?? null,
              capabilities: meta?.capabilities ?? null,
            };
          });
        const pruned = repo.replaceSyncedModels(p.id, syncedModels);
        const kept = syncedModels.map((model) => model.id);
        log.info("codebuddy models synced", { provider: p.name, count: kept.length, mode });
        return { synced: kept.length, pruned, models: kept, mode };
      }

      if (p.type === "xai" && account.auth_kind === "oauth") {
        const byId = new Map<string, Awaited<ReturnType<typeof fetchXaiModels>>[number]>();
        const failures: string[] = [];
        for (const xaiAccount of accounts.filter((candidate) => candidate.auth_kind === "oauth")) {
          try {
            for (const model of await fetchXaiModels(repo, xaiAccount)) {
              if (!byId.has(model.id)) byId.set(model.id, model);
            }
          } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err));
          }
        }
        if (!byId.size) throw new AdminError(502, failures[0] ?? "No Grok model catalog available");
        const models = [...byId.values()];
        const pruned = repo.replaceSyncedModels(p.id, models);
        log.info("xai models synced", { provider: p.name, count: models.length, pruned, accounts: accounts.length, failures: failures.length });
        return { synced: models.length, pruned, models: models.map((model) => model.id) };
      }

      // OAuth accounts: fetch the live Codex model catalog (same endpoint the
      // Codex CLI uses) instead of the api.openai.com /models listing. Keep the
      // catalog exactly as each token advertises it and merge catalogs across
      // enabled accounts. Entitlements can differ between ChatGPT accounts, so
      // using only the first account can hide models such as gpt-5.6-sol that
      // another enabled account is allowed to use.
      const oauthAccounts = accounts.filter(isOAuthAccount);
      if (oauthAccounts.length) {
        const byId = new Map<string, Awaited<ReturnType<typeof fetchCodexModels>>[number]>();
        const failures: string[] = [];
        for (const oauthAccount of oauthAccounts) {
          try {
            const accessToken = await ensureFreshToken(repo, oauthAccount);
            for (const model of await fetchCodexModels(oauthAccount, accessToken)) {
              if (!byId.has(model.id)) byId.set(model.id, model);
            }
          } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err));
          }
        }
        if (!byId.size) {
          throw new AdminError(502, failures[0] ?? "No OAuth model catalog available");
        }
        const models = [...byId.values()];
        const mode = (settings.getJson<ModelSyncMode>("model_sync_mode") ?? "curated") as ModelSyncMode;
        const pruned = repo.replaceSyncedModels(p.id, models);
        log.info("codex models synced", { provider: p.name, count: models.length, pruned, mode, accounts: oauthAccounts.length, failures: failures.length });
        return { synced: models.length, pruned, mode, models: models.map((m) => m.id) };
      }

      const base = baseUrlFor(p);

      // Upstream /models entries vary by provider; capture whatever metadata
      // is offered (OpenAI-style fields + OpenRouter-style top_provider /
      // supported_parameters) so the dashboard can show context length, max
      // output tokens, and capability badges.
      type UpstreamModel = z.infer<typeof upstreamModelsResponseSchema>["data"][number];

      function capsOf(m: UpstreamModel): string[] {
        const caps = new Set<string>();
        for (const sp of m.supported_parameters ?? []) {
          const s = sp.toLowerCase();
          if (s.includes("reason")) caps.add("reasoning");
          if (s === "tools" || s === "tool_choice" || s === "function_call") caps.add("tools");
          if (s.includes("response_format") || s.includes("structured")) caps.add("json");
        }
        if (m.capabilities) {
          for (const [k, v] of Object.entries(m.capabilities)) if (v) caps.add(k.toLowerCase());
        }
        const idl = m.id.toLowerCase();
        if (/vision|imag|vl[-/]|photo|seedream|flux|banana/.test(idl)) caps.add("vision");
        if (/reason|think|r1|o1|o3|deepthink/.test(idl)) caps.add("reasoning");
        if (/pdf|document/.test(idl)) caps.add("pdf");
        return [...caps];
      }

      let entries: UpstreamModel[] = [];
      if (p.type === "anthropic") {
        const res = await fetch(`${base}/v1/models`, {
          headers: { "x-api-key": account.api_key, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new AdminError(502, `Upstream returned HTTP ${res.status}`);
        const data = upstreamModelsResponseSchema.safeParse(await res.json());
        if (!data.success) throw new AdminError(502, "Upstream returned an invalid model catalog");
        entries = data.data.data;
      } else {
        const res = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${account.api_key}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new AdminError(502, `Upstream returned HTTP ${res.status}`);
        const data = upstreamModelsResponseSchema.safeParse(await res.json());
        if (!data.success) throw new AdminError(502, "Upstream returned an invalid model catalog");
        entries = data.data.data;
      }

      // Filter which models to keep. Mode is a global setting
      // ("model_sync_mode": "curated" | "all"), defaulting to curated.
      const mode = (settings.getJson<ModelSyncMode>("model_sync_mode") ?? "curated") as ModelSyncMode;

      const kept: string[] = [];
      const syncedModels: Array<{ id: string; contextLength: number | null; maxOutputTokens: number | null; capabilities: string[] | null }> = [];
      let dropped = 0;
      for (const m of entries) {
        if (!m.id) continue;
        if (!keepModel(m.id, mode)) {
          dropped++;
          continue;
        }
        kept.push(m.id);
        // Upstream metadata wins; fall back to the per-model catalog so
        // upstreams that return no metadata (e.g. BlackBox) still get accurate
        // context length / max output / capabilities for each model.
        const meta = resolveModelMeta(m.id, {
          contextLength: m.context_length ?? m.top_provider?.context_length ?? null,
          maxOutputTokens: m.max_output_tokens ?? m.max_completion_tokens ?? m.top_provider?.max_completion_tokens ?? m.max_tokens ?? null,
          capabilities: capsOf(m),
        });
        syncedModels.push({ id: m.id,
          contextLength: meta?.contextLength ?? null,
          maxOutputTokens: meta?.maxOutputTokens ?? null,
          capabilities: meta?.capabilities ?? null,
        });
      }

      // Remove previously-synced models that no longer pass the filter so the
      // catalog stays clean (only when we actually got a non-empty upstream list).
      let pruned = 0;
      if (entries.length > 0) {
        pruned = repo.replaceSyncedModels(p.id, syncedModels);
      }

      log.info("models synced", { provider: p.name, kept: kept.length, dropped, pruned, mode });
      return { synced: kept.length, dropped, pruned, mode, models: kept };
    });
}
