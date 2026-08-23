// Headroom — context compression via /v1/compress endpoint
// Compresses conversation history before routing to the model, reducing input tokens.
// Inspired by: https://github.com/chopratejas/headroom

import type { CanonicalRequest, ChatMessage } from "../../shared/types";

export interface HeadroomConfig {
  enabled: boolean;
  /** Maximum number of recent messages to keep uncompressed */
  keepRecent: number;
  /** Summarize older messages instead of dropping them */
  summarize: boolean;
  /** Maximum total characters after compression before truncation */
  maxChars: number;
}

export const HEADROOM_DEFAULT: HeadroomConfig = {
  enabled: false,
  keepRecent: 10,
  summarize: true,
  maxChars: 100_000,
};

/**
 * Compress a conversation by summarizing older messages while keeping recent ones intact.
 * Returns the compressed request and estimated tokens saved.
 */
export function applyHeadroom(req: CanonicalRequest, cfg: HeadroomConfig): { request: CanonicalRequest; tokensSaved: number } {
  if (!cfg.enabled) return { request: req, tokensSaved: 0 };
  if (req.messages.length <= cfg.keepRecent) return { request: req, tokensSaved: 0 };

  const before = estimateTotalTokens(req.messages);
  const messages: ChatMessage[] = [];

  // Keep system message always
  const systemMsgs = req.messages.filter((m) => m.role === "system");
  messages.push(...systemMsgs);

  // Messages to potentially compress (non-system)
  const nonSystem = req.messages.filter((m) => m.role !== "system");

  if (nonSystem.length <= cfg.keepRecent) {
    messages.push(...nonSystem);
  } else {
    // Never cut between an assistant tool_calls message and its tool results:
    // both APIs reject a tool result whose call is missing, so a naive slice
    // turns a working conversation into a 400.
    const keep = expandToToolCallBoundary(nonSystem, cfg.keepRecent);
    const older = nonSystem.slice(0, nonSystem.length - keep);
    const recent = nonSystem.slice(nonSystem.length - keep);

    if (cfg.summarize && older.length > 0) {
      // Create a compressed summary of older messages
      const summary = summarizeMessages(older);
      messages.push({ role: "user", content: summary });
    }

    messages.push(...recent);
  }

  // Truncate if still too long
  const after = estimateTotalTokens(messages);
  let tokensSaved = Math.max(0, before - after);

  // Apply character limit if needed
  let final = messages;
  const totalChars = JSON.stringify(messages).length;
  if (totalChars > cfg.maxChars) {
    final = truncateMessages(messages, cfg.maxChars);
    const afterTrunc = estimateTotalTokens(final);
    tokensSaved = Math.max(0, before - afterTrunc);
  }

  return { request: { ...req, messages: final }, tokensSaved };
}

/**
 * Grow `keepRecent` until the kept window does not start on an orphaned tool
 * result. A `tool` message is only valid when the assistant message carrying
 * its `tool_call_id` is also present, so the boundary moves backwards past the
 * whole call/result group rather than splitting it.
 */
function expandToToolCallBoundary(nonSystem: ChatMessage[], keepRecent: number): number {
  let keep = Math.min(Math.max(keepRecent, 1), nonSystem.length);
  while (keep < nonSystem.length) {
    const window = nonSystem.slice(nonSystem.length - keep);
    const callIds = new Set<string>();
    for (const m of window) {
      for (const tc of m.tool_calls ?? []) callIds.add(tc.id);
    }
    const orphan = window.some((m) => m.role === "tool" && m.tool_call_id != null && !callIds.has(m.tool_call_id));
    if (!orphan) break;
    keep += 1;
  }
  return keep;
}

function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + Math.ceil(content.length / 4);
  }, 0);
}

function summarizeMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  let userMsgs = 0;
  let assistantMsgs = 0;
  let toolMsgs = 0;

  for (const m of messages) {
    if (m.role === "user") userMsgs++;
    else if (m.role === "assistant") assistantMsgs++;
    else if (m.role === "tool") toolMsgs++;
  }

  parts.push(`[mirais-headroom: compressed ${messages.length} earlier messages (${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool results)`);

  // Extract key user queries
  const userQueries = messages
    .filter((m) => m.role === "user")
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return c.length > 120 ? c.slice(0, 120) + "..." : c;
    });

  if (userQueries.length > 0) {
    parts.push(`Previous queries: ${userQueries.join(" | ")}`);
  }

  // Note tool usage
  const toolCalls = messages
    .filter((m) => m.role === "assistant" && m.tool_calls?.length)
    .flatMap((m) => m.tool_calls?.map((tc) => tc.function.name) ?? []);

  if (toolCalls.length > 0) {
    const uniqueTools = [...new Set(toolCalls)];
    parts.push(`Tools used: ${uniqueTools.join(", ")}`);
  }

  parts.push("Continue the conversation from here.]");

  return parts.join(". ");
}

/**
 * Drop messages to fit `maxChars`, keeping the newest turns.
 *
 * Truncation walks from the newest message backwards: the latest user question
 * is the one thing the model cannot do without, and a forward walk would spend
 * the whole budget on the oldest history and discard it. The system prompt is
 * always kept, and tool results whose call was dropped are removed so the
 * request stays valid.
 */
function truncateMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  let total = systemMsgs.reduce((sum, m) => sum + contentLength(m), 0);
  const kept: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const m = rest[i]!;
    const size = contentLength(m);
    // Always keep the newest message, even when it alone exceeds the budget:
    // sending no user turn at all is worse than sending an oversized one.
    if (kept.length > 0 && total + size > maxChars) break;
    total += size;
    kept.unshift(m);
  }

  const callIds = new Set<string>();
  for (const m of kept) {
    for (const tc of m.tool_calls ?? []) callIds.add(tc.id);
  }
  const valid = kept.filter((m) => !(m.role === "tool" && m.tool_call_id != null && !callIds.has(m.tool_call_id)));

  const dropped = rest.length - valid.length;
  const out = [...systemMsgs];
  if (dropped > 0) {
    out.push({
      role: "user",
      content: `[mirais-headroom: ${dropped} earlier messages dropped to stay within ${maxChars} characters]`,
    });
  }
  out.push(...valid);
  return out;
}

function contentLength(m: ChatMessage): number {
  const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  const calls = m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
  return content.length + calls;
}
