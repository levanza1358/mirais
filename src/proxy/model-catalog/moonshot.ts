import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /kimi.*(vision|vl)/i, meta: { contextLength: 256_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /kimi/i, meta: { contextLength: 256_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];