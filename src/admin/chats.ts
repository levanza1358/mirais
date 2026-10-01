/**
 * Playground chat session routes. The dashboard's /dashboard/chat page is
 * the only consumer. Sessions live in `chat_sessions` + `chat_messages`
 * (created by migration 0040) and survive restart, browser switch, and
 * accidental localStorage wipes.
 *
 * Reads are unbounded by `sessionGuard()`; writes go through `AdminError`
 * 4xx for malformed input. No quota beyond the dashboard-side cap
 * (100 sessions × 50 messages = ~2.5 MB worst case).
 */
import { Elysia } from "elysia";
import type { Database } from "../store/sql";
import { ChatSessionsRepo } from "../store/repos/chats";
import { AdminError } from "../shared/errors";
import {
  chatSessionCreateSchema,
  chatSessionUpdateSchema,
  chatMessagesReplaceSchema,
  chatSessionReorderSchema,
} from "../shared/schemas";

export function chatRoutes(db: Database) {
  const repo = new ChatSessionsRepo(db);

  return new Elysia({ prefix: "/api/chats" })
    .get("/", async () => ({ items: await repo.list() }))
    .get("/:id", async ({ params }) => {
      const session = await repo.get(params.id);
      if (!session) throw new AdminError(404, "Chat session not found");
      return session;
    })
    .post("/", async ({ body }) => {
      const parsed = chatSessionCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const id = await repo.create(parsed.data);
      // Trim aggressively so a loop that creates sessions never blows past
      // the 100-session soft cap.
      await repo.trimToLatest(100);
      const created = await repo.get(id);
      if (!created) throw new AdminError(500, "Session created but not retrievable");
      return created;
    })
    .patch("/:id", async ({ params, body }) => {
      const parsed = chatSessionUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      await repo.update(params.id, parsed.data);
      const updated = await repo.get(params.id);
      if (!updated) throw new AdminError(404, "Chat session not found");
      return updated;
    })
    .delete("/:id", async ({ params }) => ({ ok: true, deleted: await repo.delete(params.id) }))
    .put("/:id/messages", async ({ params, body }) => {
      const parsed = chatMessagesReplaceSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const exists = await repo.get(params.id);
      if (!exists) throw new AdminError(404, "Chat session not found");
      await repo.setMessages(params.id, parsed.data.messages);
      const updated = await repo.get(params.id);
      if (!updated) throw new AdminError(404, "Chat session not found");
      return updated;
    })
    // Manual reorder. The dashboard sidebar lets the operator move a session
    // up or down; we record that as an explicit `position` so the ordering
    // survives a restart (default sort is by `updated_at`).
    .put("/order", async ({ body }) => {
      const parsed = chatSessionReorderSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const moved = await repo.setOrder(parsed.data.ids);
      return { ok: true, moved };
    })
    // Pin toggle: a pinned session stays at the top of the sidebar regardless
    // of its `updated_at`. Most-recent pinned wins.
    .post("/:id/pin", async ({ params }) => {
      const exists = await repo.get(params.id);
      if (!exists) throw new AdminError(404, "Chat session not found");
      await repo.setPinned(params.id, true);
      return { ok: true, pinned: true };
    })
    .delete("/:id/pin", async ({ params }) => {
      await repo.setPinned(params.id, false);
      return { ok: true, pinned: false };
    });
}