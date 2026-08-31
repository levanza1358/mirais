import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /deepseek.*(r1|reason|think)/i, meta: { contextLength: 128_000, maxOutputTokens: 64_000, capabilities: ["reasoning", "tools", "json"] } },
  { re: /deepseek.*(vl|vision)/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /deepseek-v4/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /deepseek/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];