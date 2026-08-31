import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /claude-.*(opus|sonnet|haiku).*4/i, meta: { contextLength: 200_000, maxOutputTokens: 64_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /claude.*3-5-sonnet/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /claude.*3-5-haiku/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /claude.*3-opus/i, meta: { contextLength: 200_000, maxOutputTokens: 4_096, capabilities: ["tools", "json", "vision"] } },
  { re: /claude/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
];