import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /minimax.*(vision|vl|image)/i, meta: { contextLength: 1_000_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /minimax-m3/i, meta: { contextLength: 1_000_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /minimax/i, meta: { contextLength: 1_000_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];