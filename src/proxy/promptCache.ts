import type { CanonicalRequest, ChatMessage, Usage } from "../shared/types";

/**
 * Provider prompt caching.
 *
 * Coding-agent traffic replays a large, stable prefix on every turn: system
 * prompt, tool definitions, and the earlier conversation. Providers can serve
 * that prefix from their own cache at a large discount, but only if we tell
 * them where the reusable boundary is.
 *
 * Two dialects:
 *
 * - **Anthropic** wants explicit `cache_control: { type: "ephemeral" }` markers
 *   on the last block of each reusable span. At most four markers are allowed,
 *   so they go where they pay off most: the system prompt, the tool list, and
 *   the end of the stable message history.
 * - **OpenAI** caches automatically for long prompts but keys the cache on a
 *   hash of the prefix. Sending a stable `prompt_cache_key` for a session keeps
 *   requests from the same conversation landing on the same cache shard.
 *
 * Both are advisory: a provider that ignores them behaves exactly as before.
 */

/**
 * Anthropic bills cache *writes* at a premium, so marking a prefix that is
 * never reused costs more than not caching at all. Below this many characters a
 * prefix is not worth a breakpoint.
 */
const MIN_CACHEABLE_CHARS = 2_000;

/** Anthropic permits at most 4 cache breakpoints per request. */
const MAX_BREAKPOINTS = 4;

export interface PromptCacheConfig {
  enabled: boolean;
}

export const DEFAULT_PROMPT_CACHE: PromptCacheConfig = { enabled: true };

function charLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum: number, part) => {
      if (typeof part === "string") return sum + part.length;
      if (part && typeof part === "object" && "text" in part) return sum + String((part as { text: unknown }).text ?? "").length;
      return sum;
    }, 0);
  }
  return 0;
}

/** Total characters in the request's stable prefix (system + tools). */
export function prefixSize(req: CanonicalRequest): number {
  const system = req.messages
    .filter((m) => m.role === "system" || (m.role as string) === "developer")
    .reduce((sum, m) => sum + charLength(m.content), 0);
  const tools = req.tools?.length ? JSON.stringify(req.tools).length : 0;
  return system + tools;
}

/**
 * True when the request has a prefix large enough to be worth caching. Small
 * requests are left alone so a cache write is never billed for nothing.
 */
export function isCacheable(req: CanonicalRequest): boolean {
  return prefixSize(req) >= MIN_CACHEABLE_CHARS;
}

/**
 * Apply `cache_control` markers to an Anthropic request body.
 *
 * Markers are placed on:
 * 1. the final system block (the system prompt rarely changes),
 * 2. the final tool definition (the tool list is stable for a session),
 * 3. the last message before the newest user turn (the settled history).
 *
 * Mutates and returns `body` for convenience; safe to call on a body that
 * already has markers because it only ever sets, never appends.
 */
export function withAnthropicCacheControl<T extends Record<string, unknown>>(body: T): T {
  const marker = { type: "ephemeral" as const };
  let used = 0;

  const system = body.system;
  if (Array.isArray(system) && system.length) {
    const last = system[system.length - 1] as Record<string, unknown>;
    if (last && typeof last === "object") {
      last.cache_control = marker;
      used += 1;
    }
  }

  const tools = body.tools;
  if (Array.isArray(tools) && tools.length && used < MAX_BREAKPOINTS) {
    const last = tools[tools.length - 1] as Record<string, unknown>;
    if (last && typeof last === "object") {
      last.cache_control = marker;
      used += 1;
    }
  }

  const messages = body.messages;
  if (Array.isArray(messages) && messages.length > 1 && used < MAX_BREAKPOINTS) {
    // The newest turn is what changes, so the boundary goes before it.
    const target = messages[messages.length - 2] as Record<string, unknown> | undefined;
    const content = target?.content;
    if (Array.isArray(content) && content.length) {
      const lastBlock = content[content.length - 1] as Record<string, unknown>;
      if (lastBlock && typeof lastBlock === "object") lastBlock.cache_control = marker;
    } else if (typeof content === "string" && target) {
      target.content = [{ type: "text", text: content, cache_control: marker }];
    }
  }

  return body;
}

/**
 * Derive a stable OpenAI `prompt_cache_key`.
 *
 * The key must be identical across turns of one conversation and different
 * across unrelated conversations. The stable prefix hashes to exactly that: the
 * system prompt and tool list stay fixed for a session while the trailing
 * messages change.
 */
export function promptCacheKey(req: CanonicalRequest, sessionId?: string): string {
  if (sessionId) return `mirais-${sessionId}`;
  const system = req.messages
    .filter((m) => m.role === "system" || (m.role as string) === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  const tools = req.tools?.map((t) => t.function.name).join(",") ?? "";
  return `mirais-${Bun.hash(`${req.model}\u0000${system}\u0000${tools}`).toString(36)}`;
}

/**
 * Normalize provider-reported cache token counts into canonical `Usage`.
 *
 * OpenAI reports `prompt_tokens_details.cached_tokens`; Anthropic reports
 * `cache_read_input_tokens` and `cache_creation_input_tokens`. Absent fields
 * stay absent rather than being zero-filled, so "provider does not report
 * caching" stays distinguishable from "nothing was cached".
 */
export function cacheTokensFrom(raw: Record<string, unknown> | undefined): Pick<Usage, "cached_tokens" | "cache_write_tokens"> {
  if (!raw) return {};
  const out: Pick<Usage, "cached_tokens" | "cache_write_tokens"> = {};

  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  const openAiCached = details?.cached_tokens ?? (raw.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens;
  if (typeof openAiCached === "number") out.cached_tokens = openAiCached;

  const anthropicRead = raw.cache_read_input_tokens;
  if (typeof anthropicRead === "number") out.cached_tokens = anthropicRead;

  const anthropicWrite = raw.cache_creation_input_tokens;
  if (typeof anthropicWrite === "number") out.cache_write_tokens = anthropicWrite;

  return out;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Convert a raw upstream `usage` object into canonical `Usage`, preserving
 * cache counters.
 *
 * Every upstream dialect goes through here so cache telemetry cannot be lost by
 * a path that only copies `prompt_tokens`/`completion_tokens`: Chat Completions
 * uses those names, the Responses API uses `input_tokens`/`output_tokens`, and
 * cache counts are nested (`prompt_tokens_details.cached_tokens`) or renamed
 * (`cache_read_input_tokens`).
 */
export function normalizeUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const prompt = asNumber(u.prompt_tokens) ?? asNumber(u.input_tokens) ?? 0;
  const completion = asNumber(u.completion_tokens) ?? asNumber(u.output_tokens) ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: asNumber(u.total_tokens) ?? prompt + completion,
    ...cacheTokensFrom(u),
  };
}

/** Messages that form the stable prefix, for diagnostics and tests. */
export function stablePrefix(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "system" || (m.role as string) === "developer");
}
