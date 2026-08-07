// Typed API client for the Mirais admin API.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string | { message?: string } };
      if (typeof body.error === "string") message = body.error;
      else if (body.error?.message) message = body.error.message;
    } catch {
      /* keep default */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── types ──

export interface Provider {
  id: string;
  name: string;
  type: string;
  base_url: string | null;
  base_url_effective?: string;
  enabled: number;
  priority: number;
  created_at: string;
  updated_at: string;
  accounts?: ProviderAccount[];
  models?: ProviderModel[];
}

export interface ProviderAccount {
  id: string;
  provider_id: string;
  label: string;
  api_key: string;
  enabled: number;
  priority: number;
  created_at: string;
  updated_at: string;
  auth_kind?: string;
  account_id?: string | null;
  notes?: string | null;
  tags?: string | null;
  last_warmup_at?: string | null;
  last_warmup_status?: string | null;
  last_warmup_latency_ms?: number | null;
  last_warmup_detail?: string | null;
}

export interface ProviderModel {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string | null;
  enabled: number;
  context_length: number | null;
  max_output_tokens: number | null;
  capabilities: string | null;
}

export interface Alias {
  id: string;
  alias: string;
  target: string;
  created_at: string;
}

export interface ComboEntry {
  id: string;
  combo_id: string;
  position: number;
  target: string;
}

export interface Combo {
  id: string;
  name: string;
  strategy: string;
  created_at: string;
  updated_at: string;
  entries: ComboEntry[];
}

export interface GatewayKey {
  id: string;
  label: string;
  key_prefix: string;
  enabled: number;
  allowed_models: string | null;
  rate_limit_rpm: number | null;
  concurrency: number | null;
  daily_token_budget: number | null;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface RequestLog {
  id: string;
  ts: string;
  key_id: string | null;
  endpoint: string;
  requested_model: string;
  provider: string | null;
  model: string | null;
  account_label: string | null;
  attempts: number;
  status: string;
  http_status: number | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  credit_usage: number | null;
  latency_ms: number | null;
  tokens_saved: number | null;
  request_body?: string | null;
  response_body?: string | null;
  kind?: string;
}

export interface UsageRow {
  provider: string | null;
  model: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  avg_latency_ms: number;
  errors: number;
  last_ts: string;
}

export interface StatsSummary {
  range_days: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  tokens_saved: number;
  avg_latency_ms: number;
  success_rate: number;
}

export interface TimeseriesPoint {
  day: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  tokens_saved: number;
}

export interface TokenSaverSettings {
  enabled: boolean;
  rules: { gitDiff: boolean; grep: boolean; ls: boolean; longOutputMaxLines: number };
}

export interface Settings {
  token_saver: TokenSaverSettings | null;
  terse_mode: unknown;
  log_retention_days: number;
  session_remember_default: boolean;
  network_binding?: { exposed: boolean; host: "0.0.0.0" | "127.0.0.1" };
  model_sync_mode: "curated" | "all";
  warmup_config?: { enabled: boolean; interval_minutes: number } | null;
  ui: { theme?: string; accent?: string } | null;
  env: { port: number; host: string; track_payloads: string; upstream_timeout_ms: number };
}

// ── providers ──
export const providers = {
  list: () => req<Provider[]>("/api/providers"),
  create: (input: { name: string; type: string; baseUrl?: string; priority?: number }) =>
    req<Provider>("/api/providers", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, patch: Partial<{ name: string; baseUrl: string | null; enabled: boolean; priority: number }>) =>
    req<Provider>(`/api/providers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => req<{ ok: boolean }>(`/api/providers/${id}`, { method: "DELETE" }),
  addAccount: (id: string, input: { label: string; apiKey: string; priority?: number }) =>
    req<ProviderAccount>(`/api/providers/${id}/accounts`, { method: "POST", body: JSON.stringify(input) }),
  addAccountsBulk: (id: string, apiKeys: string[], labelPrefix?: string) =>
    req<{ added: number; skipped: number }>(`/api/providers/${id}/accounts/bulk`, { method: "POST", body: JSON.stringify({ apiKeys, labelPrefix }) }),
  accountUsage: (id: string) =>
    req<Array<{ account: string; requests_today: number; tokens_today: number; requests_total: number; tokens_total: number }>>(
      `/api/providers/${id}/accounts/usage`),
  codexQuota: (accId: string) => req<CodexQuota>(`/api/providers/accounts/${accId}/codex-quota`),
  codexQuotaReset: (accId: string) => req<{ ok: boolean; message: string }>(`/api/providers/accounts/${accId}/codex-quota/reset`, { method: "POST" }),
  oauthStart: (providerId: string) =>
    req<{ url: string; state: string }>("/api/oauth/openai/start", { method: "POST", body: JSON.stringify({ providerId }) }),
  oauthRedirectUrl: (url: string) => `/api/oauth/openai/redirect?url=${encodeURIComponent(url)}`,
  oauthStatus: (state: string) =>
    req<{ done: boolean; ok?: boolean; message?: string }>(`/api/oauth/openai/status?state=${encodeURIComponent(state)}`),
  oauthSubmitCallback: (url: string) =>
    req<{ ok: boolean }>("/api/oauth/openai/callback", { method: "POST", body: JSON.stringify({ url }) }),
  updateAccount: (accId: string, patch: Partial<{ label: string; apiKey: string; priority: number; enabled: boolean; notes: string | null; tags: string | null }>) =>
    req<ProviderAccount>(`/api/providers/accounts/${accId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeAccount: (accId: string) => req<{ ok: boolean }>(`/api/providers/accounts/${accId}`, { method: "DELETE" }),
  upsertModel: (id: string, modelId: string, patch?: Partial<{ displayName: string; enabled: boolean; contextLength: number | null; maxOutputTokens: number | null; capabilities: string[] | null }>) =>
    req<{ ok: boolean }>(`/api/providers/${id}/models/${encodeURIComponent(modelId)}`, { method: "PUT", body: JSON.stringify(patch ?? {}) }),
  removeModel: (id: string, modelId: string) =>
    req<{ ok: boolean }>(`/api/providers/${id}/models/${encodeURIComponent(modelId)}`, { method: "DELETE" }),
  removeAllModels: async (id: string, modelIds: string[]) => {
    await Promise.all(modelIds.map((modelId) => req<{ ok: boolean }>(`/api/providers/${id}/models/${encodeURIComponent(modelId)}`, { method: "DELETE" })));
    return { ok: true };
  },
  test: (id: string) =>
    req<{ ok: boolean; status: number; latency_ms: number; account: string; detail?: string }>(`/api/providers/${id}/test`, { method: "POST" }),
  warmupAllAccounts: (id: string) =>
    req<{ provider: string; total: number; success: number; failed: number; results: Array<{ account: string; ok: boolean; status: number; latency_ms: number; detail?: string }> }>(`/api/providers/${id}/warmup`, { method: "POST" }),
  testModel: (id: string, modelId: string) =>
    req<{ ok: boolean; status: number; latency_ms: number; model: string; detail?: string; preview_text?: string; context_length?: number | null; max_output_tokens?: number | null; capabilities?: string[] }>(
      `/api/providers/${id}/models/${encodeURIComponent(modelId)}/test`, { method: "POST" }),
  sync: (id: string) => req<{ synced: number; models: string[] }>(`/api/providers/${id}/sync`, { method: "POST" }),
};

export interface CodexQuotaWindow {
  used_percent: number;
  remaining_percent: number;
  window_seconds: number | null;
  resets_in_seconds: number | null;
  reset_at: number | null;
}

export interface CodexQuota {
  plan_type: string | null;
  email: string | null;
  limit_reached: boolean;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
  banked_resets: { remaining: number | null; total: number | null } | null;
  credits: { has_credits: boolean; unlimited: boolean; balance: number | null } | null;
}

// ── aliases / combos ──
export const aliases = {
  list: () => req<Alias[]>("/api/aliases"),
  create: (alias: string, target: string) => req<Alias>("/api/aliases", { method: "POST", body: JSON.stringify({ alias, target }) }),
  remove: (id: string) => req<{ ok: boolean }>(`/api/aliases/${id}`, { method: "DELETE" }),
};

export const combos = {
  list: () => req<Combo[]>("/api/combos"),
  create: (name: string, chain: string[]) => req<Combo>("/api/combos", { method: "POST", body: JSON.stringify({ name, chain }) }),
  update: (id: string, patch: { name?: string; chain?: string[] }) =>
    req<Combo>(`/api/combos/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => req<{ ok: boolean }>(`/api/combos/${id}`, { method: "DELETE" }),
};

// ── keys ──
export const keys = {
  list: () => req<GatewayKey[]>("/api/keys"),
  create: (input: { label: string; allowedModels?: string[]; rateLimitRpm?: number; concurrency?: number; dailyTokenBudget?: number; expiresAt?: string }) =>
    req<GatewayKey & { plaintext: string }>("/api/keys", { method: "POST", body: JSON.stringify(input) }),
  rotate: (id: string) => req<GatewayKey & { plaintext: string }>(`/api/keys/${id}/rotate`, { method: "POST" }),
  update: (id: string, patch: Partial<{ label: string; enabled: boolean; rateLimitRpm: number | null; concurrency: number | null; dailyTokenBudget: number | null; expiresAt: string | null }>) =>
    req<GatewayKey>(`/api/keys/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
};

// ── backups ──
export interface BackupEntry {
  id: string;
  filename: string;
  size_bytes: number;
  created_at: string;
}

export const backups = {
  list: () => req<{ backups: BackupEntry[] }>("/api/backups"),
  create: () => req<BackupEntry>("/api/backups", { method: "POST" }),
  remove: (id: string) => req<{ ok: boolean }>(`/api/backups/${encodeURIComponent(id)}`, { method: "DELETE" }),
  downloadUrl: (id: string) => `/api/backups/${encodeURIComponent(id)}/download`,
  upload: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/backups/upload", { method: "POST", body: form, credentials: "same-origin" });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (typeof body.error === "string") message = body.error;
      } catch { /* keep default */ }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as BackupEntry;
  },
  restore: (id: string) => req<{ ok: boolean; restarting?: boolean; fallback?: string }>(`/api/backups/${encodeURIComponent(id)}/restore`, { method: "POST" }),
};

// ── stats / logs / settings ──
export const stats = {
  summary: (days: number) => req<StatsSummary>(`/api/stats/summary?days=${days}`),
  timeseries: (days: number) => req<TimeseriesPoint[]>(`/api/stats/timeseries?days=${days}`),
  byModel: (days: number) => req<Array<{ model: string; requests: number; input_tokens: number; output_tokens: number }>>(`/api/stats/by-model?days=${days}`),
  byProvider: (days: number) => req<Array<{ provider: string; requests: number; input_tokens: number; output_tokens: number; success_rate: number }>>(`/api/stats/by-provider?days=${days}`),
};

export const logs = {
  list: (params: { page?: number; limit?: number; status?: string; model?: string; provider?: string; kind?: string }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return req<{ items: RequestLog[]; total: number }>(`/api/logs?${q}`);
  },
  get: (id: string) => req<RequestLog & { attempts_detail?: unknown }>(`/api/logs/${id}`),
  usage: (days = 7) => req<UsageRow[]>(`/api/logs/usage?days=${days}`),
  clearUsage: () => req<{ ok: boolean; cleared: number }>("/api/logs/usage", { method: "DELETE" }),
};

export const settings = {
  get: () => req<Settings>("/api/settings"),
  update: (patch: unknown) => req<{ ok: boolean }>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
};

export const health = () => req<{ status: string; uptime_s?: number; version?: string }>("/health");

// ── integrations ──
export interface IntegrationModel {
  id: string;
  provider: string;
  providerType: string;
}

export interface IntegrationCli {
  id: "opencode" | "codex" | "claude-code" | "aider";
  name: string;
  configPath: string;
  detected: boolean;
  command: string | null;
  configExists: boolean;
  supportsApply: boolean;
  note: string;
}

export interface IntegrationCatalog {
  baseUrl: string;
  clis: IntegrationCli[];
  models: IntegrationModel[];
}

export const integrations = {
  catalog: () => req<IntegrationCatalog>("/api/integrations/catalog"),
  apply: (input: { cli: IntegrationCli["id"]; model: string; apiKey: string }) =>
    req<{ ok: boolean; cli: string; path: string; backup: string | null }>("/api/integrations/apply", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

// ── proxies ──
export type ProxyStatus = "pending" | "healthy" | "slow" | "failing" | "disabled";

export interface ProxyRecord {
  id: string;
  scheme: "http";
  host: string;
  port: number;
  country: string | null;
  source: string;
  status: ProxyStatus;
  latency_ms: number | null;
  last_checked: string | null;
  last_error: string | null;
  failure_streak: number;
  success_count: number;
  failure_count: number;
  username: string | null;
  password: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProxyScrapeRun {
  id: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  fetched: number;
  added: number;
  skipped: number;
  error: string | null;
  triggered_by: "manual" | "interval" | "auto-warmup";
}

export interface ProxyAssignment {
  provider_id: string;
  mode: "direct" | "pool" | "scored";
  enabled: boolean;
}

export interface ProxySource {
  name: string;
  url: string;
}

export interface ProxyBundle {
  sources: ProxySource[];
  proxies: ProxyRecord[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  assignments: ProxyAssignment[];
  scrape_runs: ProxyScrapeRun[];
  config: { enabled: boolean; interval_minutes: number };
}

export const proxies = {
  list: (params: { page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.page) q.set("page", String(params.page));
    if (params.pageSize) q.set("page_size", String(params.pageSize));
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return req<ProxyBundle>(`/api/proxies${suffix}`);
  },
  scrape: () => req<{ results: Array<{ source: string; fetched: number; added: number; skipped: number; error?: string; durationMs: number }>; probed: string[] }>("/api/proxies/scrape", { method: "POST" }),
  probe: (id?: string) => req<{ ok: boolean; probed: string[] }>("/api/proxies/probe", { method: "POST", body: JSON.stringify({ id }) }),
  create: (input: { host: string; port: number; country?: string; username?: string; password?: string; source?: string }) =>
    req<ProxyRecord>("/api/proxies", { method: "POST", body: JSON.stringify(input) }),
  bulkAdd: (input: { lines: string[]; source?: string }) =>
    req<{ received: number; added: number; skipped: number; invalid: number }>("/api/proxies/bulk", { method: "POST", body: JSON.stringify(input) }),
  remove: (id: string) => req<{ ok: boolean }>(`/api/proxies/${id}`, { method: "DELETE" }),
  clear: () => req<{ removed: number }>("/api/proxies/clear", { method: "POST" }),
  toggle: (id: string) => req<ProxyRecord>(`/api/proxies/${id}/toggle`, { method: "POST" }),
  setAssignment: (provider_id: string, mode: "direct" | "pool" | "scored") =>
    req<{ mode: "direct" | "pool" | "scored"; enabled: boolean }>("/api/proxies/assignments", { method: "POST", body: JSON.stringify({ provider_id, mode }) }),
  getConfig: () => req<{ enabled: boolean; interval_minutes: number }>("/api/proxies/config"),
  saveConfig: (input: { enabled: boolean; interval_minutes: number }) =>
    req<{ enabled: boolean; interval_minutes: number }>("/api/proxies/config", { method: "POST", body: JSON.stringify(input) }),
};

// -- music --
export interface MusicTrack {
  id: string;
  playlist_id: string;
  source: string;
  source_id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  position: number;
  created_at: string;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  tracks?: MusicTrack[];
}

export interface MusicSearchResult {
  id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  source: "youtube";
}

export const music = {
  search: (q: string, limit = 12) => req<{ source: "yt-dlp" | "invidious"; results: MusicSearchResult[] }>(`/api/music/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  trending: (limit = 20) => req<{ source: "yt-dlp" | "invidious"; results: MusicSearchResult[] }>(`/api/music/trending?limit=${limit}`),
  listPlaylists: () => req<{ playlists: MusicPlaylist[] }>("/api/music/playlists"),
  createPlaylist: (name: string) => req<MusicPlaylist>("/api/music/playlists", { method: "POST", body: JSON.stringify({ name }) }),
  getPlaylist: (id: string) => req<MusicPlaylist>(`/api/music/playlists/${id}`),
  renamePlaylist: (id: string, name: string) => req<MusicPlaylist>(`/api/music/playlists/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deletePlaylist: (id: string) => req<{ ok: boolean }>(`/api/music/playlists/${id}`, { method: "DELETE" }),
  addTrack: (playlistId: string, input: { url?: string; videoId?: string; title: string; channel?: string; durationSec?: number; thumbnailUrl?: string; source?: string }) =>
    req<MusicTrack>(`/api/music/playlists/${playlistId}/tracks`, { method: "POST", body: JSON.stringify(input) }),
  removeTrack: (trackId: string) => req<{ ok: boolean }>(`/api/music/tracks/${trackId}`, { method: "DELETE" }),
  streamUrl: (videoId: string) => `/api/music/stream?id=${encodeURIComponent(videoId)}`,
};
