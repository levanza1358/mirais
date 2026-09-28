// Atria provider detection.
//
// The console token-quota scraper was removed: the API key alone is enough to
// route requests, and no reliable upstream quota endpoint exists. The only
// thing still needed here is `isAtriaProvider`, which other Atria features
// (auto-login, session capture) use to recognise the provider.

import type { Provider } from "../shared/types";

/**
 * Recognise an Atria provider.
 *
 * Atria ships as a `custom`-type preset, so it cannot be identified by
 * `Provider.type` alone — fall back to the base URL host and the provider name.
 */
export function isAtriaProvider(provider: Pick<Provider, "type" | "name" | "base_url">): boolean {
  if (provider.base_url && /(^|\/\/)(api\.)?atria-asi\.ai\b/i.test(provider.base_url)) return true;
  const name = provider.name.toLowerCase();
  return name === "atria" || name.startsWith("atria-");
}
