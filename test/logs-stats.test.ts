import { describe, test, expect } from "bun:test";
import type { Database } from "../src/store/sql";
import { num, coerceAggregates } from "../src/store/sql";
import { DailyUsageRepo } from "../src/store/repos/usage";
import { LogsRepo } from "../src/store/repos/logs";

/**
 * SQLite (the test harness) returns `number` for `SUM()`/`AVG()`, so it cannot
 * reproduce the production bug. MySQL types those aggregates as DECIMAL and Bun's
 * adapter hands DECIMAL back as a **string**, which turns `a + b` into string
 * concatenation. These fixtures therefore inject MySQL-shaped rows (string
 * aggregates, numeric `COUNT(*)`) through a fake `Database`.
 */
function mysqlShapedDb(handler: (sql: string) => unknown): Database {
  return {
    query(statement: string) {
      const result = handler(statement);
      const rows: unknown[] = result === undefined || result === null
        ? []
        : Array.isArray(result) ? result : [result];
      return {
        get: async () => rows[0] ?? null,
        all: async () => rows,
        run: async () => ({ changes: 0 }),
      };
    },
  } as unknown as Database;
}

describe("num()", () => {
  test("passes finite numbers through", () => {
    expect(num(0)).toBe(0);
    expect(num(4833)).toBe(4833);
    expect(num(-12.5)).toBe(-12.5);
  });

  test("parses the DECIMAL strings MySQL returns for aggregates", () => {
    expect(num("300581189")).toBe(300581189);
    expect(num("8080.4341")).toBe(8080.4341);
    expect(num(" 42 ")).toBe(42);
  });

  test("converts bigint", () => {
    expect(num(302075009n)).toBe(302075009);
  });

  test("falls back for nullish, empty and non-numeric values", () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("")).toBe(0);
    expect(num("   ")).toBe(0);
    expect(num("abc")).toBe(0);
    expect(num({})).toBe(0);
    expect(num(NaN)).toBe(0);
    expect(num(Infinity)).toBe(0);
    expect(num(null, -1)).toBe(-1);
  });

  test("coerceAggregates only rewrites the listed fields and does not mutate the row", () => {
    const row: Record<string, unknown> = { day: "2026-09-30", requests: 10, input_tokens: "300581189", tokens_saved: "5" };
    const out = coerceAggregates(row, ["input_tokens", "tokens_saved"]);
    expect(out["input_tokens"]).toBe(300581189);
    expect(out["tokens_saved"]).toBe(5);
    expect(out["requests"]).toBe(10);
    expect(out["day"]).toBe("2026-09-30");
    // original untouched
    expect(row["input_tokens"]).toBe("300581189");
  });
});

describe("LogsRepo aggregate coercion (MySQL DECIMAL shape)", () => {
  test("statsSummary returns numbers, so token totals add instead of concatenating", async () => {
    const db = mysqlShapedDb((sql) => {
      if (sql.includes("requests) - SUM(errors)")) return { c: 4750 };
      return {
        requests: 4833,
        input_tokens: "300581189",
        output_tokens: "1493820",
        tokens_saved: "10515718",
        avg_latency_ms: "8080.4341",
      };
    });
    const summary = await new DailyUsageRepo(db).statsSummary(7);

    expect(typeof summary.input_tokens).toBe("number");
    expect(typeof summary.output_tokens).toBe("number");
    expect(typeof summary.tokens_saved).toBe("number");
    expect(summary.avg_latency_ms).toBe(8080);
    // The bug rendered "300581189" + "1493820" as the 16-digit 3005811891493820.
    expect(summary.input_tokens + summary.output_tokens).toBe(302075009);
    expect(summary.requests).toBe(4833);
    expect(summary.success_rate).toBeCloseTo(4750 / 4833, 10);
  });

  test("statsSummary reports success_rate 1 when there are no requests", async () => {
    const db = mysqlShapedDb((sql) => {
      if (sql.includes("requests) - SUM(errors)")) return { c: 0 };
      return { requests: 0, input_tokens: "0", output_tokens: "0", tokens_saved: "0", total_latency_ms: 0 };
    });
    const summary = await new DailyUsageRepo(db).statsSummary(7);
    expect(summary.requests).toBe(0);
    expect(summary.success_rate).toBe(1);
    expect(summary.avg_latency_ms).toBe(0);
  });

  test("keyUsage coerces every token counter", async () => {
    const db = mysqlShapedDb((sql) => {
      if (sql.includes("GROUP BY")) return [{ model: "gpt-5", requests: 12, tokens: "900" }];
      if (sql.includes("SUM(input_tokens), 0) AS input_tokens")) {
        return { requests: 20, input_tokens: "1000", output_tokens: "500" };
      }
      if (sql.includes("SUM(input_tokens) + SUM(output_tokens)")) return { requests: 5, tokens: "1500" };
      return { requests: 7 };
    });
    const usage = await new LogsRepo(db).keyUsage("key-1");

    expect(usage.tokens_total).toBe(1500);
    expect(usage.tokens_today).toBe(1500);
    expect(usage.input_tokens_total).toBe(1000);
    expect(usage.output_tokens_total).toBe(500);
    expect(usage.requests_today).toBe(5);
    expect(usage.requests_total).toBe(20);
    expect(usage.requests_minute).toBe(7);
    expect(usage.top_models[0]?.tokens).toBe(900);
    expect(usage.input_tokens_total + usage.output_tokens_total).toBe(1500);
  });

  test("usageAggregate / statsTimeseries / statsByModel / statsByProvider / providerHealth coerce their rows", async () => {
    const aggRow = {
      provider: "openai",
      model: "gpt-5",
      day: "2026-09-30",
      requests: 3,
      input_tokens: "300581189",
      output_tokens: "1493820",
      cached_tokens: "10",
      cache_write_tokens: "20",
      reasoning_tokens: "30",
      tokens_saved: "40",
      avg_latency_ms: "12.7",
      errors: "2",
      error_rate: "0.5",
      success_rate: "0.9",
      last_ts: "2026-09-30T10:00:00.000Z",
      last_request_at: "2026-09-30T10:00:00.000Z",
    };
    const db = mysqlShapedDb(() => aggRow);
    const repo = new DailyUsageRepo(db);

    const [usage] = await repo.usageAggregate(7);
    expect(usage?.input_tokens).toBe(300581189);
    expect(usage?.output_tokens).toBe(1493820);
    expect(usage?.cached_tokens).toBe(10);
    expect(usage?.cache_write_tokens).toBe(20);
    expect(usage?.reasoning_tokens).toBe(30);
    expect(usage?.avg_latency_ms).toBe(12.7);
    expect(usage?.errors).toBe(2);
    expect(usage?.last_ts).toBe("2026-09-30T10:00:00.000Z");

    const [ts] = await repo.statsTimeseries(7);
    expect((ts?.input_tokens ?? 0) + (ts?.output_tokens ?? 0)).toBe(302075009);

    const [byModel] = await repo.statsByModel(7);
    expect(byModel?.input_tokens).toBe(300581189);

    const [byProvider] = await repo.statsByProvider(7);
    expect(byProvider?.success_rate).toBe(0.9);

    const [health] = await repo.providerHealth(7);
    expect(health?.error_rate).toBe(0.5);
    expect(health?.avg_latency_ms).toBe(12.7);
    expect(health?.errors).toBe(2);
  });

  test("usageByAccount aggregates per account_label from daily_usage", async () => {
    const db = mysqlShapedDb(() => [
      { account: "acc-a", requests_today: 2, tokens_today: "1523", requests_total: 2, tokens_total: "1523" },
    ]);
    const [acc] = await new DailyUsageRepo(db).usageByAccount("openai");

    expect(acc?.account).toBe("acc-a");
    expect(acc?.tokens_total).toBe(1523);
    expect(acc?.tokens_today).toBe(1523);
    expect(acc?.requests_total).toBe(2);
    expect(acc?.requests_today).toBe(2);
  });
});
