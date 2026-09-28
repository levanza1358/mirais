import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { logRoutes } from "../src/admin/settings";
import { AdminError } from "../src/shared/errors";
import { LogsRepo } from "../src/store/repos/logs";
import type { Database } from "../src/store/sql";
import { freshDb } from "./helpers";

function app(db: Database) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AdminError) { set.status = error.status; return { error: error.message }; }
      throw error;
    })
    .use(logRoutes(db));
}

describe("logRoutes", () => {
  test("list excludes payloads and detail returns them", async () => {
    const db = await freshDb();
    const id = new LogsRepo(db);
    await id.insert({ keyId: null, endpoint: "/v1/chat/completions", requestedModel: "m", provider: "p", model: "m", attempts: 1, status: "success", httpStatus: 200, error: null, inputTokens: 1, outputTokens: 2, latencyMs: 3, tokensSaved: 0, requestBody: JSON.stringify({ text: "it's safe" }), responseBody: "done" });
    const row = (await id.list({ page: 1, limit: 1 })).items[0];
    const a = app(db);
    const list = await a.handle(new Request("http://test/api/logs?kind=request&limit=1"));
    expect(list.status).toBe(200);
    const listBody = await list.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(listBody.total).toBe(1);
    expect(listBody.items[0]?.request_body).toBeUndefined();
    expect(listBody.items[0]?.has_payload).toBeTruthy();
    const detail = await a.handle(new Request(`http://test/api/logs/${row?.id}`));
    expect(detail.status).toBe(200);
    expect((await detail.json() as { request_body: string }).request_body).toContain("it's safe");
  });

  test("rejects fractional pagination", async () => {
    const db = await freshDb();
    const response = await app(db).handle(new Request("http://test/api/logs?limit=1.5"));
    expect(response.status).toBe(400);
  });

  test("quote and question-mark filters stay data", async () => {
    const db = await freshDb();
    const logs = new LogsRepo(db);
    await logs.insert({ keyId: null, endpoint: "/v1/chat/completions", requestedModel: "x' OR 1=1 -- ?", provider: "p", model: "x", attempts: 1, status: "error", httpStatus: 500, error: null, inputTokens: 1, outputTokens: 1, latencyMs: 1, tokensSaved: 0 });
    const a = app(db);
    const response = await a.handle(new Request("http://test/api/logs?model=x%27%20OR%201%3D1%20--%20%3F&limit=1"));
    expect(response.status).toBe(200);
    expect((await response.json() as { total: number }).total).toBe(1);
  });
});
