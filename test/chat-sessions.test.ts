import { describe, test, expect, beforeEach } from "bun:test";
import { freshDb } from "./helpers";
import { ChatSessionsRepo } from "../src/store/repos/chats";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { db = await freshDb(); });

describe("ChatSessionsRepo.create + list", () => {
  test("creates a session and lists it", async () => {
    const repo = new ChatSessionsRepo(db);
    const id = await repo.create({ title: "First chat", model: "openai/gpt-5", system: null });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, title: "First chat", model: "openai/gpt-5", message_count: 0 });
  });

  test("orders by updated_at descending", async () => {
    const repo = new ChatSessionsRepo(db);
    const a = await repo.create({ title: "Older", model: "openai/gpt-5" });
    await new Promise((r) => setTimeout(r, 10));
    const b = await repo.create({ title: "Newer", model: "openai/gpt-5" });
    const list = await repo.list();
    expect(list[0]?.id).toBe(b);
    expect(list[1]?.id).toBe(a);
  });
});

describe("ChatSessionsRepo.get", () => {
  test("returns null when session does not exist", async () => {
    const repo = new ChatSessionsRepo(db);
    expect(await repo.get("does-not-exist")).toBeNull();
  });

  test("returns full session with empty messages", async () => {
    const repo = new ChatSessionsRepo(db);
    const id = await repo.create({ title: "Empty", model: "openai/gpt-5" });
    const session = await repo.get(id);
    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(0);
  });
});

describe("ChatSessionsRepo.addMessage + updateMessage", () => {
  test("adds a message and updates it in place", async () => {
    const repo = new ChatSessionsRepo(db);
    const id = await repo.create({ title: "T", model: "openai/gpt-5" });
    const msgId = await repo.addMessage(id, { role: "user", content: "hi", position: 0 });
    const session = await repo.get(id);
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0]?.content).toBe("hi");
    expect(session?.messages[0]?.id).toBe(msgId);

    await repo.updateMessage(msgId, { content: "hi edited", in_tokens: 12, out_tokens: 8 });
    const updated = await repo.get(id);
    expect(updated?.messages[0]?.content).toBe("hi edited");
    expect(updated?.messages[0]?.in_tokens).toBe(12);
    expect(updated?.messages[0]?.out_tokens).toBe(8);
  });
});

describe("ChatSessionsRepo.deleteAfter", () => {
  test("drops messages after the keep position", async () => {
    const repo = new ChatSessionsRepo(db);
    const id = await repo.create({ title: "T", model: "openai/gpt-5" });
    await repo.addMessage(id, { role: "user", content: "u1", position: 0 });
    await repo.addMessage(id, { role: "assistant", content: "a1", position: 1 });
    await repo.addMessage(id, { role: "user", content: "u2", position: 2 });
    await repo.addMessage(id, { role: "assistant", content: "a2", position: 3 });

    const removed = await repo.deleteAfter(id, 1);
    expect(removed).toBe(2);
    const session = await repo.get(id);
    expect(session?.messages.map((m) => m.position)).toEqual([0, 1]);
  });

  test("returns 0 when no messages after the keep position", async () => {
    const repo = new ChatSessionsRepo(db);
    const id = await repo.create({ title: "T", model: "openai/gpt-5" });
    expect(await repo.deleteAfter(id, 0)).toBe(0);
  });
});

describe("ChatSessionsRepo.delete (cascade)", () => {
  test("deleting a session removes its messages", async () => {
    const repo = new ChatSessionsRepo(db);
    const id = await repo.create({ title: "T", model: "openai/gpt-5" });
    await repo.addMessage(id, { role: "user", content: "u1", position: 0 });
    await repo.addMessage(id, { role: "assistant", content: "a1", position: 1 });

    const removed = await repo.delete(id);
    expect(removed).toBe(1);
    const orphans = await db.query("SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?").get<{ c: number }>(id);
    expect(orphans?.c ?? 0).toBe(0);
    expect(await repo.get(id)).toBeNull();
  });
});

describe("ChatSessionsRepo.trimToLatest", () => {
  test("keeps only the N most recent sessions", async () => {
    const repo = new ChatSessionsRepo(db);
    for (let i = 0; i < 5; i++) {
      await repo.create({ title: `s${i}`, model: "openai/gpt-5" });
      await new Promise((r) => setTimeout(r, 5));
    }
    const removed = await repo.trimToLatest(2);
    expect(removed).toBe(3);
    const remaining = await repo.list();
    expect(remaining).toHaveLength(2);
  });

  test("returns 0 when already under the limit", async () => {
    const repo = new ChatSessionsRepo(db);
    await repo.create({ title: "x", model: "openai/gpt-5" });
    expect(await repo.trimToLatest(10)).toBe(0);
  });
});

describe("ChatSessionsRepo.setMessages", () => {
  test("replaces the entire message list and preserves order", async () => {
    const repo = new ChatSessionsRepo(db);
    const id = await repo.create({ title: "T", model: "openai/gpt-5" });
    await repo.addMessage(id, { role: "user", content: "old", position: 0 });

    await repo.setMessages(id, [
      { role: "user", content: "new1", in_tokens: null, out_tokens: null, cost: null },
      { role: "assistant", content: "new2", in_tokens: null, out_tokens: null, cost: null },
    ]);
    const session = await repo.get(id);
    expect(session?.messages.map((m) => m.content)).toEqual(["new1", "new2"]);
  });
});

describe("ChatSessionsRepo.setPinned + list order", () => {
  test("pinned sessions sort first", async () => {
    const repo = new ChatSessionsRepo(db);
    const a = await repo.create({ title: "a", model: "openai/gpt-5" });
    const b = await repo.create({ title: "b", model: "openai/gpt-5" });
    await new Promise((r) => setTimeout(r, 10));
    const c = await repo.create({ title: "c", model: "openai/gpt-5" });
    await repo.setPinned(c, true);
    const list = await repo.list();
    expect(list[0]?.id).toBe(c);
    expect(list.find((x) => x.id === a)?.pinned).toBe(false);
    expect(list.find((x) => x.id === b)?.pinned).toBe(false);
  });

  test("toggle off moves the session back", async () => {
    const repo = new ChatSessionsRepo(db);
    const id = await repo.create({ title: "x", model: "openai/gpt-5" });
    await repo.setPinned(id, true);
    expect((await repo.get(id))?.pinned).toBe(true);
    await repo.setPinned(id, false);
    expect((await repo.get(id))?.pinned).toBe(false);
  });
});

describe("ChatSessionsRepo.setOrder", () => {
  test("assigns position 0..n-1 in the supplied order", async () => {
    const repo = new ChatSessionsRepo(db);
    const a = await repo.create({ title: "a", model: "openai/gpt-5" });
    const b = await repo.create({ title: "b", model: "openai/gpt-5" });
    const c = await repo.create({ title: "c", model: "openai/gpt-5" });

    await repo.setOrder([c, a, b]);
    const list = await repo.list();
    expect(list[0]?.id).toBe(c);
    expect(list[1]?.id).toBe(a);
    expect(list[2]?.id).toBe(b);
    expect((await repo.get(a))?.position).toBe(1);
  });

  test("returns 0 when ids is empty", async () => {
    const repo = new ChatSessionsRepo(db);
    expect(await repo.setOrder([])).toBe(0);
  });
});