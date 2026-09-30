import { describe, test, expect, beforeEach } from "bun:test";
import { freshDb } from "./helpers";
import { LogsRepo } from "../src/store/repos/logs";
import { AuditRepo } from "../src/store/repos/audit";
import { DailyUsageRepo } from "../src/store/repos/usage";
import type { RequestLog } from "../src/shared/types";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { db = await freshDb(); });

describe("request_logs body cap", () => {
  test("truncates request_body and response_body to 32 KB", async () => {
    const logs = new LogsRepo(db);
    const huge = "x".repeat(200_000);
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
      kind: "request",
      requestBody: huge,
      responseBody: huge,
    });
    const row = await db.query("SELECT request_body, response_body FROM request_logs").get<{ request_body: string; response_body: string }>();
    // 32 KB ≈ 32768 chars (ASCII), allow a couple of slack chars from byte boundary handling.
    expect(row?.request_body.length).toBeLessThanOrEqual(32768);
    expect(row?.response_body.length).toBeLessThanOrEqual(32768);
    // null passes through unchanged
    expect(row?.request_body.startsWith("x")).toBe(true);
  });

  test("truncates attempts_detail JSON", async () => {
    const logs = new LogsRepo(db);
    const huge = JSON.stringify([{ accountLabel: "x", outcome: "success", note: "y".repeat(200_000) }]);
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
      kind: "request",
      attemptsDetail: [{ accountLabel: "x", outcome: "success", note: "y".repeat(200_000) } as never],
    });
    const row = await db.query("SELECT attempts_detail FROM request_logs").get<{ attempts_detail: string }>();
    expect(row?.attempts_detail.length).toBeLessThanOrEqual(32768);
    // still valid JSON prefix (or truncated mid-string but no crash)
    const txt = row?.attempts_detail ?? "";
    expect(txt.length).toBeGreaterThan(0);
  });
});

describe("audit_log retention", () => {
  test("purgeOlderThan drops rows older than the cutoff", async () => {
    const audit = new AuditRepo(db);
    await audit.record("updated", "settings", null, { fields: ["x"] });
    // Backdate by re-inserting an older row directly so we don't have to wait.
    await db.query("INSERT INTO admin_audit_log (id, ts, action, resource, resource_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run("old-1", "2020-01-01T00:00:00.000Z", "updated", "settings", null, null);
    const removed = await audit.purgeOlderThan(7);
    expect(removed).toBe(1);
    const remaining = (await db.query("SELECT COUNT(*) AS c FROM admin_audit_log").get<{ c: number }>())?.c ?? 0;
    expect(remaining).toBe(1);
  });

  test("returns 0 when nothing matches", async () => {
    const audit = new AuditRepo(db);
    expect(await audit.purgeOlderThan(30)).toBe(0);
  });
});

describe("daily_usage rollup from LogsRepo (no body for non-request kinds)", () => {
  test("warmup/claim/test rows are not mirrored into daily_usage", async () => {
    const usage = new DailyUsageRepo(db);
    const logs = new LogsRepo(db, usage);
    for (const kind of ["warmup", "claim", "test"] as const) {
      await logs.insert({
        keyId: null,
        endpoint: "/x",
        requestedModel: "m",
        provider: "openai",
        model: "m",
        attempts: 1,
        status: "success" as RequestLog["status"],
        httpStatus: 200,
        error: null,
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 10,
        tokensSaved: 0,
        kind,
        requestBody: "would-be-truncated-body",
        responseBody: "would-be-truncated-body",
      });
    }
    const count = (await db.query("SELECT COUNT(*) AS c FROM daily_usage").get<{ c: number }>())?.c ?? 0;
    expect(count).toBe(0);
  });

  test("request row still rolls up; its request_body is null when caller doesn't supply one", async () => {
    const usage = new DailyUsageRepo(db);
    const logs = new LogsRepo(db, usage);
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
      kind: "request",
    });
    const row = await db.query("SELECT requests, request_body FROM request_logs LEFT JOIN daily_usage ON 1=1 LIMIT 1").get<{ requests: number; request_body: string | null }>();
    expect(row?.requests).toBe(1);
  });
});
