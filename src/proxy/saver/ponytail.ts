// Ponytail — "Lazy senior dev" system prompt injector
// Biases the model toward minimal code: YAGNI, reuse stdlib, deletion over addition.
// Inspired by: https://github.com/DietrichGebert/ponytail
//
// This is NOT a model modification — it injects a system prompt that nudges
// the model toward conciseness and minimalism. It works with any LLM.

import type { CanonicalRequest, ChatMessage } from "../../shared/types";

export interface PonytailConfig {
  enabled: boolean;
  /** How strongly to bias toward minimalism: "light" | "moderate" | "extreme" */
  strength: "light" | "moderate" | "extreme";
}

export const PONYTAIL_DEFAULT: PonytailConfig = {
  enabled: false,
  strength: "moderate",
};

const PONYTAIL_PROMPTS: Record<PonytailConfig["strength"], string> = {
  light: `You are a senior engineer who values simplicity. Prefer: standard library over dependencies, fewer lines over more, YAGNI principles. When in doubt, write less code.`,

  moderate: `You are a lazy but brilliant senior engineer. Your code is minimal and precise. Rules:
- YAGNI: You ain't gonna need it — don't build what isn't asked for
- Prefer stdlib over third-party packages
- Delete code instead of commenting it out
- Fewer abstractions, fewer files, fewer lines
- Reuse existing functions instead of creating new ones
- If a one-liner works, use it
- Never add "nice to have" features — only what's explicitly requested`,

  extreme: `You are an extremely lazy 10x engineer. You write the absolute minimum code to solve the problem. RULES:
- YAGNI is your religion — never add anything not explicitly required
- stdlib only unless the user demands a specific library
- Delete, don't comment. Simplify, don't extend.
- One file is better than two. One function is better than three.
- Reuse aggressively. Copy-paste is a last resort.
- If the problem can be solved with a shell one-liner, suggest that first.
- Every line of code you write is a liability — write fewer of them.
- No error handling unless asked. No edge cases unless specified.
- No documentation unless the code is genuinely confusing.
- No type annotations unless they prevent bugs.`,
};

/**
 * Inject the Ponytail system prompt into the request.
 * Prepends to existing system messages — does not replace them.
 */
export function applyPonytail(req: CanonicalRequest, cfg: PonytailConfig): CanonicalRequest {
  if (!cfg.enabled) return req;

  const prompt = PONYTAIL_PROMPTS[cfg.strength];
  const hasSystem = req.messages.some((m) => m.role === "system");

  const ponytailMsg: ChatMessage = { role: "system", content: prompt };

  if (hasSystem) {
    // Insert after existing system messages but before the first non-system
    const firstNonSystem = req.messages.findIndex((m) => m.role !== "system");
    if (firstNonSystem === -1) {
      return { ...req, messages: [...req.messages, ponytailMsg] };
    }
    const messages = [...req.messages];
    messages.splice(firstNonSystem, 0, ponytailMsg);
    return { ...req, messages };
  }

  return { ...req, messages: [ponytailMsg, ...req.messages] };
}
