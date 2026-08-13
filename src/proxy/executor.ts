import type { CanonicalRequest, CanonicalResponse, AttemptRecord, RouteCandidate, Usage, RoutingPolicy, ProviderAccount } from "../shared/types";
import { GatewayError, isRetriableStatus } from "../shared/errors";
import { baseUrlFor, upstreamFormat } from "./router";
import { openaiToAnthropicRequest } from "./translator/anthropic-to-openai";
import { anthropicToOpenaiResponse } from "./translator/openai-to-anthropic";
import { AnthropicToOpenAIStreamTranslator, SseParser } from "./translator/stream";
import { aggregateChatCompletionsStream, aggregateResponsesStream, codexHeaders, codexPlanAllowsModel, codexPlanRequirement, codexRequestBody, codexUrl, ensureFreshToken, isOAuthAccount, responsesStreamToChat } from "./codex";
import { aggregateXaiChatCompletionsStream, aggregateXaiResponsesStream, ensureFreshXaiToken, fetchXaiChatCompletions, fetchXaiResponses, supportsReasoningEffort, xaiChatCompletionsBody, xaiChatCompletionsStreamToChat, xaiHeaders, xaiRequestBody, xaiRequestContext, xaiResponsesStreamToChat } from "./xai";
import { metaForModel } from "./modelMeta";
import type { ProvidersRepo } from "../store/repos/providers";
import { config } from "../config";
import { log } from "../utils/logger";

/**
 * Strip universal fields from the canonical request and translate the
 * universal `reasoning` block into the OpenAI Chat Completions dialect
 * (`reasoning_effort`). Providers that don't understand the field simply
 * ignore it, but we still send it for the ones that do.
 */
function toOpenAiBody(req: CanonicalRequest, modelId: string): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: modelId };
  // Don't leak our canonical name back upstream; the upstream already knows the model.
  delete (body as { reasoning?: unknown }).reasoning;
  if (req.reasoning?.effort) {
    body.reasoning_effort = req.reasoning.effort;
  }
  return body;
}

// ── in-memory health state ──

interface CooldownEntry {
  until: number;
  failures: number;
}

const cooldowns = new Map<string, CooldownEntry>();
const rrCursor = new Map<string, number>();

function cooldownKey(candidate: RouteCandidate, accountId: string): string {
  return `${candidate.provider.name}:${candidate.modelId}:${accountId}`;
}

function isCoolingDown(key: string): boolean {
  const c = cooldowns.get(key);
  if (!c) return false;
    if (c.until <= Date.now()) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export function markCooldown(key: string, retryAfterMs?: number): void {
  const cur = cooldowns.get(key);
  const failures = (cur?.failures ?? 0) + 1;
  const backoff = retryAfterMs ?? (failures === 1 ? 60_000 : failures === 2 ? 300_000 : 900_000);
  cooldowns.set(key, { until: Date.now() + backoff, failures });
  log.debug("candidate cooled down", { key, failures, cooldown_ms: backoff });
}

export function markSuccess(key: string): void {
  cooldowns.delete(key);
}

/** Clear a persisted rate-limit window after a successful call. */
function clearAccountRateLimit(repo: ProvidersRepo | undefined, accountId: string): void {
  if (!repo) return;
  try {
    repo.updateAccount(accountId, {
      rateLimitedUntil: null,
      lastWarmupStatus: "healthy",
      lastWarmupDetail: null,
      lastWarmupAt: new Date().toISOString(),
    });
  } catch { /* best-effort — DB may be mid-restart */ }
}

export function cooldownSnapshot(): Array<{ key: string; until: number; failures: number }> {
  return [...cooldowns.entries()]
    .filter(([, v]) => v.until > Date.now())
    .map(([key, v]) => ({ key, until: v.until, failures: v.failures }));
}

function nextCoolingCandidate(candidates: RouteCandidate[]): { accountLabel: string; retryAt: number } | null {
  let next: { accountLabel: string; retryAt: number } | null = null;
  for (const candidate of candidates) {
    for (const account of candidate.accounts) {
      const cd = cooldowns.get(cooldownKey(candidate, account.id));
      if (!cd || cd.until <= Date.now()) continue;
      if (!next || cd.until < next.retryAt) {
        next = { accountLabel: account.label, retryAt: cd.until };
      }
    }
  }
  return next;
}

export interface ExecutorContext {
  signal?: AbortSignal;
  xaiSessionId?: string;
  xaiRequestId?: string;
}

export interface ExecuteSuccess {
  kind: "json";
  response: CanonicalResponse;
  candidate: RouteCandidate;
  accountLabel: string;
  attempts: AttemptRecord[];
  latencyMs: number;
}

export interface ExecuteStreamSuccess {
  kind: "stream";
  stream: ReadableStream<Uint8Array>;
  candidate: RouteCandidate;
  accountLabel: string;
  attempts: AttemptRecord[];
  usagePromise: Promise<Usage | null>;
}

export type ExecuteResult = ExecuteSuccess | ExecuteStreamSuccess;

const MAX_ATTEMPTS = 3;

function isCodeBuddyProvider(type: string): boolean {
  return type === "codebuddy-global" || type === "codebuddy-cn";
}

function withRequiredSystemMessage(req: CanonicalRequest): CanonicalRequest {
  if (req.messages.some((m) => m.role === "system")) return req;
  return {
    ...req,
    messages: [{ role: "system", content: "You are a helpful AI assistant." }, ...req.messages],
  };
}

function codeBuddyHeaders(apiKey: string, accept: "text/event-stream" | "application/json"): Record<string, string> {
  return {
    "content-type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "x-codebuddy-request": "1",
    accept,
  };
}

export async function executeRequest(
  req: CanonicalRequest,
  candidates: RouteCandidate[],
  ctx: ExecutorContext = {},
  providersRepo?: ProvidersRepo,
  policy?: RoutingPolicy,
): Promise<ExecuteResult> {
  const attempts: AttemptRecord[] = [];
  let lastError: GatewayError | null = null;

  // Flatten candidates × accounts, skipping cooled-down pairs, round-robin start
  const plan: Array<{ candidate: RouteCandidate; account: RouteCandidate["accounts"][number] }> = [];
  for (const candidate of candidates) {
    const start = (rrCursor.get(candidate.provider.name) ?? 0) % candidate.accounts.length;
    const ordered = [...candidate.accounts.slice(start), ...candidate.accounts.slice(0, start)];
    rrCursor.set(candidate.provider.name, start + 1);
    for (const account of ordered) {
      const key = cooldownKey(candidate, account.id);
      if (!isCoolingDown(key)) plan.push({ candidate, account });
    }
  }

  if (!plan.length) {
    const next = nextCoolingCandidate(candidates);
    if (next) {
      const seconds = Math.max(1, Math.ceil((next.retryAt - Date.now()) / 1000));
      throw new GatewayError(503, "server_error", `All candidates are cooling down. Next ready account: ${next.accountLabel} in ${seconds}s.`);
    }
    throw new GatewayError(503, "server_error", "All candidates are cooling down. Try again shortly.");
  }

  const orderedPlan = plan.filter(({ account }) => account.last_warmup_status === "healthy");

  if (!orderedPlan.length) {
    throw new GatewayError(503, "server_error", "No healthy accounts are available. Run account warmup and try again.");
  }

  // A paid Codex model must never be sent through a Free or unclassified
  // ChatGPT OAuth account. Plan tiers are refreshed during warmup/quota
  // checks; fail closed until known instead of attempting Free first.
  const paidRequirements = candidates
    .map((candidate) => codexPlanRequirement(candidate.modelId))
    .filter((requirement): requirement is "plus" | "pro" => requirement !== null);
  const planEligible = !paidRequirements.length
    ? orderedPlan
    : orderedPlan.filter(({ candidate, account }) =>
      account.auth_kind !== "oauth"
      || candidate.provider.type !== "openai"
      || codexPlanAllowsModel(account.plan_type, candidate.modelId),
    );
  if (!planEligible.length) {
    const label = paidRequirements.includes("pro") ? "ChatGPT Pro" : "ChatGPT Plus or Pro";
    throw new GatewayError(503, "server_error", `${req.model} requires an eligible ${label} Codex account. Run account warmup to refresh account plan tiers.`);
  }

  const maxAttempts = Math.min(policy?.maxAttempts ?? MAX_ATTEMPTS, planEligible.length);
  for (let attemptNo = 0; attemptNo < maxAttempts; attemptNo++) {
    const { candidate, account } = planEligible[attemptNo]!;
    const effectiveReq = clampMaxTokens(req, candidate, providersRepo);
    const started = Date.now();
    const format = upstreamFormat(candidate.provider);
    const base = baseUrlFor(candidate.provider);
    const cdKey = cooldownKey(candidate, account.id);

    try {
      // OAuth accounts require their provider's CLI Responses endpoint; they
      // cannot call the public OpenAI-compatible endpoint with a bearer token.
      const isXaiOAuth = candidate.provider.type === "xai" && account.auth_kind === "oauth";
      // Chat Completions exposes Grok-4.5 reasoning deltas for plain chat.
      // Tool agents must use Responses API: it preserves function-call item
      // lifecycle events and is the endpoint the Grok CLI uses for tools.
      const hasTools = (effectiveReq.tools?.length ?? 0) > 0;
      const useXaiChat = isXaiOAuth
        && supportsReasoningEffort(candidate.modelId)
        && effectiveReq.reasoning?.enabled !== false
        && !hasTools;
      if (isOAuthAccount(account) || isXaiOAuth) {
        if (!providersRepo) throw new GatewayError(500, "server_error", "OAuth account requires a providers repo in the executor");
        const accessToken = isXaiOAuth
          ? await ensureFreshXaiToken(providersRepo, account)
          : await ensureFreshToken(providersRepo, account);
        if (req.stream) {
          const result = useXaiChat
            ? await openXaiChatStream(effectiveReq, candidate, accessToken, account, ctx)
            : isXaiOAuth
            ? await openXaiStream(effectiveReq, candidate, accessToken, account, ctx)
            : await openCodexStream(effectiveReq, candidate, account, accessToken, ctx.signal);
          markSuccess(cdKey);
          clearAccountRateLimit(providersRepo, account.id);
          attempts.push({
            provider: candidate.provider.name,
            model: candidate.modelId,
            accountId: account.id,
            accountLabel: account.label,
            outcome: "success",
            latencyMs: Date.now() - started,
          });
          return { kind: "stream", stream: result.stream, candidate, accountLabel: account.label, attempts, usagePromise: result.usagePromise };
        }
        const response = useXaiChat
          ? await callXaiChat(effectiveReq, candidate, accessToken, account, ctx)
          : isXaiOAuth
          ? await callXai(effectiveReq, candidate, accessToken, account, ctx)
          : await callCodex(effectiveReq, candidate, account, accessToken, ctx.signal);
        markSuccess(cdKey);
        clearAccountRateLimit(providersRepo, account.id);
        attempts.push({
          provider: candidate.provider.name,
          model: candidate.modelId,
          accountId: account.id,
          accountLabel: account.label,
          outcome: "success",
          latencyMs: Date.now() - started,
          reason: attemptNo === 0 ? "primary candidate" : "fallback candidate",
        });
        return { kind: "json", response, candidate, accountLabel: account.label, attempts, latencyMs: Date.now() - started };
      }

      if (req.stream) {
        const result = await openUpstreamStream(effectiveReq, candidate, account.api_key, base, format, ctx.signal);
        markSuccess(cdKey);
        clearAccountRateLimit(providersRepo, account.id);
        attempts.push({
          provider: candidate.provider.name,
          model: candidate.modelId,
          accountId: account.id,
          accountLabel: account.label,
          outcome: "success",
          latencyMs: Date.now() - started,
          reason: attemptNo === 0 ? "primary candidate" : "fallback candidate",
        });
        return {
          kind: "stream",
          stream: result.stream,
          candidate,
          accountLabel: account.label,
          attempts,
          usagePromise: result.usagePromise,
        };
      }

      const result = await callUpstream(effectiveReq, candidate, account.api_key, base, format, ctx.signal);
      markSuccess(cdKey);
      clearAccountRateLimit(providersRepo, account.id);
      attempts.push({
        provider: candidate.provider.name,
        model: candidate.modelId,
        accountLabel: account.label,
        outcome: "success",
        latencyMs: Date.now() - started,
        reason: attemptNo === 0 ? "primary candidate" : "fallback candidate",
      });
      return {
        kind: "json",
        response: result,
        candidate,
        accountLabel: account.label,
        attempts,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const gErr = toGatewayError(err);
      const retriable = gErr instanceof GatewayError
        ? isRetriableStatus(gErr.status) || gErr.type === "authentication_error"
        : true;

      attempts.push({
        provider: candidate.provider.name,
        model: candidate.modelId,
        accountId: account.id,
        accountLabel: account.label,
        outcome: "error",
        httpStatus: gErr.status,
        error: gErr.message,
        latencyMs,
        reason: attemptNo === 0 ? "primary candidate failed" : "fallback candidate failed",
      });

      if (retriable) {
        const quotaExhausted = gErr.status === 429 && /free-usage-exhausted|usage limit has been reached|limit has been reached|quota/i.test(gErr.message);
        const cooldownMs = quotaExhausted ? 24 * 60 * 60_000 : gErr.status === 429 ? (retryAfterMsFrom(gErr) ?? 60_000) : undefined;
        // A "quota exhausted" 429 is not a transient rate limit — the account
        // stays out of rotation until the window resets (up to ~24h). Treating
        // it as a short cooldown would make the gateway fail over to other
        // exhausted accounts and force clients into repeated recovery+retry
        // loops that replay the same answer.
        markCooldown(cdKey, cooldownMs);
        if (cooldownMs && providersRepo) {
          // Persist the rate-limit window so the account is skipped on the next
          // request (not just in-memory), and recovers to healthy automatically
          // once the window passes — no warmup required.
          providersRepo.updateAccount(account.id, {
            rateLimitedUntil: Date.now() + cooldownMs,
            lastWarmupStatus: "rate_limited",
            lastWarmupDetail: gErr.message.slice(0, 300),
            lastWarmupAt: new Date().toISOString(),
          });
        }
        lastError = gErr;
        log.warn("upstream attempt failed, failing over", {
          provider: candidate.provider.name,
          model: candidate.modelId,
          status: gErr.status,
          attempt: attemptNo + 1,
        });
        continue;
      }
      throw gErr;
    }
  }

  throw lastError ?? new GatewayError(503, "server_error", "All upstream attempts failed");
}

function retryAfterMsFrom(err: GatewayError): number | undefined {
  const m = /retry[_ -]after[":= ]+(\d+)/i.exec(err.message);
  return m ? Number(m[1]) * 1000 : undefined;
}

function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timeout/i.test(msg)) return new GatewayError(504, "server_error", "Upstream timeout");
  return new GatewayError(502, "server_error", `Upstream network error: ${msg}`);
}

async function callUpstream(
  req: CanonicalRequest,
  candidate: RouteCandidate,
  apiKey: string,
  base: string,
  format: "openai" | "anthropic",
  signal?: AbortSignal,
): Promise<CanonicalResponse> {
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  if (isCodeBuddyProvider(candidate.provider.type)) {
    const forced = withRequiredSystemMessage(req);
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: codeBuddyHeaders(apiKey, "text/event-stream"),
      body: JSON.stringify({ ...forced, model: candidate.modelId, stream: true }),
      signal: combined,
    });
    if (!res.ok) throw await upstreamError(res);
    if (!res.body) throw new GatewayError(502, "server_error", "Upstream returned no stream body");
    // CodeBuddy returns standard OpenAI Chat Completions SSE — aggregate into one response
    return await aggregateChatCompletionsStream(res.body, req.model);
  }

  if (format === "anthropic") {
    const body = openaiToAnthropicRequest({ ...req, stream: false }, candidate.modelId);
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: combined,
    });
    if (!res.ok) throw await upstreamError(res);
    const data = (await res.json()) as Record<string, unknown>;
    return anthropicToOpenaiResponse(data, req.model);
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: candidate.provider.type === "xai"
      ? xaiHeaders(apiKey)
      : { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(toOpenAiBody({ ...req, stream: false }, candidate.modelId)),
    signal: combined,
  });
  if (!res.ok) throw await upstreamError(res);
  return (await res.json()) as CanonicalResponse;
}

/** Cap max_tokens at the model's documented output limit (never hardcoded per
 * account — it follows the model's own spec). Leaves the request untouched
 * when no limit is known or the client didn't set max_tokens. */
export function clampMaxTokens(req: CanonicalRequest, candidate: RouteCandidate, providersRepo?: ProvidersRepo): CanonicalRequest {
  if (req.max_tokens == null) return req;
  const cap = providersRepo?.getProviderModel(candidate.provider.id, candidate.modelId)?.max_output_tokens
    ?? metaForModel(candidate.modelId)?.maxOutputTokens;
  if (!cap || req.max_tokens <= cap) return req;
  log.debug("clamping max_tokens to model limit", { provider: candidate.provider.name, model: candidate.modelId, requested: req.max_tokens, cap });
  return { ...req, max_tokens: cap };
}

async function openUpstreamStream(
  req: CanonicalRequest,
  candidate: RouteCandidate,
  apiKey: string,
  base: string,
  format: "openai" | "anthropic",
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null> }> {
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  if (isCodeBuddyProvider(candidate.provider.type)) {
    const forced = withRequiredSystemMessage(req);
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: codeBuddyHeaders(apiKey, "text/event-stream"),
      body: JSON.stringify({ ...forced, model: candidate.modelId, stream: true }),
      signal: combined,
    });
  } else if (format === "anthropic") {
    const body = openaiToAnthropicRequest({ ...req, stream: true }, candidate.modelId);
    res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } else {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: candidate.provider.type === "xai"
        ? xaiHeaders(apiKey, true)
        : {
          "content-type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          accept: "text/event-stream",
        },
      body: JSON.stringify(toOpenAiBody({ ...req, stream: true }, candidate.modelId)),
      signal: combined,
    });
  }
  if (!res.ok) throw await upstreamError(res);
  if (!res.body) throw new GatewayError(502, "server_error", "Upstream returned no stream body");

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  if (format === "anthropic") {
    // translate Anthropic SSE → OpenAI SSE chunks
    const parser = new SseParser();
    const translator = new AnthropicToOpenAIStreamTranslator(req.model);
    let resolveUsage: (u: Usage | null) => void;
    const usagePromise = new Promise<Usage | null>((r) => { resolveUsage = r; });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = res.body!.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const ev of parser.feed(text)) {
              for (const line of translator.handleEvent(ev.event, ev.data)) {
                controller.enqueue(encoder.encode(line));
              }
            }
          }
        } catch (err) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: "upstream stream error", type: "server_error" } })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          void err;
        } finally {
          resolveUsage!(translator.result().usage);
          controller.close();
        }
      },
      cancel() {
        res.body?.cancel().catch(() => undefined);
      },
    });
    return { stream, usagePromise };
  }

  // openai passthrough (model name inside chunks replaced with requested model)
  const parser = new SseParser();
  let usage: Usage | null = null;
  let resolveUsage: (u: Usage | null) => void;
  let rejectUsage: (reason?: unknown) => void;
  const usagePromise = new Promise<Usage | null>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = res.body!.getReader();
      let sentDone = false;
      const forwardEvents = (events: Array<{ event: string; data: string }>) => {
        for (const ev of events) {
          if (ev.data === "[DONE]") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            sentDone = true;
            continue;
          }
          try {
            const obj = JSON.parse(ev.data) as Record<string, unknown>;
            obj.model = req.model;
            const u = obj.usage as Usage | undefined;
            if (u) usage = u;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {
            controller.enqueue(encoder.encode(`data: ${ev.data}\n\n`));
          }
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          forwardEvents(parser.feed(text));
        }
        forwardEvents(parser.feed(decoder.decode()));
        forwardEvents(parser.finish());
      } finally {
        if (sentDone) {
          resolveUsage!(usage);
          controller.close();
        } else {
          const error = new Error("Upstream SSE stream ended before [DONE]");
          rejectUsage!(error);
          controller.error(error);
        }
      }
    },
    cancel() {
      res.body?.cancel().catch(() => undefined);
    },
  });
  return { stream, usagePromise };
}

// ── ChatGPT Codex backend (OAuth accounts) ──

async function callCodex(
  req: CanonicalRequest,
  candidate: RouteCandidate,
  account: RouteCandidate["accounts"][number],
  accessToken: string,
  signal?: AbortSignal,
): Promise<CanonicalResponse> {
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // The Codex backend requires stream=true even for non-streaming callers —
  // stream internally and aggregate the events into one chat completion.
  const res = await fetch(codexUrl("/responses"), {
    method: "POST",
    headers: codexHeaders(account, accessToken, true),
    body: JSON.stringify(codexRequestBody(req, candidate.modelId, true)),
    signal: combined,
  });
  if (!res.ok) throw await upstreamError(res);
  if (!res.body) throw new GatewayError(502, "server_error", "Upstream returned no stream body");
  return aggregateResponsesStream(res.body, req.model);
}

async function openCodexStream(
  req: CanonicalRequest,
  candidate: RouteCandidate,
  account: RouteCandidate["accounts"][number],
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null> }> {
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(codexUrl("/responses"), {
    method: "POST",
    headers: codexHeaders(account, accessToken, true),
    body: JSON.stringify(codexRequestBody(req, candidate.modelId, true)),
    signal: combined,
  });
  if (!res.ok) throw await upstreamError(res);
  if (!res.body) throw new GatewayError(502, "server_error", "Upstream returned no stream body");
  return responsesStreamToChat(res.body, req.model);
}

async function callXai(
  req: CanonicalRequest,
  candidate: RouteCandidate,
  accessToken: string,
  account: ProviderAccount,
  context: ExecutorContext,
): Promise<CanonicalResponse> {
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const xaiContext = xaiRequestContext({ sessionId: context.xaiSessionId, requestId: context.xaiRequestId }, req, candidate.modelId);
  const res = await fetchXaiResponses({
    method: "POST",
    headers: xaiHeaders(accessToken, true, xaiContext, account),
    body: JSON.stringify(xaiRequestBody(req, candidate.modelId)),
    signal: combined,
  }, combined);
  if (!res.ok) throw await upstreamError(res);
  if (!res.body) throw new GatewayError(502, "server_error", "Grok returned no stream body");
  return aggregateXaiResponsesStream(res.body, req.model);
}

async function openXaiStream(
  req: CanonicalRequest,
  candidate: RouteCandidate,
  accessToken: string,
  account: ProviderAccount,
  context: ExecutorContext,
): Promise<{ stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null> }> {
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const xaiContext = xaiRequestContext({ sessionId: context.xaiSessionId, requestId: context.xaiRequestId }, req, candidate.modelId);
  const res = await fetchXaiResponses({
    method: "POST",
    headers: xaiHeaders(accessToken, true, xaiContext, account),
    body: JSON.stringify(xaiRequestBody(req, candidate.modelId)),
    signal: combined,
  }, combined);
  if (!res.ok) throw await upstreamError(res);
  if (!res.body) throw new GatewayError(502, "server_error", "Grok returned no stream body");
  return xaiResponsesStreamToChat(await requireInitialStreamByte(res.body, "Grok"), req.model);
}

async function callXaiChat(
  req: CanonicalRequest,
  candidate: RouteCandidate,
  accessToken: string,
  account: ProviderAccount,
  context: ExecutorContext,
): Promise<CanonicalResponse> {
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const xaiContext = xaiRequestContext({ sessionId: context.xaiSessionId, requestId: context.xaiRequestId }, req, candidate.modelId);
  const res = await fetchXaiChatCompletions({
    method: "POST",
    headers: xaiHeaders(accessToken, true, xaiContext, account),
    body: JSON.stringify(xaiChatCompletionsBody(req, candidate.modelId)),
    signal: combined,
  }, combined);
  if (!res.ok) throw await upstreamError(res);
  if (!res.body) throw new GatewayError(502, "server_error", "Grok Chat Completions returned no stream body");
  return aggregateXaiChatCompletionsStream(res.body, req.model);
}

async function openXaiChatStream(
  req: CanonicalRequest,
  candidate: RouteCandidate,
  accessToken: string,
  account: ProviderAccount,
  context: ExecutorContext,
): Promise<{ stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null> }> {
  const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
  const combined = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const xaiContext = xaiRequestContext({ sessionId: context.xaiSessionId, requestId: context.xaiRequestId }, req, candidate.modelId);
  const res = await fetchXaiChatCompletions({
    method: "POST",
    headers: xaiHeaders(accessToken, true, xaiContext, account),
    body: JSON.stringify(xaiChatCompletionsBody(req, candidate.modelId)),
    signal: combined,
  }, combined);
  if (!res.ok) throw await upstreamError(res);
  if (!res.body) throw new GatewayError(502, "server_error", "Grok Chat Completions returned no stream body");
  return xaiChatCompletionsStreamToChat(await requireInitialStreamByte(res.body, "Grok"), req.model);
}

/**
 * A successful HTTP response does not prove an SSE connection is usable. xAI
 * can abort after the 200 response but before sending any body bytes. Reading
 * one byte here keeps the executor's retry/failover path available. The byte
 * is replayed into the stream without buffering the rest of the response.
 *
 * After the first byte reaches the client the request is never retried, which
 * prevents duplicate assistant output and duplicate tool calls.
 */
export async function requireInitialStreamByte(
  body: ReadableStream<Uint8Array>,
  providerName: string,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  let first: { done: boolean; value?: Uint8Array };
  try {
    first = await reader.read();
  } catch (err) {
    const detail = err instanceof Error ? err.name : "UnknownError";
    throw new GatewayError(502, "server_error", `${providerName} SSE stream aborted before first byte (${detail})`);
  }
  if (first.done || !first.value?.byteLength) {
    throw new GatewayError(502, "server_error", `${providerName} SSE stream ended before first byte`);
  }

  let firstPending = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first.value!);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function upstreamError(res: Response): Promise<GatewayError> {
  let message = `Upstream HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const raw = await res.text();
    if (raw) {
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        const e = data.error as Record<string, unknown> | undefined;
        if (e?.message) message = String(e.message);
        else if (typeof data.message === "string") message = data.message;
        else if (typeof data.detail === "string") message = data.detail;
        else message = raw;
        if (e?.code) code = String(e.code);
      } catch {
        message = raw;
      }
    }
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) message += ` (retry-after: ${retryAfter})`;
  } catch {
    // keep generic message if body can't be read
  }
  const type =
    res.status === 401 || res.status === 403 ? "authentication_error"
    : res.status === 429 ? "rate_limit_error"
    : res.status >= 400 && res.status < 500 ? "invalid_request_error"
    : "server_error";
  return new GatewayError(res.status, type, message, code);
}
