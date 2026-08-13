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
    const older = nonSystem.slice(0, -cfg.keepRecent);
    const recent = nonSystem.slice(-cfg.keepRecent);

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

function truncateMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const result: ChatMessage[] = [];
  let total = 0;

  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    total += content.length;
    if (total > maxChars) break;
    result.push(m);
  }

  if (result.length < messages.length) {
    result.push({
      role: "user",
      content: `[mirais-headroom: ${messages.length - result.length} messages truncated to stay within ${maxChars} character limit]`,
    });
  }

  return result;
}
