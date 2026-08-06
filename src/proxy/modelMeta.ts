// ── Model metadata catalog ──
//
// Many upstreams (e.g. BlackBox) return only `{ id, object, created }` from
// /models — no context window or output limits. This catalog fills those gaps
// from each model's *publicly documented* specs, keyed by name pattern, so the
// values follow the model itself rather than being hardcoded per account.
//
// Precedence at sync time: upstream-provided value → this catalog → null.

export interface ModelMeta {
  contextLength: number;
  maxOutputTokens: number;
  capabilities: string[];
}

interface Pattern {
  re: RegExp;
  meta: ModelMeta;
}

// Ordered most-specific → most-general. First match wins.
const PATTERNS: Pattern[] = [
  // ── OpenAI GPT-5 / Codex ──
  { re: /gpt-5(\.\d+)?-codex|codex/i, meta: { contextLength: 400_000, maxOutputTokens: 128_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gpt-5/i, meta: { contextLength: 400_000, maxOutputTokens: 128_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gpt-4\.1/i, meta: { contextLength: 1_047_576, maxOutputTokens: 32_768, capabilities: ["tools", "json", "vision"] } },
  { re: /gpt-4o/i, meta: { contextLength: 128_000, maxOutputTokens: 16_384, capabilities: ["tools", "json", "vision"] } },
  { re: /gpt-4-turbo/i, meta: { contextLength: 128_000, maxOutputTokens: 4_096, capabilities: ["tools", "json", "vision"] } },
  { re: /\bo[134](-mini|-pro)?\b/i, meta: { contextLength: 200_000, maxOutputTokens: 100_000, capabilities: ["reasoning", "tools", "json", "vision"] } },

  // ── Anthropic Claude ──
  { re: /claude-.*(opus|sonnet|haiku).*4/i, meta: { contextLength: 200_000, maxOutputTokens: 64_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /claude.*3-5-sonnet/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /claude.*3-5-haiku/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /claude.*3-opus/i, meta: { contextLength: 200_000, maxOutputTokens: 4_096, capabilities: ["tools", "json", "vision"] } },
  { re: /claude/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },

  // ── Google Gemini ──
  { re: /gemini-.*(2\.5|3)/i, meta: { contextLength: 1_048_576, maxOutputTokens: 65_536, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gemini.*flash/i, meta: { contextLength: 1_048_576, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /gemini.*pro/i, meta: { contextLength: 2_097_152, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /gemma/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── DeepSeek ──
  { re: /deepseek.*(r1|reason|think)/i, meta: { contextLength: 128_000, maxOutputTokens: 64_000, capabilities: ["reasoning", "tools", "json"] } },
  { re: /deepseek.*(vl|vision)/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /deepseek-v4/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /deepseek/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── Meta Llama ──
  { re: /llama-3\.[23]/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /llama-3\.1-405/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /llama-3\.1/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /llama-4/i, meta: { contextLength: 1_048_576, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /llama/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── Mistral ──
  { re: /codestral/i, meta: { contextLength: 256_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /devstral/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /mistral.*large/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /mistral|mixtral|ministral/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── Qwen ──
  { re: /qwen.*(max|plus|turbo)/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /qwen|qwq/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["reasoning", "tools", "json"] } },

  // ── xAI Grok ──
  { re: /grok-4/i, meta: { contextLength: 256_000, maxOutputTokens: 16_384, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /grok-3/i, meta: { contextLength: 131_072, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /grok/i, meta: { contextLength: 131_072, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── Zhipu GLM ──
  { re: /glm-5v|glm-4v|glm.*vision/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /glm-5/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["reasoning", "tools", "json"] } },
  { re: /glm-4/i, meta: { contextLength: 128_000, maxOutputTokens: 4_096, capabilities: ["tools", "json"] } },

  // ── Moonshot Kimi ──
  { re: /kimi.*(vision|vl)/i, meta: { contextLength: 256_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /kimi/i, meta: { contextLength: 256_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── NVIDIA Nemotron ──
  { re: /nemotron/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── MiniMax ──
  { re: /minimax.*(vision|vl|image)/i, meta: { contextLength: 1_000_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /minimax-m3/i, meta: { contextLength: 1_000_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /minimax/i, meta: { contextLength: 1_000_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── Morph ──
  { re: /morph/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── OpenAI open-weight / BlackBox own ──
  { re: /gpt-oss/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /blackbox-pro/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // ── Amazon Nova ──
  { re: /nova.*pro/i, meta: { contextLength: 300_000, maxOutputTokens: 5_000, capabilities: ["tools", "json", "vision"] } },
  { re: /nova/i, meta: { contextLength: 128_000, maxOutputTokens: 5_000, capabilities: ["tools", "json"] } },
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
