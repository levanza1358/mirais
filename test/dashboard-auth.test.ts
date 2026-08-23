import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { freshDb } from "./helpers";
import { authRoutes, hasValidSession, passwordEnabled, sessionGuard } from "../src/admin/auth";
import { AdminError } from "../src/shared/errors";

function app(db: Database) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AdminError) { set.status = error.status; return error.toJSON(); }
      throw error;
    })
    .use(authRoutes(db))
    .use(sessionGuard(db))
    .get("/api/providers", () => [])
    .get("/api/health", () => ({ status: "ok" }))
    .post("/v1/chat/completions", () => ({ ok: true }));
}

async function setPassword(a: ReturnType<typeof app>, password: string, currentPassword?: string, cookie?: string) {
  const res = await a.handle(new Request("http://test/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ new_password: password, current_password: currentPassword }),
  }));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie") ?? "";
}

async function login(a: ReturnType<typeof app>, password: string, remember = false) {
  return a.handle(new Request("http://test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, remember }),
  }));
}

function cookieOf(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

function maxAgeOf(cookie: string): number {
  return Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? 0);
}

describe("dashboard password", () => {
  test("defaults to 12345678 and locks the admin API", async () => {
    const db = freshDb();
    const a = app(db);
    expect(passwordEnabled(db)).toBe(true);
    expect((await a.handle(new Request("http://test/api/providers"))).status).toBe(401);
    expect((await login(a, "12345678")).status).toBe(200);
  });

  test("never blocks the gateway proxy path", async () => {
    const db = freshDb();
    const a = app(db);
    const res = await a.handle(new Request("http://test/v1/chat/completions", { method: "POST" }));
    expect(res.status).toBe(200);
  });

  test("login issues a session cookie that survives page refreshes", async () => {
    const db = freshDb();
    const a = app(db);
    expect((await login(a, "wrong-password")).status).toBe(401);
    const cookie = cookieOf(await login(a, "12345678"));
    expect(cookie).toContain("HttpOnly");

    for (let i = 0; i < 3; i += 1) {
      const authed = await a.handle(new Request("http://test/api/providers", { headers: { cookie } }));
      expect(authed.status).toBe(200);
    }
  });

  test("session lifetime is configurable and remember-me lasts 30 days", async () => {
    const db = freshDb();
    const a = app(db);
    const cookie = cookieOf(await login(a, "12345678"));
    const saved = await a.handle(new Request("http://test/api/auth/session-hours", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ hours: 72 }),
    }));
    expect(await saved.json()).toMatchObject({ session_hours: 72 });

    expect(maxAgeOf(cookieOf(await login(a, "12345678")))).toBe(72 * 3600);
    expect(maxAgeOf(cookieOf(await login(a, "12345678", true)))).toBe(30 * 24 * 3600);

    const check = await a.handle(new Request("http://test/api/auth/check"));
    expect(await check.json()).toMatchObject({ password_set: true, session_hours: 72 });
  });

  test("rejects an out-of-range session lifetime", async () => {
    const db = freshDb();
    const a = app(db);
    const cookie = cookieOf(await login(a, "12345678"));
    const res = await a.handle(new Request("http://test/api/auth/session-hours", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ hours: 0 }),
    }));
    expect(res.status).toBe(400);
  });

  test("health probe and auth endpoints stay public", async () => {
    const db = freshDb();
    const a = app(db);
    expect((await a.handle(new Request("http://test/api/health"))).status).toBe(200);
    const check = await a.handle(new Request("http://test/api/auth/check"));
    expect(await check.json()).toMatchObject({ password_set: true, authenticated: false });
  });

  test("changing the password revokes existing sessions", async () => {
    const db = freshDb();
    const a = app(db);
    const cookie = cookieOf(await login(a, "12345678"));

    await setPassword(a, "another-secret", "12345678", cookie);
    expect(hasValidSession(db, new Request("http://test/api/providers", { headers: { cookie } }))).toBe(false);
  });

  test("turning the password off reopens the admin API and stays off", async () => {
    const db = freshDb();
    const a = app(db);
    const cookie = cookieOf(await login(a, "12345678"));
    const removed = await a.handle(new Request("http://test/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current_password: "12345678", new_password: "" }),
    }));
    expect(await removed.json()).toMatchObject({ password_set: false });
    expect(passwordEnabled(db)).toBe(false);
    expect((await a.handle(new Request("http://test/api/providers"))).status).toBe(200);
  });

  test("wrong current password cannot change the password", async () => {
    const db = freshDb();
    const a = app(db);
    const cookie = cookieOf(await login(a, "12345678"));
    const res = await a.handle(new Request("http://test/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current_password: "nope", new_password: "another-secret" }),
    }));
    expect(res.status).toBe(401);
  });

  test("rejects passwords shorter than 8 characters", async () => {
    const db = freshDb();
    const a = app(db);
    const cookie = cookieOf(await login(a, "12345678"));
    const res = await a.handle(new Request("http://test/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current_password: "12345678", new_password: "short" }),
    }));
    expect(res.status).toBe(400);
  });

  test("throttles repeated failed logins", async () => {
    const db = freshDb();
    const a = app(db);
    for (let i = 0; i < 5; i += 1) expect((await login(a, "wrong")).status).toBe(401);
    expect((await login(a, "12345678")).status).toBe(429);
  });
});
