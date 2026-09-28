import { describe, test, expect } from "bun:test";
import { isAtriaProvider } from "../src/proxy/atria-usage";

// The token-quota scraper (parseAtriaConsole / fetchAtriaUsage / cookieHeader /
// rscInt) was removed: the API key alone is enough to route requests and no
// reliable upstream quota endpoint exists. Only provider detection remains.
describe("isAtriaProvider", () => {
  test("matches by base URL host", () => {
    expect(isAtriaProvider({ type: "custom", name: "whatever", base_url: "https://api.atria-asi.ai/v1" })).toBe(true);
  });

  test("matches by name when no base URL is set", () => {
    expect(isAtriaProvider({ type: "custom", name: "atria", base_url: null })).toBe(true);
    expect(isAtriaProvider({ type: "custom", name: "atria-backup", base_url: null })).toBe(true);
  });

  test("rejects unrelated providers", () => {
    expect(isAtriaProvider({ type: "openai", name: "openai", base_url: "https://api.openai.com/v1" })).toBe(false);
    expect(isAtriaProvider({ type: "custom", name: "tokenrouter", base_url: "https://api.tokenrouter.com/v1" })).toBe(false);
  });
});
