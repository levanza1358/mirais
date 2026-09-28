import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "../src/store/sql";
import { freshDb } from "./helpers";
import { ProvidersRepo } from "../src/store/repos/providers";
import { AliasesRepo, CombosRepo } from "../src/store/repos/routing";
import { Router } from "../src/proxy/router";
import { GatewayError } from "../src/shared/errors";
import { executeRequest } from "../src/proxy/executor";

// A 429 whose Retry-After must be honoured, and whose per-minute window hints
// should be captured. Mirrors Atria's documented response shape.
function atriaRateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": "42",
      "x-rpm-limit": "60",
      "x-rpm-remaining": "0",
    },
  });
}

let db: Database;
let providers: ProvidersRepo;
let router: Router;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  db = await freshDb();
  providers = new ProvidersRepo(db);
  router = new Router(providers, new AliasesRepo(db), new CombosRepo(db));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function seedOpenAiProvider(name: string): Promise<{ id: string; accountId: string }> {
  const p = await providers.create({ name, type: "openai" });
  const account = await providers.addAccount(p.id, { label: "main", apiKey: "sk-test" });
  await providers.updateAccount(account.id, { lastWarmupStatus: "healthy" });
  await providers.upsertModel(p.id, "gpt-4o-mini");
  return { id: p.id, accountId: account.id };
}

describe("upstream rate-limit headers", () => {
  test("Retry-After drives the persisted cooldown window", async () => {
    await seedOpenAiProvider("rl");
    const { candidates } = await router.resolve("gpt-4o-mini");
    globalThis.fetch = (async () => atriaRateLimitResponse()) as unknown as typeof fetch;

    const before = Date.now();
    let thrown: unknown;
    try {
      await executeRequest({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }, candidates, {}, providers);
    } catch (err) {
      thrown = err;
    }

    // The structured field is populated from the header, not scraped from text.
    expect(thrown).toBeInstanceOf(GatewayError);
    expect((thrown as GatewayError).retryAfterSec).toBe(42);
    expect((thrown as GatewayError).rateLimit).toEqual({ limit: 60, remaining: 0 });

    // A plain 429 is model-scoped, so the persisted cooldown lands on
    // account_model_cooldowns (not the account-wide rate_limited_until) and
    // should reflect ~42s from the header, not the 60s default.
    const row = await db
      .query("SELECT until FROM account_model_cooldowns WHERE model_id = ?")
      .get<{ until: number }>("gpt-4o-mini");
    expect(row).toBeTruthy();
    const delta = row!.until - before;
    expect(delta).toBeGreaterThan(35_000);
    expect(delta).toBeLessThan(50_000);
  });

  test("missing headers leave the structured fields undefined", () => {
    const err = new GatewayError(429, "rate_limit_error", "Rate limit exceeded");
    expect(err.retryAfterSec).toBeUndefined();
    expect(err.rateLimit).toBeUndefined();
  });
});
