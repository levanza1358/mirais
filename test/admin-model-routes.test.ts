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
});

describe("combo diagnostic route", () => {
  test("returns ordered resolved candidates without upstream traffic", async () => {
    const providers = new ProvidersRepo(db);
    const p = providers.create({ name: "p", type: "openai" });
    providers.addAccount(p.id, { label: "main", apiKey: "test" });
    providers.upsertModel(p.id, "m");
    const combos = new CombosRepo(db);
    const combo = combos.create("fallback", ["p/m"]);
    const app = adminApp(comboRoutes(db));
    const response = await app.handle(new Request(`http://test/api/combos/${combo.id}/test`, { method: "POST" }));
    expect(response.status).toBe(200);
    const body = await response.json() as { requested_model: string; candidates: Array<{ position: number; provider: string; model: string; available_accounts: number; healthy_accounts: number }> };
    expect(body.requested_model).toBe("combo:fallback");
    expect(body.candidates).toEqual([{ position: 0, provider: "p", model: "m", available_accounts: 1, healthy_accounts: 0 }]);
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
