import type { CanonicalRequest, CanonicalResponse, ProviderAccount, Usage } from "../shared/types";
import { GatewayError } from "../shared/errors";
import { config } from "../config";
import type { ProvidersRepo } from "../store/repos/providers";
import { SseParser } from "./translator/stream";
import { isPermanentRefreshFailure, markReauthRequired, withRefreshLock } from "./refresh";
import { normalizeUsage } from "./promptCache";
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

/** Headers used by the CodeBuddy CLI for API calls. */
function codeBuddyHeaders(account: ProviderAccount): Record<string, string> {
  return {
    Authorization: `Bearer ${account.api_key}`,
    "content-type": "application/json",
    "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    accept: "application/json",
  };
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

// ── daily check-in ──

export interface CheckinResult {
  ok: boolean;
  message: string;
  quotaTotal: number | null;
}

/**
 * Attempt the daily check-in for a CodeBuddy CN account.
 * The /activity/* area is gated by the APISIX web gateway and normally
 * requires a browser session cookie. We try the API token first (some
 * gateways accept it), then the stored session cookie when present.
 */
export async function attemptCodeBuddyCheckin(
  account: ProviderAccount,
  providerBaseUrl?: string | null,
): Promise<CheckinResult> {
  const base = (providerBaseUrl?.trim() || "https://copilot.tencent.com/v2").replace(/\/+$/, "");
  const url = `${base}/activity/check-in`;

  const safeUsage = async (): Promise<number | null> => {
    try {
      const snap = await fetchCodeBuddyUsage(account, base);
      return snap.quotas?.Credits?.total ?? null;
    } catch {
      return null;
    }
  };

  const beforeTotal = await safeUsage();

  const attempts: Record<string, string>[] = [
    codeBuddyHeaders(account),
  ];
  if (account.session_cookie) {
    attempts.push({
      ...codeBuddyHeaders(account),
      cookie: account.session_cookie.includes("=")
        ? account.session_cookie
        : `session=${account.session_cookie}`,
    });
  }

  let lastStatus = 0;
  for (const headers of attempts) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      continue;
    }
    lastStatus = res.status;
    const text = await res.text().catch(() => "");
    if (text.trimStart().startsWith("<")) continue; // APISIX HTML rejection
    if (!res.ok) continue;

    let parsed: { code?: unknown; msg?: unknown } | null = null;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null) parsed = value as { code?: unknown; msg?: unknown };
    } catch { /* non-JSON body */ }
    if (parsed && typeof parsed.code === "number" && parsed.code !== 0) {
      const msg = typeof parsed.msg === "string" ? parsed.msg : "check-in rejected";
      if (/already|重复|已|signed/i.test(msg)) {
        return { ok: true, message: "Already checked in today", quotaTotal: beforeTotal };
      }
      return { ok: false, message: msg, quotaTotal: beforeTotal };
    }

    // Verify by re-fetching the quota — a total increase confirms credit.
    const afterTotal = await safeUsage();
    if (beforeTotal !== null && afterTotal !== null && afterTotal > beforeTotal) {
      return { ok: true, message: `Checked in — quota +${afterTotal - beforeTotal} credits`, quotaTotal: afterTotal };
    }
    if (parsed) {
      const msg = typeof parsed.msg === "string" && parsed.msg ? parsed.msg : "check-in response received";
      return { ok: true, message: /already|重复|已|signed/i.test(msg) ? "Already checked in today" : msg, quotaTotal: afterTotal };
    }
    return { ok: true, message: "Check-in request accepted", quotaTotal: afterTotal };
  }

  if (lastStatus === 401 || lastStatus === 403) {
    return {
      ok: false,
      message: "Check-in needs a web session cookie — paste it in the account's edit dialog (session cookie field), or check in via the CodeBuddy website.",
      quotaTotal: beforeTotal,
    };
  }
  return { ok: false, message: `Check-in failed (HTTP ${lastStatus || "network error"})`, quotaTotal: beforeTotal };
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

type CodexPlanRequirement = "plus" | "pro" | null;

/** Minimum ChatGPT plan needed by Codex-only models with paid access gates. */
export function codexPlanRequirement(modelId: string): CodexPlanRequirement {
  const id = modelId.toLowerCase();
  if (/^gpt-5\.3-codex-spark(?:$|-)/.test(id)) return "pro";
  if (/^gpt-5\.6-sol(?:$|-)/.test(id)) return "plus";
  return null;
}

/** Whether a persisted ChatGPT plan satisfies a Codex model's access gate. */
export function codexPlanAllowsModel(planType: string | null | undefined, modelId: string): boolean {
  const requirement = codexPlanRequirement(modelId);
  if (!requirement) return true;
  const plan = planType?.trim().toLowerCase() ?? "";
  if (requirement === "plus") return /plus|pro|business|team|enterprise|edu/.test(plan);
  return /pro|business|team|enterprise|edu/.test(plan);
}

export interface CodexResetResult {
  ok: boolean;
  message: string;
}

/**
 * The usage endpoint does not consistently set `limit_reached` when a rate
 * limit window is exactly full. Treat either a primary or secondary window at
 * 100% as exhausted so warmups never advertise an unusable account as healthy.
 */
export function isCodexQuotaExhausted(usage: CodexUsageSnapshot): boolean {
  return usage.limit_reached || [usage.primary, usage.secondary].some((window) =>
    window !== null && window.used_percent >= 100,
  );
}

/** Human-readable quota state for warmup logs and the account status tooltip. */
export function codexQuotaDetail(usage: CodexUsageSnapshot): string {
  if (usage.limit_reached) return "Codex quota exhausted";
  if ((usage.secondary?.used_percent ?? 0) >= 100) return "Codex quota exhausted (short window at 100%)";
  if ((usage.primary?.used_percent ?? 0) >= 100) return "Codex quota exhausted (primary window at 100%)";
  return "ChatGPT login active";
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
    const res = await fetch(`${CODEX_BASE}/models?client_version=${config.codexClientVersion}`, {
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
    return withRefreshLock(account.id, async () => {
      const res = await fetch(refreshUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: account.refresh_token }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json() as { code?: number; data?: { accessToken?: string; refreshToken?: string; expiresIn?: number }; msg?: string };
      if (!res.ok || data.code !== 0 || !data.data?.accessToken) {
        const detail = data.msg ?? `HTTP ${res.status}`;
        if (isPermanentRefreshFailure(res.status, detail)) {
          throw markReauthRequired(repo, account, `CodeBuddy token refresh failed: ${detail}.`);
        }
        throw new GatewayError(502, "server_error", `CodeBuddy token refresh failed: ${detail}`);
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
    });
  }

  const expiresAt = account.expires_at ?? null;
  if (expiresAt && expiresAt - Date.now() > REFRESH_THRESHOLD_MS) return account.api_key;
  if (!account.refresh_token) {
    if (expiresAt && expiresAt > Date.now()) return account.api_key;
    throw markReauthRequired(repo, account, "ChatGPT login has expired and no refresh token is stored.");
  }

  return withRefreshLock(account.id, async () => {
    let data: RefreshResponse;
    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: account.refresh_token!,
        }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
      data = (await res.json()) as RefreshResponse;
      if (!res.ok) {
        const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
        log.warn("oauth token refresh failed", { status: res.status, err: data.error });
        if (isPermanentRefreshFailure(res.status, `${data.error ?? ""} ${data.error_description ?? ""}`)) {
          throw markReauthRequired(repo, account, `ChatGPT token refresh failed: ${detail}.`);
        }
        throw new GatewayError(502, "server_error", `ChatGPT token refresh failed: ${detail}`);
      }
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(502, "server_error", `Token refresh request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!data.access_token) {
      throw markReauthRequired(repo, account, "Token refresh response did not include an access token.");
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
  });
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
  // NOTE: the ChatGPT Codex backend rejects max_output_tokens, temperature,
  // and top_p — output length and sampling are server-managed for
  // ChatGPT-account calls.
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters ?? { type: "object", properties: {} },
    }));
    if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  }
  // Universal reasoning → Codex Responses API `reasoning.effort`.
  if (req.reasoning?.enabled !== false && req.reasoning?.effort) {
    body.reasoning = { effort: req.reasoning.effort };
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

/** Visible assistant text carried by a Responses API `output` array. */
export function responsesOutputText(output?: Array<Record<string, unknown>>): string {
  let text = "";
  for (const item of output ?? []) {
    if (item.type !== "message") continue;
    for (const c of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
      if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string") text += c.text;
    }
  }
  return text;
}

export function responsesApiToChatCompletion(data: ResponsesApiResponse, requestedModel: string): CanonicalResponse {
  const text = responsesOutputText(data.output);
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

  for (const item of data.output ?? []) {
    if (item.type === "function_call") {
      toolCalls.push({
        id: (item.call_id ?? item.id ?? `call_${ulid()}`) as string,
        type: "function",
        function: { name: (item.name ?? "") as string, arguments: (item.arguments ?? "") as string },
      });
    }
  }

  const message: CanonicalResponse["choices"][number]["message"] = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage: Usage | undefined = normalizeUsage(data.usage) ?? undefined;

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
  private sawText = false;
  private nextToolCallIndex = 0;
  private toolCallIndices = new Map<string, number>();

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
          const index = this.nextToolCallIndex++;
          const callId = (item.call_id ?? item.id ?? `call_${ulid()}`) as string;
          if (typeof item.id === "string") this.toolCallIndices.set(item.id, index);
          if (typeof item.call_id === "string") this.toolCallIndices.set(item.call_id, index);
          out.push(
            this.chunk(
              {
                tool_calls: [
                  {
                    index,
                    id: callId,
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
          this.sawText = true;
          out.push(this.chunk({ content: delta }, null));
        }
        break;
      }
      // Reasoning models (gpt-5.x) stream their thinking on a separate channel.
      // Keep it out of `content` so it never contaminates the answer.
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const delta = parsed.delta as string | undefined;
        if (delta) {
          if (!this.started) out.push(startChunk());
          out.push(this.chunk({ reasoning_content: delta }, null));
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const delta = parsed.delta as string | undefined;
        if (delta) {
          if (!this.started) out.push(startChunk());
          const itemId = typeof parsed.item_id === "string" ? parsed.item_id : "";
          const callId = typeof parsed.call_id === "string" ? parsed.call_id : "";
          const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : 0;
          const index = this.toolCallIndices.get(itemId) ?? this.toolCallIndices.get(callId) ?? outputIndex;
          out.push(this.chunk({ tool_calls: [{ index, function: { arguments: delta } }] }, null));
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const r = parsed.response as ResponsesApiResponse | undefined;
        if (r?.usage) this.usage = normalizeUsage(r.usage);
        if (!this.started) out.push(startChunk());
        // Some models put the whole answer in the final response object instead
        // of streaming text deltas — emit it so the client is not left empty.
        if (!this.sawText && !this.sawToolCall) {
          const text = responsesOutputText(r?.output);
          if (text) {
            this.sawText = true;
            out.push(this.chunk({ content: text }, null));
          }
        }
        const finish = this.sawToolCall ? "tool_calls" : type === "response.incomplete" ? "length" : "stop";
        out.push(this.chunk({}, finish));
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

  /** True when the stream carried visible content or a tool call. */
  producedOutput(): boolean {
    return this.sawText || this.sawToolCall;
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
        const u = normalizeUsage(parsed.usage);
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
  let reasoning = "";
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
        const failure = responsesStreamError(ev.event, ev.data);
        if (failure) throw new GatewayError(503, "server_error", failure);
        if (type === "response.output_text.delta" || type === "response.refusal.delta") {
          text += (parsed.delta as string | undefined) ?? "";
        } else if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
          reasoning += (parsed.delta as string | undefined) ?? "";
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
          if (!text) text = responsesOutputText((parsed.response as ResponsesApiResponse | undefined)?.output);
          finishReason = toolCalls.size ? "tool_calls" : type === "response.incomplete" ? "length" : "stop";
        }
        // feed the translator too so usage is captured
        translator.handleEvent(ev.event, ev.data);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const usage = translator.result().usage;
  // Reasoning-only responses would otherwise arrive empty for non-streaming
  // clients, so fall back to the thinking text when there is nothing else.
  const content = text || (toolCalls.size ? "" : reasoning);
  const message: CanonicalResponse["choices"][number]["message"] = { role: "assistant", content };
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

/** Events that prove the upstream response produced real output. */
const OPENING_EVENTS = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
  "response.output_item.added",
  "response.function_call_arguments.delta",
  "response.completed",
  "response.incomplete",
]);

function eventType(event: string, data: string): string {
  try {
    return (JSON.parse(data) as { type?: string }).type ?? event;
  } catch {
    return event;
  }
}

/** Error message carried by an upstream SSE event, if it is a failure event. */
export function responsesStreamError(event: string, data: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = (parsed.type as string | undefined) ?? event;
  const err = parsed.error as Record<string, unknown> | undefined;
  // Some upstreams emit a bare `{"error":{...}}` event with no `type` field.
  if (type === "error" || (err && !type.startsWith("response."))) {
    return String(err?.message ?? parsed.message ?? "upstream stream error");
  }
  if (type === "response.failed") {
    const r = parsed.response as Record<string, unknown> | undefined;
    const rErr = r?.error as Record<string, unknown> | undefined;
    return String(rErr?.message ?? err?.message ?? "upstream response failed");
  }
  return null;
}

/**
 * Wrap a Responses API SSE body as an OpenAI chat.completion.chunk stream.
 *
 * `ready` rejects when the upstream fails before emitting any content (e.g.
 * "Our servers are currently overloaded"), so the executor can fail over to
 * another account instead of handing the client an empty assistant message.
 */
export function responsesStreamToChat(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
): { stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null>; ready: Promise<void> } {
  const parser = new SseParser();
  const translator = new ResponsesToChatStreamTranslator(requestedModel);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let resolveUsage: (u: Usage | null) => void;
  const usagePromise = new Promise<Usage | null>((r) => { resolveUsage = r; });
  let openStream: () => void;
  let failStream: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { openStream = resolve; failStream = reject; });
  let opened = false;
  const seenEvents: string[] = [];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      // Hold back the leading chunks until the response proves viable.
      const pending: string[] = [];
      const flush = () => {
        opened = true;
        for (const line of pending) controller.enqueue(encoder.encode(line));
        pending.length = 0;
        openStream();
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const ev of parser.feed(text)) {
            if (ev.data === "[DONE]") continue;
            if (!opened) {
              const message = responsesStreamError(ev.event, ev.data);
              if (message) {
                failStream(new GatewayError(503, "server_error", message));
                await reader.cancel().catch(() => undefined);
                return;
              }
            }
            const type = eventType(ev.event, ev.data);
            if (seenEvents.length < 40) seenEvents.push(type);
            const lines = translator.handleEvent(ev.event, ev.data);
            if (opened) {
              for (const line of lines) controller.enqueue(encoder.encode(line));
              continue;
            }
            pending.push(...lines);
            if (OPENING_EVENTS.has(type)) flush();
          }
        }
        if (!opened) {
          failStream(new GatewayError(502, "server_error", "Upstream stream ended before any content"));
        } else if (!translator.producedOutput()) {
          // Empty assistant turn — record which upstream events arrived so the
          // unmapped event type can be identified without a payload dump.
          log.warn("codex stream produced no content", { model: requestedModel, events: seenEvents.join(",") });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.name : "UnknownError";
        if (!opened) {
          failStream(new GatewayError(502, "server_error", `Upstream stream error (${detail})`));
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: `upstream stream error (${detail})`, type: "server_error" } })}\n\n`));
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
  return { stream, usagePromise, ready };
}
