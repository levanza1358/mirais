import type { ModelMeta } from "../modelMeta";

// GitHub Copilot exposes models from multiple providers (OpenAI, Anthropic,
// Google, Meta, etc.) via the Copilot backend. These patterns cover the
// model IDs returned by the Copilot sidecar /v1/models endpoint.
export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  // OpenAI models served through Copilot
  { re: /gpt-5(\.\d+)?-codex|codex/i, meta: { contextLength: 400_000, maxOutputTokens: 128_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gpt-5/i, meta: { contextLength: 400_000, maxOutputTokens: 128_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gpt-4\.1/i, meta: { contextLength: 1_047_576, maxOutputTokens: 32_768, capabilities: ["tools", "json", "vision"] } },
  { re: /gpt-4o/i, meta: { contextLength: 128_000, maxOutputTokens: 16_384, capabilities: ["tools", "json", "vision"] } },
  { re: /gpt-4-turbo/i, meta: { contextLength: 128_000, maxOutputTokens: 4_096, capabilities: ["tools", "json", "vision"] } },
  { re: /\bo[134](-mini|-pro)?\b/i, meta: { contextLength: 200_000, maxOutputTokens: 100_000, capabilities: ["reasoning", "tools", "json", "vision"] } },

  // Anthropic models served through Copilot
  { re: /claude-.*(opus|sonnet|haiku).*4/i, meta: { contextLength: 200_000, maxOutputTokens: 64_000, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /claude.*3-5-sonnet/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /claude.*3-5-haiku/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /claude.*3-opus/i, meta: { contextLength: 200_000, maxOutputTokens: 4_096, capabilities: ["tools", "json", "vision"] } },
  { re: /claude/i, meta: { contextLength: 200_000, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },

  // Google models served through Copilot
  { re: /gemini-.*(2\.5|3)/i, meta: { contextLength: 1_048_576, maxOutputTokens: 65_536, capabilities: ["reasoning", "tools", "json", "vision"] } },
  { re: /gemini.*flash/i, meta: { contextLength: 1_048_576, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /gemini.*pro/i, meta: { contextLength: 2_097_152, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },

  // Meta models served through Copilot
  { re: /llama-4/i, meta: { contextLength: 1_048_576, maxOutputTokens: 8_192, capabilities: ["tools", "json", "vision"] } },
  { re: /llama/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // DeepSeek models served through Copilot
  { re: /deepseek.*(r1|reason|think)/i, meta: { contextLength: 128_000, maxOutputTokens: 64_000, capabilities: ["reasoning", "tools", "json"] } },
  { re: /deepseek/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // Mistral models served through Copilot
  { re: /codestral/i, meta: { contextLength: 256_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },
  { re: /mistral|mixtral|ministral/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["tools", "json"] } },

  // Qwen models served through Copilot
  { re: /qwen|qwq/i, meta: { contextLength: 128_000, maxOutputTokens: 8_192, capabilities: ["reasoning", "tools", "json"] } },
];