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

/**
 * MySQL returns `SUM()`/`AVG()` results as `DECIMAL`, and Bun's MySQL adapter
 * decodes `DECIMAL` as a *string* to preserve precision. `COUNT(*)` is a
 * `BIGINT` that fits in 32 bits, so it comes back as a number — which is why
 * only the summed columns were ever wrong. Left uncoerced, these strings reach
 * the dashboard and turn arithmetic into string concatenation
 * (`"7865349" + "31275"` → `"786534931275"`), inflating token totals by
 * roughly 1,000×.
 *
 * The SQL below therefore `CAST(... AS SIGNED|DOUBLE)`s every aggregate back to
 * a number, and this helper is the belt-and-braces guarantee for any row that
 * still arrives typed as a string.
 */
export function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function utcDayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export class LogsRepo {
  constructor(private db: Database) {}

  async insert(entry: LogInsert): Promise<void> {
    const id = ulid();
    const insert = this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO request_logs
         (id, ts, key_id, endpoint, requested_model, provider, model, attempts, status, http_status, error,
         input_tokens, output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, credit_usage, credit_source, latency_ms, tokens_saved, reasoning_effort, attempts_detail, account_label, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
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
        entry.attemptsDetail ? JSON.stringify(entry.attemptsDetail) : null,
        entry.accountLabel ?? null,
        entry.kind ?? "request",
      );
      if (entry.requestBody != null || entry.responseBody != null) {
        await tx.query(
          `INSERT INTO request_log_payloads (request_log_id, request_body, response_body, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(id, entry.requestBody ?? null, entry.responseBody ?? null, nowIso());
      }
    });
    await insert();
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

    const count = await this.db.query(`SELECT COUNT(*) as c FROM request_logs ${whereSql}`).get<{ c: number | string }>(...params);
    const total = num(count?.c);
    const items = await this.db
      .query(
        `SELECT rl.id, rl.ts, rl.ts AS created_at, rl.key_id, gk.label AS key_label, rl.endpoint, rl.requested_model, rl.provider, rl.model, rl.attempts, rl.status, rl.http_status, rl.error,
                rl.input_tokens, rl.output_tokens, rl.cached_tokens, rl.cache_write_tokens, rl.reasoning_tokens, rl.credit_usage, rl.credit_source, rl.latency_ms, rl.tokens_saved, rl.reasoning_effort, rl.account_label, rl.kind,
                EXISTS (SELECT 1 FROM request_log_payloads p WHERE p.request_log_id = rl.id) AS has_payload
         FROM request_logs rl
         LEFT JOIN gateway_keys gk ON gk.id = rl.key_id
         ${whereSql} ORDER BY rl.ts DESC, rl.id DESC LIMIT ? OFFSET ?`,
      )
      .all<RequestLog>(...params, filters.limit, (filters.page - 1) * filters.limit);
    return { items, total };
  }

  /** Aggregated usage per (provider, model) for the Usage Log page — real
   * traffic only (warmup excluded). */
  async usageAggregate(days: number): Promise<Array<{
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
    const rows = await this.db
      .query(
        `SELECT provider, model,
                COUNT(*) as requests,
                CAST(COALESCE(SUM(input_tokens), 0) AS SIGNED) as input_tokens,
                CAST(COALESCE(SUM(output_tokens), 0) AS SIGNED) as output_tokens,
                CAST(COALESCE(SUM(cached_tokens), 0) AS SIGNED) as cached_tokens,
                CAST(COALESCE(SUM(cache_write_tokens), 0) AS SIGNED) as cache_write_tokens,
                CAST(COALESCE(SUM(reasoning_tokens), 0) AS SIGNED) as reasoning_tokens,
                CAST(COALESCE(AVG(latency_ms), 0) AS SIGNED) as avg_latency_ms,
                CAST(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS SIGNED) as errors,
                MAX(ts) as last_ts
         FROM request_logs
         WHERE ts >= ? AND kind = 'request'
         GROUP BY provider, model
         ORDER BY requests DESC`,
      )
      .all<{
        provider: string | null;
        model: string | null;
        requests: number | string;
        input_tokens: number | string;
        output_tokens: number | string;
        cached_tokens: number | string;
        cache_write_tokens: number | string;
        reasoning_tokens: number | string;
        avg_latency_ms: number | string;
        errors: number | string;
        last_ts: string;
      }>(daysAgo(days));

    return rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      requests: num(row.requests),
      input_tokens: num(row.input_tokens),
      output_tokens: num(row.output_tokens),
      cached_tokens: num(row.cached_tokens),
      cache_write_tokens: num(row.cache_write_tokens),
      reasoning_tokens: num(row.reasoning_tokens),
      avg_latency_ms: num(row.avg_latency_ms),
      errors: num(row.errors),
      last_ts: row.last_ts,
    }));
  }

  async keyUsage(keyId: string): Promise<{ requests_today: number; tokens_today: number; tokens_total: number; requests_minute: number; requests_total: number; input_tokens_total: number; output_tokens_total: number; top_models: Array<{ model: string; requests: number; tokens: number }> }> {
    // Every SUM() is CAST back to SIGNED: MySQL evaluates it as DECIMAL, which
    // Bun's driver decodes as a string (see `num` above).
    const total = await this.db.query("SELECT CAST(COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS SIGNED) AS tokens FROM request_logs WHERE key_id = ?").get<{ tokens: number | string }>(keyId);
    const today = await this.db.query("SELECT COUNT(*) AS requests, CAST(COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS SIGNED) AS tokens FROM request_logs WHERE key_id = ? AND ts >= ?").get<{ requests: number | string; tokens: number | string }>(keyId, utcDayStart());
    const minute = await this.db.query("SELECT COUNT(*) AS requests FROM request_logs WHERE key_id = ? AND ts >= ?").get<{ requests: number | string }>(keyId, daysAgo(1 / 1440));
    const totals = await this.db.query("SELECT COUNT(*) AS requests, CAST(COALESCE(SUM(input_tokens), 0) AS SIGNED) AS input_tokens, CAST(COALESCE(SUM(output_tokens), 0) AS SIGNED) AS output_tokens FROM request_logs WHERE key_id = ?").get<{ requests: number | string; input_tokens: number | string; output_tokens: number | string }>(keyId);
    const topModels = await this.db.query("SELECT COALESCE(model, requested_model) AS model, COUNT(*) AS requests, CAST(COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS SIGNED) AS tokens FROM request_logs WHERE key_id = ? GROUP BY COALESCE(model, requested_model) ORDER BY tokens DESC LIMIT 5").all<{ model: string; requests: number | string; tokens: number | string }>(keyId);
    return {
      requests_today: num(today?.requests),
      tokens_today: num(today?.tokens),
      tokens_total: num(total?.tokens),
      requests_minute: num(minute?.requests),
      requests_total: num(totals?.requests),
      input_tokens_total: num(totals?.input_tokens),
      output_tokens_total: num(totals?.output_tokens),
      top_models: topModels.map((m) => ({ model: m.model, requests: num(m.requests), tokens: num(m.tokens) })),
    };
  }

  getById(id: string): Promise<RequestLog | null> {
    return this.db.query(
      `SELECT rl.*, COALESCE(p.request_body, rl.request_body) AS request_body,
              COALESCE(p.response_body, rl.response_body) AS response_body,
              CASE WHEN p.request_log_id IS NULL THEN 0 ELSE 1 END AS has_payload
       FROM request_logs rl
       LEFT JOIN request_log_payloads p ON p.request_log_id = rl.id
       WHERE rl.id = ?`,
    ).get<RequestLog>(id);
  }

  async getReplayBody(id: string): Promise<{ endpoint: string; body: Record<string, unknown> } | null> {
    const row = await this.db.query(
      `SELECT rl.kind, rl.endpoint, COALESCE(p.request_body, rl.request_body) AS request_body
       FROM request_logs rl
       LEFT JOIN request_log_payloads p ON p.request_log_id = rl.id
       WHERE rl.id = ?`,
    ).get<{ kind?: string; endpoint: string; request_body: string | null }>(id);
    if (!row || row.kind !== "request" || !row.request_body) return null;
    try {
      const parsed = JSON.parse(row.request_body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const body = { ...(parsed as Record<string, unknown>), stream: false };
      return { endpoint: row.endpoint, body };
    } catch {
      return null;
    }
  }

  async purgePayloadsOlderThan(days: number): Promise<number> {
    const res = await this.db.query("DELETE FROM request_log_payloads WHERE created_at < ?").run(daysAgo(days));
    return res.changes;
  }

  async cleanupLegacyPayloads(batchSize = 250): Promise<number> {
    const cutoff = daysAgo(7);
    const tx = this.db.transaction(async (db) => {
      const rows = await db.query(
        `SELECT id, ts, request_body, response_body
         FROM request_logs
         WHERE request_body IS NOT NULL OR response_body IS NOT NULL
         ORDER BY id ASC LIMIT ?`,
      ).all<{ id: string; ts: string; request_body: string | null; response_body: string | null }>(batchSize);
      if (rows.length === 0) {
        await db.query("UPDATE request_log_payload_cleanup SET cursor_id = NULL, updated_at = ? WHERE id = 1").run(nowIso());
        return 0;
      }
      for (const row of rows) {
        if (row.request_body == null && row.response_body == null) continue;
        if (row.ts >= cutoff) {
          if (db.dialect === "mysql") {
            await db.query(
              `INSERT INTO request_log_payloads (request_log_id, request_body, response_body, created_at)
               VALUES (?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE request_body = COALESCE(request_body, VALUES(request_body)), response_body = COALESCE(response_body, VALUES(response_body))`,
            ).run(row.id, row.request_body, row.response_body, row.ts);
          } else {
            await db.query(
              `INSERT INTO request_log_payloads (request_log_id, request_body, response_body, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(request_log_id) DO UPDATE SET request_body = COALESCE(request_log_payloads.request_body, excluded.request_body), response_body = COALESCE(request_log_payloads.response_body, excluded.response_body)`,
            ).run(row.id, row.request_body, row.response_body, row.ts);
          }
        }
        await db.query("UPDATE request_logs SET request_body = NULL, response_body = NULL WHERE id = ?").run(row.id);
      }
      await db.query("UPDATE request_log_payload_cleanup SET cursor_id = ?, updated_at = ? WHERE id = 1").run(rows.at(-1)?.id ?? null, nowIso());
      return rows.length;
    });
    return tx();
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
    // SUM()/AVG() come back from MySQL as DECIMAL → string in Bun's driver, so
    // each is CAST to a JS-friendly numeric type before it reaches the client.
    const totals = await this.db
      .query(
        `SELECT COUNT(*) as requests,
                CAST(COALESCE(SUM(input_tokens), 0) AS SIGNED) as input_tokens,
                CAST(COALESCE(SUM(output_tokens), 0) AS SIGNED) as output_tokens,
                CAST(COALESCE(SUM(tokens_saved), 0) AS SIGNED) as tokens_saved,
                COALESCE(AVG(latency_ms), 0) as avg_latency
        FROM request_logs WHERE ts >= ? AND kind = 'request'`,
      )
      .get<{
        requests: number | string;
        input_tokens: number | string;
        output_tokens: number | string;
        tokens_saved: number | string;
        avg_latency: number | string | null;
      }>(since);

    const successRow = await this.db
      .query("SELECT COUNT(*) as c FROM request_logs WHERE ts >= ? AND kind = 'request' AND status = 'success'")
      .get<{ c: number | string }>(since);

    const requests = num(totals?.requests);
    return {
      range_days: days,
      requests,
      input_tokens: num(totals?.input_tokens),
      output_tokens: num(totals?.output_tokens),
      tokens_saved: num(totals?.tokens_saved),
      avg_latency_ms: Math.round(num(totals?.avg_latency)),
      success_rate: requests > 0 ? num(successRow?.c) / requests : 1,
    };
  }

  statsTimeseries(days: number) {
    return this.db
      .query(
        `SELECT LEFT(ts, 10) as day,
                COUNT(*) as requests,
                CAST(COALESCE(SUM(input_tokens), 0) AS SIGNED) as input_tokens,
                CAST(COALESCE(SUM(output_tokens), 0) AS SIGNED) as output_tokens,
                CAST(COALESCE(SUM(tokens_saved), 0) AS SIGNED) as tokens_saved
         FROM request_logs
         WHERE ts >= ? AND kind = 'request'
         GROUP BY LEFT(ts, 10) ORDER BY day ASC`,
      )
      .all<{ day: string; requests: number | string; input_tokens: number | string; output_tokens: number | string; tokens_saved: number | string }>(daysAgo(days))
      .then((rows) => rows.map((row) => ({
        day: row.day,
        requests: num(row.requests),
        input_tokens: num(row.input_tokens),
        output_tokens: num(row.output_tokens),
        tokens_saved: num(row.tokens_saved),
      })));
  }

  statsByModel(days: number) {
    return this.db
      .query(
        `SELECT COALESCE(model, requested_model) as model,
                COUNT(*) as requests,
                CAST(COALESCE(SUM(input_tokens), 0) AS SIGNED) as input_tokens,
                CAST(COALESCE(SUM(output_tokens), 0) AS SIGNED) as output_tokens
         FROM request_logs WHERE ts >= ? AND kind = 'request'
         GROUP BY COALESCE(model, requested_model) ORDER BY requests DESC LIMIT 20`,
      )
      .all<{ model: string; requests: number | string; input_tokens: number | string; output_tokens: number | string }>(daysAgo(days))
      .then((rows) => rows.map((row) => ({
        model: row.model,
        requests: num(row.requests),
        input_tokens: num(row.input_tokens),
        output_tokens: num(row.output_tokens),
      })));
  }

  statsByProvider(days: number) {
    return this.db
      .query(
        `SELECT provider,
                COUNT(*) as requests,
                CAST(COALESCE(SUM(input_tokens), 0) AS SIGNED) as input_tokens,
                CAST(COALESCE(SUM(output_tokens), 0) AS SIGNED) as output_tokens,
                CAST(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS SIGNED) * 1.0 / COUNT(*) as success_rate
         FROM request_logs WHERE ts >= ? AND kind = 'request' AND provider IS NOT NULL
         GROUP BY provider ORDER BY requests DESC`,
      )
      .all<{ provider: string; requests: number | string; input_tokens: number | string; output_tokens: number | string; success_rate: number | string }>(daysAgo(days))
      .then((rows) => rows.map((row) => ({
        provider: row.provider,
        requests: num(row.requests),
        input_tokens: num(row.input_tokens),
        output_tokens: num(row.output_tokens),
        success_rate: num(row.success_rate),
      })));
  }

  providerHealth(days = 7) {
    return this.db.query(
      `SELECT provider,
              COUNT(*) AS requests,
              CAST(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS SIGNED) AS errors,
              CAST(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS SIGNED) * 1.0 / COUNT(*) AS error_rate,
              CAST(COALESCE(AVG(latency_ms), 0) AS SIGNED) AS avg_latency_ms,
              MAX(ts) AS last_request_at
       FROM request_logs
      WHERE kind = 'request' AND provider IS NOT NULL AND ts >= ?
       GROUP BY provider ORDER BY requests DESC`,
    ).all<{ provider: string; requests: number | string; errors: number | string; error_rate: number | string; avg_latency_ms: number | string; last_request_at: string }>(daysAgo(days))
      .then((rows) => rows.map((row) => ({
        provider: row.provider,
        requests: num(row.requests),
        errors: num(row.errors),
        error_rate: num(row.error_rate),
        avg_latency_ms: num(row.avg_latency_ms),
        last_request_at: row.last_request_at,
      })));
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
