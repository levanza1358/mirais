import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /codestral/i, meta: { contextLength: 256_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /devstral/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /mistral.*large/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /mistral|mixtral|ministral/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];