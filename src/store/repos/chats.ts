import type { Database } from "../sql";
import { ulid, nowIso } from "../../utils/id";

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: number;
  session_id: string;
  role: ChatMessageRole;
  content: string;
  position: number;
  in_tokens: number | null;
  out_tokens: number | null;
  cost: number | null;
  created_at: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  model: string;
  system: string | null;
  params: Record<string, unknown> | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  /** SQLite stores 0/1; we surface as boolean. */
  pinned: boolean;
  position: number | null;
}

/** Normalize a raw row so 0/1 becomes boolean and counts become numbers. */
function toSummary(row: Record<string, unknown>): ChatSessionSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    model: String(row.model),
    system: row.system == null ? null : String(row.system),
    params: row.params == null ? null : (typeof row.params === "string" ? JSON.parse(row.params) as Record<string, unknown> : (row.params as Record<string, unknown>)),
    message_count: Number(row.message_count ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    pinned: Number(row.pinned ?? 0) === 1,
    position: row.position == null ? null : Number(row.position),
  };
}

export interface ChatSession extends ChatSessionSummary {
  messages: ChatMessage[];
}

export interface NewSessionInput {
  title: string;
  model: string;
  system?: string | null;
  params?: Record<string, unknown> | null;
}

export interface NewMessageInput {
  role: ChatMessageRole;
  content: string;
  position: number;
  in_tokens?: number | null;
  out_tokens?: number | null;
  cost?: number | null;
}

/**
 * Playground chat sessions — multi-turn conversations persisted in SQLite.
 * The dashboard's /dashboard/chat page is the only consumer; this is a
 * convenience store, not part of the request log pipeline.
 *
 * Counts are done before writes/deletes (rather than relying on `affectedRows`
 * from Bun's SQLite adapter) — see `LogsRepo.clearKind` for the same pattern.
 */
export class ChatSessionsRepo {
  constructor(private db: Database) {}

  /** All sessions, pinned first, then explicit `position`, then by updated_at. */
  async list(): Promise<ChatSessionSummary[]> {
    const rows = await this.db.query(
      `SELECT s.id, s.title, s.model, s.system, s.params, s.created_at, s.updated_at,
              s.pinned, s.position,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
         FROM chat_sessions s
         ORDER BY s.pinned DESC,
                  CASE WHEN s.position IS NULL THEN 1 ELSE 0 END ASC,
                  s.position ASC,
                  s.updated_at DESC`,
    ).all<Record<string, unknown>>();
    return rows.map(toSummary);
  }

  async get(id: string): Promise<ChatSession | null> {
    const row = await this.db.query(
      `SELECT s.id, s.title, s.model, s.system, s.params, s.created_at, s.updated_at,
              s.pinned, s.position,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
         FROM chat_sessions s WHERE s.id = ?`,
    ).get<Record<string, unknown>>(id);
    if (!row) return null;
    const session = toSummary(row);
    const msgs = await this.db.query(
      `SELECT id, session_id, role, content, position, in_tokens, out_tokens, cost, created_at
         FROM chat_messages WHERE session_id = ? ORDER BY position ASC`,
    ).all<ChatMessage>(id);
    return { ...session, messages: msgs };
  }

  async create(input: NewSessionInput): Promise<string> {
    const id = ulid();
    const paramsJson = input.params ? JSON.stringify(input.params) : null;
    await this.db.query(
      `INSERT INTO chat_sessions (id, title, model, system, params, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.title, input.model, input.system ?? null, paramsJson, nowIso(), nowIso());
    return id;
  }

  async rename(id: string, title: string): Promise<void> {
    await this.db.query(
      `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`,
    ).run(title, nowIso(), id);
  }

  async update(id: string, patch: { title?: string; system?: string | null; params?: Record<string, unknown> | null }): Promise<void> {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(patch.title); }
    if (patch.system !== undefined) { sets.push("system = ?"); values.push(patch.system); }
    if (patch.params !== undefined) { sets.push("params = ?"); values.push(patch.params ? JSON.stringify(patch.params) : null); }
    if (!sets.length) {
      // Touch updated_at even when only metadata changed so the sidebar
      // re-sorts. Cover the cost of the write.
      await this.db.query("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(nowIso(), id);
      return;
    }
    sets.push("updated_at = ?");
    values.push(nowIso());
    values.push(id);
    await this.db.query(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  async touch(id: string): Promise<void> {
    await this.db.query("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  async delete(id: string): Promise<number> {
    const before = (await this.db.query("SELECT COUNT(*) AS c FROM chat_sessions WHERE id = ?").get<{ c: number }>(id))?.c ?? 0;
    if (before === 0) return 0;
    // FK cascade drops messages; the explicit delete is here for clarity.
    await this.db.query("DELETE FROM chat_sessions WHERE id = ?").run(id);
    return before;
  }

  /** Pin / unpin a session. Pinned sessions always sort first. */
  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.db.query("UPDATE chat_sessions SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, nowIso(), id);
  }

  /**
   * Reorder sessions. The dashboard sends the IDs in the desired order
   * (top → bottom); we assign `position` 0,1,2,... in one transaction so
   * the sidebar stays consistent even if the user navigates away mid-reorder.
   * Unknown IDs are ignored so the call is idempotent.
   */
  async setOrder(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    await this.db.exec("BEGIN");
    try {
      let index = 0;
      for (const id of ids) {
        await this.db.query("UPDATE chat_sessions SET position = ?, updated_at = ? WHERE id = ?").run(index, nowIso(), id);
        index += 1;
      }
      await this.db.exec("COMMIT");
    } catch (err) {
      try { await this.db.exec("ROLLBACK"); } catch { /* ignore — connection may be gone */ }
      throw err;
    }
    return ids.length;
  }

  /** Drop every session except the most recent `keep`. Caps storage growth. */
  async trimToLatest(keep: number): Promise<number> {
    const total = (await this.db.query("SELECT COUNT(*) AS c FROM chat_sessions").get<{ c: number }>())?.c ?? 0;
    if (total <= keep) return 0;
    const dropCount = total - keep;
    // SQLite supports `LIMIT <n>` without an offset, so we delete in two steps:
    // collect the IDs of the oldest rows by `updated_at`, then drop them.
    const stale = await this.db.query(
      `SELECT id FROM chat_sessions ORDER BY updated_at ASC LIMIT ?`,
    ).all<{ id: string }>(dropCount);
    if (stale.length === 0) return 0;
    const ids = stale.map((r) => r.id);
    await this.db.query(
      `DELETE FROM chat_sessions WHERE id IN (${ids.map(() => "?").join(", ")})`,
    ).run(...ids);
    return stale.length;
  }

  async addMessage(sessionId: string, msg: NewMessageInput): Promise<number> {
    const before = (await this.db.query("SELECT COUNT(*) AS c FROM chat_sessions WHERE id = ?").get<{ c: number }>(sessionId))?.c ?? 0;
    if (before === 0) throw new Error(`chat session not found: ${sessionId}`);
    const res = await this.db.query(
      `INSERT INTO chat_messages (session_id, role, content, position, in_tokens, out_tokens, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      msg.role,
      msg.content,
      msg.position,
      msg.in_tokens ?? null,
      msg.out_tokens ?? null,
      msg.cost ?? null,
    );
    // res.changes is unreliable on SQLite — fetch the row we just inserted.
    const row = await this.db.query(
      "SELECT id FROM chat_messages WHERE session_id = ? AND position = ?",
    ).get<{ id: number }>(sessionId, msg.position);
    if (!row) throw new Error("chat message insert succeeded but row not found");
    await this.touch(sessionId);
    return row.id;
  }

  /** Update an existing message in place (used after streaming finishes to fill token usage). */
  async updateMessage(id: number, patch: { content?: string; in_tokens?: number | null; out_tokens?: number | null; cost?: number | null }): Promise<void> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.content !== undefined) { sets.push("content = ?"); values.push(patch.content); }
    if (patch.in_tokens !== undefined) { sets.push("in_tokens = ?"); values.push(patch.in_tokens); }
    if (patch.out_tokens !== undefined) { sets.push("out_tokens = ?"); values.push(patch.out_tokens); }
    if (patch.cost !== undefined) { sets.push("cost = ?"); values.push(patch.cost); }
    if (!sets.length) return;
    values.push(id);
    await this.db.query(`UPDATE chat_messages SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  /**
   * Drop every message at position > `keepPosition` for a session. Used by
   * "regenerate from here" — the client trash edits a message, asks the
   * server to drop everything after it, then re-streams.
   */
  async deleteAfter(sessionId: string, keepPosition: number): Promise<number> {
    const before = (await this.db.query("SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ? AND position > ?").get<{ c: number }>(sessionId, keepPosition))?.c ?? 0;
    if (before === 0) return 0;
    await this.db.query("DELETE FROM chat_messages WHERE session_id = ? AND position > ?").run(sessionId, keepPosition);
    await this.touch(sessionId);
    return before;
  }

  /**
   * Replace the full message list for a session. Used after a single edit
   * to keep positions contiguous without the client re-issuing dozens of
   * per-message calls. Single transaction so a partial write can't desync
   * the positions.
   */
  async setMessages(sessionId: string, msgs: Array<Omit<NewMessageInput, "position">>): Promise<void> {
    await this.db.exec("BEGIN");
    try {
      await this.db.query("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId);
      let position = 0;
      for (const msg of msgs) {
        await this.db.query(
          `INSERT INTO chat_messages (session_id, role, content, position, in_tokens, out_tokens, cost)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(sessionId, msg.role, msg.content, position, msg.in_tokens ?? null, msg.out_tokens ?? null, msg.cost ?? null);
        position += 1;
      }
      await this.db.query("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
      await this.db.exec("COMMIT");
    } catch (err) {
      try { await this.db.exec("ROLLBACK"); } catch { /* ignore — connection may be gone */ }
      throw err;
    }
  }
}