import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "../src/store/sql";
import { freshDb } from "./helpers";
import { ProvidersRepo } from "../src/store/repos/providers";
import { AliasesRepo, CombosRepo } from "../src/store/repos/routing";
import { Router, baseUrlFor, upstreamFormat } from "../src/proxy/router";
import { GatewayError } from "../src/shared/errors";
import { buildAccountPlan, clampMaxTokens, executeRequest, limitAttemptsPerCandidate } from "../src/proxy/executor";

let db: Database;
let providers: ProvidersRepo;
let aliases: AliasesRepo;
let combos: CombosRepo;
let router: Router;

beforeEach(async () => {
  db = await freshDb();
  providers = new ProvidersRepo(db);
  aliases = new AliasesRepo(db);
  combos = new CombosRepo(db);
  router = new Router(providers, aliases, combos);
});

async function seedProvider(name: string, type: "openai" | "anthropic", models: string[], priority = 100) {
  const p = await providers.create({ name, type, priority });
  const account = await providers.addAccount(p.id, { label: "main", apiKey: "sk-test" });
  await providers.updateAccount(account.id, { lastWarmupStatus: "healthy" });
  for (const model of models) await providers.upsertModel(p.id, model);
  return p;
}

describe("baseUrlFor / upstreamFormat", () => {
  test("default base urls per type", async () => {
    const p = await providers.create({ name: "a", type: "anthropic" });
    expect(baseUrlFor(p)).toBe("https://api.anthropic.com");
    expect(upstreamFormat(p)).toBe("anthropic");
  });

  test("custom base_url wins", async () => {
    const p = await providers.create({ name: "c", type: "custom", baseUrl: "http://localhost:9999/v1" });
    expect(baseUrlFor(p)).toBe("http://localhost:9999/v1");
    expect(upstreamFormat(p)).toBe("openai");
  });

  test("GitHub Copilot uses the account sidecar URL", async () => {
    const p = await providers.create({ name: "github-copilot", type: "github-copilot" });
    const account = await providers.addAccount(p.id, { label: "personal", baseUrl: "http://127.0.0.1:4141/v1" });
    expect(baseUrlFor(p, account)).toBe("http://127.0.0.1:4141/v1");
    expect(upstreamFormat(p)).toBe("openai");
  });
});

describe("Router.resolve", () => {
  test("qualified provider/model", async () => {
    await seedProvider("openai-main", "openai", ["gpt-4o"]);
    const r = await router.resolve("openai-main/gpt-4o");
    expect(r.kind).toBe("qualified");
    expect(r.candidates[0]!.modelId).toBe("gpt-4o");
    expect(r.candidates[0]!.accounts.length).toBe(1);
  });

  test("qualified unknown provider → 404", async () => {
    try { await router.resolve("nope/gpt-4o"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(404); }
  });

  test("slashed model id with unknown first segment falls back to direct resolution", async () => {
    // BlackBoxAI-style ids: "blackboxai/meta/llama-3.1-70b" where "blackboxai"
    // is NOT a provider name — the whole string is the upstream model id.
    await seedProvider("blackbox", "openai", ["blackboxai/meta/llama-3.1-70b"]);
    const r = await router.resolve("blackboxai/meta/llama-3.1-70b");
    expect(r.kind).toBe("direct");
    expect(r.candidates[0]!.provider.name).toBe("blackbox");
    expect(r.candidates[0]!.modelId).toBe("blackboxai/meta/llama-3.1-70b");
  });

  test("known provider prefix still wins over direct fallback", async () => {
    await seedProvider("blackbox", "openai", ["meta/llama-3.1-70b", "blackbox/meta/llama-3.1-70b"]);
    const r = await router.resolve("blackbox/meta/llama-3.1-70b");
    expect(r.kind).toBe("qualified");
    expect(r.candidates[0]!.modelId).toBe("meta/llama-3.1-70b");
  });

  test("direct model id across providers, priority order", async () => {
    await seedProvider("p-low", "openai", ["gpt-4o"], 200);
    await seedProvider("p-high", "openai", ["gpt-4o"], 50);
    const r = await router.resolve("gpt-4o");
    expect(r.kind).toBe("direct");
    expect(r.candidates.length).toBe(2);
    expect(r.candidates[0]!.provider.name).toBe("p-high");
  });

  test("unknown model → 404 with helpful message", async () => {
    try { await router.resolve("no-such-model"); expect.unreachable(); }
    catch (e) {
      expect((e as GatewayError).status).toBe(404);
      expect((e as GatewayError).message).toContain("alias");
    }
  });

  test("alias → target resolution", async () => {
    await seedProvider("prov", "openai", ["gpt-4o-mini"]);
    await aliases.create("cheap", "gpt-4o-mini");
    const r = await router.resolve("cheap");
    expect(r.kind).toBe("alias");
    expect(r.candidates[0]!.modelId).toBe("gpt-4o-mini");
  });

  test("alias cycle → 400", async () => {
    await aliases.create("a", "b");
    await aliases.create("b", "a");
    try { await router.resolve("a"); expect.unreachable(); }
    catch (e) {
      expect((e as GatewayError).status).toBe(400);
      expect((e as GatewayError).message).toContain("cycle");
    }
  });

  test("combo aggregates entries in order, skips unresolvable", async () => {
    await seedProvider("p1", "openai", ["m1"]);
    await seedProvider("p2", "anthropic", ["m2"]);
    await combos.create("fallback", ["m1", "nonexistent", "m2"]);
    const r = await router.resolve("fallback");
    expect(r.kind).toBe("combo");
    expect(r.candidates.map((c) => c.modelId)).toEqual(["m1", "m2"]);
  });

  test("documented combo:name syntax resolves", async () => {
    await seedProvider("p1", "openai", ["m1"]);
    await combos.create("fallback", ["m1"]);
    const r = await router.resolve("combo:fallback");
    expect(r.kind).toBe("combo");
    expect(r.candidates[0]!.modelId).toBe("m1");
  });

  test("combo cycle → 400", async () => {
    await combos.create("a", ["combo:b"]);
    await combos.create("b", ["combo:a"]);
    try { await router.resolve("combo:a"); expect.unreachable(); }
    catch (e) {
      expect((e as GatewayError).status).toBe(400);
      expect((e as GatewayError).message).toContain("cycle");
    }
  });

  test("combo with no usable entries → 503", async () => {
    await combos.create("empty", ["nope1", "nope2"]);
    try { await router.resolve("empty"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(503); }
  });

  test("provider without enabled accounts → 503", async () => {
    const p = await providers.create({ name: "noacct", type: "openai" });
    await providers.upsertModel(p.id, "m");
    try { await router.resolve("noacct/m"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(503); }
  });

  test("provider with no healthy accounts → 503", async () => {
    const p = await providers.create({ name: "unhealthy", type: "openai" });
    const account = await providers.addAccount(p.id, { label: "main", apiKey: "sk-test" });
    await providers.updateAccount(account.id, { lastWarmupStatus: "failing" });
    await providers.upsertModel(p.id, "m");
    try { await router.resolve("unhealthy/m"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(503); }
  });

  test("disabled provider is skipped in direct resolution", async () => {
    const p = await seedProvider("off", "openai", ["mx"]);
    await providers.update(p.id, { enabled: false });
    try { await router.resolve("mx"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(404); }
  });

  test("qualified unknown or disabled model → 404", async () => {
    const p = await seedProvider("provider", "openai", ["enabled", "disabled"]);
    await providers.upsertModel(p.id, "disabled", { enabled: false });
    for (const model of ["provider/unknown", "provider/disabled"]) {
      try { await router.resolve(model); expect.unreachable(); }
      catch (e) { expect((e as GatewayError).status).toBe(404); }
    }
  });
});

describe("combo streaming failover", () => {
  test("fails over between GitHub Copilot account sidecars", async () => {
    const p = await providers.create({ name: "github-copilot", type: "github-copilot", accountStrategy: "round_robin" });
    const first = await providers.addAccount(p.id, { label: "first", baseUrl: "http://127.0.0.1:4141/v1" });
    const second = await providers.addAccount(p.id, { label: "second", baseUrl: "http://127.0.0.1:4142/v1" });
    await providers.updateAccount(first.id, { lastWarmupStatus: "healthy" });
    await providers.updateAccount(second.id, { lastWarmupStatus: "healthy" });
    await providers.upsertModel(p.id, "gpt-5");
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    let endpointCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/endpoint")) {
        endpointCalls++;
        return new Response(JSON.stringify({
          baseUrl: "https://api.copilot.example.com",
          apiKey: "test-key",
          headers: { "Content-Type": "application/json" },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("/quota")) {
        return new Response(JSON.stringify({ quotaSnapshots: {} }), { headers: { "content-type": "application/json" } });
      }
      return endpointCalls === 1
        ? new Response("rate limited", { status: 429 })
        : new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
      const result = await executeRequest({ model: "github-copilot/gpt-5", messages: [{ role: "user", content: "hi" }], stream: true }, (await router.resolve("github-copilot/gpt-5")).candidates, {}, providers);
      expect(result.kind).toBe("stream");
      expect(urls[0]).toContain("/quota");
      expect(urls[1]).toContain("/endpoint?model=gpt-5");
      expect(urls[2]).toBe("https://api.copilot.example.com/chat/completions");
      expect(urls[3]).toContain("/quota");
      expect(urls[4]).toContain("/endpoint?model=gpt-5");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to the sidecar when the direct backend does not support the model", async () => {
    const p = await providers.create({ name: "gh", type: "github-copilot" });
    const account = await providers.addAccount(p.id, { label: "main", baseUrl: "http://127.0.0.1:4141/v1" });
    await providers.updateAccount(account.id, { lastWarmupStatus: "healthy" });
    await providers.upsertModel(p.id, "claude-opus-4.8-fast");
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/quota")) return Response.json({ quotaSnapshots: {} });
      if (url.includes("/endpoint")) {
        return Response.json({ baseUrl: "https://api.copilot.example.com", apiKey: "k", headers: {} });
      }
      // The direct backend must never be contacted for Claude models — it
      // leaves streaming requests open until timeout instead of answering.
      if (url.startsWith("https://api.copilot.example.com")) {
        throw new Error("direct backend should not be called for Claude models");
      }
      // Sidecar SDK route handles Claude models the direct backend rejects.
      if (url === "http://127.0.0.1:4141/v1/chat/completions") {
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const result = await executeRequest(
        { model: "gh/claude-opus-4.8-fast", messages: [{ role: "user", content: "hi" }], stream: true },
        (await router.resolve("gh/claude-opus-4.8-fast")).candidates,
        {},
        providers,
      );
      expect(result.kind).toBe("stream");
      if (result.kind !== "stream") return;
      expect(await new Response(result.stream).text()).toContain('"content":"OK"');
      // Model stays enabled — it works through the sidecar.
      expect((await providers.getProviderModel(p.id, "claude-opus-4.8-fast"))?.enabled).toBe(1);
      expect(urls).toContain("http://127.0.0.1:4141/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("disables a retired Copilot model and fails over instead of cooling down", async () => {
    const p = await providers.create({ name: "gh", type: "github-copilot" });
    const account = await providers.addAccount(p.id, { label: "main", baseUrl: "http://127.0.0.1:4141/v1" });
    await providers.updateAccount(account.id, { lastWarmupStatus: "healthy" });
    await providers.upsertModel(p.id, "claude-retired");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/quota")) return Response.json({ quotaSnapshots: {} });
      if (url.includes("/endpoint")) {
        return Response.json({ baseUrl: "https://api.copilot.example.com", apiKey: "k", headers: {} });
      }
      return new Response(JSON.stringify({
        error: { message: 'The requested model is not available for integrator "copilot-developer-cli". Available models: [gpt-4.1]', code: "model_not_available_for_integrator" },
      }), { status: 400 });
    }) as unknown as typeof fetch;
    try {
      await expect(executeRequest(
        { model: "gh/claude-retired", messages: [{ role: "user", content: "hi" }], stream: true },
        (await router.resolve("gh/claude-retired")).candidates,
        {},
        providers,
      )).rejects.toThrow(/not available for integrator/);
      expect((await providers.getProviderModel(p.id, "claude-retired"))?.enabled).toBe(0);
      expect((await providers.getAccount(account.id))?.rate_limited_until).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("tries the next model when a 200 SSE stream ends before output", async () => {
    await seedProvider("first", "openai", ["m1"], 10);
    await seedProvider("second", "openai", ["m2"], 20);
    await combos.create("fallback", ["first/m1", "second/m2"]);
    const candidates = (await router.resolve("combo:fallback")).candidates;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(calls === 1
        ? 'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n'
        : 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await executeRequest({
        model: "combo:fallback",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }, candidates, {}, providers);
      expect(result.kind).toBe("stream");
      if (result.kind !== "stream") return;
      expect(result.candidate.provider.name).toBe("second");
      expect(await new Response(result.stream).text()).toContain('"content":"OK"');
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("tries the next model when a combo candidate rejects a large payload", async () => {
    await seedProvider("small", "openai", ["m1"], 10);
    await seedProvider("large", "openai", ["m2"], 20);
    await combos.create("payload-fallback", ["small/m1", "large/m2"]);
    const candidates = (await router.resolve("combo:payload-fallback")).candidates;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? new Response("Request Entity Too Large", { status: 413 })
        : new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
    }) as unknown as typeof fetch;
    try {
      const result = await executeRequest({
        model: "combo:payload-fallback",
        messages: [{ role: "user", content: "large prompt" }],
        stream: true,
      }, candidates, { allowPayloadTooLargeFallback: true }, providers);
      expect(result.kind).toBe("stream");
      if (result.kind !== "stream") return;
      expect(result.candidate.provider.name).toBe("large");
      expect(await new Response(result.stream).text()).toContain('"content":"OK"');
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("model output limits", () => {
  test("stored provider limit overrides static model metadata", async () => {
    const p = await seedProvider("provider", "openai", ["gpt-4o"]);
    await providers.upsertModel(p.id, "gpt-4o", { maxOutputTokens: 1234 });
    const candidate = (await router.resolve("provider/gpt-4o")).candidates[0]!;
    const result = await clampMaxTokens({ model: "provider/gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 9999 }, candidate, providers);
    expect(result.max_tokens).toBe(1234);
  });
});

describe("provider account strategy", () => {
  async function candidateWithAccounts(strategy: "priority" | "round_robin", suffix = "main") {
    const p = await providers.create({ name: `accounts-${strategy}-${suffix}`, type: "openai", accountStrategy: strategy });
    for (const [label, priority] of [["free", 0], ["plus", 10], ["pro", 20]] as const) {
      const account = await providers.addAccount(p.id, { label, apiKey: `sk-${label}`, priority });
      await providers.updateAccount(account.id, { lastWarmupStatus: "healthy", planType: label });
    }
    await providers.upsertModel(p.id, "m");
    return (await router.resolve(`${p.name}/m`)).candidates[0]!;
  }

  test("priority always starts from the lowest account priority", async () => {
    const candidate = await candidateWithAccounts("priority");
    expect((await buildAccountPlan([candidate])).map(({ account }) => account.label)).toEqual(["free", "plus", "pro"]);
    expect((await buildAccountPlan([candidate])).map(({ account }) => account.label)).toEqual(["free", "plus", "pro"]);
  });

  test("round robin rotates independently per provider model", async () => {
    const candidate = await candidateWithAccounts("round_robin");
    expect((await buildAccountPlan([candidate])).map(({ account }) => account.label)).toEqual(["free", "plus", "pro"]);
    expect((await buildAccountPlan([candidate])).map(({ account }) => account.label)).toEqual(["plus", "pro", "free"]);
  });

  test("attempt limit applies to each combo candidate", async () => {
    const first = await candidateWithAccounts("priority", "attempts");
    const second = { ...first, modelId: "fallback" };
    const limited = limitAttemptsPerCandidate(await buildAccountPlan([first, second]), 2);
    expect(limited.map(({ candidate, account }) => `${candidate.modelId}/${account.label}`)).toEqual([
      "m/free", "m/plus", "fallback/free", "fallback/plus",
    ]);
  });
});

describe("model sync provenance", () => {
  test("prunes stale synced models but preserves manual models when prune enabled", async () => {
    const p = await seedProvider("provider", "openai", []);
    await providers.upsertModel(p.id, "manual-model");
    await providers.upsertModel(p.id, "stale-model", { source: "sync" });
    await providers.upsertModel(p.id, "kept-model", { source: "sync" });
    const pruned = await providers.replaceSyncedModels(p.id, [{ id: "kept-model", contextLength: 1000, maxOutputTokens: 100, capabilities: [] }], true);
    expect(pruned).toBe(1);
    expect((await providers.listModels(p.id)).map((model) => model.model_id).sort()).toEqual(["kept-model", "manual-model"]);
    expect((await providers.getProviderModel(p.id, "manual-model"))?.source).toBe("manual");
  });

  test("keeps stale synced models by default (no prune)", async () => {
    const p = await seedProvider("provider", "openai", []);
    await providers.upsertModel(p.id, "stale-model", { source: "sync" });
    await providers.upsertModel(p.id, "kept-model", { source: "sync" });
    const pruned = await providers.replaceSyncedModels(p.id, [{ id: "kept-model", contextLength: 1000, maxOutputTokens: 100, capabilities: [] }]);
    expect(pruned).toBe(0);
    expect((await providers.listModels(p.id)).map((model) => model.model_id).sort()).toEqual(["kept-model", "stale-model"]);
  });

  test("sync does not clobber manually curated metadata with upstream nulls", async () => {
    const p = await seedProvider("provider", "openai", []);
    await providers.upsertModel(p.id, "curated-model", { contextLength: 128_000, maxOutputTokens: 4096, capabilities: ["tools"] });
    // Upstream catalog omits all metadata → nulls must not erase the curated values.
    await providers.replaceSyncedModels(p.id, [{ id: "curated-model", contextLength: null, maxOutputTokens: null, capabilities: null }]);
    const model = await providers.getProviderModel(p.id, "curated-model");
    expect(model?.source).toBe("manual");
    expect(model?.context_length).toBe(128_000);
    expect(model?.max_output_tokens).toBe(4096);
    expect(model?.capabilities).toBe(JSON.stringify(["tools"]));
  });

  for (const source of ["manual", "sync"] as const) {
    for (const capabilities of [null, []]) {
      test(`sync preserves ${source} metadata with ${JSON.stringify(capabilities)} capabilities`, async () => {
        const p = await seedProvider("provider", "openai", []);
        await providers.upsertModel(p.id, "model", { source, contextLength: 128_000, maxOutputTokens: 4096, capabilities: ["tools"] });
        await providers.replaceSyncedModels(p.id, [{ id: "model", contextLength: null, maxOutputTokens: null, capabilities }]);
        const model = await providers.getProviderModel(p.id, "model");
        expect(model?.source).toBe(source);
        expect(model?.context_length).toBe(128_000);
        expect(model?.max_output_tokens).toBe(4096);
        expect(model?.capabilities).toBe(JSON.stringify(["tools"]));
      });
    }
    test(`manual edits can clear ${source} metadata`, async () => {
      const p = await seedProvider("provider", "openai", []);
      await providers.upsertModel(p.id, "model", { source, contextLength: 128_000, maxOutputTokens: 4096, capabilities: ["tools"] });
      await providers.upsertModel(p.id, "model", { contextLength: null, maxOutputTokens: null, capabilities: [] });
      const model = await providers.getProviderModel(p.id, "model");
      expect(model?.context_length).toBeNull();
      expect(model?.max_output_tokens).toBeNull();
      expect(model?.capabilities).toBe("[]");
      await providers.upsertModel(p.id, "model", { capabilities: null });
      expect((await providers.getProviderModel(p.id, "model"))?.capabilities).toBeNull();
    });
  }

  test("sync fills metadata for synced models when upstream provides it", async () => {
    const p = await seedProvider("provider", "openai", []);
    await providers.upsertModel(p.id, "synced-model", { source: "sync", contextLength: 128_000 });
    await providers.replaceSyncedModels(p.id, [{ id: "synced-model", contextLength: 200_000, maxOutputTokens: 8192, capabilities: ["vision"] }]);
    const model = await providers.getProviderModel(p.id, "synced-model");
    expect(model?.context_length).toBe(200_000);
    expect(model?.max_output_tokens).toBe(8192);
    expect(model?.capabilities).toBe(JSON.stringify(["vision"]));
  });
});
