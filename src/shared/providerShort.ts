// Short provider prefixes — single source of truth for all compact model IDs.
// Used by: router (PROVIDER_SHORT_ALIASES), routes (/v1/models), integrations catalog,
// repos (providerNameAliases, findModelByShortId), and dashboard display.

export const PROVIDER_SHORT: Record<string, string> = {
  blackboxai: "bb",
  blackbox: "bb",
  "codebuddy-cn": "cbc",
  "codebuddy-global": "cbg",
  openai: "oa",
  anthropic: "an",
  google: "gg",
  moonshotai: "ms",
  "x-ai": "x",
  deepseek: "ds",
  glm: "gl",
  "local-llama": "ll",
};

/** Reverse map: short prefix → provider type. */
export const SHORT_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_SHORT).map(([k, v]) => [v, k]),
);

/** Get short prefix for a provider name/type. Falls back to the name itself. */
export function shortProviderName(name: string): string {
  return PROVIDER_SHORT[name] ?? PROVIDER_SHORT[name.toLowerCase()] ?? name;
}

/** Get full provider name from short prefix. Returns undefined if unknown. */
export function providerFromShort(short: string): string | undefined {
  return SHORT_TO_PROVIDER[short] ?? SHORT_TO_PROVIDER[short.toLowerCase()];
}
