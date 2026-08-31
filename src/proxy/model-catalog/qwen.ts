import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /qwen.*(max|plus|turbo)/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /qwen|qwq/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["reasoning", "tools", "json"] } },
];