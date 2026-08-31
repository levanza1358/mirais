import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
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

beforeEach(() => {
  db = freshDb();
  providers = new ProvidersRepo(db);
  aliases = new AliasesRepo(db);
  combos = new CombosRepo(db);
  router = new Router(providers, aliases, combos);
});

function seedProvider(name: string, type: "openai" | "anthropic", models: string[], priority = 100) {
  const p = providers.create({ name, type, priority });
  const account = providers.addAccount(p.id, { label: "main", apiKey: "sk-test" });
  providers.updateAccount(account.id, { lastWarmupStatus: "healthy" });
  for (const m of models) providers.upsertModel(p.id, m);
  return p;
}

describe("baseUrlFor / upstreamFormat", () => {
  test("default base urls per type", () => {
    const p = providers.create({ name: "a", type: "anthropic" });
    expect(baseUrlFor(p)).toBe("https://api.anthropic.com");
    expect(upstreamFormat(p)).toBe("anthropic");
  });

  test("custom base_url wins", () => {
    const p = providers.create({ name: "c", type: "custom", baseUrl: "http://localhost:9999/v1" });
    expect(baseUrlFor(p)).toBe("http://localhost:9999/v1");
    expect(upstreamFormat(p)).toBe("openai");
  });

  test("GitHub Copilot uses the account sidecar URL", () => {
    const p = providers.create({ name: "github-copilot", type: "github-copilot" });
    const account = providers.addAccount(p.id, { label: "personal", baseUrl: "http://127.0.0.1:4141/v1" });
    expect(baseUrlFor(p, account)).toBe("http://127.0.0.1:4141/v1");
    expect(upstreamFormat(p)).toBe("openai");
  });
});

describe("Router.resolve", () => {
  test("qualified provider/model", () => {
    seedProvider("openai-main", "openai", ["gpt-4o"]);
    const r = router.resolve("openai-main/gpt-4o");
    expect(r.kind).toBe("qualified");
    expect(r.candidates[0]!.modelId).toBe("gpt-4o");
    expect(r.candidates[0]!.accounts.length).toBe(1);
  });

  test("qualified unknown provider → 404", () => {
    try { router.resolve("nope/gpt-4o"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(404); }
  });

  test("slashed model id with unknown first segment falls back to direct resolution", () => {
    // BlackBoxAI-style ids: "blackboxai/meta/llama-3.1-70b" where "blackboxai"
    // is NOT a provider name — the whole string is the upstream model id.
    seedProvider("blackbox", "openai", ["blackboxai/meta/llama-3.1-70b"]);
    const r = router.resolve("blackboxai/meta/llama-3.1-70b");
    expect(r.kind).toBe("direct");
    expect(r.candidates[0]!.provider.name).toBe("blackbox");
    expect(r.candidates[0]!.modelId).toBe("blackboxai/meta/llama-3.1-70b");
  });

  test("known provider prefix still wins over direct fallback", () => {
    seedProvider("blackbox", "openai", ["meta/llama-3.1-70b", "blackbox/meta/llama-3.1-70b"]);
    const r = router.resolve("blackbox/meta/llama-3.1-70b");
    expect(r.kind).toBe("qualified");
    expect(r.candidates[0]!.modelId).toBe("meta/llama-3.1-70b");
  });

  test("direct model id across providers, priority order", () => {
    seedProvider("p-low", "openai", ["gpt-4o"], 200);
    seedProvider("p-high", "openai", ["gpt-4o"], 50);
    const r = router.resolve("gpt-4o");
    expect(r.kind).toBe("direct");
    expect(r.candidates.length).toBe(2);
    expect(r.candidates[0]!.provider.name).toBe("p-high");
  });

  test("unknown model → 404 with helpful message", () => {
    try { router.resolve("no-such-model"); expect.unreachable(); }
    catch (e) {
      expect((e as GatewayError).status).toBe(404);
      expect((e as GatewayError).message).toContain("alias");
    }
  });

  test("alias → target resolution", () => {
    seedProvider("prov", "openai", ["gpt-4o-mini"]);
    aliases.create("cheap", "gpt-4o-mini");
    const r = router.resolve("cheap");
    expect(r.kind).toBe("alias");
    expect(r.candidates[0]!.modelId).toBe("gpt-4o-mini");
  });

  test("alias cycle → 400", () => {
    aliases.create("a", "b");
    aliases.create("b", "a");
    try { router.resolve("a"); expect.unreachable(); }
    catch (e) {
      expect((e as GatewayError).status).toBe(400);
      expect((e as GatewayError).message).toContain("cycle");
    }
  });

  test("combo aggregates entries in order, skips unresolvable", () => {
    seedProvider("p1", "openai", ["m1"]);
    seedProvider("p2", "anthropic", ["m2"]);
    combos.create("fallback", ["m1", "nonexistent", "m2"]);
    const r = router.resolve("fallback");
    expect(r.kind).toBe("combo");
    expect(r.candidates.map((c) => c.modelId)).toEqual(["m1", "m2"]);
  });

  test("documented combo:name syntax resolves", () => {
    seedProvider("p1", "openai", ["m1"]);
    combos.create("fallback", ["m1"]);
    const r = router.resolve("combo:fallback");
    expect(r.kind).toBe("combo");
    expect(r.candidates[0]!.modelId).toBe("m1");
  });

  test("combo cycle → 400", () => {
    combos.create("a", ["combo:b"]);
    combos.create("b", ["combo:a"]);
    try { router.resolve("combo:a"); expect.unreachable(); }
    catch (e) {
      expect((e as GatewayError).status).toBe(400);
      expect((e as GatewayError).message).toContain("cycle");
    }
  });

  test("combo with no usable entries → 503", () => {
    combos.create("empty", ["nope1", "nope2"]);
    try { router.resolve("empty"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(503); }
  });

  test("provider without enabled accounts → 503", () => {
    const p = providers.create({ name: "noacct", type: "openai" });
    providers.upsertModel(p.id, "m");
    try { router.resolve("noacct/m"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(503); }
  });

  test("provider with no healthy accounts → 503", () => {
    const p = providers.create({ name: "unhealthy", type: "openai" });
    const account = providers.addAccount(p.id, { label: "main", apiKey: "sk-test" });
    providers.updateAccount(account.id, { lastWarmupStatus: "failing" });
    providers.upsertModel(p.id, "m");
    try { router.resolve("unhealthy/m"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(503); }
  });

  test("disabled provider is skipped in direct resolution", () => {
    const p = seedProvider("off", "openai", ["mx"]);
    providers.update(p.id, { enabled: false });
    try { router.resolve("mx"); expect.unreachable(); }
    catch (e) { expect((e as GatewayError).status).toBe(404); }
  });

  test("qualified unknown or disabled model → 404", () => {
    const p = seedProvider("provider", "openai", ["enabled", "disabled"]);
    providers.upsertModel(p.id, "disabled", { enabled: false });
    for (const model of ["provider/unknown", "provider/disabled"]) {
      try { router.resolve(model); expect.unreachable(); }
      catch (e) { expect((e as GatewayError).status).toBe(404); }
    }
  });
});

describe("combo streaming failover", () => {
  test("fails over between GitHub Copilot account sidecars", async () => {
    const p = providers.create({ name: "github-copilot", type: "github-copilot", accountStrategy: "round_robin" });
    const first = providers.addAccount(p.id, { label: "first", baseUrl: "http://127.0.0.1:4141/v1" });
    const second = providers.addAccount(p.id, { label: "second", baseUrl: "http://127.0.0.1:4142/v1" });
    providers.updateAccount(first.id, { lastWarmupStatus: "healthy" });
    providers.updateAccount(second.id, { lastWarmupStatus: "healthy" });
    providers.upsertModel(p.id, "gpt-5");
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
      const result = await executeRequest({ model: "github-copilot/gpt-5", messages: [{ role: "user", content: "hi" }], stream: true }, router.resolve("github-copilot/gpt-5").candidates, {}, providers);
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

  test("tries the next model when a 200 SSE stream ends before output", async () => {
    seedProvider("first", "openai", ["m1"], 10);
    seedProvider("second", "openai", ["m2"], 20);
    combos.create("fallback", ["first/m1", "second/m2"]);
    const candidates = router.resolve("combo:fallback").candidates;
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
    seedProvider("small", "openai", ["m1"], 10);
    seedProvider("large", "openai", ["m2"], 20);
    combos.create("payload-fallback", ["small/m1", "large/m2"]);
    const candidates = router.resolve("combo:payload-fallback").candidates;
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
  test("stored provider limit overrides static model metadata", () => {
    const p = seedProvider("provider", "openai", ["gpt-4o"]);
    providers.upsertModel(p.id, "gpt-4o", { maxOutputTokens: 1234 });
    const candidate = router.resolve("provider/gpt-4o").candidates[0]!;
    const result = clampMaxTokens({ model: "provider/gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 9999 }, candidate, providers);
    expect(result.max_tokens).toBe(1234);
  });
});

describe("provider account strategy", () => {
  function candidateWithAccounts(strategy: "priority" | "round_robin", suffix = "main") {
    const p = providers.create({ name: `accounts-${strategy}-${suffix}`, type: "openai", accountStrategy: strategy });
    for (const [label, priority] of [["free", 0], ["plus", 10], ["pro", 20]] as const) {
      const account = providers.addAccount(p.id, { label, apiKey: `sk-${label}`, priority });
      providers.updateAccount(account.id, { lastWarmupStatus: "healthy", planType: label });
    }
    providers.upsertModel(p.id, "m");
    return router.resolve(`${p.name}/m`).candidates[0]!;
  }

  test("priority always starts from the lowest account priority", () => {
    const candidate = candidateWithAccounts("priority");
    expect(buildAccountPlan([candidate]).map(({ account }) => account.label)).toEqual(["free", "plus", "pro"]);
    expect(buildAccountPlan([candidate]).map(({ account }) => account.label)).toEqual(["free", "plus", "pro"]);
  });

  test("round robin rotates independently per provider model", () => {
    const candidate = candidateWithAccounts("round_robin");
    expect(buildAccountPlan([candidate]).map(({ account }) => account.label)).toEqual(["free", "plus", "pro"]);
    expect(buildAccountPlan([candidate]).map(({ account }) => account.label)).toEqual(["plus", "pro", "free"]);
  });

  test("attempt limit applies to each combo candidate", () => {
    const first = candidateWithAccounts("priority", "attempts");
    const second = { ...first, modelId: "fallback" };
    const limited = limitAttemptsPerCandidate(buildAccountPlan([first, second]), 2);
    expect(limited.map(({ candidate, account }) => `${candidate.modelId}/${account.label}`)).toEqual([
      "m/free", "m/plus", "fallback/free", "fallback/plus",
    ]);
  });
});

describe("model sync provenance", () => {
  test("prunes stale synced models but preserves manual models", () => {
    const p = seedProvider("provider", "openai", []);
    providers.upsertModel(p.id, "manual-model");
    providers.upsertModel(p.id, "stale-model", { source: "sync" });
    providers.upsertModel(p.id, "kept-model", { source: "sync" });
    const pruned = providers.replaceSyncedModels(p.id, [{ id: "kept-model", contextLength: 1000, maxOutputTokens: 100, capabilities: [] }]);
    expect(pruned).toBe(1);
    expect(providers.listModels(p.id).map((model) => model.model_id).sort()).toEqual(["kept-model", "manual-model"]);
    expect(providers.getProviderModel(p.id, "manual-model")?.source).toBe("manual");
  });
});
