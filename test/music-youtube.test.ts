import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { youtubeRoutes } from "../src/admin/music";
import { freshDb } from "./helpers";
import { AdminError } from "../src/shared/errors";
import { config } from "../src/config";
import type { Database } from "../src/store/sql";

function app(db: Database) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AdminError) { set.status = error.status; return { error: error.message }; }
      throw error;
    })
    .use(youtubeRoutes(db));
}

describe("youtubeRoutes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    (config as unknown as { invidiousInstances: string[] }).invidiousInstances = ["https://inv.test"];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GET /search returns compact results", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        items: [
          {
            type: "video",
            title: "Sample",
            videoId: "dQw4w9WgXcQ",
            author: "Channel",
            lengthSeconds: 200,
            videoThumbnails: [{ quality: "maxresdefault", url: "https://x/t.jpg" }],
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as unknown as typeof fetch;

    const a = app(await freshDb());
    const res = await a.handle(new Request("http://test/api/music/youtube/search?q=hello"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; title: string; author: string; duration_sec: number; thumbnail_url: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]).toEqual({
      id: "dQw4w9WgXcQ",
      title: "Sample",
      author: "Channel",
      duration_sec: 200,
      thumbnail_url: "https://x/t.jpg",
    });
  });

  test("GET /search rejects empty query", async () => {
    const a = app(await freshDb());
    const res = await a.handle(new Request("http://test/api/music/youtube/search?q="));
    expect(res.status).toBe(400);
  });

  test("POST /import with bare video id creates a track", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/api/v1/videos/dQw4w9WgXcQ")) {
        return new Response(JSON.stringify({
          videoId: "dQw4w9WgXcQ",
          title: "Hello",
          author: "Channel",
          lengthSeconds: 200,
          videoThumbnails: [{ quality: "maxresdefault", url: "https://x/t.jpg" }],
          adaptiveFormats: [{ type: "audio/mp4", url: "https://x/a.mp4", bitrate: 128_000 }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const db = await freshDb();
    const a = app(db);
    const res = await a.handle(new Request("http://test/api/music/youtube/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video_id: "dQw4w9WgXcQ" }),
    }));
    expect(res.status).toBe(201);
    const track = (await res.json()) as { id: string; title: string; source_type: string; source_url: string };
    expect(track.title).toBe("Hello");
    expect(track.source_type).toBe("url");
    expect(track.source_url).toBe("https://x/a.mp4");
  });

  test("POST /import with full YouTube URL extracts id", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/api/v1/videos/dQw4w9WgXcQ")) {
        return new Response(JSON.stringify({
          videoId: "dQw4w9WgXcQ",
          title: "Hello",
          author: "Channel",
          lengthSeconds: 200,
          adaptiveFormats: [{ type: "audio/mp4", url: "https://x/a.mp4", bitrate: 128_000 }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const a = app(await freshDb());
    const res = await a.handle(new Request("http://test/api/music/youtube/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    }));
    expect(res.status).toBe(201);
  });

  test("POST /import with neither video_id nor url returns 400", async () => {
    const a = app(await freshDb());
    const res = await a.handle(new Request("http://test/api/music/youtube/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  test("GET /suggestions falls back to empty array when instance lacks the endpoint", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const a = app(await freshDb());
    const res = await a.handle(new Request("http://test/api/music/youtube/suggestions?q=hel"));
    // 404 on /suggestions is treated as "instance doesn't support it" — we
    // serve an empty list rather than failing the UX. Status stays 200.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: string[] };
    expect(body.suggestions).toEqual([]);
  });
});