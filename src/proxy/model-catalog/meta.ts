import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /llama-3\.[23]/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /llama-3\.1-405/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /llama-3\.1/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /llama-4/i, meta: { contextLength: 1_048_576, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /llama/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];