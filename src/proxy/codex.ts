import type { CanonicalRequest, CanonicalResponse, ProviderAccount, Usage } from "../shared/types";
import { GatewayError } from "../shared/errors";
import type { ProvidersRepo } from "../store/repos/providers";
import { SseParser } from "./translator/stream";
import { ulid } from "../utils/id";
import { log } from "../utils/logger";

// ── ChatGPT (Codex) backend support for OAuth-connected accounts ──
//
// OAuth access tokens issued by auth.openai.com are NOT accepted by
// api.openai.com (403). They only work against the ChatGPT backend
// (chatgpt.com/backend-api), which exposes the Responses API used by the
// Codex CLI. This module handles:
//   - access-token refresh (refresh_token grant, same public client as Codex CLI)
//   - Chat Completions → Responses API request translation
//   - Responses API (JSON + SSE) → Chat Completions translation
//   - a static model list (the backend has no /models endpoint)

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const WHAM_BASE = "https://chatgpt.com/backend-api/wham";
const REFRESH_THRESHOLD_MS = 5 * 60_000;

const CODEBUDDY_REFRESH_URLS: Record<string, string> = {
  "codebuddy-global": "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
  "codebuddy-cn": "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
};

export function isOAuthAccount(account: ProviderAccount): boolean {
  return account.auth_kind === "oauth";
}

function isCodeBuddyToken(account: ProviderAccount): boolean {
  return account.api_key.startsWith("eyJ") && !!account.refresh_token;
}

export interface CodeBuddyUsageSnapshot {
  plan: string | null;
  quotas: {
    Credits: {
      used: number;
      total: number;
      remaining: number;
      remainingPercentage: number;
      resetAt: string | null;
    };
  } | null;
}

export async function fetchCodeBuddyUsage(account: ProviderAccount, providerBaseUrl: string): Promise<CodeBuddyUsageSnapshot> {
  const res = await fetch(`${providerBaseUrl}/billing/meter/get-user-resource`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.api_key}`,
      "content-type": "application/json",
      "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
      accept: "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GatewayError(res.status === 401 ? 401 : 502, "server_error", `CodeBuddy usage fetch failed: HTTP ${res.status}`);
  const j = await res.json() as {
    code?: number;
    data?: { Response?: { Data?: { Accounts?: Array<{ CapacitySize?: number; CapacityUsed?: number; CapacityRemain?: number; CycleEndTime?: string; PackageName?: string }> | null } } };
  };
  const accounts = j.data?.Response?.Data?.Accounts;
  if (!accounts || accounts.length === 0) return { plan: null, quotas: null };
  // Aggregate across all quota packages (CN accounts may have multiple)
  let total = 0;
  let used = 0;
  let remaining = 0;
  let latestReset: string | null = null;
  let plan: string | null = null;
  for (const a of accounts) {
    total += a.CapacitySize ?? 0;
    used += a.CapacityUsed ?? 0;
    remaining += a.CapacityRemain ?? Math.max(0, (a.CapacitySize ?? 0) - (a.CapacityUsed ?? 0));
    if (a.CycleEndTime && (!latestReset || a.CycleEndTime > latestReset)) latestReset = a.CycleEndTime;
    if (!plan && a.PackageName) plan = a.PackageName;
  }
  return {
    plan,
    quotas: {
      Credits: {
        used,
        total,
        remaining,
        remainingPercentage: total > 0 ? (remaining / total) * 100 : 0,
        resetAt: latestReset,
      },
    },
  };
}

// ── usage / quota snapshot ──

export interface CodexUsageWindow {
  used_percent: number;
  remaining_percent: number;
  window_seconds: number | null;
  resets_in_seconds: number | null;
  reset_at: number | null;
}

export interface CodexUsageSnapshot {
  plan_type: string | null;
  email: string | null;
  limit_reached: boolean;
  /** Primary rate-limit window (weekly / monthly depending on plan). */
  primary: CodexUsageWindow | null;
  /** Secondary rate-limit window (the shorter 5-hour window when present). */
  secondary: CodexUsageWindow | null;
  banked_resets: { remaining: number | null; total: number | null } | null;
  credits: { has_credits: boolean; unlimited: boolean; balance: number | null } | null;
}

export interface CodexResetResult {
  ok: boolean;
  message: string;
}

function parseUsageWindow(v: unknown): CodexUsageWindow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const used = typeof o.used_percent === "number" ? Math.min(100, Math.max(0, o.used_percent)) : 0;
  return {
    used_percent: used,
    remaining_percent: Math.min(100, Math.max(0, 100 - used)),
    window_seconds: typeof o.limit_window_seconds === "number" ? o.limit_window_seconds : null,
    resets_in_seconds: typeof o.reset_after_seconds === "number" ? o.reset_after_seconds : null,
    reset_at: typeof o.reset_at === "number" ? o.reset_at : null,
  };
}

/** Fetch the ChatGPT/Codex quota snapshot (5-hour + weekly windows) for an OAuth account. */
export async function fetchCodexUsage(account: ProviderAccount, accessToken: string): Promise<CodexUsageSnapshot> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    originator: "codex_cli_rs",
  };
  if (account.account_id) headers["chatgpt-account-id"] = account.account_id;
  const res = await fetch(`${WHAM_BASE}/usage`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new GatewayError(res.status === 401 ? 401 : 502, "server_error", `Usage fetch failed: HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const rl = (j.rate_limit ?? {}) as Record<string, unknown>;
  const banked = (j.banked_resets ?? j.banked_reset ?? null) as Record<string, unknown> | null;
  const credits = (j.credits ?? null) as Record<string, unknown> | null;
  return {
    plan_type: typeof j.plan_type === "string" ? j.plan_type : null,
    email: typeof j.email === "string" ? j.email : null,
    limit_reached: rl.limit_reached === true,
    primary: parseUsageWindow(rl.primary_window),
    secondary: parseUsageWindow(rl.secondary_window),
    banked_resets: banked
      ? {
          remaining: typeof banked.remaining === "number" ? banked.remaining : typeof banked.available === "number" ? banked.available : typeof banked.left === "number" ? banked.left : null,
          total: typeof banked.total === "number" ? banked.total : typeof banked.limit === "number" ? banked.limit : null,
        }
      : null,
    credits: credits
      ? {
          has_credits: credits.has_credits === true,
          unlimited: credits.unlimited === true,
          balance: typeof credits.balance === "number" ? credits.balance : null,
        }
      : null,
  };
}

export async function resetCodexBankedUsage(account: ProviderAccount, accessToken: string): Promise<CodexResetResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    originator: "codex_cli_rs",
    "content-type": "application/json",
  };
  if (account.account_id) headers["chatgpt-account-id"] = account.account_id;
  const res = await fetch(`${WHAM_BASE}/banked-reset`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  let message = raw || (res.ok ? "Banked reset requested" : `HTTP ${res.status}`);
  try {
    const j = JSON.parse(raw) as { message?: string; detail?: string; error?: { message?: string } };
    message = j.message ?? j.detail ?? j.error?.message ?? message;
  } catch {
    // keep text fallback
  }
  if (!res.ok) {
    throw new GatewayError(res.status === 401 ? 401 : 502, res.status === 401 ? "authentication_error" : "server_error", `Banked reset failed: ${message}`);
  }
  return { ok: true, message };
}

// Fallback model list, used only when the live catalog fetch fails. The
// authoritative list comes from the Codex backend /models catalog (same
// endpoint the Codex CLI uses), which is version-gated via client_version.
export const CODEX_MODELS: Array<{ id: string; contextLength: number; maxOutputTokens: number; capabilities: string[] }> = [
  { id: "gpt-5.5", contextLength: 272_000, maxOutputTokens: 128_000, capabilities: ["reasoning", "tools", "json", "vision"] },
  { id: "gpt-5.4-mini", contextLength: 272_000, maxOutputTokens: 128_000, capabilities: ["reasoning", "tools", "json", "vision"] },
];

// Client version sent to the catalog endpoint — the catalog is gated on
// minimal_client_version, so an older version returns fewer models.
const CODEX_CLIENT_VERSION = "1.0.0";

interface CodexCatalogModel {
  slug?: string;
  visibility?: string;
  supported_in_api?: boolean;
  context_window?: number;
  input_modalities?: string[];
  supported_reasoning_levels?: Array<{ effort?: string }>;
}

/**
 * Fetch the live Codex model catalog for a ChatGPT account
 * (GET {codex}/models?client_version=…, same as the Codex CLI). Falls back to
 * the static CODEX_MODELS list when the endpoint is unreachable.
 */
export async function fetchCodexModels(account: ProviderAccount, accessToken: string): Promise<Array<{ id: string; contextLength: number; maxOutputTokens: number; capabilities: string[] }>> {
  try {
    const res = await fetch(`${CODEX_BASE}/models?client_version=${CODEX_CLIENT_VERSION}`, {
      headers: codexHeaders(account, accessToken, false),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: CodexCatalogModel[] };
    const out: Array<{ id: string; contextLength: number; maxOutputTokens: number; capabilities: string[] }> = [];
    for (const m of data.models ?? []) {
      if (!m.slug || m.visibility === "hide") continue;
      const caps = new Set<string>(["tools", "json"]);
      if ((m.supported_reasoning_levels ?? []).length) caps.add("reasoning");
      if ((m.input_modalities ?? []).includes("image")) caps.add("vision");
      out.push({
        id: m.slug,
        contextLength: m.context_window ?? 272_000,
        maxOutputTokens: 128_000,
        capabilities: [...caps],
      });
    }
    return out.length ? out : CODEX_MODELS;
  } catch (err) {
    log.warn("codex model catalog fetch failed, using static list", { err: err instanceof Error ? err.message : String(err) });
    return CODEX_MODELS;
  }
}

// ── token refresh ──

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Returns a valid access token for an OAuth account, refreshing it via the
 * refresh_token grant when it is expired (or about to expire). Persists the
 * new tokens back to the DB. Throws GatewayError(401) when the refresh fails
 * (e.g. the user revoked access).
 */
export async function ensureFreshToken(repo: ProvidersRepo, account: ProviderAccount): Promise<string> {
  if (isCodeBuddyToken(account)) {
    const provider = repo.get(account.provider_id);
    const refreshUrl = provider ? CODEBUDDY_REFRESH_URLS[provider.type] : undefined;
    const expiresAt = account.expires_at ?? null;
    if (!refreshUrl || (expiresAt && expiresAt - Date.now() > REFRESH_THRESHOLD_MS)) return account.api_key;
    const res = await fetch(refreshUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: account.refresh_token }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json() as { code?: number; data?: { accessToken?: string; refreshToken?: string; expiresIn?: number }; msg?: string };
    if (!res.ok || data.code !== 0 || !data.data?.accessToken) {
      throw new GatewayError(401, "authentication_error", `CodeBuddy token refresh failed: ${data.msg ?? `HTTP ${res.status}`} — reconnect the account.`);
    }
    const newExpiresAt = data.data.expiresIn ? Date.now() + data.data.expiresIn * 1000 : null;
    repo.updateAccountOAuth(account.id, {
      refreshToken: data.data.refreshToken ?? account.refresh_token,
      expiresAt: newExpiresAt,
    });
    repo.updateAccount(account.id, { apiKey: data.data.accessToken });
    account.api_key = data.data.accessToken;
    account.refresh_token = data.data.refreshToken ?? account.refresh_token;
    account.expires_at = newExpiresAt;
    return data.data.accessToken;
  }

  const expiresAt = account.expires_at ?? null;
  if (expiresAt && expiresAt - Date.now() > REFRESH_THRESHOLD_MS) return account.api_key;
  if (!account.refresh_token) {
    if (expiresAt && expiresAt > Date.now()) return account.api_key;
    throw new GatewayError(401, "authentication_error", "ChatGPT login has expired and no refresh token is stored — reconnect the account.");
  }

  let data: RefreshResponse;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: account.refresh_token,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    data = (await res.json()) as RefreshResponse;
    if (!res.ok) {
      log.warn("oauth token refresh failed", { status: res.status, err: data.error });
      throw new GatewayError(401, "authentication_error", `ChatGPT token refresh failed: ${data.error_description ?? data.error ?? `HTTP ${res.status}`} — reconnect the account.`);
    }
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError(502, "server_error", `Token refresh request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!data.access_token) {
    throw new GatewayError(401, "authentication_error", "Token refresh response did not include an access token — reconnect the account.");
  }

  const newExpiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : null;
  repo.updateAccountOAuth(account.id, {
    refreshToken: data.refresh_token ?? account.refresh_token,
    expiresAt: newExpiresAt,
  });
  // updateAccountOAuth does not touch api_key — store the new access token there.
  repo.updateAccount(account.id, { apiKey: data.access_token });
  account.api_key = data.access_token;
  account.refresh_token = data.refresh_token ?? account.refresh_token;
  account.expires_at = newExpiresAt;
  log.info("oauth access token refreshed", { account: account.label });
  return data.access_token;
}

// ── request translation: Chat Completions → Responses API ──

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        const o = c as Record<string, unknown>;
        if (o.type === "text" && typeof o.text === "string") return o.text;
        if (typeof o.content === "string") return o.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function codexRequestBody(req: CanonicalRequest, modelId: string, stream: boolean): Record<string, unknown> {
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      const t = textOf(m.content);
      if (t) instructions.push(t);
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? "",
        output: textOf(m.content),
      });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const contentType = role === "assistant" ? "output_text" : "input_text";
    const content: Array<Record<string, unknown>> = [];
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        const o = c as Record<string, unknown>;
        if (typeof c === "string") content.push({ type: contentType, text: c });
        else if (o.type === "text" && typeof o.text === "string") content.push({ type: contentType, text: o.text });
        else if (o.type === "image_url" && role === "user") {
          const url = (o.image_url as Record<string, unknown> | undefined)?.url;
          if (typeof url === "string") content.push({ type: "input_image", image_url: url });
        }
      }
    } else {
      content.push({ type: contentType, text: textOf(m.content) });
    }
    const item: Record<string, unknown> = { type: "message", role, content };
    if (role === "assistant" && m.tool_calls?.length) {
      input.push(item);
      for (const tc of m.tool_calls) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
      continue;
    }
    input.push(item);
  }

  const body: Record<string, unknown> = {
    model: modelId,
    input,
    store: false,
    stream,
  };
  if (instructions.length) body.instructions = instructions.join("\n\n");
  // NOTE: the ChatGPT Codex backend rejects max_output_tokens ("Unsupported
  // parameter") — output length is server-managed for ChatGPT-account calls.
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters ?? { type: "object", properties: {} },
    }));
    if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  }
  return body;
}

export function codexHeaders(account: ProviderAccount, accessToken: string, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    originator: "codex_cli_rs",
  };
  if (account.account_id) headers["chatgpt-account-id"] = account.account_id;
  if (stream) headers.accept = "text/event-stream";
  return headers;
}

export function codexUrl(path: string): string {
  return `${CODEX_BASE}${path}`;
}

// ── response translation: Responses API → Chat Completions ──

interface ResponsesApiResponse {
  id?: string;
  model?: string;
  status?: string;
  output?: Array<Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export function responsesApiToChatCompletion(data: ResponsesApiResponse, requestedModel: string): CanonicalResponse {
  let text = "";
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const c of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
        if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string") text += c.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: (item.call_id ?? item.id ?? `call_${ulid()}`) as string,
        type: "function",
        function: { name: (item.name ?? "") as string, arguments: (item.arguments ?? "") as string },
      });
    }
  }

  const message: CanonicalResponse["choices"][number]["message"] = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage: Usage | undefined = data.usage
    ? {
        prompt_tokens: data.usage.input_tokens ?? 0,
        completion_tokens: data.usage.output_tokens ?? 0,
        total_tokens: data.usage.total_tokens ?? (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      }
    : undefined;

  return {
    id: `chatcmpl-${data.id ?? ulid()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    ...(usage ? { usage } : {}),
  };
}

// ── streaming: Responses API SSE → OpenAI chat.completion.chunk SSE ──

export class ResponsesToChatStreamTranslator {
  private id = `chatcmpl-${ulid()}`;
  private created = Math.floor(Date.now() / 1000);
  private model: string;
  private started = false;
  private usage: Usage | null = null;
  private sawToolCall = false;

  constructor(requestedModel: string) {
    this.model = requestedModel;
  }

  /** Returns SSE lines (`data: ...\n\n`) to emit for one upstream event. */
  handleEvent(event: string, data: string): string[] {
    const out: string[] = [];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return out;
    }
    const type = (parsed.type as string | undefined) ?? event;

    const startChunk = (): string => {
      this.started = true;
      return this.chunk({ role: "assistant", content: "" }, null);
    };

    switch (type) {
      case "response.created": {
        const r = parsed.response as Record<string, unknown> | undefined;
        if (r?.id) this.id = `chatcmpl-${r.id as string}`;
        if (!this.started) out.push(startChunk());
        break;
      }
      case "response.output_item.added": {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          this.sawToolCall = true;
          if (!this.started) out.push(startChunk());
          out.push(
            this.chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: (item.call_id ?? item.id ?? `call_${ulid()}`) as string,
                    type: "function",
                    function: { name: (item.name ?? "") as string, arguments: "" },
                  },
                ],
              },
              null,
            ),
          );
        }
        break;
      }
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const delta = parsed.delta as string | undefined;
        if (delta) {
          if (!this.started) out.push(startChunk());
          out.push(this.chunk({ content: delta }, null));
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const delta = parsed.delta as string | undefined;
        if (delta) {
          if (!this.started) out.push(startChunk());
          out.push(this.chunk({ tool_calls: [{ index: 0, function: { arguments: delta } }] }, null));
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const r = parsed.response as ResponsesApiResponse | undefined;
        if (r?.usage) {
          this.usage = {
            prompt_tokens: r.usage.input_tokens ?? 0,
            completion_tokens: r.usage.output_tokens ?? 0,
            total_tokens: r.usage.total_tokens ?? (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0),
          };
        }
        if (!this.started) out.push(startChunk());
        out.push(this.chunk({}, this.sawToolCall ? "tool_calls" : "stop"));
        out.push("data: [DONE]\n\n");
        break;
      }
      case "error": {
        const msg = (parsed.error as Record<string, unknown> | undefined)?.message ?? parsed.message ?? "upstream stream error";
        out.push(`data: ${JSON.stringify({ error: { message: msg, type: "server_error" } })}\n\n`);
        out.push("data: [DONE]\n\n");
        break;
      }
      default:
        break;
    }
    return out;
  }

  result(): { usage: Usage | null } {
    return { usage: this.usage };
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null): string {
    const obj = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return `data: ${JSON.stringify(obj)}\n\n`;
  }
}

/**
 * Aggregate a standard OpenAI Chat Completions SSE stream (as returned by
 * CodeBuddy and most OpenAI-compatible providers) into a single
 * chat.completion response object. Used for non-streaming requests that are
 * internally streamed because the upstream requires stream=true.
 */
export async function aggregateChatCompletionsStream(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
): Promise<CanonicalResponse> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | null = null;
  let usage: Usage | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const ev of parser.feed(chunk)) {
        if (ev.data === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
        if (choice) {
          const delta = choice.delta as Record<string, unknown> | undefined;
          if (delta) {
            if (typeof delta.content === "string") text += delta.content;
            if (typeof delta.reasoning_content === "string") text += delta.reasoning_content;
            const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
            if (tcs) {
              for (const tc of tcs) {
                const idx = (tc.index as number | undefined) ?? toolCalls.size;
                const existing = toolCalls.get(idx);
                if (existing) {
                  if (typeof tc.arguments === "string") existing.arguments += tc.arguments;
                } else {
                  toolCalls.set(idx, {
                    id: (tc.id as string | undefined) ?? `call_${ulid()}`,
                    name: ((tc.function as Record<string, unknown> | undefined)?.name as string | undefined) ?? "",
                    arguments: (tc.arguments as string | undefined) ?? "",
                  });
                }
              }
            }
          }
          if (choice.finish_reason && typeof choice.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }
        }
        const u = parsed.usage as Usage | undefined;
        if (u) usage = u;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const message: CanonicalResponse["choices"][number]["message"] = { role: "assistant", content: text || "" };
  if (toolCalls.size) {
    message.tool_calls = [...[...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)].map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id: `chatcmpl-${ulid()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * The ChatGPT Codex backend requires stream=true, so non-streaming callers
 * stream internally and aggregate the SSE events into one chat completion.
 */
export async function aggregateResponsesStream(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
): Promise<CanonicalResponse> {
  const parser = new SseParser();
  const translator = new ResponsesToChatStreamTranslator(requestedModel);
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const ev of parser.feed(chunk)) {
        if (ev.data === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = (parsed.type as string | undefined) ?? ev.event;
        if (type === "response.output_text.delta" || type === "response.refusal.delta") {
          text += (parsed.delta as string | undefined) ?? "";
        } else if (type === "response.output_item.added") {
          const item = parsed.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            toolCalls.set(toolCalls.size, {
              id: (item.call_id ?? item.id ?? `call_${ulid()}`) as string,
              name: (item.name ?? "") as string,
              arguments: "",
            });
          }
        } else if (type === "response.function_call_arguments.delta") {
          const idx = (parsed.output_index as number | undefined) ?? toolCalls.size - 1;
          const tc = toolCalls.get(Math.max(0, idx)) ?? toolCalls.get(toolCalls.size - 1);
          if (tc) tc.arguments += (parsed.delta as string | undefined) ?? "";
        } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
          finishReason = toolCalls.size ? "tool_calls" : "stop";
        }
        // feed the translator too so usage is captured
        translator.handleEvent(ev.event, ev.data);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const usage = translator.result().usage;
  const message: CanonicalResponse["choices"][number]["message"] = { role: "assistant", content: text };
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.values()].map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id: `chatcmpl-${ulid()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    ...(usage ? { usage } : {}),
  };
}

/** Wrap a Responses API SSE body as an OpenAI chat.completion.chunk stream. */
export function responsesStreamToChat(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
): { stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null> } {
  const parser = new SseParser();
  const translator = new ResponsesToChatStreamTranslator(requestedModel);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let resolveUsage: (u: Usage | null) => void;
  const usagePromise = new Promise<Usage | null>((r) => { resolveUsage = r; });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const ev of parser.feed(text)) {
            if (ev.data === "[DONE]") continue;
            for (const line of translator.handleEvent(ev.event, ev.data)) {
              controller.enqueue(encoder.encode(line));
            }
          }
        }
      } catch (err) {
        void err;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: "upstream stream error", type: "server_error" } })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        resolveUsage!(translator.result().usage);
        controller.close();
      }
    },
    cancel() {
      body.cancel().catch(() => undefined);
    },
  });
  return { stream, usagePromise };
}
