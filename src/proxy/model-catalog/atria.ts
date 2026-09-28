import type { ModelMeta } from "../modelMeta";

// Atria (api.atria-asi.ai) currently exposes a single model, `Atria-Dawn-Preview`.
//
// Documented facts (https://api.atria-asi.ai/docs):
//   - 256K context window (input + generated content share it)
//   - output limit is an integer from 1 to 65,536 tokens
//   - text-only: `input_modalities: ["text"]`; sending an image fails with
//     `400 Atria-Dawn-Preview is not a multimodal model`. The docs' Codex guide
//     declares the model text-only so clients stop attaching screenshots, and
//     this catalog mirrors that by listing no "vision" capability.
//   - supports tool/function calling and JSON mode across all three APIs
//
// Model ids are case-sensitive upstream, but the matcher lowercases its input.
export const PATTERNS: { re: RegExp; meta: ModelMeta }[] = [
  {
    re: /atria[-_ ]?dawn/i,
    meta: {
      contextLength: 256_000,
      maxOutputTokens: 65_536,
      capabilities: ["tools", "json"],
    },
  },
];
