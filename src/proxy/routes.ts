import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { config } from "../config";
import { authenticateGatewayKey, authorizeModel } from "../auth";
import { checkRateLimit, acquireSlot, releaseSlot } from "../ratelimit";
import { normalizeRoutingPolicy, Router } from "./router";
import { executeRequest, cooldownSnapshot } from "./executor";
import { applyTokenSaver } from "./saver/rules";
import type { TokenSaverConfig } from "./saver/compress";
import { chatCompletionsSchema, anthropicMessagesSchema, responsesCreateSchema } from "../shared/schemas";
import { anthropicToOpenaiRequest } from "./translator/anthropic-to-openai";
import { openaiToAnthropicResponse } from "./translator/openai-to-anthropic";
import { OpenAIToAnthropicStreamTranslator } from "./translator/stream";
import { GatewayError } from "../shared/errors";
import { ProvidersRepo } from "../store/repos/providers";
import { AliasesRepo, CombosRepo } from "../store/repos/routing";
import { LogsRepo } from "../store/repos/logs";
import { SettingsRepo } from "../store/repos/settings";
import type { CanonicalRequest, CanonicalResponse, RoutingPolicy } from "../shared/types";
import { log } from "../utils/logger";
import { canonicalResponseToResponses, chatSseToResponses, responsesRequestToCanonical } from "./translator/responses";
import { ulid } from "../utils/id";
import type { GatewayKey } from "../shared/types";

export function v1Routes(db: Database) {
  const providersRepo = new ProvidersRepo(db);
  const router = new Router(providersRepo, new AliasesRepo(db), new CombosRepo(db));
  const logs = new LogsRepo(db);
  const settings = new SettingsRepo(db);
  const app = new Elysia({ prefix: "/v1" });

  const tokenSaverConfig = (request: Request): TokenSaverConfig => {
    const configured = settings.getJson<TokenSaverConfig>("token_saver") ?? {
      enabled: config.tokenSaverDefault,
      rules: { gitDiff: true, grep: true, ls: true, longOutputMaxLines: 200 },
    };
    return request.headers.get("x-mirais-token-saver") === "off" ? { ...configured, enabled: false } : configured;
  };

  app.get("/models", ({ request }) => {
    const key = authenticateGatewayKey(db, request.headers.get("authorization"));
    const providers = new ProvidersRepo(db);
    const policy = normalizeRoutingPolicy(settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
    const models = providers.listAllModels().filter((m) => {
      const provider = providers.get(m.provider_id);
      const exposedId = provider ? `${provider.name}/${m.model_id}` : m.model_id;
      try { authorizeModel(key, exposedId); } catch { return false; }
      return Boolean(m.enabled && provider?.enabled && !policy.denyProviders.includes(provider.name) && !policy.denyModels.includes(m.model_id));
    });
    const aliases = new AliasesRepo(db).list();
    const combos = new CombosRepo(db).list();
    const visibleVirtualModel = (id: string): boolean => {
      try {
        authorizeModel(key, id);
        return router.resolveWithPolicy(id, policy).candidates.length > 0;
      } catch {
        return false;
      }
    };
    return {
      object: "list",
      data: [
        ...models.map((m) => {
          const pname = providers.get(m.provider_id)?.name ?? "unknown";
          // Surface the full provider/model id so OpenAI-compatible clients
          // can pass it straight back to /v1/chat/completions without
          // knowing about any internal aliasing.
          return {
            id: `${pname}/${m.model_id}`,
            object: "model",
            created: 0,
            owned_by: pname,
          };
        }),
        ...aliases.filter((a) => visibleVirtualModel(a.alias)).map((a) => ({ id: a.alias, object: "model", created: 0, owned_by: "mirais-alias" })),
        ...combos.filter((c) => visibleVirtualModel(`combo:${c.name}`)).map((c) => ({ id: `combo:${c.name}`, object: "model", created: 0, owned_by: "mirais-combo" })),
      ],
    };
  });

  app.post("/chat/completions", async ({ request, set }) => {
    set.headers["x-request-id"] = `req_${ulid()}`;
    const started = Date.now();
    const key = authenticateGatewayKey(db, request.headers.get("authorization"));
    const kind: "request" | "warmup" = request.headers.get("x-mirais-warmup") === "1" ? "warmup" : "request";

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new GatewayError(400, "invalid_request_error", "Request body must be valid JSON");
    }
    const parsed = chatCompletionsSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new GatewayError(400, "invalid_request_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    let req = parsed.data as unknown as CanonicalRequest & { max_completion_tokens?: number };
    if (req.max_completion_tokens && !req.max_tokens) req.max_tokens = req.max_completion_tokens;

    authorizeModel(key, req.model);
    const rl = checkRateLimit(db, key);
    if (rl.retryAfterSec !== undefined) {
      set.status = 429;
      set.headers["retry-after"] = String(rl.retryAfterSec);
      logRequest(key.id === "anonymous" ? null : key.id, "/v1/chat/completions", req.model, null, null, 1, "rate_limited", 429, "rate limit", started);
      return new GatewayError(429, "rate_limit_error", "Rate limit exceeded").toJSON();
    }

    // token saver
    const saverCfg = tokenSaverConfig(request);
    const saver = applyTokenSaver(req, saverCfg);
    req = saver.request;

    // terse mode
    const terse = settings.getJson<{ enabled: boolean; prompt: string }>("terse_mode");
    if (terse?.enabled) {
      req = { ...req, messages: [{ role: "system", content: terse.prompt }, ...req.messages] };
    }

    const routingPolicy = request.headers.get("x-mirais-no-fallback") === "1"
      ? { ...normalizeRoutingPolicy(settings.getJson<Partial<RoutingPolicy>>("routing_policy")), maxAttempts: 1 }
      : normalizeRoutingPolicy(settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
    const route = router.resolveWithPolicy(req.model, routingPolicy);
    const logKeyId = key.id === "anonymous" ? null : key.id;
    if (logKeyId) acquireSlot(logKeyId);
    try {
      const result = await executeRequest(req, route.candidates, { signal: request.signal }, providersRepo, routingPolicy);

      if (result.kind === "stream") {
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        set.headers["cache-control"] = "no-cache";
        set.headers["connection"] = "keep-alive";
        set.headers["x-accel-buffering"] = "no";
        const tap = tapOpenAiStream(result.stream);
        Promise.all([result.usagePromise, tap.textPromise])
          .then(([usage, text]) => {
            logRequest(logKeyId, "/v1/chat/completions", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "success", 200, null, started, usage, saver.tokensSaved, result.attempts,
              { request: summarizeRequest(req), response: text || "[streamed]" }, kind);
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            logRequest(logKeyId, "/v1/chat/completions", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "error", 502, message, started, undefined, saver.tokensSaved, result.attempts,
              { request: summarizeRequest(req), response: summarizeResponse(null, message) }, kind);
          })
          .finally(() => { if (logKeyId) releaseSlot(logKeyId); });
        return tap.stream;
      }

      logRequest(logKeyId, "/v1/chat/completions", req.model, result.candidate.provider.name, result.candidate.modelId,
        result.attempts.length, "success", 200, null, started, result.response.usage ?? null, saver.tokensSaved, result.attempts,
        { request: summarizeRequest(req), response: summarizeResponse(result.response, null) }, kind);
      return result.response;
    } catch (err) {
      const status = err instanceof GatewayError ? err.status : 500;
      const msg = err instanceof Error ? err.message : String(err);
      logRequest(logKeyId, "/v1/chat/completions", req.model, null, null, 1, status < 500 ? "client_error" : "error", status, msg, started,
        undefined, 0, undefined, { request: summarizeRequest(req), response: summarizeResponse(null, msg) }, kind);
      throw err;
    } finally {
      if (req.stream !== true && logKeyId) releaseSlot(logKeyId);
    }
  });

  app.post("/responses", async ({ request, set }) => {
    set.headers["x-request-id"] = `req_${ulid()}`;
    const started = Date.now();
    const key = authenticateGatewayKey(db, request.headers.get("authorization"));
    let rawBody: unknown;
    try { rawBody = await request.json(); }
    catch { throw new GatewayError(400, "invalid_request_error", "Request body must be valid JSON"); }
    const parsed = responsesCreateSchema.safeParse(rawBody);
    if (!parsed.success) throw new GatewayError(400, "invalid_request_error", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    let req = responsesRequestToCanonical(parsed.data);
    authorizeModel(key, req.model);
    const rl = checkRateLimit(db, key);
    if (rl.retryAfterSec !== undefined) throw new GatewayError(429, "rate_limit_error", "Rate limit exceeded");
    const saverCfg = tokenSaverConfig(request);
    const saver = applyTokenSaver(req, saverCfg);
    req = saver.request;
    const terse = settings.getJson<{ enabled: boolean; prompt: string }>("terse_mode");
    if (terse?.enabled) req = { ...req, messages: [{ role: "system", content: terse.prompt }, ...req.messages] };
    const routingPolicy = request.headers.get("x-mirais-no-fallback") === "1"
      ? { ...normalizeRoutingPolicy(settings.getJson<Partial<RoutingPolicy>>("routing_policy")), maxAttempts: 1 }
      : normalizeRoutingPolicy(settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
    const route = router.resolveWithPolicy(req.model, routingPolicy);
    const logKeyId = key.id === "anonymous" ? null : key.id;
    if (logKeyId) acquireSlot(logKeyId);
    try {
      const result = await executeRequest(req, route.candidates, { signal: request.signal }, providersRepo, routingPolicy);
      if (result.kind === "stream") {
        const translated = chatSseToResponses(result.stream, req.model);
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        set.headers["cache-control"] = "no-cache";
        set.headers["x-accel-buffering"] = "no";
        Promise.all([result.usagePromise, translated.usagePromise])
          .then(([upstreamUsage, translatedUsage]) => {
            logRequest(logKeyId, "/v1/responses", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "success", 200, null, started, translatedUsage ?? upstreamUsage, saver.tokensSaved, result.attempts, undefined, "request");
          })
          .catch(() => undefined)
          .finally(() => { if (logKeyId) releaseSlot(logKeyId); });
        return translated.stream;
      }
      logRequest(logKeyId, "/v1/responses", req.model, result.candidate.provider.name, result.candidate.modelId,
        result.attempts.length, "success", 200, null, started, result.response.usage ?? null, saver.tokensSaved, result.attempts);
      return canonicalResponseToResponses(result.response, req.model);
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 500;
      logRequest(logKeyId, "/v1/responses", req.model, null, null, 1, status < 500 ? "client_error" : "error", status,
        error instanceof Error ? error.message : String(error), started);
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
    const key = authenticateGatewayKey(db, request.headers.get("authorization") ?? (anthropicKey ? `Bearer ${anthropicKey}` : null));
    const kind: "request" | "warmup" = request.headers.get("x-mirais-warmup") === "1" ? "warmup" : "request";

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new GatewayError(400, "invalid_request_error", "Request body must be valid JSON");
    }
    const parsed = anthropicMessagesSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new GatewayError(400, "invalid_request_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const anthropicBody = rawBody as Record<string, unknown>;
    let req = anthropicToOpenaiRequest(anthropicBody);

    authorizeModel(key, req.model);
    const rl = checkRateLimit(db, key);
    if (rl.retryAfterSec !== undefined) {
      set.status = 429;
      set.headers["retry-after"] = String(rl.retryAfterSec);
      return { type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } };
    }

    const saverCfg = tokenSaverConfig(request);
    const saver = applyTokenSaver(req, saverCfg);
    req = saver.request;

    const terse = settings.getJson<{ enabled: boolean; prompt: string }>("terse_mode");
    if (terse?.enabled) {
      req = { ...req, messages: [{ role: "system", content: terse.prompt }, ...req.messages] };
    }

    const routingPolicy = request.headers.get("x-mirais-no-fallback") === "1"
      ? { ...normalizeRoutingPolicy(settings.getJson<Partial<RoutingPolicy>>("routing_policy")), maxAttempts: 1 }
      : normalizeRoutingPolicy(settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
    const route = router.resolveWithPolicy(req.model, routingPolicy);
    const logKeyId = key.id === "anonymous" ? null : key.id;
    if (logKeyId) acquireSlot(logKeyId);
    try {
      const result = await executeRequest(req, route.candidates, { signal: request.signal }, providersRepo, routingPolicy);

      if (result.kind === "stream") {
        // need Anthropic-shaped SSE back to client
        const translator = new OpenAIToAnthropicStreamTranslator(req.model);
        const tap = tapOpenAiStream(result.stream);
        const outStream = translateOpenAiSseToAnthropic(tap.stream, translator);
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        set.headers["cache-control"] = "no-cache";
        set.headers["x-accel-buffering"] = "no";
        Promise.all([result.usagePromise, tap.textPromise])
          .then(([, text]) => {
            const u = translator.result().usage;
            logRequest(logKeyId, "/v1/messages", req.model, result.candidate.provider.name, result.candidate.modelId,
              result.attempts.length, "success", 200, null, started, u, saver.tokensSaved, result.attempts,
              { request: summarizeRequest(req), response: text || "[streamed]" }, kind);
          })
          .catch(() => undefined)
          .finally(() => { if (logKeyId) releaseSlot(logKeyId); });
        return outStream;
      }

      const anthropicResp = openaiToAnthropicResponse(result.response);
      logRequest(logKeyId, "/v1/messages", req.model, result.candidate.provider.name, result.candidate.modelId,
        result.attempts.length, "success", 200, null, started, result.response.usage ?? null, saver.tokensSaved, result.attempts,
        { request: summarizeRequest(req), response: summarizeResponse(result.response, null) }, kind);
      return anthropicResp;
    } catch (err) {
      const status = err instanceof GatewayError ? err.status : 500;
      const msg = err instanceof Error ? err.message : String(err);
      logRequest(logKeyId, "/v1/messages", req.model, null, null, 1, status < 500 ? "client_error" : "error", status, msg, started,
        undefined, 0, undefined, { request: summarizeRequest(req), response: summarizeResponse(null, msg) }, kind);
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

  function logRequest(
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
    usage?: { prompt_tokens: number; completion_tokens: number } | null,
    tokensSaved = 0,
    attemptsDetail?: unknown[],
    payload?: { request?: string | null; response?: string | null },
    kind: "request" | "warmup" = "request",
  ) {
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
      logs.insert({
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
        creditUsage,
        latencyMs: Date.now() - started,
        tokensSaved,
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
 * untouched stream while we accumulate the assistant's text deltas so the
 * request log can show the actual reply instead of "[streamed]".
 */
function tapOpenAiStream(stream: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; textPromise: Promise<string> } {
  const [clientBranch, tapBranch] = stream.tee();
  const textPromise = (async () => {
    const reader = tapBranch.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls = new Map<number, { name: string; arguments: string }>();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const data = dataLine.slice(5).trim();
          if (!data || data === "[DONE]") continue;
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
        }
      }
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
    const MAX = 12000;
    return out.length > MAX ? out.slice(0, MAX) + "\n…[truncated]" : out;
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
