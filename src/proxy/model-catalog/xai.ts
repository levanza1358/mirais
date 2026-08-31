import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /grok-4/i, meta: { contextLength: 256_000, maxOutputTokens: 16_384, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /grok-3/i, meta: { contextLength: 131_072, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /grok/i, meta: { contextLength: 131_072, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];