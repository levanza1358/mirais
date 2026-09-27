// Provider × reasoning capability matrix.
//
// Source of truth for both the backend (e.g. docs rendering, future telemetry)
// and the dashboard Settings → Reasoning tab. Keep entries in display order so
// the matrix renders consistently in both surfaces.

export interface ReasoningCapability {
  /** Stable identifier, mirrors provider.name in the DB. */
  id: string;
  /** Human-readable provider name. */
  label: string;
  /** Upstream dialect this provider maps to. */
  dialect: "openai-chat" | "openai-responses" | "anthropic" | "xai-chat" | "xai-responses" | "codex" | "copilot" | "codebuddy" | "custom";
  /** Accepts `reasoning.effort` directly. */
  effort: boolean;
  /** Accepts `reasoning.budget_tokens` (Anthropic extended thinking). */
  budget_tokens: boolean;
  /** Accepts `reasoning.summary`. */
  summary: boolean;
  /** Accepts `reasoning.include` allowlist. */
  include: boolean;
  /** Streams `delta.reasoning_content` back to clients. */
  stream_reasoning: boolean;
  /** Reports `output_tokens_details.reasoning_tokens` in usage. */
  reports_tokens: boolean;
  /** One-paragraph note surfaced in the UI/docs. */
  note: string;
}

export const REASONING_MATRIX: ReasoningCapability[] = [
  {
    id: "openai",
    label: "OpenAI",
    dialect: "openai-responses",
    effort: true,
    budget_tokens: false,
    summary: true,
    include: true,
    stream_reasoning: true,
    reports_tokens: true,
    note: "Chat Completions uses `reasoning_effort`. OpenAI Responses uses the same universal `reasoning` block; `summary` defaults to concise.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    dialect: "anthropic",
    effort: false,
    budget_tokens: true,
    summary: false,
    include: false,
    stream_reasoning: true,
    reports_tokens: false,
    note: "Maps universal `reasoning.budget_tokens` to `thinking.budget_tokens`. Supports `type: \"adaptive\"` on Claude 4.7+. Anthropic omits `temperature` and `top_p` when thinking is on.",
  },
  {
    id: "xai",
    label: "xAI Grok",
    dialect: "xai-chat",
    effort: true,
    budget_tokens: false,
    summary: true,
    include: true,
    stream_reasoning: true,
    reports_tokens: true,
    note: "Grok-4.5 accepts `reasoning_effort`. The Grok CLI endpoint also accepts `summary: \"concise\"` and `include: [\"reasoning.encrypted_content\"]` for multi-turn continuity.",
  },
  {
    id: "codex",
    label: "ChatGPT Codex",
    dialect: "codex",
    effort: true,
    budget_tokens: false,
    summary: true,
    include: true,
    stream_reasoning: true,
    reports_tokens: true,
    note: "Codex backend mirrors OpenAI Responses: `effort`, `summary`, and `include` are forwarded; budget is server-managed and not accepted.",
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    dialect: "copilot",
    effort: false,
    budget_tokens: false,
    summary: false,
    include: false,
    stream_reasoning: false,
    reports_tokens: false,
    note: "Reasoning depends on the model the Copilot SDK routes to. Mirais passes the request through; consult the upstream Copilot catalog for model-specific behaviour.",
  },
  {
    id: "codebuddy-global",
    label: "CodeBuddy (Global)",
    dialect: "codebuddy",
    effort: false,
    budget_tokens: false,
    summary: false,
    include: false,
    stream_reasoning: false,
    reports_tokens: false,
    note: "CodeBuddy rejects `reasoning`/`reasoning_effort` and returns 11128 errors; Mirais strips these fields per docs/08-codebuddy-compatibility.md.",
  },
  {
    id: "codebuddy-cn",
    label: "CodeBuddy (CN)",
    dialect: "codebuddy",
    effort: false,
    budget_tokens: false,
    summary: false,
    include: false,
    stream_reasoning: false,
    reports_tokens: false,
    note: "CodeBuddy CN strips the same fields as the global variant; honour upstream pricing/quota rather than reasoning.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    dialect: "openai-chat",
    effort: true,
    budget_tokens: false,
    summary: false,
    include: false,
    stream_reasoning: true,
    reports_tokens: false,
    note: "DeepSeek DSML markup is converted to OpenAI `tool_calls` by Mirais. Reasoning deltas surface as `reasoning_content` for compatible clients.",
  },
  {
    id: "blackbox",
    label: "BlackBoxAI",
    dialect: "openai-chat",
    effort: true,
    budget_tokens: false,
    summary: false,
    include: false,
    stream_reasoning: false,
    reports_tokens: false,
    note: "Generic OpenAI-compatible; `reasoning_effort` is honoured by supported upstream models.",
  },
  {
    id: "glm",
    label: "Zhipu GLM",
    dialect: "openai-chat",
    effort: true,
    budget_tokens: false,
    summary: false,
    include: false,
    stream_reasoning: true,
    reports_tokens: false,
    note: "Z.ai Coding Plan uses Anthropic Messages (dialect: anthropic); standard GLM uses Chat Completions. Mirais picks the dialect from the base URL.",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    dialect: "custom",
    effort: true,
    budget_tokens: false,
    summary: false,
    include: false,
    stream_reasoning: false,
    reports_tokens: false,
    note: "Each custom upstream is responsible for its own reasoning semantics. Mirais forwards `reasoning_effort` and streams reasoning deltas when the upstream emits them.",
  },
];

export function capabilityFor(providerId: string): ReasoningCapability | undefined {
  return REASONING_MATRIX.find((entry) => entry.id === providerId);
}