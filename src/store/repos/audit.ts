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
}
