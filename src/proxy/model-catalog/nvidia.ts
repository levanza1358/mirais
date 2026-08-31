import type { ModelMeta } from "../modelMeta";

export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  { re: /nemotron/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
];