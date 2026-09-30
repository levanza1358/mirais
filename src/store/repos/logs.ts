import type { Database } from "../sql";
import { num, coerceAggregates } from "../sql";
import { ulid, nowIso } from "../../utils/id";
import type { RequestLog, AttemptRecord } from "../../shared/types";
import { log } from "../../utils/logger";

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

/** Log kinds sharing the `request_logs` table; `kind` selects which view shows a row. */
export const LOG_KINDS = ["request", "warmup", "claim", "test"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

/**
 * Hard cap on the size of free-form text columns we store in `request_logs`.
 * A 32 KB body is plenty for previewing a request — the full payload lives
 * in the provider's logs and the upstream replay buffer. Truncating keeps the
 * row footprint bounded so a chat response with hundreds of KB of streamed
 * tokens cannot blow the SQLite file past a GB.
 */
const MAX_BODY_BYTES = 32 * 1024;

/** Truncate a string to at most `bytes` UTF-8 bytes, returning the original if smaller. */
function truncateBody(value: string | null | undefined, maxBytes = MAX_BODY_BYTES): string | null {
  if (!value) return null;
  // Fast path: ASCII or short UTF-8 → byte length ≈ string length.
  if (value.length <= maxBytes) return value;
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  // Slice by bytes then lop off any half-encoded UTF-8 char at the tail.
  let end = maxBytes;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0xc0) end--;
  return buf.subarray(0, end).toString("utf8");
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function utcDayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export class LogsRepo {
  constructor(private db: Database, private readonly dailyUsage?: import("./usage").DailyUsageRepo) {}

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
        // Cap free-form text columns so a 500 KB streaming reply can't push a
        // single row past 1 MB. Operators who need the full body should set
        // `TRACK_PAYLOADS=full` and route the upstream provider's own request
        // log; we only keep a preview here.
        truncateBody(entry.requestBody),
        truncateBody(entry.responseBody),
        truncateBody(entry.attemptsDetail ? JSON.stringify(entry.attemptsDetail) : null),
        entry.accountLabel ?? null,
        entry.kind ?? "request",
      );

    // Mirror real-traffic counters into `daily_usage` so stats survive the
    // 1-day row purge. Best-effort — a rollup failure must never fail the
    // user-facing request that already produced a log row.
    if (this.dailyUsage && (entry.kind ?? "request") === "request") {
      try {
        await this.dailyUsage.record(
          entry.provider,
          entry.model,
          entry.accountLabel ?? null,
          nowIso(),
          {
            inputTokens: entry.inputTokens ?? 0,
            outputTokens: entry.outputTokens ?? 0,
            cachedTokens: entry.cachedTokens ?? 0,
            cacheWriteTokens: entry.cacheWriteTokens ?? 0,
            reasoningTokens: entry.reasoningTokens ?? 0,
            tokensSaved: entry.tokensSaved,
            latencyMs: entry.latencyMs ?? 0,
            errored: entry.status !== "success",
          },
        );
      } catch (err) {
        log.warn("daily_usage rollup failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
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

  async keyUsage(keyId: string): Promise<{ requests_today: number; tokens_today: number; tokens_total: number; requests_minute: number; requests_total: number; input_tokens_total: number; output_tokens_total: number; top_models: Array<{ model: string; requests: number; tokens: number }> }> {
    const total = await this.db.query("SELECT COALESCE(SUM(input_tokens) + SUM(output_tokens), 0) AS tokens FROM request_logs WHERE key_id = ?").get<{ tokens: number }>(keyId);
    const today = await this.db.query("SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens) + SUM(output_tokens), 0) AS tokens FROM request_logs WHERE key_id = ? AND ts >= ?").get<{ requests: number; tokens: number }>(keyId, utcDayStart());
    const minute = await this.db.query("SELECT COUNT(*) AS requests FROM request_logs WHERE key_id = ? AND ts >= ?").get<{ requests: number }>(keyId, daysAgo(1 / 1440));
    const totals = await this.db.query("SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens FROM request_logs WHERE key_id = ?").get<{ requests: number; input_tokens: number; output_tokens: number }>(keyId);
    const topModels = await this.db.query("SELECT COALESCE(model, requested_model) AS model, COUNT(*) AS requests, COALESCE(SUM(input_tokens) + SUM(output_tokens), 0) AS tokens FROM request_logs WHERE key_id = ? GROUP BY COALESCE(model, requested_model) ORDER BY tokens DESC LIMIT 5").all<{ model: string; requests: number; tokens: number }>(keyId);
    return {
      requests_today: num(today?.requests),
      tokens_today: num(today?.tokens),
      tokens_total: num(total?.tokens),
      requests_minute: num(minute?.requests),
      requests_total: num(totals?.requests),
      input_tokens_total: num(totals?.input_tokens),
      output_tokens_total: num(totals?.output_tokens),
      top_models: topModels.map((row) => coerceAggregates(row, ["requests", "tokens"])),
    };
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
    // Count first because Bun's SQLite adapter does not return affectedRows
    // for DELETE (see `clearKind()` for the same workaround).
    const before = (await this.db
      .query("SELECT COUNT(*) AS c FROM request_logs WHERE ts < ?")
      .get<{ c: number }>(daysAgo(days)))?.c ?? 0;
    if (before === 0) return 0;
    await this.db.query("DELETE FROM request_logs WHERE ts < ?").run(daysAgo(days));
    return before;
  }

  /**
   * Null out captured request/response bodies past their retention window.
   * Kept as a no-op safety net: with the 1-day row purge now in effect the
   * sweep almost never finds a stale body to clear, but if it does we still
   * drop the body and keep the counters intact.
   */
  async purgePayloadBodiesOlderThan(days: number): Promise<number> {
    const before = (await this.db
      .query(
        `SELECT COUNT(*) AS c FROM request_logs
         WHERE ts < ? AND (request_body IS NOT NULL OR response_body IS NOT NULL)`,
      )
      .get<{ c: number }>(daysAgo(days)))?.c ?? 0;
    if (before === 0) return 0;
    await this.db
      .query(
        `UPDATE request_logs
            SET request_body = NULL, response_body = NULL
          WHERE ts < ? AND (request_body IS NOT NULL OR response_body IS NOT NULL)`,
      )
      .run(daysAgo(days));
    return before;
  }

  /** Delete every log row, or only the rows of one `kind`. */
  async clearKind(kind?: LogKind): Promise<number> {
    // Bun's `SQL` adapter returns `[]` (no `affectedRows`) for SQLite writes,
    // so the generic `Database.run()` path reports zero changes even when the
    // DELETE succeeded. Count first to give callers an accurate number.
    const before = (await this.db
      .query(kind ? "SELECT COUNT(*) AS c FROM request_logs WHERE kind = ?" : "SELECT COUNT(*) AS c FROM request_logs")
      .get<{ c: number }>(...(kind ? [kind] : [])))?.c ?? 0;
    if (before === 0) return 0;
    if (kind) {
      await this.db.query("DELETE FROM request_logs WHERE kind = ?").run(kind);
    } else {
      await this.db.query("DELETE FROM request_logs").run();
    }
    return before;
  }

  async clearAll(): Promise<number> {
    return this.clearKind();
  }

  /**
   * Drop the orphan payload tables that the abandoned `fix/logs-hardening`
   * branch created. They are not referenced by any code on `main` and consume
   * ~1.3 GB of disk. Safe to run repeatedly: `DROP TABLE IF EXISTS` is a
   * no-op when the table is already gone. Returns the number of tables
   * actually dropped.
   */
  async dropOrphanPayloadTables(): Promise<number> {
    let dropped = 0;
    for (const name of ["request_log_payloads", "request_log_payload_cleanup"]) {
      try {
        // MySQL exposes the catalog through information_schema; SQLite has no
        // catalog so it consults sqlite_master. The check follows the dialect
        // of the active connection.
        const existsQuery = this.db.dialect === "mysql"
          ? `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`
          : `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?`;
        const exists = (await this.db.query(existsQuery).get<{ c: number }>(name))?.c ?? 0;
        if (exists === 0) continue;
        await this.db.query(`DROP TABLE IF EXISTS \`${name}\``).run();
        dropped += 1;
      } catch (err) {
        log.warn("orphan payload table drop failed", { name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return dropped;
  }

  // ── stats queries live in `DailyUsageRepo` ──
}
