import { describe, test, expect, beforeEach } from "bun:test";
import { freshDb } from "./helpers";
import { DailyUsageRepo } from "../src/store/repos/usage";
import { LogsRepo } from "../src/store/repos/logs";
import type { RequestLog } from "../src/shared/types";

let db: Awaited<ReturnType<typeof freshDb>>;

beforeEach(async () => {
  db = await freshDb();
});

describe("DailyUsageRepo.record", () => {
  test("inserts a new row for a (provider, model, account, day) bucket", async () => {
    const usage = new DailyUsageRepo(db);
    await usage.record("openai", "gpt-5", "acc-1", "2026-09-30T10:00:00.000Z", {
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      tokensSaved: 0,
      latencyMs: 200,
      errored: false,
    });
    const row = await db.query("SELECT * FROM daily_usage").get<{
      utc_day: string; provider: string; model: string; account_label: string;
      requests: number; input_tokens: number; output_tokens: number; errors: number; total_latency_ms: number;
    }>();
    expect(row).toMatchObject({
      utc_day: "2026-09-30",
      provider: "openai",
      model: "gpt-5",
      account_label: "acc-1",
      requests: 1,
      input_tokens: 100,
      output_tokens: 50,
      errors: 0,
      total_latency_ms: 200,
    });
  });

  test("upserts (adds to existing) for the same bucket on the same day", async () => {
    const usage = new DailyUsageRepo(db);
    for (let i = 0; i < 3; i++) {
      await usage.record("openai", "gpt-5", "acc-1", "2026-09-30T10:00:00.000Z", {
        inputTokens: 100, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0,
        reasoningTokens: 0, tokensSaved: 10, latencyMs: 200, errored: false,
      });
    }
    const row = await db.query("SELECT * FROM daily_usage").get<{
      requests: number; input_tokens: number; output_tokens: number;
      tokens_saved: number; errors: number; total_latency_ms: number;
    }>();
    expect(row).toMatchObject({
      requests: 3,
      input_tokens: 300,
      output_tokens: 150,
      tokens_saved: 30,
      errors: 0,
      total_latency_ms: 600,
    });
  });

  test("different day → new row", async () => {
    const usage = new DailyUsageRepo(db);
    await usage.record("openai", "gpt-5", "acc-1", "2026-09-29T10:00:00.000Z", {
      inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, tokensSaved: 0, latencyMs: 10, errored: false,
    });
    await usage.record("openai", "gpt-5", "acc-1", "2026-09-30T10:00:00.000Z", {
      inputTokens: 2, outputTokens: 2, cachedTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, tokensSaved: 0, latencyMs: 20, errored: false,
    });
    const rows = await db.query("SELECT utc_day, requests, input_tokens FROM daily_usage ORDER BY utc_day ASC").all<{ utc_day: string; requests: number; input_tokens: number }>();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ utc_day: "2026-09-29", requests: 1, input_tokens: 1 });
    expect(rows[1]).toMatchObject({ utc_day: "2026-09-30", requests: 1, input_tokens: 2 });
  });

  test("errored=true adds to errors counter", async () => {
    const usage = new DailyUsageRepo(db);
    await usage.record("openai", "gpt-5", null, "2026-09-30T10:00:00.000Z", {
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, tokensSaved: 0, latencyMs: 5, errored: true,
    });
    const row = await db.query("SELECT errors FROM daily_usage").get<{ errors: number }>();
    expect(row?.errors).toBe(1);
  });
});

describe("DailyUsageRepo.purgeOlderThan", () => {
  test("deletes only rows older than the cutoff", async () => {
    const usage = new DailyUsageRepo(db);
    await usage.record("openai", "gpt-5", "a", "2026-09-01T10:00:00.000Z", {
      inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, tokensSaved: 0, latencyMs: 10, errored: false,
    });
    await usage.record("openai", "gpt-5", "a", "2026-09-30T10:00:00.000Z", {
      inputTokens: 2, outputTokens: 2, cachedTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, tokensSaved: 0, latencyMs: 20, errored: false,
    });
    const removed = await usage.purgeOlderThan(7);
    expect(removed).toBe(1);
    const remaining = await db.query("SELECT utc_day FROM daily_usage").all<{ utc_day: string }>();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.utc_day).toBe("2026-09-30");
  });

  test("returns 0 when nothing matches", async () => {
    const usage = new DailyUsageRepo(db);
    expect(await usage.purgeOlderThan(30)).toBe(0);
  });
});

describe("DailyUsageRepo.clearAll", () => {
  test("deletes every row", async () => {
    const usage = new DailyUsageRepo(db);
    await usage.record("openai", "gpt-5", "a", "2026-09-30T10:00:00.000Z", {
      inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, tokensSaved: 0, latencyMs: 10, errored: false,
    });
    expect(await usage.clearAll()).toBe(1);
    expect(await usage.clearAll()).toBe(0);
  });
});

describe("DailyUsageRepo stats survive request_logs purge", () => {
  test("statsSummary / usageAggregate / usageByAccount read from daily_usage, not request_logs", async () => {
    const usage = new DailyUsageRepo(db);
    await usage.record("openai", "gpt-5", "acc-a", "2026-09-30T10:00:00.000Z", {
      inputTokens: 100, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, tokensSaved: 10, latencyMs: 200, errored: false,
    });
    await usage.record("openai", "gpt-5", "acc-b", "2026-09-30T11:00:00.000Z", {
      inputTokens: 5, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, tokensSaved: 0, latencyMs: 50, errored: true,
    });
    // Delete every request_logs row to mimic the 1-day purge.
    await db.query("DELETE FROM request_logs").run();

    const summary = await usage.statsSummary(7);
    expect(summary.requests).toBe(2);
    expect(summary.input_tokens).toBe(105);
    expect(summary.output_tokens).toBe(55);
    expect(summary.avg_latency_ms).toBe(125);
    expect(summary.success_rate).toBe(0.5);

    const [agg] = await usage.usageAggregate(7);
    expect(agg).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      requests: 2,
      input_tokens: 105,
      output_tokens: 55,
      errors: 1,
      avg_latency_ms: 125,
    });

    const accounts = await usage.usageByAccount("openai");
    expect(accounts).toHaveLength(2);
    const accA = accounts.find((a) => a.account === "acc-a");
    const accB = accounts.find((a) => a.account === "acc-b");
    expect(accA?.requests_total).toBe(1);
    expect(accA?.tokens_total).toBe(150);
    expect(accB?.requests_total).toBe(1);
    expect(accB?.tokens_total).toBe(10);
    // accB had errored=true so it counts as an error in `errors` totals but the
    // per-account row only exposes request/token totals.
  });
});

describe("LogsRepo.insert mirrors into daily_usage", () => {
  test("a LogsRepo constructed with a DailyUsageRepo upserts counters per request", async () => {
    const usage = new DailyUsageRepo(db);
    const logs = new LogsRepo(db, usage);
    const base = {
      keyId: null,
      endpoint: "/v1/chat/completions",
      requestedModel: "gpt-5",
      provider: "openai",
      model: "gpt-5",
      attempts: 1,
      status: "success" as RequestLog["status"],
      httpStatus: 200,
      error: null,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      latencyMs: 200,
      tokensSaved: 10,
      kind: "request",
      accountLabel: "acc-1",
    };
    await logs.insert(base);
    await logs.insert(base);

    const row = await db.query("SELECT requests, input_tokens, output_tokens, errors FROM daily_usage").get<{
      requests: number; input_tokens: number; output_tokens: number; errors: number;
    }>();
    expect(row).toMatchObject({ requests: 2, input_tokens: 200, output_tokens: 100, errors: 0 });
  });

  test("warmup/claim/test rows do not roll up (only kind=request does)", async () => {
    const usage = new DailyUsageRepo(db);
    const logs = new LogsRepo(db, usage);
    for (const kind of ["warmup", "claim", "test"]) {
      await logs.insert({
        keyId: null,
        endpoint: "/v1/chat/completions",
        requestedModel: "gpt-5",
        provider: "openai",
        model: "gpt-5",
        attempts: 1,
        status: "success",
        httpStatus: 200,
        error: null,
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 10,
        tokensSaved: 0,
        kind,
      });
    }
    const count = (await db.query("SELECT COUNT(*) AS c FROM daily_usage").get<{ c: number }>())?.c ?? 0;
    expect(count).toBe(0);
  });

  test("LogsRepo without DailyUsageRepo still works (rollup is best-effort)", async () => {
    const logs = new LogsRepo(db);
    await logs.insert({
      keyId: null,
      endpoint: "/v1/chat/completions",
      requestedModel: "gpt-5",
      provider: "openai",
      model: "gpt-5",
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
    const logCount = (await db.query("SELECT COUNT(*) AS c FROM request_logs").get<{ c: number }>())?.c ?? 0;
    const usageCount = (await db.query("SELECT COUNT(*) AS c FROM daily_usage").get<{ c: number }>())?.c ?? 0;
    expect(logCount).toBe(1);
    expect(usageCount).toBe(0);
  });
});