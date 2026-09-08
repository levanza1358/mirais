import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import childProcess from "node:child_process";
import { config } from "../src/config";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { freshDb } from "./helpers";
import { copilotRoutes, _setSpawnForTests, _resetCopilotStateForTests } from "../src/admin/copilot";
import { ProvidersRepo } from "../src/store/repos/providers";
import { AdminError } from "../src/shared/errors";
import { Elysia } from "elysia";

let db: Database;
let repo: ProvidersRepo;
const originalDataDir = config.dataDir;
let originalFetch: typeof globalThis.fetch;
let tempHome: string;
let allProcs: FakeProc[];
let credentialMock: ReturnType<typeof spyOn<typeof childProcess, "execSync">>;

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() { this.killed = true; }
  close(code: number) { queueMicrotask(() => this.emit("close", code, null)); }
}

function makeSpawn(procs: FakeProc[]): typeof spawn {
  return ((..._args: unknown[]) => {
    const p = new FakeProc();
    procs.push(p);
    allProcs.push(p);
    return p as unknown as ChildProcess;
  }) as typeof spawn;
}

function app(database: Database) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AdminError) { set.status = error.status; return error.toJSON(); }
      throw error;
    })
    .use(copilotRoutes(database));
}

async function post(a: ReturnType<typeof app>, p: string, body?: unknown) {
  return a.handle(new Request(`http://test${p}`, {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

async function waitForJob(a: ReturnType<typeof app>, jobId: string) {
  type Job = { done: boolean; results: Array<{ success: boolean; error?: string | null }> };
  for (let i = 0; i < 50; i++) {
    const r = await a.handle(new Request(`http://test/api/copilot/bulk/${jobId}`));
    const j = await r.json() as Job;
    if (j.done) return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish in time");
}

beforeEach(() => {
  db = freshDb();
  repo = new ProvidersRepo(db);
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mirais-copilot-test-"));
  originalFetch = globalThis.fetch;
  Object.defineProperty(config, "dataDir", { value: tempHome, configurable: true });
  allProcs = [];
  credentialMock = spyOn(childProcess, "execSync").mockImplementation((() => "") as unknown as typeof childProcess.execSync);
  _setSpawnForTests(makeSpawn([]));
  globalThis.fetch = (async () => { throw new Error("Unexpected network request"); }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const proc of allProcs) { proc.emit("close", 0, null); proc.emit("exit", 0); }
  _resetCopilotStateForTests();
  globalThis.fetch = originalFetch;
  _setSpawnForTests(spawn);
  credentialMock.mockRestore();
  Object.defineProperty(config, "dataDir", { value: originalDataDir, configurable: true });
  db.close();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("C2 — GET status is read-only", () => {
  test("does not start a sidecar or touch the DB when no login flow exists", async () => {
    const procs: FakeProc[] = [];
    _setSpawnForTests(makeSpawn(procs));

    const p = repo.create({ name: "copilot", type: "github-copilot" });
    const account = repo.addAccount(p.id, { label: "my-account" });
    repo.updateAccount(account.id, { enabled: true });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ ok: true, login: "octocat", message: null });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const a = app(db);
    const res = await a.handle(new Request(`http://test/api/copilot/${account.id}/status`));
    expect(res.status).toBe(200);
    const body = await res.json() as { done: boolean; ok: boolean };
    expect(body.done).toBe(true);
    expect(body.ok).toBe(true);
    expect(procs.length).toBe(0);
    expect(repo.listModels(p.id).length).toBe(0);
  });

  test("reports waiting state for a running login flow without mutation", async () => {
    const procs: FakeProc[] = [];
    _setSpawnForTests(makeSpawn(procs));

    const p = repo.create({ name: "copilot", type: "github-copilot" });
    const a = app(db);

    const startRes = await post(a, "/api/copilot/start", { providerId: p.id, label: "" });
    expect(startRes.status).toBe(200);
    const { accountId } = await startRes.json() as { accountId: string };

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ ok: false, login: null, message: "Starting Copilot adapter..." });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const statusRes = await a.handle(new Request(`http://test/api/copilot/${accountId}/status`));
    expect(statusRes.status).toBe(200);
    const body = await statusRes.json() as { done: boolean; ok: boolean; message?: string };
    expect(body.done).toBe(false);
    expect(body.message).toContain("Waiting");
    expect(repo.getAccount(accountId)?.enabled).toBe(0);
  });
});

describe("C2 — POST finalize performs mutations", () => {
  test("returns 409 when no login flow exists", async () => {
    const p = repo.create({ name: "copilot", type: "github-copilot" });
    const account = repo.addAccount(p.id, { label: "some-account" });
    const a = app(db);
    const res = await post(a, `/api/copilot/${account.id}/finalize`);
    expect(res.status).toBe(409);
  });

  test("completes login: enables account, syncs models, renames placeholder label", async () => {
    const procs: FakeProc[] = [];
    _setSpawnForTests(makeSpawn(procs));

    const p = repo.create({ name: "copilot", type: "github-copilot" });
    const a = app(db);

    const startRes = await post(a, "/api/copilot/start", { providerId: p.id, label: "" });
    expect(startRes.status).toBe(200);
    const { accountId } = await startRes.json() as { accountId: string };

    procs[0]!.close(0);
    await new Promise((r) => setTimeout(r, 10));

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ ok: true, login: "octocat", message: null });
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "gpt-4o" }, { id: "claude-3-5" }] });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const finalizeRes = await post(a, `/api/copilot/${accountId}/finalize`);
    expect(finalizeRes.status).toBe(200);
    const body = await finalizeRes.json() as { done: boolean; ok: boolean; message?: string };
    expect(body.done).toBe(true);
    expect(body.ok).toBe(true);

    const updated = repo.getAccount(accountId);
    expect(updated?.enabled).toBe(1);
    expect(updated?.label).toBe("octocat");
    const models = repo.listModels(p.id);
    expect(models.map((m) => m.model_id).sort()).toEqual(["claude-3-5", "gpt-4o"]);
  });

  test("C1 — returns duplicate requiring confirmation when another account owns the login", async () => {
    const procs: FakeProc[] = [];
    _setSpawnForTests(makeSpawn(procs));

    const p = repo.create({ name: "copilot", type: "github-copilot" });
    const existing = repo.addAccount(p.id, { label: "octocat" });
    repo.updateAccount(existing.id, { enabled: false });

    const a = app(db);
    const startRes = await post(a, "/api/copilot/start", { providerId: p.id, label: "" });
    expect(startRes.status).toBe(200);
    const { accountId } = await startRes.json() as { accountId: string };

    procs[0]!.close(0);
    await new Promise((r) => setTimeout(r, 10));

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ ok: true, login: "octocat", message: null });
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "gpt-4o" }] });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 61_000);
    let finalizeRes: Response;
    try {
      finalizeRes = await post(a, `/api/copilot/${accountId}/finalize`);
    } finally {
      clock.mockRestore();
    }
    expect(finalizeRes.status).toBe(200);
    const body = await finalizeRes.json() as { done: boolean; ok: boolean; duplicate?: boolean; login?: string };
    expect(body.duplicate).toBe(true);
    expect(body.login).toBe("octocat");
    expect(repo.getAccount(accountId)?.enabled).toBe(0);
    expect(repo.getAccount(existing.id)).not.toBeNull();
  });
});

describe("C3 — bulk login safety", () => {
  test("failed forced bulk login keeps the old account", async () => {
    const procs: FakeProc[] = [];
    _setSpawnForTests(makeSpawn(procs));

    const p = repo.create({ name: "copilot", type: "github-copilot" });
    const oldAccount = repo.addAccount(p.id, { label: "user@example.com" });
    repo.updateAccount(oldAccount.id, { enabled: true });

    const a = app(db);
    const res = await post(a, "/api/copilot/bulk", {
      providerId: p.id,
      accounts: "user@example.com|password123",
      force: true,
    });
    expect(res.status).toBe(200);
    const { jobId } = await res.json() as { jobId: string };

    while (!procs.length) await new Promise((resolve) => setImmediate(resolve));
    procs[0]!.close(1);
    const job = await waitForJob(a, jobId);

    expect(job.results[0]?.success).toBe(false);
    expect(repo.getAccount(oldAccount.id)).not.toBeNull();
  });

  test("successful forced bulk login replaces old account only after new one is enabled", async () => {
    const procs: FakeProc[] = [];
    _setSpawnForTests(makeSpawn(procs));

    const p = repo.create({ name: "copilot", type: "github-copilot" });
    const oldAccount = repo.addAccount(p.id, { label: "user@example.com" });
    repo.updateAccount(oldAccount.id, { enabled: true });

    const a = app(db);
    const res = await post(a, "/api/copilot/bulk", {
      providerId: p.id,
      accounts: "user@example.com|password123",
      force: true,
    });
    expect(res.status).toBe(200);
    const { jobId } = await res.json() as { jobId: string };

    while (!procs.length) await new Promise((resolve) => setImmediate(resolve));
    const newAccount = repo.listAccounts(p.id).find((x) => x.id !== oldAccount.id);
    expect(newAccount).toBeDefined();
    const outputFile = path.join(tempHome, "copilot", newAccount!.id, "bulk_result.json");
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify([{ email: "user@example.com", success: true }]), "utf-8");

    procs[0]!.close(0);
    const job = await waitForJob(a, jobId);

    expect(job.results[0]?.success).toBe(true);
    const remaining = repo.listAccounts(p.id).filter((x) => x.label.toLowerCase() === "user@example.com");
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.id).not.toBe(oldAccount.id);
    expect(remaining[0]?.enabled).toBe(1);
  });

  test("non-force bulk login skips an existing account without touching it", async () => {
    const p = repo.create({ name: "copilot", type: "github-copilot" });
    const oldAccount = repo.addAccount(p.id, { label: "user@example.com" });

    const a = app(db);
    const res = await post(a, "/api/copilot/bulk", {
      providerId: p.id,
      accounts: "user@example.com|password123",
    });
    expect(res.status).toBe(200);
    const { jobId } = await res.json() as { jobId: string };

    const job = await waitForJob(a, jobId);
    expect(job.results[0]?.success).toBe(false);
    expect(job.results[0]?.error).toBe("Account already exists");
    expect(repo.getAccount(oldAccount.id)).not.toBeNull();
  });
});
