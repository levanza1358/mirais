import type { Database } from "../sql";
import { ulid, nowIso } from "../../utils/id";

export interface AuditEntry {
  id: string;
  ts: string;
  action: string;
  resource: string;
  resource_id: string | null;
  detail: string | null;
}

export class AuditRepo {
  constructor(private db: Database) {}

  async record(action: string, resource: string, resourceId?: string | null, detail?: Record<string, unknown> | null): Promise<void> {
    await this.db.query("INSERT INTO admin_audit_log (id, ts, action, resource, resource_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ulid(), nowIso(), action, resource, resourceId ?? null, detail ? JSON.stringify(detail) : null);
  }

  async list(page = 1, limit = 50): Promise<{ items: AuditEntry[]; total: number }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(200, Math.max(1, limit));
    const count = await this.db.query("SELECT COUNT(*) AS c FROM admin_audit_log").get<{ c: number }>();
    const total = count?.c ?? 0;
    const items = await this.db.query("SELECT * FROM admin_audit_log ORDER BY ts DESC LIMIT ? OFFSET ?")
      .all<AuditEntry>(safeLimit, (safePage - 1) * safeLimit);
    return { items, total };
  }

  /**
   * Delete every audit-log row. Used by the "Clear all logs" feature when the
   * operator asks to wipe logs without exception. The next call to `record()`
   * starts a fresh trail.
   */
  async clearAll(): Promise<number> {
    // See `LogsRepo.clearKind()` for why the generic affected-rows value is
    // unreliable: Bun's SQLite adapter does not return one.
    const before = (await this.db.query("SELECT COUNT(*) AS c FROM admin_audit_log").get<{ c: number }>())?.c ?? 0;
    if (before === 0) return 0;
    await this.db.query("DELETE FROM admin_audit_log").run();
    return before;
  }
}
