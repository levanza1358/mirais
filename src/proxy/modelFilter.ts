// Model sync filter — decides which upstream models are worth keeping.
//
// Two layers, applied to every provider at sync time:
//   1. isNonChatModel  — drops anything that clearly isn't a chat-completion
//      model (embeddings, image, audio, moderation, rerankers, …).
//   2. isCuratedChatModel — in "curated" mode, additionally keeps only the
//      flagship chat families from well-known vendors so providers with huge
//      catalogs (e.g. BlackBox's 123 models) stay clean and usable.

/** True when the model is clearly NOT a chat completion model. */
export function isNonChatModel(id: string): boolean {
  const s = id.toLowerCase();
  return /embedding|embed|bge-|text-ada|tts|whisper|transcribe|audio|voice|speech|dall-e|image|img|flux|seedream|stable-diffusion|sdxl|banana|photo|paint|upscal|moderation|guard|safety|rerank|rank|classify|classifier|realtime|search-grounding|codey|gecko|-edit|\/edit|inpaint/.test(s);
}

/**
 * Curated allowlist of flagship chat model families (matched as lowercase
 * substrings against the model id). Covers the major vendors any provider
 * (BlackBox, direct, …) might expose.
 */
const CURATED_FAMILIES: readonly string[] = [
  // OpenAI
  "gpt-4o", "gpt-4.1", "gpt-4.5", "gpt-5", "o3", "o4-mini",
  // Anthropic
  "claude-opus", "claude-sonnet", "claude-haiku",
  // Google
  "gemini-2.5", "gemini-2.0-flash", "gemini-pro",
  // DeepSeek
  "deepseek-chat", "deepseek-reasoner", "deepseek-v3", "deepseek-r1",
  // Meta Llama
  "llama-3.3", "llama-3.1-405", "llama-3.1-70", "llama-4",
  // Qwen
  "qwen3", "qwen-2.5-72", "qwen2.5-72", "qwen-max", "qwen-plus", "qwq",
  // Moonshot / Kimi
  "kimi-k2", "kimi-latest", "moonshot-v1",
  // Mistral
  "mistral-large", "mistral-medium", "mistral-small", "codestral", "mixtral-8x22",
  // xAI
  "grok-3", "grok-4", "grok-2",
  // Microsoft
  "phi-4",
  // Cohere
  "command-r-plus", "command-a",
  // Amazon
  "nova-pro", "nova-premier",
];

/** True when the model belongs to a curated flagship chat family. */
export function isCuratedChatModel(id: string): boolean {
  if (isNonChatModel(id)) return false;
  const s = id.toLowerCase();
  return CURATED_FAMILIES.some((f) => s.includes(f));
}

export type ModelSyncMode = "curated" | "all";

/**
 * Decide whether a model should be kept at sync time.
 * In "all" mode everything chat-capable is kept; in "curated" mode only the
 * flagship families survive.
 */
export function keepModel(id: string, mode: ModelSyncMode): boolean {
  if (isNonChatModel(id)) return false;
  if (mode === "all") return true;
  return isCuratedChatModel(id);
}
