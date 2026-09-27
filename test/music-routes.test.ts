import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { musicRoutes } from "../src/admin/music";
import { freshDb } from "./helpers";
import { AdminError } from "../src/shared/errors";
import type { Database } from "../src/store/sql";

function app(db: Database) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AdminError) { set.status = error.status; return { error: error.message }; }
      throw error;
    })
    .use(musicRoutes(db));
}

describe("musicRoutes", () => {
  test("GET /api/music/tracks returns empty list", async () => {
    const a = app(await freshDb());
    const res = await a.handle(new Request("http://test/api/music/tracks"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(0);
  });

  test("POST creates a URL-source track and PATCH / DELETE work", async () => {
    const a = app(await freshDb());
    const create = await a.handle(new Request("http://test/api/music/tracks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Streamed",
        source_type: "url",
        source_url: "https://example.test/song.mp3",
        duration_sec: 200,
      }),
    }));
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; source_url: string };
    expect(created.source_url).toContain("example.test");

    const patch = await a.handle(new Request(`http://test/api/music/tracks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Streamed (remix)" }),
    }));
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { title: string }).title).toBe("Streamed (remix)");

    const del = await a.handle(new Request(`http://test/api/music/tracks/${created.id}`, { method: "DELETE" }));
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("GET /api/music/tracks/:id/audio for URL source returns 302 with location", async () => {
    const a = app(await freshDb());
    const create = await a.handle(new Request("http://test/api/music/tracks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "URL", source_type: "url", source_url: "https://example.test/track.ogg" }),
    }));
    const track = (await create.json()) as { id: string };
    const res = await a.handle(new Request(`http://test/api/music/tracks/${track.id}/audio`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.test/track.ogg");
  });

  test("POST playlist enforces unique name", async () => {
    const a = app(await freshDb());
    const create = await a.handle(new Request("http://test/api/music/playlists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "favs" }),
    }));
    expect(create.status).toBe(201);
    const dup = await a.handle(new Request("http://test/api/music/playlists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "favs" }),
    }));
    expect(dup.status).toBe(409);
  });

  test("play history record increments the table", async () => {
    const a = app(await freshDb());
    const create = await a.handle(new Request("http://test/api/music/tracks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", source_type: "url", source_url: "https://example.test/t" }),
    }));
    const track = (await create.json()) as { id: string };
    const play = await a.handle(new Request(`http://test/api/music/tracks/${track.id}/play?position_ms=15000&completed=true`));
    expect(play.status).toBe(200);
    const entry = (await play.json()) as { track_id: string; position_ms: number; completed: boolean };
    expect(entry.track_id).toBe(track.id);
    expect(entry.position_ms).toBe(15000);
    expect(entry.completed).toBe(true);
  });
});