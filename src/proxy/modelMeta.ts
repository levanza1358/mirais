// ── Model metadata catalog ──
//
// Many upstreams (e.g. BlackBox) return only `{ id, object, created }` from
// /models — no context window or output limits. This catalog fills those gaps
// from each model's *publicly documented* specs, keyed by name pattern, so the
// values follow the model itself rather than being hardcoded per account.
//
// Precedence at sync time: upstream-provided value → this catalog → null.
//
// Each provider has its own file in model-catalog/. Import here and merge.

export interface ModelMeta {
  contextLength: number;
  maxOutputTokens: number;
  capabilities: string[];
}

interface Pattern {
  re: RegExp;
  meta: ModelMeta;
}

import { PATTERNS as openai } from "./model-catalog/openai";
import { PATTERNS as anthropic } from "./model-catalog/anthropic";
import { PATTERNS as google } from "./model-catalog/google";
import { PATTERNS as deepseek } from "./model-catalog/deepseek";
import { PATTERNS as meta } from "./model-catalog/meta";
import { PATTERNS as mistral } from "./model-catalog/mistral";
import { PATTERNS as qwen } from "./model-catalog/qwen";
import { PATTERNS as xai } from "./model-catalog/xai";
import { PATTERNS as zhipu } from "./model-catalog/zhipu";
import { PATTERNS as moonshot } from "./model-catalog/moonshot";
import { PATTERNS as nvidia } from "./model-catalog/nvidia";
import { PATTERNS as minimax } from "./model-catalog/minimax";
import { PATTERNS as morph } from "./model-catalog/morph";
import { PATTERNS as blackbox } from "./model-catalog/blackbox";
import { PATTERNS as amazon } from "./model-catalog/amazon";
import { PATTERNS as githubCopilot } from "./model-catalog/github-copilot";
import { PATTERNS as codex } from "./model-catalog/codex";

const PATTERNS: Pattern[] = [
  ...openai,
  ...anthropic,
  ...google,
  ...deepseek,
  ...meta,
  ...mistral,
  ...qwen,
  ...xai,
  ...zhipu,
  ...moonshot,
  ...nvidia,
  ...minimax,
  ...morph,
  ...blackbox,
  ...amazon,
  ...githubCopilot,
  ...codex,
];

/** Look up metadata for a model id by matching against known model families. */
export function metaForModel(modelId: string): ModelMeta | null {
  const id = modelId.toLowerCase();
  for (const p of PATTERNS) {
    if (p.re.test(id)) return p.meta;
  }
  return null;
}

/**
 * Merge upstream-provided metadata with the catalog. Upstream wins when it
 * provides a non-null value; catalog fills the rest.
 */
export function resolveModelMeta(
  modelId: string,
  upstream: { contextLength?: number | null; maxOutputTokens?: number | null; capabilities?: string[] | null },
): ModelMeta | null {
  const cat = metaForModel(modelId);
  const contextLength = upstream.contextLength ?? cat?.contextLength ?? null;
  const maxOutputTokens = upstream.maxOutputTokens ?? cat?.maxOutputTokens ?? null;
  const caps = new Set<string>([...(upstream.capabilities ?? []), ...(cat?.capabilities ?? [])]);
  if (contextLength == null && maxOutputTokens == null && caps.size === 0) return null;
  return {
    contextLength: contextLength ?? 128_000,
    maxOutputTokens: maxOutputTokens ?? 8_192,
    capabilities: [...caps],
  };
}
