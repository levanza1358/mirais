// Helpers for rendering compact, consistent model names across the dashboard.
// The backend stores fully-qualified model ids (e.g. `blackboxai/openai/gpt-5.4`);
// in UI lists we want short, scannable labels like `bb/gpt-5.4` while preserving
// the full id as the option value for forms and selectors.
//
// Key rule: the provider prefix comes from the provider this model belongs to
// (the Mirais provider name), NOT from upstream segments inside the model id.

const PROVIDER_SHORT: Record<string, string> = {
  blackboxai: "bb",
  blackbox: "bb",
  "codebuddy-cn": "cbc",
  "codebuddy-global": "cbg",
  openai: "oa",
  anthropic: "an",
  google: "gg",
  moonshotai: "ms",
  "x-ai": "x",
};

function shortProviderName(provider: string): string {
  return PROVIDER_SHORT[provider] ?? PROVIDER_SHORT[provider.toLowerCase()] ?? provider;
}

/**
 * Simplify a raw model_id for display.  Strips all intermediate vendor
 * segments and keeps only the last part.
 *
 *   blackboxai/openai/gpt-5.4   → gpt-5.4
 *   blackboxai/mistral/codestral → codestral
 *   moonshotai/kimi-k3           → kimi-k3
 */
function stripModelVendorSegments(modelId: string): string {
  const parts = modelId.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? modelId;
}

/**
 * Render a model label scoped to a provider.
 *
 *   labelForProvider("blackboxai", "blackboxai/openai/gpt-5.4")  → bb/gpt-5.4
 *   labelForProvider("blackboxai", "moonshotai/kimi-k3")         → bb/kimi-k3
 */
export function labelForProvider(providerName: string, modelId: string): string {
  const short = shortProviderName(providerName);
  const normalizedProvider = providerName.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedProvider && normalizedModelId.startsWith(`${normalizedProvider}/`)) {
    return `${short}/${modelId.slice(providerName.length + 1)}`;
  }
  const tail = stripModelVendorSegments(modelId);
  return `${short}/${tail}`;
}

/**
 * Convenience – same as labelForProvider when you already have the
 * Mirais provider name and model_id.
 */
export { labelForProvider as simplifyModelLabel };

/**
 * Render a `providerName/modelId` qualified target in short form.
 * The first segment is the Mirais provider name, the rest is the model id.
 */
export function simplifyQualifiedTarget(target: string): string {
  const idx = target.indexOf("/");
  if (idx < 0) return target;
  const provider = target.slice(0, idx);
  const modelId = target.slice(idx + 1);
  return labelForProvider(provider, modelId);
}

export function normalizeCustomModelId(input: string): string {
  const value = input.trim();
  if (!value) return value;
  if (value.includes("/")) return value;
  if (/^gpt|^o\d|^codex/i.test(value)) return `blackboxai/openai/${value}`;
  if (/^kimi/i.test(value)) return `moonshotai/${value}`;
  if (/^claude/i.test(value)) return `anthropic/${value}`;
  if (/^gemini/i.test(value)) return `google/${value}`;
  return value;
}