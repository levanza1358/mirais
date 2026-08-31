import type { Database } from "bun:sqlite";
import { ulid, nowIso } from "../../utils/id";
import type { RequestLog, AttemptRecord } from "../../shared/types";

export interface LogInsert {
  keyId: string | null;
  endpoint: string;
  requestedModel: string;
  provider: string | null;
  model: string | null;
  accountLabel?: string | null;
  attempts: number;
  status: RequestLog["status"];
  httpStatus: number | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  creditUsage?: number | null;
  creditSource?: RequestLog["credit_source"];
  latencyMs: number | null;
  tokensSaved: number;
  reasoningEffort?: RequestLog["reasoning_effort"];
  requestBody?: string | null;
  responseBody?: string | null;
  attemptsDetail?: AttemptRecord[] | null;
  /** 'request' (default) or 'warmup'. */
  kind?: string;
}

export class LogsRepo {
  constructor(private db: Database) {}

  insert(entry: LogInsert): void {
    this.db
      .query(
        `INSERT INTO request_logs
         (id, ts, key_id, endpoint, requested_model, provider, model, attempts, status, http_status, error,
         input_tokens, output_tokens, cached_tokens, cache_write_tokens, credit_usage, credit_source, latency_ms, tokens_saved, reasoning_effort, request_body, response_body, attempts_detail, account_label, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ulid(),
        nowIso(),
        entry.keyId,
        entry.endpoint,
        entry.requestedModel,
        entry.provider,
        entry.model,
        entry.attempts,
        entry.status,
        entry.httpStatus,
        entry.error,
        entry.inputTokens,
        entry.outputTokens,
        entry.cachedTokens ?? null,
        entry.cacheWriteTokens ?? null,
        entry.creditUsage ?? null,
        entry.creditSource ?? null,
        entry.latencyMs,
        entry.tokensSaved,
        entry.reasoningEffort ?? null,
        entry.requestBody ?? null,
        entry.responseBody ?? null,
        entry.attemptsDetail ? JSON.stringify(entry.attemptsDetail) : null,
        entry.accountLabel ?? null,
        entry.kind ?? "request",
      );
  }

  list(filters: {
    page: number;
    limit: number;
    model?: string;
    provider?: string;
    status?: string;
    keyId?: string;
    from?: string;
    to?: string;
    kind?: string;
  }): { items: RequestLog[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.model) { where.push("(model = ? OR requested_model = ?)"); params.push(filters.model, filters.model); }
    if (filters.provider) { where.push("provider = ?"); params.push(filters.provider); }
    if (filters.status) { where.push("status = ?"); params.push(filters.status); }
    if (filters.keyId) { where.push("key_id = ?"); params.push(filters.keyId); }
    if (filters.from) { where.push("ts >= ?"); params.push(filters.from); }
    if (filters.to) { where.push("ts <= ?"); params.push(filters.to); }
    if (filters.kind) { where.push("kind = ?"); params.push(filters.kind); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = (this.db.query(`SELECT COUNT(*) as c FROM request_logs ${whereSql}`).get(...params) as { c: number }).c;
    const items = this.db
      .query(
        `SELECT rl.id, rl.ts, rl.ts AS created_at, rl.key_id, gk.label AS key_label, rl.endpoint, rl.requested_model, rl.provider, rl.model, rl.attempts, rl.status, rl.http_status, rl.error,
                rl.input_tokens, rl.output_tokens, rl.cached_tokens, rl.cache_write_tokens, rl.credit_usage, rl.credit_source, rl.latency_ms, rl.tokens_saved, rl.reasoning_effort, rl.request_body, rl.response_body, rl.account_label, rl.kind
         FROM request_logs rl
         LEFT JOIN gateway_keys gk ON gk.id = rl.key_id
         ${whereSql} ORDER BY rl.ts DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, filters.limit, (filters.page - 1) * filters.limit) as RequestLog[];
    return { items, total };
  }

  /** Aggregated usage per (provider, model) for the Usage Log page — real
   * traffic only (warmup excluded). */
  usageAggregate(days: number): Array<{
    provider: string | null;
    model: string | null;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cache_write_tokens: number;
    avg_latency_ms: number;
    errors: number;
    last_ts: string;
  }> {
    return this.db
      .query(
        `SELECT provider, model,
                COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
                COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as errors,
                MAX(ts) as last_ts
         FROM request_logs
         WHERE ts >= datetime('now', ?) AND kind = 'request'
         GROUP BY provider, model
         ORDER BY requests DESC`,
      )
      .all(`-${days} days`) as never;
  }

  getById(id: string): RequestLog | null {
    return (this.db.query("SELECT * FROM request_logs WHERE id = ?").get(id) as RequestLog) ?? null;
  }

  purgeOlderThan(days: number): number {
    const res = this.db
      .query("DELETE FROM request_logs WHERE ts < datetime('now', ?)")
      .run(`-${days} days`);
    return res.changes;
  }

  clearAll(): number {
    const res = this.db.query("DELETE FROM request_logs").run();
    return res.changes;
  }

  // ── stats queries ──

  statsSummary(days: number) {
    const since = `-${days} days`;
    const totals = this.db
      .query(
        `SELECT COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(tokens_saved), 0) as tokens_saved,
                AVG(latency_ms) as avg_latency
         FROM request_logs WHERE ts >= datetime('now', ?) AND kind = 'request'`,
      )
      .get(since) as {
        requests: number;
        input_tokens: number;
        output_tokens: number;
        tokens_saved: number;
        avg_latency: number | null;
      };

    const successRow = this.db
      .query("SELECT COUNT(*) as c FROM request_logs WHERE ts >= datetime('now', ?) AND kind = 'request' AND status = 'success'")
      .get(since) as { c: number };

    return {
      range_days: days,
      requests: totals.requests,
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      tokens_saved: totals.tokens_saved,
      avg_latency_ms: Math.round(totals.avg_latency ?? 0),
      success_rate: totals.requests > 0 ? successRow.c / totals.requests : 1,
    };
  }

  statsTimeseries(days: number) {
    return this.db
      .query(
        `SELECT date(ts) as day,
                COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(tokens_saved), 0) as tokens_saved
         FROM request_logs
         WHERE ts >= datetime('now', ?) AND kind = 'request'
         GROUP BY date(ts) ORDER BY day ASC`,
      )
      .all(`-${days} days`);
  }

  statsByModel(days: number) {
    return this.db
      .query(
        `SELECT COALESCE(model, requested_model) as model,
                COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens
         FROM request_logs WHERE ts >= datetime('now', ?) AND kind = 'request'
         GROUP BY COALESCE(model, requested_model) ORDER BY requests DESC LIMIT 20`,
      )
      .all(`-${days} days`);
  }

  statsByProvider(days: number) {
    return this.db
      .query(
        `SELECT provider,
                COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as success_rate
         FROM request_logs WHERE ts >= datetime('now', ?) AND kind = 'request' AND provider IS NOT NULL
         GROUP BY provider ORDER BY requests DESC`,
      )
      .all(`-${days} days`);
  }

  /**
   * Per-account usage for one provider, keyed by account label (recorded in
   * attempts_detail). Returns today + all-time request/token totals.
   */
  usageByAccount(providerName: string): Array<{
    account: string;
    requests_today: number;
    tokens_today: number;
    requests_total: number;
    tokens_total: number;
  }> {
    const rows = this.db
      .query(
        `SELECT attempts_detail, ts, input_tokens, output_tokens
         FROM request_logs
         WHERE provider = ? AND attempts_detail IS NOT NULL AND kind = 'request'`,
      )
      .all(providerName) as Array<{
        attempts_detail: string;
        ts: string;
        input_tokens: number | null;
        output_tokens: number | null;
      }>;

    const today = new Date().toISOString().slice(0, 10);
    const acc = new Map<string, { requests_today: number; tokens_today: number; requests_total: number; tokens_total: number }>();
    for (const row of rows) {
      let label: string | undefined;
      try {
        const attempts = JSON.parse(row.attempts_detail) as Array<{ accountLabel?: string; outcome?: string }>;
        label = attempts.find((a) => a.outcome === "success")?.accountLabel ?? attempts[0]?.accountLabel;
      } catch { continue; }
      if (!label) continue;
      const entry = acc.get(label) ?? { requests_today: 0, tokens_today: 0, requests_total: 0, tokens_total: 0 };
      const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
      entry.requests_total += 1;
      entry.tokens_total += tokens;
      if (row.ts.slice(0, 10) === today) {
        entry.requests_today += 1;
        entry.tokens_today += tokens;
      }
      acc.set(label, entry);
    }
    return [...acc.entries()].map(([account, v]) => ({ account, ...v }));
  }
}
