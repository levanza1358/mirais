import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { freshDb } from "./helpers";
import { providerRoutes } from "../src/admin/providers";
import { comboRoutes } from "../src/admin/routes";
import { ProvidersRepo } from "../src/store/repos/providers";
import { CombosRepo } from "../src/store/repos/routing";
import { AdminError } from "../src/shared/errors";
import { GatewayError } from "../src/shared/errors";
import { v1Routes } from "../src/proxy/routes";

let db: Database;

function adminApp(plugin: ReturnType<typeof providerRoutes> | ReturnType<typeof comboRoutes>) {
  return new Elysia().onError(({ error, set }) => {
    if (error instanceof AdminError) { set.status = error.status; return error.toJSON(); }
    throw error;
  }).use(plugin);
}

beforeEach(() => { db = freshDb(); });

describe("model admin routes", () => {
  test("rejects Copilot quota requests for non-Copilot accounts", async () => {
    const repo = new ProvidersRepo(db);
    const provider = repo.create({ name: "p", type: "openai" });
    const account = repo.addAccount(provider.id, { label: "account", apiKey: "test" });
    const app = adminApp(providerRoutes(db));
    const response = await app.handle(new Request(`http://test/api/providers/accounts/${account.id}/copilot-quota`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Quota is only available for GitHub Copilot accounts" });
  });

  test("lists provider models and validates updates", async () => {
    const repo = new ProvidersRepo(db);
    const provider = repo.create({ name: "p", type: "openai" });
    repo.upsertModel(provider.id, "vendor/model");
    const app = adminApp(providerRoutes(db));
    const list = await app.handle(new Request(`http://test/api/providers/${provider.id}/models`));
    expect(list.status).toBe(200);
    expect(((await list.json()) as Array<{ model_id: string }>)[0]?.model_id).toBe("vendor/model");
    const invalid = await app.handle(new Request(`http://test/api/providers/${provider.id}/models/test`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxOutputTokens: -1 }),
    }));
    expect(invalid.status).toBe(400);
  });

  test("updates provider account strategy", async () => {
    const repo = new ProvidersRepo(db);
    const provider = repo.create({ name: "strategy", type: "openai" });
    const app = adminApp(providerRoutes(db));
    const response = await app.handle(new Request(`http://test/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountStrategy: "round_robin" }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json() as { account_strategy: string }).account_strategy).toBe("round_robin");
  });

  test("sync retries a healthy account with an invalid model catalog", async () => {
    const repo = new ProvidersRepo(db);
    const provider = repo.create({ name: "catalog", type: "custom", baseUrl: "https://catalog.test/v1" });
    for (const label of ["first", "second"]) {
      const account = repo.addAccount(provider.id, { label, apiKey: label });
      repo.updateAccount(account.id, { lastWarmupStatus: "healthy" });
    }
    const app = adminApp(providerRoutes(db));
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(init?.headers instanceof Headers ? init.headers.get("Authorization") : (init?.headers as Record<string, string>).Authorization));
      return calls.length === 1
        ? new Response("<html>temporary error</html>")
        : Response.json({ data: [{ id: "gpt-5" }] });
    }) as unknown as typeof fetch;
    try {
      const response = await app.handle(new Request(`http://test/api/providers/${provider.id}/sync`, { method: "POST" }));
      expect(response.status).toBe(200);
      expect((await response.json() as { models: string[] }).models).toEqual(["gpt-5"]);
      expect(calls).toEqual(["Bearer first", "Bearer second"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("combo diagnostic route", () => {
  test("probes every resolved candidate and continues after failure", async () => {
    const providers = new ProvidersRepo(db);
    const first = providers.create({ name: "first", type: "openai", baseUrl: "https://first.test/v1" });
    const second = providers.create({ name: "second", type: "openai", baseUrl: "https://second.test/v1" });
    for (const provider of [first, second]) {
      const account = providers.addAccount(provider.id, { label: `${provider.name}-account`, apiKey: "test" });
      providers.updateAccount(account.id, { lastWarmupStatus: "healthy" });
      providers.upsertModel(provider.id, "m");
    }
    const combos = new CombosRepo(db);
    const combo = combos.create("fallback", ["first/m", "second/m"]);
    const app = adminApp(comboRoutes(db));
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: { model: string; max_tokens: number; messages: Array<{ content: string }> } }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.startsWith("https://first.test")) return new Response(JSON.stringify({ error: { message: "offline" } }), { status: 500 });
      return Response.json({
        id: "test",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    }) as unknown as typeof fetch;
    try {
      const response = await app.handle(new Request(`http://test/api/combos/${combo.id}/test`, { method: "POST" }));
      expect(response.status).toBe(200);
      const body = await response.json() as { requested_model: string; ok: boolean; candidates: Array<{ provider: string; ok: boolean; status: number; account?: string }> };
      expect(body.requested_model).toBe("combo:fallback");
      expect(body.ok).toBe(false);
      expect(body.candidates.map(({ provider, ok, status }) => ({ provider, ok, status }))).toEqual([
        { provider: "first", ok: false, status: 500 },
        { provider: "second", ok: true, status: 200 },
      ]);
      expect(body.candidates[1]?.account).toBe("second-account");
      expect(calls.map((call) => call.url)).toEqual([
        "https://first.test/v1/chat/completions",
        "https://second.test/v1/chat/completions",
      ]);
      expect(calls.every((call) => call.body.model === "m" && call.body.max_tokens === 8 && call.body.messages.at(-1)?.content === "Reply with exactly: OK")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("v1 model routes", () => {
  test("models and Responses require authentication when auth is enabled", async () => {
    const app = new Elysia().onError(({ error, set }) => {
      if (error instanceof GatewayError) { set.status = error.status; return error.toJSON(); }
      throw error;
    }).use(v1Routes(db));
    const models = await app.handle(new Request("http://test/v1/models"));
    expect(models.status).toBe(401);
    const responses = await app.handle(new Request("http://test/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", input: "hi" }),
    }));
    expect(responses.status).toBe(401);
  });
});
