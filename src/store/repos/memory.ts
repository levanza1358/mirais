import type { Database } from "bun:sqlite";
import type { ChatMessage } from "../../shared/types";
import { nowIso } from "../../utils/id";

export class MemoryRepo {
  constructor(private db: Database) {}

  get(sessionId: string): ChatMessage[] {
    const row = this.db.query("SELECT messages FROM memory_sessions WHERE id = ? AND expires_at > datetime('now')").get(sessionId) as { messages: string } | null;
    if (!row) return [];
    try { return JSON.parse(row.messages) as ChatMessage[]; } catch { return []; }
  }

  set(sessionId: string, messages: ChatMessage[], ttlDays: number, maxMessages: number): void {
    const bounded = messages.slice(-maxMessages);
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
    this.db.query(`INSERT INTO memory_sessions (id, messages, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET messages=excluded.messages, updated_at=?, expires_at=excluded.expires_at`)
      .run(sessionId, JSON.stringify(bounded), expiresAt, nowIso());
  }

  remove(sessionId: string): void {
    this.db.query("DELETE FROM memory_sessions WHERE id = ?").run(sessionId);
  }

  list(): Array<{ id: string; count: number; created_at: string; updated_at: string; expires_at: string }> {
    return this.db.query(`SELECT id, json_array_length(messages) AS count, created_at, updated_at, expires_at
      FROM memory_sessions ORDER BY updated_at DESC`).all() as Array<{ id: string; count: number; created_at: string; updated_at: string; expires_at: string }>;
  }

  stats(): { sessions: number; messages: number } {
    const row = this.db.query(`SELECT COUNT(*) AS sessions,
      COALESCE(SUM(json_array_length(messages)), 0) AS messages FROM memory_sessions`).get() as { sessions: number; messages: number };
    return row;
  }

  clearAll(): number {
    return this.db.query("DELETE FROM memory_sessions").run().changes;
  }

  purgeExpired(): number {
    return this.db.query("DELETE FROM memory_sessions WHERE expires_at <= datetime('now')").run().changes;
  }
}
