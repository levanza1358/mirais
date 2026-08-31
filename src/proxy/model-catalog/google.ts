import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /gemini-.*(2\.5|3)/i, meta: { contextLength: 1_048_576, maxOutputTokens: 65_536, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gemini.*flash/i, meta: { contextLength: 1_048_576, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /gemini.*pro/i, meta: { contextLength: 2_097_152, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /gemma/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];