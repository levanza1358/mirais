import type { Database } from "../sql";
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
  reasoningTokens?: number | null;
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

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function utcDayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export class LogsRepo {
  constructor(private db: Database) {}

async insert(entry: LogInsert): Promise<void> {
  await this.db
      .query(
        `INSERT INTO request_logs
         (id, ts, key_id, endpoint, requested_model, provider, model, attempts, status, http_status, error,
         input_tokens, output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, credit_usage, credit_source, latency_ms, tokens_saved, reasoning_effort, request_body, response_body, attempts_detail, account_label, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        entry.reasoningTokens ?? null,
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

  async list(filters: {
    page: number;
    limit: number;
    model?: string;
    provider?: string;
    status?: string;
    keyId?: string;
    from?: string;
    to?: string;
    kind?: string;
  }): Promise<{ items: RequestLog[]; total: number }> {
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

    const count = await this.db.query(`SELECT COUNT(*) as c FROM request_logs ${whereSql}`).get<{ c: number }>(...params);
    const total = count?.c ?? 0;
    const items = await this.db
      .query(
        `SELECT rl.id, rl.ts, rl.ts AS created_at, rl.key_id, gk.label AS key_label, rl.endpoint, rl.requested_model, rl.provider, rl.model, rl.attempts, rl.status, rl.http_status, rl.error,
                rl.input_tokens, rl.output_tokens, rl.cached_tokens, rl.cache_write_tokens, rl.reasoning_tokens, rl.credit_usage, rl.credit_source, rl.latency_ms, rl.tokens_saved, rl.reasoning_effort, rl.request_body, rl.response_body, rl.account_label, rl.kind
         FROM request_logs rl
         LEFT JOIN gateway_keys gk ON gk.id = rl.key_id
         ${whereSql} ORDER BY rl.ts DESC LIMIT ? OFFSET ?`,
      )
      .all<RequestLog>(...params, filters.limit, (filters.page - 1) * filters.limit);
    return { items, total };
  }

  /** Aggregated usage per (provider, model) for the Usage Log page — real
   * traffic only (warmup excluded). */
  usageAggregate(days: number): Promise<Array<{
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
  }>> {
    return this.db
      .query(
        `SELECT provider, model,
                COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
                COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
                COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as errors,
                MAX(ts) as last_ts
         FROM request_logs
         WHERE ts >= ? AND kind = 'request'
         GROUP BY provider, model
         ORDER BY requests DESC`,
      )
      .all(daysAgo(days));
  }

  async keyUsage(keyId: string): Promise<{ requests_today: number; tokens_today: number; tokens_total: number; requests_minute: number; requests_total: number; input_tokens_total: number; output_tokens_total: number; top_models: Array<{ model: string; requests: number; tokens: number }> }> {
    const total = await this.db.query("SELECT COALESCE(SUM(input_tokens) + SUM(output_tokens), 0) AS tokens FROM request_logs WHERE key_id = ?").get<{ tokens: number }>(keyId);
    const today = await this.db.query("SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens) + SUM(output_tokens), 0) AS tokens FROM request_logs WHERE key_id = ? AND ts >= ?").get<{ requests: number; tokens: number }>(keyId, utcDayStart());
    const minute = await this.db.query("SELECT COUNT(*) AS requests FROM request_logs WHERE key_id = ? AND ts >= ?").get<{ requests: number }>(keyId, daysAgo(1 / 1440));
    const totals = await this.db.query("SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens FROM request_logs WHERE key_id = ?").get<{ requests: number; input_tokens: number; output_tokens: number }>(keyId);
    const topModels = await this.db.query("SELECT COALESCE(model, requested_model) AS model, COUNT(*) AS requests, COALESCE(SUM(input_tokens) + SUM(output_tokens), 0) AS tokens FROM request_logs WHERE key_id = ? GROUP BY COALESCE(model, requested_model) ORDER BY tokens DESC LIMIT 5").all<{ model: string; requests: number; tokens: number }>(keyId);
    return { requests_today: today?.requests ?? 0, tokens_today: today?.tokens ?? 0, tokens_total: total?.tokens ?? 0, requests_minute: minute?.requests ?? 0, requests_total: totals?.requests ?? 0, input_tokens_total: totals?.input_tokens ?? 0, output_tokens_total: totals?.output_tokens ?? 0, top_models: topModels };
  }

  getById(id: string): Promise<RequestLog | null> {
    return this.db.query("SELECT * FROM request_logs WHERE id = ?").get<RequestLog>(id);
  }

  async getReplayBody(id: string): Promise<{ endpoint: string; body: Record<string, unknown> } | null> {
    const row = await this.getById(id);
    if (!row || row.kind !== "request" || !row.request_body) return null;
    try {
      const parsed = JSON.parse(row.request_body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const body = { ...(parsed as Record<string, unknown>), stream: false };
      return { endpoint: "/v1/chat/completions", body };
    } catch {
      return null;
    }
  }

  async purgeOlderThan(days: number): Promise<number> {
    const res = await this.db
      .query("DELETE FROM request_logs WHERE ts < ?")
      .run(daysAgo(days));
    return res.changes;
  }

  async clearAll(): Promise<number> {
    const res = await this.db.query("DELETE FROM request_logs").run();
    return res.changes;
  }

  // ── stats queries ──

  async statsSummary(days: number) {
    const since = daysAgo(days);
    const totals = await this.db
      .query(
        `SELECT COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(tokens_saved), 0) as tokens_saved,
                AVG(latency_ms) as avg_latency
        FROM request_logs WHERE ts >= ? AND kind = 'request'`,
      )
      .get<{
        requests: number;
        input_tokens: number;
        output_tokens: number;
        tokens_saved: number;
        avg_latency: number | null;
      }>(since);

    const successRow = await this.db
      .query("SELECT COUNT(*) as c FROM request_logs WHERE ts >= ? AND kind = 'request' AND status = 'success'")
      .get<{ c: number }>(since);

    return {
      range_days: days,
      requests: totals?.requests ?? 0,
      input_tokens: totals?.input_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
      tokens_saved: totals?.tokens_saved ?? 0,
      avg_latency_ms: Math.round(totals?.avg_latency ?? 0),
      success_rate: totals && totals.requests > 0 ? (successRow?.c ?? 0) / totals.requests : 1,
    };
  }

  statsTimeseries(days: number) {
    return this.db
      .query(
        `SELECT LEFT(ts, 10) as day,
                COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(tokens_saved), 0) as tokens_saved
         FROM request_logs
         WHERE ts >= ? AND kind = 'request'
         GROUP BY LEFT(ts, 10) ORDER BY day ASC`,
      )
      .all(daysAgo(days));
  }

  statsByModel(days: number) {
    return this.db
      .query(
        `SELECT COALESCE(model, requested_model) as model,
                COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens
         FROM request_logs WHERE ts >= ? AND kind = 'request'
         GROUP BY COALESCE(model, requested_model) ORDER BY requests DESC LIMIT 20`,
      )
      .all(daysAgo(days));
  }

  statsByProvider(days: number) {
    return this.db
      .query(
        `SELECT provider,
                COUNT(*) as requests,
                COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as success_rate
         FROM request_logs WHERE ts >= ? AND kind = 'request' AND provider IS NOT NULL
         GROUP BY provider ORDER BY requests DESC`,
      )
      .all(daysAgo(days));
  }

  providerHealth(days = 7) {
    return this.db.query(
      `SELECT provider,
              COUNT(*) AS requests,
              SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS error_rate,
              ROUND(COALESCE(AVG(latency_ms), 0)) AS avg_latency_ms,
              MAX(ts) AS last_request_at
       FROM request_logs
      WHERE kind = 'request' AND provider IS NOT NULL AND ts >= ?
       GROUP BY provider ORDER BY requests DESC`,
    ).all(daysAgo(days));
  }

  /**
   * Per-account usage for one provider, keyed by account label (recorded in
   * attempts_detail). Returns today + all-time request/token totals.
   */
  async usageByAccount(providerName: string): Promise<Array<{
    account: string;
    requests_today: number;
    tokens_today: number;
    requests_total: number;
    tokens_total: number;
  }>> {
    const rows = await this.db
      .query(
        `SELECT attempts_detail, ts, input_tokens, output_tokens
         FROM request_logs
         WHERE provider = ? AND attempts_detail IS NOT NULL AND kind = 'request'`,
      )
      .all<{
        attempts_detail: string;
        ts: string;
        input_tokens: number | null;
        output_tokens: number | null;
      }>(providerName);

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
