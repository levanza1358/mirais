import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /gpt-oss/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /blackbox-pro/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];