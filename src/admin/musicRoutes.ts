import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { sessionGuardHandle } from "../session";
import { MusicRepo } from "../store/repos/music";
import { searchMusic, resolveAudioStreamUrl, videoIdFromInput, fetchTrending } from "./music";

const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 25;

// Body schemas. Elysia enforces strict validation by default; without these
// schemas, JSON bodies throw a "Bad Request" before our handlers run.
const nameBody = { body: t.Object({ name: t.String({ minLength: 1 }) }) };
const trackBody = {
  body: t.Object({
    source: t.Optional(t.String()),
    url: t.Optional(t.String()),
    videoId: t.Optional(t.String()),
    title: t.String({ minLength: 1 }),
    channel: t.Optional(t.String()),
    durationSec: t.Optional(t.Number()),
    thumbnailUrl: t.Optional(t.String()),
  }),
};
const positionBody = { body: t.Object({ position: t.Number({ minimum: 0 }) }) };

export function musicRoutes(db: Database) {
  const music = new MusicRepo(db);

  return new Elysia({ prefix: "/api/music" })
    .onBeforeHandle(sessionGuardHandle)

    // ── Playlists ──
    .get("/playlists", () => ({ playlists: music.listPlaylists() }))
    .post("/playlists", ({ body }) => music.createPlaylist(body.name), {
      body: t.Object({ name: t.String({ minLength: 1 }) }),
    })
    .get("/playlists/:id", ({ params }) => {
      const playlist = music.getPlaylist(params.id);
      if (!playlist) throw new Error("playlist not found");
      return playlist;
    })
    .patch("/playlists/:id", ({ params, body }) => music.renamePlaylist(params.id, body.name), nameBody)
    .delete("/playlists/:id", ({ params }) => music.deletePlaylist(params.id))

    // ── Tracks ──
    .post("/playlists/:id/tracks", ({ params, body }) => {
      const sourceId = body.videoId ?? videoIdFromInput(body.url ?? "");
      if (!sourceId) throw new Error("videoId or url is required");
      return music.addTrack(params.id, {
        source: body.source,
        sourceId,
        title: body.title,
        channel: body.channel ?? null,
        durationSec: body.durationSec ?? null,
        thumbnailUrl: body.thumbnailUrl ?? null,
      });
    }, trackBody)
    .delete("/tracks/:trackId", ({ params }) => music.removeTrack(params.trackId))
    .patch("/tracks/:trackId/position", ({ params, body }) =>
      music.reorderTrack("", params.trackId, body.position),
    positionBody)

    // ── Search ──
    .get("/search", ({ query }) => {
      const q = (query?.q ?? "").toString();
      const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number(query?.limit ?? DEFAULT_SEARCH_LIMIT) || DEFAULT_SEARCH_LIMIT));
      return searchMusic(q, limit);
    })

    // ── Trending ──
    .get("/trending", ({ query }) => {
      const limit = Math.min(50, Math.max(1, Number(query?.limit ?? 20) || 20));
      return fetchTrending(limit);
    })

    // ── Stream proxy ──
    // Resolves the audio bytes URL via yt-dlp / Invidious and returns a 302
    // redirect to the upstream CDN. The browser then opens that URL with
    // Range headers (or our /api/music/stream-direct?id=... if you want a
    // full passthrough proxy — see /stream-direct).
    .get("/stream", async ({ query, set }) => {
      const id = videoIdFromInput((query?.id ?? "").toString());
      if (!id) { set.status = 400; return { error: "id or url is required" }; }
      const resolved = await resolveAudioStreamUrl(id);
      if (!resolved) { set.status = 502; return { error: "could not resolve audio source" }; }
      set.status = 302;
      set.headers["location"] = resolved.url;
      if (resolved.contentType) set.headers["x-content-type"] = resolved.contentType;
      set.headers["x-mirais-source"] = resolved.via;
      return "";
    });
}