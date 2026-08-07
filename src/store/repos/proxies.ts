import type { Database } from "bun:sqlite";
import { ulid } from "../../utils/id";

export type ProxyScheme = "http";
export type ProxyStatus = "pending" | "healthy" | "slow" | "failing" | "disabled";

export interface ProxyRecord {
  id: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  country: string | null;
  source: string;
  status: ProxyStatus;
  latency_ms: number | null;
  last_checked: string | null;
  last_error: string | null;
  failure_streak: number;
  success_count: number;
  failure_count: number;
  username: string | null;
  password: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProxyTags {
  username?: string;
  password?: string;
  [key: string]: unknown;
}

export interface ScrapeRunRecord {
  id: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  fetched: number;
  added: number;
  skipped: number;
  error: string | null;
  triggered_by: "manual" | "interval" | "auto-warmup";
}

interface RawProxyRow {
  id: string;
  scheme: string;
  host: string;
  port: number;
  country: string | null;
  source: string;
  status: string;
  latency_ms: number | null;
  last_checked: string | null;
  last_error: string | null;
  failure_streak: number;
  success_count: number;
  failure_count: number;
  username: string | null;
  password: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function normalize(row: RawProxyRow): ProxyRecord {
  // username/password were originally stashed inside `tags`; on legacy rows
  // we promote them back to first-class columns so the dashboard can show
  // them without parsing JSON.
  let username = row.username;
  let password = row.password;
  if ((!username || !password) && row.tags) {
    try {
      const parsed = JSON.parse(row.tags) as Record<string, unknown>;
      username ??= typeof parsed.username === "string" ? parsed.username : null;
      password ??= typeof parsed.password === "string" ? parsed.password : null;
    } catch { /* keep whatever columns already had */ }
  }
  return {
    id: row.id,
    scheme: row.scheme === "http" ? "http" : "http",
    host: row.host,
    port: row.port,
    country: row.country,
    source: row.source,
    status: (row.status ?? "pending") as ProxyStatus,
    latency_ms: row.latency_ms,
    last_checked: row.last_checked,
    last_error: row.last_error,
    failure_streak: row.failure_streak,
    success_count: row.success_count,
    failure_count: row.failure_count,
    username,
    password,
    tags: row.tags,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ProxyUpsert {
  scheme?: ProxyScheme;
  host: string;
  port: number;
  country?: string | null;
  source: string;
  username?: string | null;
  password?: string | null;
  tags?: Record<string, unknown> | null;
}

export class ProxyRepo {
  constructor(private db: Database) {}

  list(): ProxyRecord[] {
    const rows = this.db.query(
      "SELECT * FROM proxy_proxies ORDER BY status = 'healthy' DESC, latency_ms IS NULL, latency_ms ASC, host ASC",
    ).all() as RawProxyRow[];
    return rows.map(normalize);
  }

  /**
   * Page through proxies with a stable ordering. `page` is 1-based;
   * `pageSize` is clamped to a sensible range so callers cannot pull
   * the whole table by accident.
   */
  listPaged(page: number, pageSize: number): { items: ProxyRecord[]; total: number; page: number; page_size: number; total_pages: number } {
    const size = Math.max(1, Math.min(200, Math.floor(pageSize)));
    const pageNum = Math.max(1, Math.floor(page));
    const total = (this.db.query("SELECT COUNT(*) AS c FROM proxy_proxies").get() as { c: number }).c;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const offset = (pageNum - 1) * size;
    const rows = this.db.query(
      "SELECT * FROM proxy_proxies ORDER BY status = 'healthy' DESC, latency_ms IS NULL, latency_ms ASC, host ASC LIMIT ? OFFSET ?",
    ).all(size, offset) as RawProxyRow[];
    return {
      items: rows.map(normalize),
      total,
      page: pageNum,
      page_size: size,
      total_pages: totalPages,
    };
  }

  get(id: string): ProxyRecord | null {
    const row = this.db.query("SELECT * FROM proxy_proxies WHERE id = ?").get(id) as RawProxyRow | null;
    return row ? normalize(row) : null;
  }

  /** Insert or update if the host:port already exists. Returns the canonical record. */
  upsert(row: ProxyUpsert): { record: ProxyRecord; added: boolean } {
    const existing = this.db.query(
      "SELECT * FROM proxy_proxies WHERE scheme = ? AND host = ? AND port = ?",
    ).get(row.scheme ?? "http", row.host, row.port) as RawProxyRow | null;
    const username = row.username ?? null;
    const password = row.password ?? null;
    if (existing) {
      // Refresh credentials/country/source if the new payload carries them.
      this.db.query(
        `UPDATE proxy_proxies
         SET username = COALESCE(?, username),
             password = COALESCE(?, password),
             country   = COALESCE(?, country),
             source    = COALESCE(?, source),
             updated_at = datetime('now')
         WHERE id = ?`,
      ).run(username, password, row.country ?? null, row.source, existing.id);
      return { record: this.get(existing.id)!, added: false };
    }
    const id = ulid();
    const tags = row.tags ? JSON.stringify(row.tags) : null;
    this.db.query(
      "INSERT INTO proxy_proxies (id, scheme, host, port, country, source, status, username, password, tags) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
    ).run(id, row.scheme ?? "http", row.host, row.port, row.country ?? null, row.source, username, password, tags);
    const created = this.get(id);
    return { record: created!, added: true };
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM proxy_proxies WHERE id = ?").run(id);
    return result.changes > 0;
  }

  clear(): number {
    const result = this.db.query("DELETE FROM proxy_proxies").run();
    return result.changes;
  }

  markStatus(
    id: string,
    status: ProxyStatus,
    latencyMs: number | null,
    error: string | null,
  ): void {
    const checked = new Date().toISOString();
    if (status === "healthy") {
      this.db.query(
        `UPDATE proxy_proxies
         SET status = ?, latency_ms = COALESCE(?, latency_ms), last_checked = ?, last_error = NULL,
             failure_streak = 0, success_count = success_count + 1, updated_at = ?
         WHERE id = ?`,
      ).run(status, latencyMs, checked, checked, id);
      return;
    }
    this.db.query(
      `UPDATE proxy_proxies
       SET status = ?, latency_ms = COALESCE(?, latency_ms), last_checked = ?, last_error = ?,
           failure_streak = failure_streak + 1, failure_count = failure_count + 1, updated_at = ?
       WHERE id = ?`,
    ).run(status, latencyMs, checked, error, checked, id);
  }

  /** Select a healthy proxy for the next attempt, round-robin by latency + success count. */
  pickHealthy(): ProxyRecord | null {
    const row = this.db.query(
      `SELECT * FROM proxy_proxies
       WHERE status = 'healthy'
       ORDER BY RANDOM()
       LIMIT 1`,
    ).get() as RawProxyRow | null;
    return row ? normalize(row) : null;
  }

  recordScrape(input: {
    source: string;
    fetched: number;
    added: number;
    skipped: number;
    triggered_by: "manual" | "interval" | "auto-warmup";
    error?: string | null;
    durationMs?: number;
  }): ScrapeRunRecord {
    const id = ulid();
    const finishedAt = new Date().toISOString();
    this.db.query(
      "INSERT INTO proxy_scrape_runs (id, source, started_at, finished_at, fetched, added, skipped, error, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      input.source,
      finishedAt,
      finishedAt,
      input.fetched,
      input.added,
      input.skipped,
      input.error ?? null,
      input.triggered_by,
    );
    return {
      id,
      source: input.source,
      started_at: finishedAt,
      finished_at: finishedAt,
      fetched: input.fetched,
      added: input.added,
      skipped: input.skipped,
      error: input.error ?? null,
      triggered_by: input.triggered_by,
    };
  }

  listScrapeRuns(limit = 25): ScrapeRunRecord[] {
    const rows = this.db.query("SELECT * FROM proxy_scrape_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Array<{
      id: string; source: string; started_at: string; finished_at: string | null; fetched: number; added: number; skipped: number; error: string | null; triggered_by: string;
    }>;
    return rows.map((r) => ({ ...r, triggered_by: r.triggered_by as ScrapeRunRecord["triggered_by"] }));
  }

  /* ── assignments ── */

  getAssignment(providerId: string): { mode: "direct" | "pool" | "scored"; enabled: boolean } {
    const row = this.db.query("SELECT mode, enabled FROM proxy_assignments WHERE provider_id = ?").get(providerId) as { mode: string; enabled: number } | null;
    if (!row) return { mode: "direct", enabled: true };
    return { mode: row.mode as "direct" | "pool" | "scored", enabled: row.enabled === 1 };
  }

  setAssignment(providerId: string, mode: "direct" | "pool" | "scored"): void {
    this.db.query(
      `INSERT INTO proxy_assignments (provider_id, mode, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(provider_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    ).run(providerId, mode);
  }

  listAssignments(): Array<{ provider_id: string; mode: "direct" | "pool" | "scored"; enabled: boolean }> {
    const rows = this.db.query("SELECT provider_id, mode, enabled FROM proxy_assignments").all() as Array<{ provider_id: string; mode: string; enabled: number }>;
    return rows.map((r) => ({ provider_id: r.provider_id, mode: r.mode as "direct" | "pool" | "scored", enabled: r.enabled === 1 }));
  }
}