// ── Canonical request/response types (OpenAI Chat Completions based) ──

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image_url";
  image_url: { url: string; detail?: "low" | "high" | "auto" };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type MessageContent = string | Array<TextContent | ImageContent | ToolResultContent | Record<string, unknown>>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

/**
 * Universal reasoning/thinking control.
 *
 * Mirais is a multi-provider gateway — clients shouldn't have to know whether
 * a model wants `reasoning_effort`, `budget_tokens`, or Anthropic's
 * `thinking` blocks. The `reasoning` block is translated per provider by the
 * executor (see `src/proxy/executor.ts` and `src/proxy/codex.ts`).
 */
export interface ReasoningSpec {
  /** Enable thinking-style output. Defaults to `true` when the block is present. */
  enabled?: boolean;
  /**
   * Lightweight effort hint — mapped to OpenAI/Codex `reasoning.effort`,
   * ignored on providers that don't accept an effort enum.
   */
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Token budget for thinking — Anthropic `thinking.budget_tokens` and a
   * server-side cap on Codex reasoning tokens.
   */
  budget_tokens?: number;
}

export interface CanonicalRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ToolDef[];
  tool_choice?: unknown;
  response_format?: unknown;
  parallel_tool_calls?: boolean;
  service_tier?: string;
  stream_options?: { include_usage?: boolean };
  /** Universal reasoning/thinking configuration. */
  reasoning?: ReasoningSpec;
}

export interface RoutingPolicy {
  mode: "balanced" | "priority" | "sticky";
  preferProviders: string[];
  denyProviders: string[];
  denyModels: string[];
  maxAttempts: number;
  respectPriority: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface CanonicalResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
}

// ── Domain entities ──

export type ProviderType =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "xai"
  | "glm"
  | "blackbox"
  | "codebuddy-global"
  | "codebuddy-cn"
  | "custom";

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string | null;
  enabled: number;
  priority: number;
  created_at: string;
  updated_at: string;
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
  /** 'api_key' (default) or 'oauth' (ChatGPT login — api_key holds the access token). */
  auth_kind?: string;
  refresh_token?: string | null;
  id_token?: string | null;
  /** ChatGPT account id, sent as the chatgpt-account-id header on Codex backend calls. */
  account_id?: string | null;
  /** Epoch ms when the OAuth access token expires. */
  expires_at?: number | null;
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
  source: "manual" | "sync";
}

export interface Alias {
  id: string;
  alias: string;
  target: string;
  created_at: string;
}

export interface Combo {
  id: string;
  name: string;
  strategy: string;
  created_at: string;
  updated_at: string;
}

export interface ComboEntry {
  id: string;
  combo_id: string;
  position: number;
  target: string;
}

export interface GatewayKey {
  id: string;
  label: string;
  key_hash: string;
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
  status: "success" | "error" | "client_error" | "rate_limited";
  http_status: number | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  credit_usage: number | null;
  latency_ms: number | null;
  tokens_saved: number;
  request_body: string | null;
  response_body: string | null;
  /** 'request' (real traffic) or 'warmup' (test/ping). */
  kind?: string;
}

export interface AttemptRecord {
  provider: string;
  model: string;
  accountId?: string;
  accountLabel?: string;
  outcome: "success" | "error";
  httpStatus?: number;
  error?: string;
  latencyMs?: number;
  reason?: string;
}

// ── Routing ──

export interface RouteCandidate {
  provider: Provider;
  modelId: string;
  accounts: ProviderAccount[];
}

export interface ResolvedRoute {
  kind: "direct" | "qualified" | "alias" | "combo";
  requested: string;
  candidates: RouteCandidate[];
}
