import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { sessionGuardHandle } from "../session";
import { MusicRepo } from "../store/repos/music";
import { searchMusic, resolveAudioStreamUrl, videoIdFromInput } from "./music";

const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 25;

export function musicRoutes(db: Database) {
  const music = new MusicRepo(db);

  return new Elysia({ prefix: "/api/music" })
    .onBeforeHandle(sessionGuardHandle)

    // ── Playlists ──
    .get("/playlists", () => ({ playlists: music.listPlaylists() }))
    .post("/playlists", ({ body }) => {
      const input = (body ?? {}) as { name?: string };
      if (!input.name?.trim()) throw new Error("name is required");
      return music.createPlaylist(input.name);
    })
    .get("/playlists/:id", ({ params }) => {
      const playlist = music.getPlaylist(params.id);
      if (!playlist) throw new Error("playlist not found");
      return playlist;
    })
    .patch("/playlists/:id", ({ params, body }) => {
      const input = (body ?? {}) as { name?: string };
      if (!input.name?.trim()) throw new Error("name is required");
      const out = music.renamePlaylist(params.id, input.name);
      if (!out) throw new Error("playlist not found");
      return out;
    })
    .delete("/playlists/:id", ({ params }) => music.deletePlaylist(params.id))

    // ── Tracks ──
    .post("/playlists/:id/tracks", ({ params, body }) => {
      const playlist = music.getPlaylist(params.id);
      if (!playlist) throw new Error("playlist not found");
      const input = (body ?? {}) as {
        source?: string;
        url?: string;
        videoId?: string;
        title?: string;
        channel?: string;
        durationSec?: number;
        thumbnailUrl?: string;
      };
      const sourceId = input.videoId ?? videoIdFromInput(input.url ?? "");
      if (!sourceId) throw new Error("videoId or url is required");
      if (!input.title?.trim()) throw new Error("title is required");
      return music.addTrack(params.id, {
        source: input.source ?? "youtube",
        sourceId,
        title: input.title,
        channel: input.channel ?? null,
        durationSec: input.durationSec ?? null,
        thumbnailUrl: input.thumbnailUrl ?? null,
      });
    })
    .delete("/tracks/:trackId", ({ params }) => music.removeTrack(params.trackId))
    .patch("/tracks/:trackId/position", ({ params, body }) => {
      const input = (body ?? {}) as { position?: number };
      if (input.position === undefined) throw new Error("position is required");
      return music.reorderTrack("", params.trackId, input.position);
    })

    // ── Search ──
    .get("/search", async ({ query }) => {
      const q = (query?.q ?? "").toString();
      const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number(query?.limit ?? DEFAULT_SEARCH_LIMIT) || DEFAULT_SEARCH_LIMIT));
      return searchMusic(q, limit);
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