import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /nova.*pro/i, meta: { contextLength: 300_000, maxOutputTokens: 5_000, capabilities: ["tools", "json", "vision"] } },
  { re: /nova/i, meta: { contextLength: 128_000, maxOutputTokens: 5_000, capabilities: ["tools", "json"] } },
];