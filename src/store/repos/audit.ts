import type { Database } from "bun:sqlite";
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

  record(action: string, resource: string, resourceId?: string | null, detail?: Record<string, unknown> | null): void {
    this.db.query("INSERT INTO admin_audit_log (id, ts, action, resource, resource_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ulid(), nowIso(), action, resource, resourceId ?? null, detail ? JSON.stringify(detail) : null);
  }

  list(page = 1, limit = 50): { items: AuditEntry[]; total: number } {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(200, Math.max(1, limit));
    const total = (this.db.query("SELECT COUNT(*) AS c FROM admin_audit_log").get() as { c: number }).c;
    const items = this.db.query("SELECT * FROM admin_audit_log ORDER BY ts DESC LIMIT ? OFFSET ?")
      .all(safeLimit, (safePage - 1) * safeLimit) as AuditEntry[];
    return { items, total };
  }
}
