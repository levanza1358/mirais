import type { ModelMeta } from "../modelMeta";

// Ordered most-specific → most-general. First match wins.
export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /gpt-5(\.\d+)?-codex|codex/i, meta: { contextLength: 400_000, maxOutputTokens: 128_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gpt-5/i, meta: { contextLength: 400_000, maxOutputTokens: 128_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gpt-4\.1/i, meta: { contextLength: 1_047_576, maxOutputTokens: 32_768, capabilities: ["tools", "json", "vision"] } },
  { re: /gpt-4o/i, meta: { contextLength: 128_000, maxOutputTokens: 16_384, capabilities: ["tools", "json", "vision"] } },
  { re: /gpt-4-turbo/i, meta: { contextLength: 128_000, maxOutputTokens: 4_096, capabilities: ["tools", "json", "vision"] } },
  { re: /\bo[134](-mini|-pro)?\b/i, meta: { contextLength: 200_000, maxOutputTokens: 100_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
];