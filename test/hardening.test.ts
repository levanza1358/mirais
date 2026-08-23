import { describe, expect, test } from "bun:test";
import { freshDb } from "./helpers";
import { ProvidersRepo } from "../src/store/repos/providers";
import { AliasesRepo, CombosRepo } from "../src/store/repos/routing";
import { Router } from "../src/proxy/router";
import { buildAccountPlan, executeRequest } from "../src/proxy/executor";
import { cacheTokensFrom, isCacheable, normalizeUsage, promptCacheKey, withAnthropicCacheControl } from "../src/proxy/promptCache";
import { autostartStatus, setAutostart } from "../scripts/autostart";
import { isBlockedUpstreamHost, isSafeUpstreamUrl } from "../src/utils/upstreamUrl";
import { isPermanentRefreshFailure, withRefreshLock } from "../src/proxy/refresh";
import type { CanonicalRequest } from "../src/shared/types";

function request(system = "x".repeat(2_100)): CanonicalRequest {
  return {
    model: "model",
    messages: [{ role: "system", content: system }, { role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
  };
}

describe("per-model account cooldowns", () => {
  test("cooling one model does not lock the account for another model", () => {
    const db = freshDb();
    const providers = new ProvidersRepo(db);
    const p = providers.create({ name: "openai", type: "openai" });
    const a = providers.addAccount(p.id, { label: "main", apiKey: "key" });
    providers.updateAccount(a.id, { lastWarmupStatus: "healthy" });
    providers.upsertModel(p.id, "model-a");
    providers.upsertModel(p.id, "model-b");
    providers.setModelCooldown(a.id, "model-a", Date.now() + 60_000, "429");
    const router = new Router(providers, new AliasesRepo(db), new CombosRepo(db));

    expect(buildAccountPlan(router.resolve("openai/model-a").candidates, providers)).toHaveLength(0);
    expect(buildAccountPlan(router.resolve("openai/model-b").candidates, providers)).toHaveLength(1);
  });

  test("expired cooldown is pruned lazily", () => {
    const db = freshDb();
    const providers = new ProvidersRepo(db);
    const p = providers.create({ name: "openai", type: "openai" });
    const a = providers.addAccount(p.id, { label: "main", apiKey: "key" });
    providers.setModelCooldown(a.id, "model-a", Date.now() - 1, "old");
    expect(providers.isModelCoolingDown(a.id, "model-a")).toBe(false);
    expect(providers.listModelCooldowns(a.id)).toEqual([]);
  });
});

describe("combo round robin", () => {
  test("rotates the primary and preserves fallback order", () => {
    const db = freshDb();
    const providers = new ProvidersRepo(db);
    for (const name of ["a", "b", "c"]) {
      const p = providers.create({ name, type: "openai" });
      const account = providers.addAccount(p.id, { label: "main", apiKey: "key" });
      providers.updateAccount(account.id, { lastWarmupStatus: "healthy" });
      providers.upsertModel(p.id, "model");
    }
    const combos = new CombosRepo(db);
    combos.create("pool", ["a/model", "b/model", "c/model"], "round_robin");
    const router = new Router(providers, new AliasesRepo(db), combos);

    expect(router.resolve("combo:pool").candidates.map((c) => c.provider.name)).toEqual(["a", "b", "c"]);
    expect(router.resolve("combo:pool").candidates.map((c) => c.provider.name)).toEqual(["b", "c", "a"]);
    expect(router.resolve("combo:pool").candidates.map((c) => c.provider.name)).toEqual(["c", "a", "b"]);
  });
});

describe("refresh coordination", () => {
  test("collapses concurrent refreshes for one account", async () => {
    let calls = 0;
    const refresh = async () => {
      calls += 1;
      await Promise.resolve();
      return "token";
    };
    expect(await Promise.all([
      withRefreshLock("account", refresh),
      withRefreshLock("account", refresh),
      withRefreshLock("account", refresh),
    ])).toEqual(["token", "token", "token"]);
    expect(calls).toBe(1);
  });

  test("classifies terminal and transient failures", () => {
    expect(isPermanentRefreshFailure(400, "invalid_grant")).toBe(true);
    expect(isPermanentRefreshFailure(401, "unauthorized")).toBe(true);
    expect(isPermanentRefreshFailure(503, "temporarily unavailable")).toBe(false);
  });
});

describe("prompt caching", () => {
  test("adds Anthropic breakpoints to reusable spans", () => {
    const body = {
      system: [{ type: "text", text: "system" }],
      tools: [{ name: "read", input_schema: {} }],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: "next" },
      ],
    };
    withAnthropicCacheControl(body);
    expect(body.system[0]).toHaveProperty("cache_control.type", "ephemeral");
    expect(body.tools[0]).toHaveProperty("cache_control.type", "ephemeral");
    expect(body.messages[1]!.content[0]).toHaveProperty("cache_control.type", "ephemeral");
  });

  test("stable OpenAI key ignores changing user turns", () => {
    const a = request();
    const b = request();
    b.messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "next" });
    expect(isCacheable(a)).toBe(true);
    expect(promptCacheKey(a)).toBe(promptCacheKey(b));
  });

  test("normalizes provider cache usage fields", () => {
    expect(cacheTokensFrom({ prompt_tokens_details: { cached_tokens: 500 } })).toEqual({ cached_tokens: 500 });
    expect(cacheTokensFrom({ cache_read_input_tokens: 300, cache_creation_input_tokens: 200 })).toEqual({ cached_tokens: 300, cache_write_tokens: 200 });
  });

  test("keeps cache counters when normalizing either usage dialect", () => {
    expect(normalizeUsage({ prompt_tokens: 900, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 700 } }))
      .toEqual({ prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, cached_tokens: 700 });
    expect(normalizeUsage({ input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }))
      .toEqual({ prompt_tokens: 40, completion_tokens: 5, total_tokens: 45, cached_tokens: 30, cache_write_tokens: 10 });
  });

  test("leaves cache counters absent when the upstream does not report them", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }))
      .toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    expect(normalizeUsage(undefined)).toBeNull();
  });

  test("survives the OpenAI-format stream path end to end", async () => {
    const db = freshDb();
    const providers = new ProvidersRepo(db);
    const p = providers.create({ name: "openai", type: "openai" });
    const account = providers.addAccount(p.id, { label: "main", apiKey: "key" });
    providers.updateAccount(account.id, { lastWarmupStatus: "healthy" });
    providers.upsertModel(p.id, "gpt-5");
    const router = new Router(providers, new AliasesRepo(db), new CombosRepo(db));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'
      + 'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":900,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":768}}}\n\n'
      + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    try {
      const result = await executeRequest(
        { model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }], stream: true },
        router.resolve("openai/gpt-5").candidates,
        {},
        providers,
      );
      expect(result.kind).toBe("stream");
      if (result.kind !== "stream") return;
      await new Response(result.stream).text();
      expect(await result.usagePromise).toMatchObject({ prompt_tokens: 900, cached_tokens: 768 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("autostart", () => {
  test("reports a manageable platform-appropriate method", async () => {
    const status = await autostartStatus();
    expect(status.platform).toBe(process.platform);
    if (process.platform === "win32") {
      expect(status.method).toBe("windows-startup");
      expect(status.manageable).toBe(true);
      expect(status.detail).toContain("Startup");
    } else if (process.platform === "linux") {
      expect(status.method).toBe("systemd");
    } else {
      expect(status.method).toBe("unsupported");
      expect(status.manageable).toBe(false);
    }
    expect(typeof status.enabled).toBe("boolean");
  });

  test("toggling is idempotent and restores the previous state", async () => {
    if (process.platform !== "win32") return;
    const before = await autostartStatus();
    try {
      // Twice: the existing Startup directory must not be treated as an error.
      expect((await setAutostart("on")).enabled).toBe(true);
      expect((await setAutostart("on")).enabled).toBe(true);
      expect((await setAutostart("off")).enabled).toBe(false);
      expect((await setAutostart("off")).enabled).toBe(false);
    } finally {
      await setAutostart(before.enabled ? "on" : "off");
    }
  });
});

describe("upstream URL safety", () => {
  test("blocks loopback, private, link-local, and metadata hosts", () => {
    for (const host of ["127.0.0.1", "10.0.0.1", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "metadata.google.internal"]) {
      expect(isBlockedUpstreamHost(host)).toBe(true);
    }
    expect(isBlockedUpstreamHost("api.openai.com")).toBe(false);
  });

  test("only accepts http(s) public upstreams by default", () => {
    expect(isSafeUpstreamUrl("https://api.openai.com/v1")).toBe(true);
    expect(isSafeUpstreamUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUpstreamUrl("http://127.0.0.1:3000")).toBe(false);
    expect(isSafeUpstreamUrl("http://127.0.0.1:3000", { allowPrivate: true })).toBe(true);
  });
});
