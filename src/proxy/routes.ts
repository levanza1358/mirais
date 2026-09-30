import { Elysia } from "elysia";
import type { Database } from "../store/sql";
import { config } from "../config";
import { authenticateGatewayKey, authorizeModel } from "../auth";
import { checkRateLimit, acquireSlot, releaseSlot } from "../ratelimit";
import { normalizeRoutingPolicy, Router } from "./router";
import { executeRequest, cooldownSnapshot } from "./executor";
import { applyTokenSaver } from "./saver/rules";
import type { TokenSaverConfig } from "./saver/compress";
import type { HeadroomConfig } from "./saver/headroom";
import type { PonytailConfig } from "./saver/ponytail";
import { chatCompletionsSchema, anthropicMessagesSchema, responsesCreateSchema } from "../shared/schemas";
import { anthropicToOpenaiRequest } from "./translator/anthropic-to-openai";
import { openaiToAnthropicResponse } from "./translator/openai-to-anthropic";
import { OpenAIToAnthropicStreamTranslator } from "./translator/stream";
import { dsmlToOpenAiStream } from "./translator/dsml";
import { GatewayError } from "../shared/errors";
import { ProvidersRepo } from "../store/repos/providers";
import { AliasesRepo, CombosRepo } from "../store/repos/routing";
import { LogsRepo } from "../store/repos/logs";
import { DailyUsageRepo } from "../store/repos/usage";
import { SettingsRepo } from "../store/repos/settings";
import type { CanonicalRequest, CanonicalResponse, RoutingPolicy, Usage, ReasoningEffort } from "../shared/types";
import { log } from "../utils/logger";
import { canonicalResponseToResponses, chatSseToResponses, responsesRequestToCanonical } from "./translator/responses";
import { ulid } from "../utils/id";
import type { GatewayKey } from "../shared/types";

export function v1Routes(db: Database) {
  const providersRepo = new ProvidersRepo(db);
  const router = new Router(providersRepo, new AliasesRepo(db), new CombosRepo(db));
  const usage = new DailyUsageRepo(db);
  const logs = new LogsRepo(db, usage);
  const settings = new SettingsRepo(db);
  const app = new Elysia({ prefix: "/v1" });

  const tokenSaverConfig = async (request: Request, providerName?: string): Promise<TokenSaverConfig> => {
    const configured = await settings.getJson<TokenSaverConfig>("token_saver") ?? {
      enabled: config.tokenSaverDefault,
      rules: { gitDiff: true, grep: true, ls: true, longOutputMaxLines: 200 },
    };
    const allowlist = await settings.getJson<string[] | null>("token_saver_providers") ?? null;
    // Per-provider opt-out: when an allowlist is set, only providers in the list
    // get token saver; everything else runs raw. `null` = apply to all providers.
    const providerEnabled = allowlist === null || (providerName != null && allowlist.includes(providerName));
    const enabled = configured.enabled && providerEnabled;
    const final: TokenSaverConfig = request.headers.get("x-mirais-token-saver") === "off"
      ? { ...configured, enabled: false }
      : { ...configured, enabled };
    return final;
  };

  const headroomConfig = async (): Promise<HeadroomConfig> => {
    return await settings.getJson<HeadroomConfig>("headroom") ?? { enabled: false, keepRecent: 10, summarize: true, maxChars: 100_000 };
  };

  const ponytailConfig = async (): Promise<PonytailConfig> => {
    return await settings.getJson<PonytailConfig>("ponytail") ?? { enabled: false, strength: "moderate" };
  };

  /**
   * Parse a JSON body while enforcing `REQUEST_BODY_LIMIT_MB`.
   *
   * `content-length` is only a hint — a chunked or spoofed request can omit it
   * or understate the real size, so the decoded text is measured too. Reading
   * as text first also keeps the limit meaningful for streaming clients.
   */
  const readJsonBody = async (request: Request): Promise<unknown> => {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > config.requestBodyLimit) {
      throw new GatewayError(413, "invalid_request_error", `Request body exceeds the ${Math.floor(config.requestBodyLimit / (1024 * 1024))}MB limit`);
    }
    let text: string;
    try {
      text = await request.text();
    } catch {
      throw new GatewayError(400, "invalid_request_error", "Request body could not be read");
    }
    if (Buffer.byteLength(text) > config.requestBodyLimit) {
      throw new GatewayError(413, "invalid_request_error", `Request body exceeds the ${Math.floor(config.requestBodyLimit / (1024 * 1024))}MB limit`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GatewayError(400, "invalid_request_error", "Request body must be valid JSON");
    }
  };

  app.get("/models", async ({ request }) => {
    const key = await authenticateGatewayKey(db, request.headers.get("authorization"));
    const providers = new ProvidersRepo(db);
    const policy = normalizeRoutingPolicy(await settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
    const providersById = new Map((await providers.list()).map((provider) => [provider.id, provider]));
    const models: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
    for (const m of await providers.listAllModels()) {
      const provider = providersById.get(m.provider_id);
      const exposedId = provider ? `${provider.name}/${m.model_id}` : m.model_id;
      try { authorizeModel(key, exposedId); } catch { continue; }
      if (m.enabled && provider?.enabled && !policy.denyProviders.includes(provider.name) && !policy.denyModels.includes(m.model_id)) {
        models.push({ id: exposedId, object: "model", created: 0, owned_by: provider.name });
      }
    }
    const aliases = await new AliasesRepo(db).list();
    const combos = await new CombosRepo(db).list();
    const visibleVirtualModel = async (id: string): Promise<boolean> => {
      try {
        authorizeModel(key, id);
        return (await router.resolveWithPolicy(id, policy)).candidates.length > 0;
      } catch {
        return false;
      }
    };
    const aliasModels = (await Promise.all(aliases.map(async (alias) =>
      await visibleVirtualModel(alias.alias) ? { id: alias.alias, object: "model", created: 0, owned_by: "mirais-alias" } : null,
    ))).filter((model) => model !== null);
    const comboModels = (await Promise.all(combos.map(async (combo) =>
      await visibleVirtualModel(`combo:${combo.name}`) ? { id: `combo:${combo.name}`, object: "model", created: 0, owned_by: "mirais-combo" } : null,
    ))).filter((model) => model !== null);
    return {
      object: "list",
      data: [...models, ...aliasModels, ...comboModels],
    };
  });

  app.post("/chat/completions", async ({ request, set }) => {
    set.headers["x-request-id"] = `req_${ulid()}`;
    const started = Date.now();
    const key = await authenticateGatewayKey(db, request.headers.get("authorization"));
    const kind: "request" | "warmup" = request.headers.get("x-mirais-warmup") === "1" ? "warmup" : "request";

    const rawBody = await readJsonBody(request);
    const parsed = chatCompletionsSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new GatewayError(400, "invalid_request_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    let req = parsed.data as unknown as CanonicalRequest & { max_completion_tokens?: number };
    if (req.max_completion_tokens && !req.max_tokens) req.max_tokens = req.max_completion_tokens;

    authorizeModel(key, req.model);
    const rl = await checkRateLimit(db, key);
    if (rl.retryAfterSec !== undefined) {
      if (key.token_budget) {
        const used = (await new LogsRepo(db).keyUsage(key.id)).tokens_total;
        const message = used >= key.token_budget ? "Your token limit has been reached for this API key" : "Rate limit exceeded";
        if (used >= key.token_budget) throw new GatewayError(429, "rate_limit_error", message, "token_limit_reached");
      }
      set.status = 429;
      set.headers["retry-after"] = String(rl.retryAfterSec);
      logRequest(key.id === "anonymous" ? null : key.id, "/v1/chat/completions", req.model, null, null, 1, "rate_limited", 429, "rate limit", started, undefined, 0, undefined, undefined, "request", reasoningEffort(req));
      return new GatewayError(429, "rate_limit_error", "Rate limit exceeded").toJSON();
    }

    const routingPolicy = request.headers.get("x-mirais-no-fallback") === "1"
      ? { ...normalizeRoutingPolicy(await settings.getJson<Partial<RoutingPolicy>>("routing_policy")), maxAttempts: 1 }
      : normalizeRoutingPolicy(await settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
    const route = await router.resolveWithPolicy(req.model, routingPolicy);
    req = await applyReasoningDefaults(req, route.candidates[0]?.provider.name);

    // token saver (RTK + Headroom + Ponytail) — scoped to the resolved provider
    const saverCfg = await tokenSaverConfig(request, route.candidates[0]?.provider.name);
    const hCfg = await headroomConfig();
    const pCfg = await ponytailConfig();
    const saver = applyTokenSaver(req, saverCfg, hCfg, pCfg);
    req = saver.request;

    // terse mode (Caveman)
    const terse = await settings.getJson<{ enabled: boolean; prompt: string }>("terse_mode");
    if (terse?.enabled) {
      req = { ...req, messages: [{ role: "system", content: terse.prompt }, ...req.messages] };
    }

    const logKeyId = key.id === "anonymous" ? null : key.id;
    if (logKeyId) acquireSlot(logKeyId);
    try {
      const result = await executeRequest(req, route.candidates, {
        signal: request.signal,
        xaiSessionId: request.headers.get("x-mirais-session-id") ?? request.headers.get("x-grok-session-id") ?? undefined,
        xaiRequestId: set.headers["x-request-id"],
        allowPayloadTooLargeFallback: route.kind === "combo",
      }, providersRepo, routingPolicy, (await maxBudgetTokens()) ?? undefined);

      if (result.kind === "stream") {
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        set.headers["cache-control"] = "no-cache";
        set.headers["connection"] = "keep-alive";
        set.headers["x-accel-buffering"] = "no";
        const tap = tapOpenAiStream(req.tools?.length ? dsmlToOpenAiStream(result.stream) : result.stream);
        Promise.all([result.usagePromise, tap.textPromise])
          .then(async ([usage, text]) => {
            await logRequest(logKeyId, "/v1/chat/completions", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "success", 200, null, started, usage, saver.tokensSaved, result.attempts,
              { request: summarizeRequest(req), response: text || "[stream ended without SSE events]" }, kind, reasoningEffort(req));
          })
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            await logRequest(logKeyId, "/v1/chat/completions", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "error", 502, message, started, undefined, saver.tokensSaved, result.attempts,
              { request: summarizeRequest(req), response: summarizeResponse(null, message) }, kind, reasoningEffort(req));
          })
          .finally(() => { if (logKeyId) releaseSlot(logKeyId); });
        return tap.stream;
      }

      await logRequest(logKeyId, "/v1/chat/completions", req.model, result.candidate.provider.name, result.candidate.modelId,
        result.attempts.length, "success", 200, null, started, result.response.usage ?? null, saver.tokensSaved, result.attempts,
        { request: summarizeRequest(req), response: summarizeResponse(result.response, null) }, kind, reasoningEffort(req));
      return result.response;
    } catch (err) {
      const status = err instanceof GatewayError ? err.status : 500;
      const msg = err instanceof Error ? err.message : String(err);
      await logRequest(logKeyId, "/v1/chat/completions", req.model, null, null, 1, status < 500 ? "client_error" : "error", status, msg, started,
        undefined, 0, undefined, { request: summarizeRequest(req), response: summarizeResponse(null, msg) }, kind, reasoningEffort(req));
      throw err;
    } finally {
      if (req.stream !== true && logKeyId) releaseSlot(logKeyId);
    }
  });

  app.post("/responses", async ({ request, set }) => {
    set.headers["x-request-id"] = `req_${ulid()}`;
    const started = Date.now();
    const key = await authenticateGatewayKey(db, request.headers.get("authorization"));
    const rawBody = await readJsonBody(request);
    const parsed = responsesCreateSchema.safeParse(rawBody);
    if (!parsed.success) throw new GatewayError(400, "invalid_request_error", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    let req = responsesRequestToCanonical(parsed.data);
    authorizeModel(key, req.model);
    const rl = await checkRateLimit(db, key);
    if (rl.retryAfterSec !== undefined) {
      if (key.token_budget && (await new LogsRepo(db).keyUsage(key.id)).tokens_total >= key.token_budget) throw new GatewayError(429, "rate_limit_error", "Your token limit has been reached for this API key", "token_limit_reached");
      throw new GatewayError(429, "rate_limit_error", "Rate limit exceeded");
    }
    const routingPolicy = request.headers.get("x-mirais-no-fallback") === "1"
      ? { ...normalizeRoutingPolicy(await settings.getJson<Partial<RoutingPolicy>>("routing_policy")), maxAttempts: 1 }
      : normalizeRoutingPolicy(await settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
    const route = await router.resolveWithPolicy(req.model, routingPolicy);
    req = await applyReasoningDefaults(req, route.candidates[0]?.provider.name);
    const saverCfg = await tokenSaverConfig(request, route.candidates[0]?.provider.name);
    const hCfg = await headroomConfig();
    const pCfg = await ponytailConfig();
    const saver = applyTokenSaver(req, saverCfg, hCfg, pCfg);
    req = saver.request;
    const terse = await settings.getJson<{ enabled: boolean; prompt: string }>("terse_mode");
    if (terse?.enabled) req = { ...req, messages: [{ role: "system", content: terse.prompt }, ...req.messages] };
    const logKeyId = key.id === "anonymous" ? null : key.id;
    if (logKeyId) acquireSlot(logKeyId);
    try {
      const result = await executeRequest(req, route.candidates, {
        signal: request.signal,
        xaiSessionId: request.headers.get("x-mirais-session-id") ?? request.headers.get("x-grok-session-id") ?? undefined,
        xaiRequestId: set.headers["x-request-id"],
        allowPayloadTooLargeFallback: route.kind === "combo",
      }, providersRepo, routingPolicy, (await maxBudgetTokens()) ?? undefined);
      if (result.kind === "stream") {
        const tap = tapOpenAiStream(result.stream);
        const translated = chatSseToResponses(tap.stream, req.model);
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        set.headers["cache-control"] = "no-cache";
        set.headers["x-accel-buffering"] = "no";
        Promise.all([result.usagePromise, translated.usagePromise, tap.textPromise])
          .then(async ([upstreamUsage, translatedUsage, text]) => {
            await logRequest(logKeyId, "/v1/responses", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "success", 200, null, started, translatedUsage ?? upstreamUsage, saver.tokensSaved, result.attempts,
              { request: summarizeRequest(req), response: text || "[stream ended without SSE events]" }, "request", reasoningEffort(req));
          })
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            await logRequest(logKeyId, "/v1/responses", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "error", 502, message, started, undefined, saver.tokensSaved, result.attempts,
              { request: summarizeRequest(req), response: summarizeResponse(null, message) }, "request", reasoningEffort(req));
          })
          .finally(() => { if (logKeyId) releaseSlot(logKeyId); });
        return translated.stream;
      }
      await logRequest(logKeyId, "/v1/responses", req.model, result.candidate.provider.name, result.candidate.modelId,
        result.attempts.length, "success", 200, null, started, result.response.usage ?? null, saver.tokensSaved, result.attempts,
        { request: summarizeRequest(req), response: summarizeResponse(result.response, null) }, "request", reasoningEffort(req));
      return canonicalResponseToResponses(result.response, req.model);
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      await logRequest(logKeyId, "/v1/responses", req.model, null, null, 1, status < 500 ? "client_error" : "error", status,
        message, started, undefined, 0, undefined,
        { request: summarizeRequest(req), response: summarizeResponse(null, message) }, "request", reasoningEffort(req));
      throw error;
    } finally {
      if (!req.stream && logKeyId) releaseSlot(logKeyId);
    }
  });

  app.post("/messages", async ({ request, set }) => {
    const requestId = `req_${ulid()}`;
    set.headers["request-id"] = requestId;
    set.headers["x-request-id"] = requestId;
    const started = Date.now();
    const anthropicKey = request.headers.get("x-api-key");
    const key = await authenticateGatewayKey(db, request.headers.get("authorization") ?? (anthropicKey ? `Bearer ${anthropicKey}` : null));
    const kind: "request" | "warmup" = request.headers.get("x-mirais-warmup") === "1" ? "warmup" : "request";

    const rawBody = await readJsonBody(request);
    const parsed = anthropicMessagesSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new GatewayError(400, "invalid_request_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const anthropicBody = rawBody as Record<string, unknown>;
    let req = anthropicToOpenaiRequest(anthropicBody);

    authorizeModel(key, req.model);
    const rl = await checkRateLimit(db, key);
    if (rl.retryAfterSec !== undefined) {
      if (key.token_budget && (await new LogsRepo(db).keyUsage(key.id)).tokens_total >= key.token_budget) throw new GatewayError(429, "rate_limit_error", "Your token limit has been reached for this API key", "token_limit_reached");
      set.status = 429;
      set.headers["retry-after"] = String(rl.retryAfterSec);
      return { type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } };
    }

    const routingPolicy = request.headers.get("x-mirais-no-fallback") === "1"
      ? { ...normalizeRoutingPolicy(await settings.getJson<Partial<RoutingPolicy>>("routing_policy")), maxAttempts: 1 }
      : normalizeRoutingPolicy(await settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
    const route = await router.resolveWithPolicy(req.model, routingPolicy);
    req = await applyReasoningDefaults(req, route.candidates[0]?.provider.name);
    const saverCfg = await tokenSaverConfig(request, route.candidates[0]?.provider.name);
    const saver = applyTokenSaver(req, saverCfg);
    req = saver.request;

    const terse = await settings.getJson<{ enabled: boolean; prompt: string }>("terse_mode");
    if (terse?.enabled) {
      req = { ...req, messages: [{ role: "system", content: terse.prompt }, ...req.messages] };
    }

    const logKeyId = key.id === "anonymous" ? null : key.id;
    if (logKeyId) acquireSlot(logKeyId);
    try {
      const result = await executeRequest(req, route.candidates, {
        signal: request.signal,
        xaiSessionId: request.headers.get("x-mirais-session-id") ?? request.headers.get("x-grok-session-id") ?? undefined,
        xaiRequestId: requestId,
        allowPayloadTooLargeFallback: route.kind === "combo",
      }, providersRepo, routingPolicy, (await maxBudgetTokens()) ?? undefined);

      if (result.kind === "stream") {
        // need Anthropic-shaped SSE back to client
        const translator = new OpenAIToAnthropicStreamTranslator(req.model);
        const tap = tapOpenAiStream(result.stream);
        const outStream = translateOpenAiSseToAnthropic(tap.stream, translator);
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        set.headers["cache-control"] = "no-cache";
        set.headers["x-accel-buffering"] = "no";
        Promise.all([result.usagePromise, tap.textPromise])
          .then(async ([, text]) => {
            const u = translator.result().usage;
            await logRequest(logKeyId, "/v1/messages", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "success", 200, null, started, u, saver.tokensSaved, result.attempts,
              { request: summarizeRequest(req), response: text || "[stream ended without SSE events]" }, kind, reasoningEffort(req));
          })
          .catch(() => undefined)
          .finally(() => { if (logKeyId) releaseSlot(logKeyId); });
        return outStream;
      }

      const anthropicResp = openaiToAnthropicResponse(result.response);
      await logRequest(logKeyId, "/v1/messages", req.model, result.candidate.provider.name, result.candidate.modelId,
        result.attempts.length, "success", 200, null, started, result.response.usage ?? null, saver.tokensSaved, result.attempts,
        { request: summarizeRequest(req), response: summarizeResponse(result.response, null) }, kind, reasoningEffort(req));
      return anthropicResp;
    } catch (err) {
      const status = err instanceof GatewayError ? err.status : 500;
      const msg = err instanceof Error ? err.message : String(err);
      await logRequest(logKeyId, "/v1/messages", req.model, null, null, 1, status < 500 ? "client_error" : "error", status, msg, started,
        undefined, 0, undefined, { request: summarizeRequest(req), response: summarizeResponse(null, msg) }, kind, reasoningEffort(req));
      if (err instanceof GatewayError) {
        set.status = err.status;
        return { type: "error", error: { type: err.type, message: err.message } };
      }
      throw err;
    } finally {
      if (req.stream !== true && logKeyId) releaseSlot(logKeyId);
    }
  });

  app.get("/health", () => ({ status: "ok", cooldowns: cooldownSnapshot() }));

  async function logRequest(
    keyId: string | null,
    endpoint: string,
    requestedModel: string,
    provider: string | null,
    model: string | null,
    attempts: number,
    status: "success" | "error" | "client_error" | "rate_limited",
    httpStatus: number,
    error: string | null,
    started: number,
    usage?: Usage | null,
    tokensSaved = 0,
    attemptsDetail?: unknown[],
    payload?: { request?: string | null; response?: string | null },
    kind: "request" | "warmup" = "request",
    reasoningEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null = null,
    reasoningTokens: number | null = null,
  ): Promise<void> {
    try {
      const trackPayloads = config.trackPayloads;
      const storePayload = trackPayloads === "full";
      const accountLabel = Array.isArray(attemptsDetail)
        ? (attemptsDetail as Array<{ accountLabel?: unknown; outcome?: unknown }>)
            .find((attempt) => attempt.outcome === "success" && typeof attempt.accountLabel === "string")?.accountLabel
          ?? (attemptsDetail as Array<{ accountLabel?: unknown }>).find((attempt) => typeof attempt.accountLabel === "string")?.accountLabel
        : null;
      const creditUsage = provider === "openai" || provider === "codebuddy-cn"
        ? usage ? usage.prompt_tokens + usage.completion_tokens : null
        : null;
      // Providers that report real credit consumption win. For everything else
      // fall back to the model's configured credit_rate — clearly marked as an
      // estimate so the dashboard never presents it as an actual bill.
      const estimated = creditUsage === null ? await estimateCredits(provider, model, usage) : null;
      await logs.insert({
        keyId,
        endpoint,
        requestedModel,
        provider,
        model,
        attempts,
        status,
        httpStatus,
        error,
        inputTokens: usage?.prompt_tokens ?? null,
        outputTokens: usage?.completion_tokens ?? null,
        cachedTokens: usage?.cached_tokens ?? null,
        cacheWriteTokens: usage?.cache_write_tokens ?? null,
        reasoningTokens: reasoningTokens ?? usage?.reasoning_tokens ?? null,
        creditUsage: creditUsage ?? estimated,
        creditSource: creditUsage !== null ? "upstream" : estimated !== null ? "estimated" : null,
        latencyMs: Date.now() - started,
        tokensSaved,
        reasoningEffort,
        requestBody: storePayload ? payload?.request ?? null : null,
        responseBody: storePayload ? payload?.response ?? null : null,
        attemptsDetail: attemptsDetail as never,
        accountLabel: typeof accountLabel === "string" ? accountLabel : null,
        kind,
      });
    } catch (err) {
      log.warn("failed to write request log", { err: String(err) });
    }
  }

  function reasoningEffort(req: CanonicalRequest): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null {
    if (!req.reasoning) return null;
    return req.reasoning.enabled === false ? "off" : req.reasoning.effort ?? "minimal";
  }

  /**
   * Merge the global default `reasoning` settings into the request. Per-provider
   * overrides win over globals; an explicit `enabled === false` on the request
   * always wins (R1.4 — never re-enable reasoning the client disabled).
   */
  async function applyReasoningDefaults(req: CanonicalRequest, providerName?: string): Promise<CanonicalRequest> {
    const cfg = await settings.getJson<{
      default_enabled?: boolean;
      default_effort?: ReasoningEffort;
      max_budget_tokens?: number;
      provider_overrides?: Record<string, { enabled?: boolean; effort?: ReasoningEffort; budget_tokens?: number }>;
    }>("reasoning");
    if (!cfg) return req;
    const override = providerName ? cfg.provider_overrides?.[providerName] : undefined;
    const explicitlyDisabled = req.reasoning?.enabled === false;
    if (explicitlyDisabled) return req;
    const block = req.reasoning ?? {};
    const enabled = block.enabled ?? override?.enabled ?? cfg.default_enabled ?? true;
    const effort = block.effort ?? override?.effort ?? cfg.default_effort;
    const overrideBudget = override?.budget_tokens;
    const budget = block.budget_tokens ?? (overrideBudget ?? cfg.max_budget_tokens ?? undefined);
    const next: CanonicalRequest["reasoning"] = { enabled };
    if (effort) next.effort = effort;
    if (budget) next.budget_tokens = budget;
    if (block.summary) next.summary = block.summary;
    if (block.include?.length) next.include = block.include;
    if (block.thinking) next.thinking = block.thinking;
    return { ...req, reasoning: next };
  }

  async function maxBudgetTokens(): Promise<number | null> {
    const cfg = await settings.getJson<{ max_budget_tokens?: number }>("reasoning");
    return cfg?.max_budget_tokens ?? null;
  }

  /**
   * Estimate credit consumption from the model's configured `credit_rate`
   * (credits per 1,000 tokens). Returns null when no rate is configured — we
   * never invent a number.
   */
  async function estimateCredits(
    provider: string | null,
    model: string | null,
    usage?: { prompt_tokens: number; completion_tokens: number } | null,
  ): Promise<number | null> {
    if (!provider || !model || !usage) return null;
    const providerRow = await providersRepo.getByName(provider);
    if (!providerRow) return null;
    const rate = (await providersRepo.getProviderModel(providerRow.id, model))?.credit_rate;
    if (rate == null || rate <= 0) return null;
    return ((usage.prompt_tokens + usage.completion_tokens) / 1000) * rate;
  }

  function stringifyUnknown(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function summarizeMessageContent(content: CanonicalRequest["messages"][number]["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return stringifyUnknown(content);
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return stringifyUnknown(part);
        if ((part as { type?: string }).type === "text") return (part as { text?: string }).text ?? "";
        if ((part as { type?: string }).type === "image_url") return "[image]";
        if ((part as { type?: string }).type === "tool_result") {
          const toolPart = part as { tool_use_id?: string; content?: unknown };
          return `[tool_result:${toolPart.tool_use_id ?? "unknown"}] ${stringifyUnknown(toolPart.content)}`;
        }
        return stringifyUnknown(part);
      })
      .filter(Boolean)
      .join("\n");
  }

  function summarizeRequest(r: CanonicalRequest): string {
    // Persist a machine-readable canonical request when TRACK_PAYLOADS=full so
    // the admin UI can offer an explicit, non-streaming replay. Reasoning is
    // redacted: the `reasoning_effort` column captures the requested mode, and
    // we don't want the per-request budget/effort block to leak across logs.
    const redacted: CanonicalRequest = { ...r, reasoning: undefined };
    return JSON.stringify(redacted);
    /*
    const parts: string[] = [];

    parts.push(`model: ${r.model}`);
    if (typeof r.stream === "boolean") parts.push(`stream: ${r.stream}`);
    if (typeof r.temperature === "number") parts.push(`temperature: ${r.temperature}`);
    if (typeof r.top_p === "number") parts.push(`top_p: ${r.top_p}`);
    if (typeof r.max_tokens === "number") parts.push(`max_tokens: ${r.max_tokens}`);
    if (r.stop) parts.push(`stop: ${stringifyUnknown(r.stop)}`);
    if (r.tool_choice) parts.push(`tool_choice: ${stringifyUnknown(r.tool_choice)}`);
    if (r.response_format) parts.push(`response_format: ${stringifyUnknown(r.response_format)}`);

    if (r.tools?.length) {
      parts.push("tools:");
      for (const tool of r.tools) {
        parts.push(`- ${tool.function.name}${tool.function.description ? ` — ${tool.function.description}` : ""}`);
        if (tool.function.parameters) parts.push(`  params: ${stringifyUnknown(tool.function.parameters)}`);
      }
    }

    parts.push("messages:");
    for (const [index, m] of r.messages.entries()) {
      parts.push(`[${index + 1}] ${m.role}${m.name ? ` (${m.name})` : ""}`);
      const text = summarizeMessageContent(m.content);
      if (text) parts.push(text);
      if (m.tool_call_id) parts.push(`tool_call_id: ${m.tool_call_id}`);
      if (m.tool_calls?.length) {
        parts.push("tool_calls:");
        for (const tc of m.tool_calls) {
          parts.push(`- ${tc.function.name}`);
          if (tc.function.arguments) parts.push(tc.function.arguments);
        }
      }
      parts.push("");
    }

    const joined = parts.join("\n").trim();
    return joined.length > 12000 ? joined.slice(0, 12000) + "\n…[truncated]" : joined;
    */
  }

  function summarizeResponse(resp: CanonicalResponse | null, errMsg: string | null): string {
    if (errMsg) return `ERROR: ${errMsg}`;
    if (!resp) return "";

    const parts: string[] = [];
    parts.push(`model: ${resp.model}`);
    if (resp.usage) {
      parts.push(`usage: prompt=${resp.usage.prompt_tokens}, completion=${resp.usage.completion_tokens}, total=${resp.usage.total_tokens}`);
    }

    for (const [index, choice] of (resp.choices ?? []).entries()) {
      parts.push(`choice[${index}] finish_reason=${choice.finish_reason ?? "null"}`);
      const text = summarizeMessageContent(choice.message.content);
      if (text) parts.push(text);
      // `reasoning_content` is sensitive model output. The `reasoning_effort`
      // column already tells operators whether thinking was requested; we never
      // persist the raw trace.
      const reasoning = (choice.message as { reasoning_content?: unknown }).reasoning_content;
      if (reasoning) parts.push("[reasoning content omitted for privacy]");
      if (choice.message.tool_calls?.length) {
        parts.push("tool_calls:");
        for (const tc of choice.message.tool_calls) {
          parts.push(`- ${tc.function.name}`);
          if (tc.function.arguments) parts.push(tc.function.arguments);
        }
      }
      parts.push("");
    }

    const out = parts.join("\n").trim();
    return out.length > 12000 ? out.slice(0, 12000) + "\n…[truncated]" : out;
  }

  return app;
}

/**
 * Tee an OpenAI chat.completion.chunk SSE stream: the client receives the
 * untouched stream while we accumulate the assistant's text deltas. When a
 * provider emits only non-text events, retain a bounded SSE transcript so the
 * request log remains useful for troubleshooting.
 */
export function tapOpenAiStream(stream: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; textPromise: Promise<string> } {
  const [clientBranch, tapBranch] = stream.tee();
  const textPromise = (async () => {
    const reader = tapBranch.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const events: string[] = [];
    let eventBytes = 0;
    const MAX = 12_000;
    const toolCalls = new Map<number, { name: string; arguments: string }>();
    const processEvent = (raw: string) => {
      const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) return;
      const data = dataLine.slice(5).trim();
      if (!data || data === "[DONE]") return;
      if (eventBytes < MAX) {
        const remaining = MAX - eventBytes;
        const captured = data.length > remaining ? `${data.slice(0, Math.max(0, remaining - 14))}…[truncated]` : data;
        events.push(captured);
        eventBytes += captured.length;
      }
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>;
            };
          }>;
        };
        const choice = chunk.choices?.[0];
        const contentDelta = choice?.delta?.content;
        const reasoningDelta = choice?.delta?.reasoning_content;
        if (typeof reasoningDelta === "string") text += reasoningDelta;
        if (typeof contentDelta === "string") text += contentDelta;
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const current = toolCalls.get(idx) ?? { name: "", arguments: "" };
          if (tc.function?.name) current.name = tc.function.name;
          if (tc.function?.arguments) current.arguments += tc.function.arguments;
          toolCalls.set(idx, current);
        }
      } catch { /* ignore non-JSON keep-alives */ }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const separator = /\r?\n\r?\n/;
        let match: RegExpExecArray | null;
        while ((match = separator.exec(buffer)) !== null) {
          processEvent(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer);
    } catch { /* client disconnected mid-stream — keep what we have */ }
    const parts: string[] = [];
    if (text) parts.push(text);
    if (toolCalls.size) {
      parts.push("tool_calls:");
      for (const tc of [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)) {
        parts.push(`- ${tc.name || "unknown"}`);
        if (tc.arguments) parts.push(tc.arguments);
      }
    }
    const out = parts.join("\n").trim();
    if (out) return out.length > MAX ? out.slice(0, MAX) + "\n…[truncated]" : out;
    return events.length ? `SSE events (no text delta):\n${events.join("\n")}` : "";
  })();
  return { stream: clientBranch, textPromise };
}

function translateOpenAiSseToAnthropic(stream: ReadableStream<Uint8Array>, translator: OpenAIToAnthropicStreamTranslator): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        const data = dataLines.join("\n");
        if (!data) continue;
        for (const out of translator.handleData(data)) {
          controller.enqueue(encoder.encode(out));
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => undefined);
    },
  });
}
