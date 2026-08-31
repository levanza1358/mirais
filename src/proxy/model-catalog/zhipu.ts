import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /glm-5v|glm-4v|glm.*vision/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /glm-5/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["reasoning", "tools", "json"] } },
  { re: /glm-4/i, meta: { contextLength: 128_000, maxOutputTokens: 4_096, capabilities: ["tools", "json"] } },
];