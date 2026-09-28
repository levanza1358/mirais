import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { _resetAtriaLoginStateForTests, atriaLoginRoutes } from "../src/admin/atria-login";
import { AdminError } from "../src/shared/errors";
import type { Database } from "../src/store/sql";
import { ProvidersRepo } from "../src/store/repos/providers";
import { freshDb } from "./helpers";

function app(db: Database) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AdminError) { set.status = error.status; return { error: error.message }; }
      throw error;
    })
    .use(atriaLoginRoutes(db));
}

async function seedAtria(db: Database) {
  const repo = new ProvidersRepo(db);
  return repo.create({ name: "atria", type: "custom", baseUrl: "https://api.atria-asi.ai/v1" });
}

describe("atriaLoginRoutes", () => {
  test("rejects an unknown provider", async () => {
    _resetAtriaLoginStateForTests();
    const a = app(await freshDb());
    const res = await a.handle(new Request("http://test/api/providers/atria-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "nope", lines: ["a@b.c|pw"] }),
    }));
    expect(res.status).toBe(404);
  });

  test("rejects a non-Atria provider", async () => {
    _resetAtriaLoginStateForTests();
    const db = await freshDb();
    const repo = new ProvidersRepo(db);
    const provider = await repo.create({ name: "openai", type: "custom", baseUrl: "https://api.openai.com/v1" });
    const a = app(db);
    const res = await a.handle(new Request("http://test/api/providers/atria-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: provider.id, lines: ["a@b.c|pw"] }),
    }));
    expect(res.status).toBe(400);
  });

  test("rejects an empty line list", async () => {
    _resetAtriaLoginStateForTests();
    const db = await freshDb();
    const provider = await seedAtria(db);
    const a = app(db);
    const res = await a.handle(new Request("http://test/api/providers/atria-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: provider.id, lines: ["   ", ""] }),
    }));
    expect(res.status).toBe(400);
  });

  test("rejects malformed input", async () => {
    _resetAtriaLoginStateForTests();
    const db = await freshDb();
    const provider = await seedAtria(db);
    const a = app(db);
    const res = await a.handle(new Request("http://test/api/providers/atria-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: provider.id, lines: "not-an-array" }),
    }));
    expect(res.status).toBe(400);
  });

  test("unknown job ids return 404", async () => {
    _resetAtriaLoginStateForTests();
    const a = app(await freshDb());
    const status = await a.handle(new Request("http://test/api/providers/atria-login/missing"));
    expect(status.status).toBe(404);
    const logs = await a.handle(new Request("http://test/api/providers/atria-login/missing/logs"));
    expect(logs.status).toBe(404);
  });

  test("latest job is null before any run and dismiss is a no-op", async () => {
    _resetAtriaLoginStateForTests();
    const db = await freshDb();
    const provider = await seedAtria(db);
    const a = app(db);
    const latest = await a.handle(new Request(`http://test/api/providers/atria-login/latest/${provider.id}`));
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as { job: unknown }).job).toBeNull();

    const dismiss = await a.handle(new Request(`http://test/api/providers/atria-login/latest/${provider.id}`, { method: "DELETE" }));
    expect(dismiss.status).toBe(200);
    expect(((await dismiss.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("a started job is reachable through latest and reports progress", async () => {
    _resetAtriaLoginStateForTests();
    const db = await freshDb();
    const provider = await seedAtria(db);
    const a = app(db);
    const start = await a.handle(new Request("http://test/api/providers/atria-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: provider.id, lines: ["new-account@example.com|secret-password"] }),
    }));
    expect(start.status).toBe(200);
    const { jobId, total } = (await start.json()) as { jobId: string; total: number };
    expect(total).toBe(1);
    expect(jobId).toBeTruthy();

    const latest = await a.handle(new Request(`http://test/api/providers/atria-login/latest/${provider.id}`));
    const latestBody = (await latest.json()) as { job: { id: string } | null };
    expect(latestBody.job?.id).toBe(jobId);

    const status = await a.handle(new Request(`http://test/api/providers/atria-login/${jobId}`));
    expect(status.status).toBe(200);
    const body = (await status.json()) as { id: string; done: boolean; results: unknown[] };
    expect(body.id).toBe(jobId);
    expect(Array.isArray(body.results)).toBe(true);

    const logs = await a.handle(new Request(`http://test/api/providers/atria-login/${jobId}/logs`));
    expect(logs.status).toBe(200);
    expect(Array.isArray(((await logs.json()) as { logs: string[] }).logs)).toBe(true);

    // Never leak the password into the log stream.
    const logBody = (await (await a.handle(new Request(`http://test/api/providers/atria-login/${jobId}/logs`))).json()) as { logs: string[] };
    expect(logBody.logs.join("\n")).not.toContain("secret-password");

    const dismiss = await a.handle(new Request(`http://test/api/providers/atria-login/latest/${provider.id}`, { method: "DELETE" }));
    expect(dismiss.status).toBe(200);
    const gone = await a.handle(new Request(`http://test/api/providers/atria-login/${jobId}`));
    expect(gone.status).toBe(404);
  });
});
