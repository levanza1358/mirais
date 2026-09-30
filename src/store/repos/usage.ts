import type { Database } from "../sql";
import { num, coerceAggregates } from "../sql";

export interface UsageTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  tokensSaved: number;
  latencyMs: number;
  errored: boolean;
}

/**
 * Daily usage rollup. One row per (utc_day, provider, model, account_label).
 * Written by `LogsRepo.insert()` for `kind='request'`. Survives the 1-day
 * `request_logs` purge so Overview/Stats/usageByAccount still have history
 * across the operator's `log_retention_days` window (default 30).
 *
 * The values are counter totals per day — `record()` upserts (adds to the
 * existing row if one is already present for that bucket). `stats*`,
 * `providerHealth`, `usageByAccount`, and `usageAggregate` read from here.
 */
export class DailyUsageRepo {
  constructor(private db: Database) {}

  /** ISO ts of the request being rolled up; the day is derived in UTC. */
  async record(
    provider: string | null,
    model: string | null,
    accountLabel: string | null,
    ts: string,
    counts: UsageTokenCounts,
  ): Promise<void> {
    const utcDay = ts.slice(0, 10);
    await this.db.query(
      `INSERT INTO daily_usage
        (utc_day, provider, model, account_label,
         requests, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
         reasoning_tokens, tokens_saved, errors, total_latency_ms, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(utc_day, provider, model, account_label) DO UPDATE SET
         requests           = requests           + 1,
         input_tokens       = input_tokens       + excluded.input_tokens,
         output_tokens      = output_tokens      + excluded.output_tokens,
         cached_tokens      = cached_tokens      + excluded.cached_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         reasoning_tokens   = reasoning_tokens   + excluded.reasoning_tokens,
         tokens_saved       = tokens_saved       + excluded.tokens_saved,
         errors             = errors             + excluded.errors,
         total_latency_ms   = total_latency_ms   + excluded.total_latency_ms,
         updated_at         = datetime('now')`,
    ).run(
      utcDay,
      provider,
      model,
      accountLabel,
      counts.inputTokens,
      counts.outputTokens,
      counts.cachedTokens,
      counts.cacheWriteTokens,
      counts.reasoningTokens,
      counts.tokensSaved,
      counts.errored ? 1 : 0,
      counts.latencyMs,
    );
  }

  /**
   * Delete every `daily_usage` row (used by the dashboard's "Clear all logs").
   * Idempotent; counts rows before deleting because Bun's SQLite adapter does
   * not return `affectedRows` (see `LogsRepo.clearKind()`).
   */
  async clearAll(): Promise<number> {
    const before = (await this.db
      .query("SELECT COUNT(*) AS c FROM daily_usage")
      .get<{ c: number }>())?.c ?? 0;
    if (before === 0) return 0;
    await this.db.query("DELETE FROM daily_usage").run();
    return before;
  }

  /**
   * Purge rows older than `days` days (used by the hourly retention sweep).
   * Returns the number of rows deleted; relies on the same count-first
   * workaround as `clearAll()`.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const before = (await this.db
      .query("SELECT COUNT(*) AS c FROM daily_usage WHERE utc_day < ?")
      .get<{ c: number }>(cutoff))?.c ?? 0;
    if (before === 0) return 0;
    await this.db.query("DELETE FROM daily_usage WHERE utc_day < ?").run(cutoff);
    return before;
  }

  // ── stats queries (moved from LogsRepo) ──

  async statsSummary(days: number) {
    const since = daysAgo(days);
    const totals = await this.db
      .query(
        `SELECT COALESCE(SUM(requests), 0) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(tokens_saved), 0) as tokens_saved,
                CASE WHEN COALESCE(SUM(requests), 0) = 0 THEN 0
                     ELSE ROUND(SUM(total_latency_ms) * 1.0 / SUM(requests)) END as avg_latency_ms
         FROM daily_usage WHERE utc_day >= ?`,
      )
      .get<{
        requests: number;
        input_tokens: number;
        output_tokens: number;
        tokens_saved: number;
        avg_latency_ms: number | string | null;
      }>(since);
    const totalsRow = coerceAggregates(totals ?? {} as Record<string, unknown>, ["requests", "input_tokens", "output_tokens", "tokens_saved", "avg_latency_ms"]) as {
        requests: number; input_tokens: number; output_tokens: number;
        tokens_saved: number; avg_latency_ms: number;
      };
    const successRow = await this.db
      .query(
        `SELECT COALESCE(SUM(requests) - SUM(errors), 0) AS c
         FROM daily_usage WHERE utc_day >= ?`,
      )
      .get<{ c: number }>(since);
    const requests = num(totalsRow.requests);
    return {
      range_days: days,
      requests,
      input_tokens: num(totalsRow.input_tokens),
      output_tokens: num(totalsRow.output_tokens),
      tokens_saved: num(totalsRow.tokens_saved),
      avg_latency_ms: Math.round(num(totalsRow.avg_latency_ms)),
      success_rate: requests > 0 ? num(successRow?.c) / requests : 1,
    };
  }

  async statsTimeseries(days: number) {
    const since = daysAgo(days);
    const rows = await this.db
      .query(
        `SELECT utc_day as day,
                COALESCE(SUM(requests), 0) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(tokens_saved), 0) as tokens_saved
         FROM daily_usage WHERE utc_day >= ?
         GROUP BY utc_day ORDER BY day ASC`,
      )
      .all<{ day: string; requests: number; input_tokens: number; output_tokens: number; tokens_saved: number }>(since);
    return rows.map((row) => coerceAggregates(row, ["requests", "input_tokens", "output_tokens", "tokens_saved"]));
  }

  async statsByModel(days: number) {
    const since = daysAgo(days);
    const rows = await this.db
      .query(
        `SELECT model,
                COALESCE(SUM(requests), 0) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens
         FROM daily_usage WHERE utc_day >= ? AND model IS NOT NULL
         GROUP BY model ORDER BY requests DESC LIMIT 20`,
      )
      .all<{ model: string; requests: number; input_tokens: number; output_tokens: number }>(since);
    return rows.map((row) => coerceAggregates(row, ["requests", "input_tokens", "output_tokens"]));
  }

  async statsByProvider(days: number) {
    const since = daysAgo(days);
    const rows = await this.db
      .query(
        `SELECT provider,
                COALESCE(SUM(requests), 0) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                CASE WHEN COALESCE(SUM(requests), 0) = 0 THEN 0
                     ELSE 1.0 * (SUM(requests) - SUM(errors)) / SUM(requests) END as success_rate
         FROM daily_usage WHERE utc_day >= ? AND provider IS NOT NULL
         GROUP BY provider ORDER BY requests DESC`,
      )
      .all<{ provider: string; requests: number; input_tokens: number; output_tokens: number; success_rate: number }>(since);
    return rows.map((row) => coerceAggregates(row, ["requests", "input_tokens", "output_tokens", "success_rate"]));
  }

  async providerHealth(days = 7) {
    const since = daysAgo(days);
    const rows = await this.db
      .query(
        `SELECT provider,
                COALESCE(SUM(requests), 0) AS requests,
                COALESCE(SUM(errors), 0) AS errors,
                CASE WHEN COALESCE(SUM(requests), 0) = 0 THEN 0
                     ELSE 1.0 * SUM(errors) / SUM(requests) END AS error_rate,
                CASE WHEN COALESCE(SUM(requests), 0) = 0 THEN 0
                     ELSE ROUND(SUM(total_latency_ms) * 1.0 / SUM(requests)) END AS avg_latency_ms,
                MAX(updated_at) AS last_request_at
         FROM daily_usage WHERE utc_day >= ? AND provider IS NOT NULL
         GROUP BY provider ORDER BY requests DESC`,
      )
      .all<{ provider: string; requests: number; errors: number; error_rate: number; avg_latency_ms: number; last_request_at: string }>(since);
    return rows.map((row) => coerceAggregates(row, ["requests", "errors", "error_rate", "avg_latency_ms"]));
  }

  async usageAggregate(days: number) {
    const since = daysAgo(days);
    const rows = await this.db
      .query(
        `SELECT provider, model,
                COALESCE(SUM(requests), 0) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
                COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
                CASE WHEN COALESCE(SUM(requests), 0) = 0 THEN 0
                     ELSE ROUND(SUM(total_latency_ms) * 1.0 / SUM(requests)) END as avg_latency_ms,
                COALESCE(SUM(errors), 0) as errors,
                MAX(updated_at) as last_ts
         FROM daily_usage WHERE utc_day >= ?
         GROUP BY provider, model
         ORDER BY requests DESC`,
      )
      .all<{
        provider: string | null;
        model: string | null;
        requests: number;
        input_tokens: number;
        output_tokens: number;
        cached_tokens: number;
        cache_write_tokens: number;
        reasoning_tokens: number;
        avg_latency_ms: number;
        errors: number;
        last_ts: string;
      }>(since);
    return rows.map((row) => coerceAggregates(row, [
      "requests", "input_tokens", "output_tokens",
      "cached_tokens", "cache_write_tokens", "reasoning_tokens",
      "avg_latency_ms", "errors",
    ]));
  }

  async usageByAccount(providerName: string): Promise<Array<{
    account: string;
    requests_today: number;
    tokens_today: number;
    requests_total: number;
    tokens_total: number;
  }>> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.db
      .query(
        `SELECT COALESCE(account_label, '<none>') AS account,
                COALESCE(SUM(CASE WHEN utc_day = ? THEN requests ELSE 0 END), 0) AS requests_today,
                COALESCE(SUM(CASE WHEN utc_day = ? THEN input_tokens + output_tokens ELSE 0 END), 0) AS tokens_today,
                COALESCE(SUM(requests), 0) AS requests_total,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens_total
         FROM daily_usage WHERE provider = ?
         GROUP BY COALESCE(account_label, '<none>')
         ORDER BY tokens_total DESC`,
      )
      .all<{ account: string; requests_today: number; tokens_today: number; requests_total: number; tokens_total: number }>(
        today, today, providerName,
      );
    return rows.map((row) => coerceAggregates(row, ["requests_today", "tokens_today", "requests_total", "tokens_total"]));
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}