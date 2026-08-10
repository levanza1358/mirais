import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshDb } from "./helpers";
import { ProvidersRepo } from "../src/store/repos/providers";
import { AliasesRepo, CombosRepo } from "../src/store/repos/routing";
import { Router, baseUrlFor, upstreamFormat } from "../src/proxy/router";
import { GatewayError } from "../src/shared/errors";
import { clampMaxTokens } from "../src/proxy/executor";

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
  providers.addAccount(p.id, { label: "main", apiKey: "sk-test" });
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

describe("model output limits", () => {
  test("stored provider limit overrides static model metadata", () => {
    const p = seedProvider("provider", "openai", ["gpt-4o"]);
    providers.upsertModel(p.id, "gpt-4o", { maxOutputTokens: 1234 });
    const candidate = router.resolve("provider/gpt-4o").candidates[0]!;
    const result = clampMaxTokens({ model: "provider/gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 9999 }, candidate, providers);
    expect(result.max_tokens).toBe(1234);
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
