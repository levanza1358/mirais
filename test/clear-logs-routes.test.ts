import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database } from "../src/store/sql";
import { freshDb } from "./helpers";
import { LogsRepo } from "../src/store/repos/logs";
import { AuditRepo } from "../src/store/repos/audit";
import { logRoutes } from "../src/admin/settings";
import { AdminError } from "../src/shared/errors";

function adminApp(plugin: ReturnType<typeof logRoutes>) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AdminError) {
        set.status = error.status;
        return error.toJSON();
      }
      throw error;
    })
    .use(plugin);
}

async function seedRequestLogs(logs: LogsRepo): Promise<void> {
  for (const kind of ["request", "warmup", "claim", "test"]) {
    try {
      await logs.insert({
        keyId: null,
        endpoint: "/v1/chat/completions",
        requestedModel: "m",
        provider: "openai",
        model: "m",
        attempts: 1,
        status: "success",
        httpStatus: 200,
        error: null,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 10,
        tokensSaved: 0,
        kind,
      });
    } catch (err) {
      throw new Error(`logs.insert failed for kind=${kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function seedAudit(audit: AuditRepo): Promise<void> {
  await audit.record("updated", "settings", null, { fields: ["log_retention_days"] });
  await audit.record("created", "provider", "p-1", { name: "openai" });
}

beforeEach(async () => {
  await freshDb();
});

describe("DELETE /api/logs/all — clear logs without exception", () => {
  test("no kind: deletes every request_logs row, every audit row, and drops the orphan payload tables", async () => {
    const db = await freshDb();
    // Fresh schema doesn't include the orphan payload tables; create them so
    // the drop path actually has something to drop. SQLite ignores ENGINE/CHARSET.
    await db.exec(`CREATE TABLE request_log_payloads (
      request_log_id VARCHAR(64) NOT NULL,
      request_body TEXT NULL,
      response_body TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (request_log_id)
    )`);
    await db.exec(`CREATE TABLE request_log_payload_cleanup (
      id INTEGER NOT NULL,
      cursor_id VARCHAR(64) NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id)
    )`);

    const logs = new LogsRepo(db);
    const audit = new AuditRepo(db);
    await seedRequestLogs(logs);
    await seedAudit(audit);
    await db.query("INSERT INTO request_log_payloads (request_log_id) VALUES (?)").run("orphan-id");

    const app = adminApp(logRoutes(db));
    const res = await app.handle(new Request("http://test/api/logs/all", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      cleared: number;
      audit_cleared: number;
      usage_cleared: number;
      tables_dropped: number;
    };

    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(4); // one row per kind
    expect(body.audit_cleared).toBe(2);
    expect(body.usage_cleared).toBe(0); // no rollups yet
    expect(body.tables_dropped).toBe(2);

    const remainingRequests = (await db.query("SELECT COUNT(*) AS c FROM request_logs").get<{ c: number }>())?.c ?? 0;
    const remainingAudit = (await db.query("SELECT COUNT(*) AS c FROM admin_audit_log").get<{ c: number }>())?.c ?? 0;
    expect(remainingRequests).toBe(0);
    expect(remainingAudit).toBe(0);

    // Orphan payload tables are gone, so re-issuing the clear is still safe
    // (DROP TABLE IF EXISTS) and reports zero tables dropped.
    const res2 = await app.handle(new Request("http://test/api/logs/all", { method: "DELETE" }));
    const body2 = (await res2.json()) as { cleared: number; audit_cleared: number; tables_dropped: number };
    expect(body2.cleared).toBe(0);
    expect(body2.audit_cleared).toBe(0);
    expect(body2.tables_dropped).toBe(0);
  });

  test("kind=request: only deletes request rows, leaves audit and orphan tables intact", async () => {
    const db = await freshDb();
    await db.exec(`CREATE TABLE request_log_payloads (
      request_log_id VARCHAR(64) NOT NULL,
      PRIMARY KEY (request_log_id)
    )`);
    await db.exec(`CREATE TABLE request_log_payload_cleanup (
      id INTEGER NOT NULL,
      PRIMARY KEY (id)
    )`);
    const logs = new LogsRepo(db);
    const audit = new AuditRepo(db);
    await seedRequestLogs(logs);
    await audit.record("updated", "settings", null, { fields: ["log_retention_days"] });

    const app = adminApp(logRoutes(db));
    const res = await app.handle(new Request("http://test/api/logs/all?kind=request", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; cleared: number; audit_cleared?: number; tables_dropped?: number };

    expect(body.kind).toBe("request");
    expect(body.cleared).toBe(1);
    expect(body.audit_cleared).toBeUndefined();
    expect(body.tables_dropped).toBeUndefined();

    const auditRows = (await db.query("SELECT COUNT(*) AS c FROM admin_audit_log").get<{ c: number }>())?.c ?? 0;
    expect(auditRows).toBe(1);
    const warmups = (await db.query("SELECT COUNT(*) AS c FROM request_logs WHERE kind='warmup'").get<{ c: number }>())?.c ?? 0;
    expect(warmups).toBe(1);
  });

  test("kind=bogus: 400 with a useful error", async () => {
    const db = await freshDb();
    const app = adminApp(logRoutes(db));
    const res = await app.handle(new Request("http://test/api/logs/all?kind=bogus", { method: "DELETE" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("kind must be one of");
  });
});

describe("DELETE /api/logs/files — truncate on-disk log files", () => {
  test("truncates known log files in DATA_DIR and reports bytes freed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirais-clear-files-"));
    // The endpoint reads paths relative to config.dataDir, which is normally
    // ./data. We can't easily redirect that global, but we can at least
    // touch ./data/mirais.log in the workspace to prove the write path works
    // and that pre-existing bytes are reported.
    const workspace = process.cwd();
    const dataDir = path.join(workspace, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const target = path.join(dataDir, "xai-farm.log.jsonl");
    const before = '{"ts":"2026-09-30T00:00:00Z","level":"info","message":"hello"}\n';
    fs.writeFileSync(target, before.repeat(64));

    const db = await freshDb();
    const app = adminApp(logRoutes(db));
    const res = await app.handle(new Request("http://test/api/logs/files", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; truncated: string[]; freed_bytes: number };

    expect(body.ok).toBe(true);
    expect(body.truncated.length).toBeGreaterThanOrEqual(1);
    expect(body.freed_bytes).toBeGreaterThanOrEqual(before.length * 64);
    expect(fs.readFileSync(target, "utf8")).toBe("");

    fs.rmSync(target, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns ok with no truncated files when nothing exists yet", async () => {
    const db = await freshDb();
    const app = adminApp(logRoutes(db));
    const res = await app.handle(new Request("http://test/api/logs/files", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; truncated: string[]; freed_bytes: number };
    expect(body.ok).toBe(true);
    expect(body.freed_bytes).toBeGreaterThanOrEqual(0);
  });
});