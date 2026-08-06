import type { CanonicalRequest, ChatMessage } from "../../shared/types";
import { compressToolOutput, isCommandTool, type TokenSaverConfig } from "./compress";

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
  const messages: ChatMessage[] = req.messages.map((msg) => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;
    const { text, saved } = compressToolOutput(msg.content, cfg);
    if (saved > 0) tokensSaved += saved;
    return { ...msg, content: text };
  });

  return { request: { ...req, messages }, tokensSaved };
}

export { isCommandTool };
