import type { CanonicalRequest, ChatMessage } from "../../shared/types";
import { compressToolOutput, isCommandTool, type TokenSaverConfig } from "./compress";
import { applyHeadroom, type HeadroomConfig, HEADROOM_DEFAULT } from "./headroom";
import { applyPonytail, type PonytailConfig, PONYTAIL_DEFAULT } from "./ponytail";
import { createHash } from "node:crypto";

export interface ApplyResult {
  request: CanonicalRequest;
  tokensSaved: number;
}

/**
 * Full boltToken Saver pipeline:
 *   1. Headroom — compress older conversation context
 *   2. RTK — compact tool outputs (git, grep, ls, etc.)
 *   3. Ponytail — inject lazy-senior-dev system prompt bias
 *
 * Caveman (terse output) is applied separately at the response level.
 */
export function applyTokenSaver(
  req: CanonicalRequest,
  cfg: TokenSaverConfig,
  headroomCfg?: HeadroomConfig,
  ponytailCfg?: PonytailConfig,
): ApplyResult {
  let tokensSaved = 0;
  let request = req;

  // 1. Headroom: compress older conversation context
  const hCfg = headroomCfg ?? HEADROOM_DEFAULT;
  if (hCfg.enabled) {
    const result = applyHeadroom(request, hCfg);
    request = result.request;
    tokensSaved += result.tokensSaved;
  }

  // 2. RTK: compress tool outputs
  if (cfg.enabled) {
    const toolIndexes = request.messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
    const keepRecent = Math.max(0, cfg.rules.keepRecentToolResults ?? 8);
    const staleBefore = toolIndexes.length > keepRecent ? toolIndexes[toolIndexes.length - keepRecent] ?? 0 : 0;
    // Map tool_call_id -> tool name, so we can identify which tool produced each
    // tool-role message (the message itself only carries tool_call_id + content).
    const toolNameById = new Map<string, string>();
    for (const m of request.messages) {
      for (const tc of m.tool_calls ?? []) toolNameById.set(tc.id, tc.function.name);
    }
    const seenOutputs = new Map<string, number>();
    const messages: ChatMessage[] = request.messages.map((msg, index) => {
      if (msg.role !== "tool" || typeof msg.content !== "string") return msg;
      // Content tools (read_file, grep, etc.) must round-trip their full output back
      // to the model. Compacting/truncating them makes the model lose the file content
      // it already read and loop re-reading the same file forever. Only compact
      // command-like tools whose verbose output is safe to summarize.
      const toolName = msg.name ?? toolNameById.get(msg.tool_call_id ?? "") ?? "";
      const isContentTool = toolName !== "" && !isCommandTool(toolName);
      if (isContentTool) return msg;
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
    request = { ...request, messages };
  }

  // 3. Ponytail: inject lazy-senior-dev bias
  const pCfg = ponytailCfg ?? PONYTAIL_DEFAULT;
  if (pCfg.enabled) {
    request = applyPonytail(request, pCfg);
  }

  return { request, tokensSaved };
}

export { isCommandTool };
export { applyHeadroom, HEADROOM_DEFAULT, type HeadroomConfig } from "./headroom";
export { applyPonytail, PONYTAIL_DEFAULT, type PonytailConfig } from "./ponytail";
