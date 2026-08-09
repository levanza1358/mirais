import type { CanonicalRequest, ChatMessage } from "../../shared/types";
import { compressToolOutput, isCommandTool, type TokenSaverConfig } from "./compress";
import { createHash } from "node:crypto";

export interface ApplyResult {
  request: CanonicalRequest;
  tokensSaved: number;
}

/**
 * Apply token-saver transformations to a canonical request.
 * Only `tool` role messages from command-like tools are compacted.
 */
export function applyTokenSaver(req: CanonicalRequest, cfg: TokenSaverConfig): ApplyResult {
  if (!cfg.enabled) return { request: req, tokensSaved: 0 };

  let tokensSaved = 0;
  const toolIndexes = req.messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  const keepRecent = Math.max(0, cfg.rules.keepRecentToolResults ?? 8);
  const staleBefore = toolIndexes.length > keepRecent ? toolIndexes[toolIndexes.length - keepRecent] ?? 0 : 0;
  const seenOutputs = new Map<string, number>();
  const messages: ChatMessage[] = req.messages.map((msg, index) => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;
    const before = Math.ceil(msg.content.length / 4);
    const digest = createHash("sha256").update(msg.content).digest("hex").slice(0, 12);
    if (cfg.rules.deduplicateToolOutputs && seenOutputs.has(digest)) {
      const content = `[mirais: duplicate tool output omitted; same as tool result ${seenOutputs.get(digest)}; sha256:${digest}]`;
      if (content.length >= msg.content.length) return msg;
      tokensSaved += Math.max(0, before - Math.ceil(content.length / 4));
      return { ...msg, content };
    }
    seenOutputs.set(digest, index + 1);
    if (index < staleBefore) {
      const preview = msg.content.slice(0, 240).replace(/\s+/g, " ");
      const content = `[mirais: stale tool output compacted; sha256:${digest}; preview: ${preview}]`;
      if (content.length >= msg.content.length) return msg;
      tokensSaved += Math.max(0, before - Math.ceil(content.length / 4));
      return { ...msg, content };
    }
    const { text, saved } = compressToolOutput(msg.content, cfg);
    if (saved > 0) tokensSaved += saved;
    return { ...msg, content: text };
  });

  return { request: { ...req, messages }, tokensSaved };
}

export { isCommandTool };
