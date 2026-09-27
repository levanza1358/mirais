import { Elysia } from "elysia";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "../store/sql";
import { config } from "../config";
import { AdminError } from "../shared/errors";
import { musicTrackCreateSchema, musicTrackUpdateSchema, musicPlaylistCreateSchema, musicPlaylistUpdateSchema, youtubeSearchQuerySchema, youtubeImportSchema } from "../shared/schemas";
import { MusicPlaylistsRepo, MusicTracksRepo, PlayHistoryRepo } from "../store/repos/music";
import { AuditRepo } from "../store/repos/audit";
import { log } from "../utils/logger";
import { extractVideoId, importFromVideoId, isValidVideoId, searchVideos, suggestVideos } from "../utils/invidious";

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  webm: "audio/webm",
};

const MAX_TITLE_BYTES = 256;
const MAX_DESCRIPTION_BYTES = 2048;

function extForMime(mimeType: string | null | undefined): string {
  if (!mimeType) return "bin";
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  for (const [ext, mime] of Object.entries(AUDIO_MIME)) {
    if (mime === normalized) return ext === "oga" ? "ogg" : ext === "m4b" ? "m4a" : ext;
  }
  // Fallbacks for less common labels.
  if (normalized.endsWith("/mpeg")) return "mp3";
  if (normalized.endsWith("/mp4")) return "m4a";
  if (normalized.endsWith("/ogg")) return "ogg";
  if (normalized.endsWith("/wav") || normalized.endsWith("/x-wav")) return "wav";
  if (normalized.endsWith("/flac") || normalized.endsWith("/x-flac")) return "flac";
  if (normalized.endsWith("/webm")) return "webm";
  return "bin";
}

function audioPathFor(trackId: string, mimeType: string | null | undefined): string {
  const ext = extForMime(mimeType);
  return path.join(config.musicDir, `${trackId}.${ext}`);
}

/**
 * Resolve and validate a track's on-disk path. Returns the absolute path only
 * when the file exists; callers map the null result to a 404. The check
 * protects against path traversal by anchoring the resolved path to
 * `config.musicDir`.
 */
function resolveAudioPath(trackId: string, mimeType: string | null | undefined): string | null {
  if (!trackId || trackId.includes("/") || trackId.includes("..")) return null;
  const candidate = audioPathFor(trackId, mimeType);
  const base = config.musicDir;
  if (!candidate.startsWith(base + path.sep) && candidate !== base) return null;
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    /* not present */
  }
  return null;
}

export function musicRoutes(db: Database) {
  const tracks = new MusicTracksRepo(db);
  const playlists = new MusicPlaylistsRepo(db);
  const history = new PlayHistoryRepo(db);
  const audit = new AuditRepo(db);

  const ensureSafeTitle = (value: unknown): string => {
    if (typeof value !== "string") throw new AdminError(400, "title must be a string");
    if (Buffer.byteLength(value, "utf8") > MAX_TITLE_BYTES) throw new AdminError(400, "title too long");
    return value;
  };

  const ensureSafeDescription = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") throw new AdminError(400, "description must be a string");
    if (Buffer.byteLength(value, "utf8") > MAX_DESCRIPTION_BYTES) throw new AdminError(400, "description too long");
    return value;
  };

  return new Elysia({ prefix: "/api/music" })
    // ── Tracks ──
    .get("/tracks", ({ query }) => {
      const limit = Number(query.limit);
      const offset = Number(query.offset);
      const result = tracks.list({
        q: typeof query.q === "string" ? query.q : undefined,
        artist: typeof query.artist === "string" ? query.artist : undefined,
        album: typeof query.album === "string" ? query.album : undefined,
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(Number.isFinite(offset) ? { offset } : {}),
      });
      return result;
    })
    .get("/tracks/:id", async ({ params }) => {
      const track = await tracks.get(params.id);
      if (!track) throw new AdminError(404, "Track not found");
      return track;
    })
    .post("/tracks", async ({ body, set }) => {
      const parsed = musicTrackCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const created = await tracks.create({
        title: ensureSafeTitle(parsed.data.title),
        artist: parsed.data.artist ?? null,
        album: parsed.data.album ?? null,
        duration_sec: parsed.data.duration_sec ?? null,
        mime_type: parsed.data.mime_type ?? null,
        size_bytes: parsed.data.size_bytes ?? null,
        source_type: parsed.data.source_type,
        storage_path: parsed.data.storage_path ?? null,
        source_url: parsed.data.source_url ?? null,
        thumbnail_url: parsed.data.thumbnail_url ?? null,
      });
      await audit.record("created", "music_track", created.id, { title: created.title, source_type: created.source_type });
      set.status = 201;
      return created;
    })
    .patch("/tracks/:id", async ({ params, body }) => {
      const parsed = musicTrackUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const updated = await tracks.update(params.id, {
        ...(parsed.data.title !== undefined ? { title: ensureSafeTitle(parsed.data.title) } : {}),
        ...(parsed.data.artist !== undefined ? { artist: ensureSafeDescription(parsed.data.artist) } : {}),
        ...(parsed.data.album !== undefined ? { album: ensureSafeDescription(parsed.data.album) } : {}),
        ...(parsed.data.duration_sec !== undefined ? { duration_sec: parsed.data.duration_sec } : {}),
        ...(parsed.data.thumbnail_url !== undefined ? { thumbnail_url: parsed.data.thumbnail_url } : {}),
      });
      if (!updated) throw new AdminError(404, "Track not found");
      await audit.record("updated", "music_track", updated.id, { fields: Object.keys(parsed.data) });
      return updated;
    })
    .delete("/tracks/:id", async ({ params }) => {
      const cur = await tracks.get(params.id);
      if (!cur) throw new AdminError(404, "Track not found");
      await tracks.remove(params.id);
      // Best-effort delete the on-disk file; ignore ENOENT for URL-only tracks.
      if (cur.source_type === "file") {
        try { fs.unlinkSync(audioPathFor(cur.id, cur.mime_type)); }
        catch (err) { log.warn("failed to remove music file", { id: cur.id, err: String(err) }); }
      }
      await audit.record("deleted", "music_track", cur.id, { title: cur.title });
      return { ok: true };
    })
    .post("/tracks/:id/audio", async ({ params, request, set }) => {
      const track = await tracks.get(params.id);
      if (!track) throw new AdminError(404, "Track not found");
      if (track.source_type !== "file") throw new AdminError(400, "Track source_type is 'url'; no file to upload");
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new AdminError(400, "Missing 'file' field");
      const ext = extForMime(file.type);
      const dest = audioPathFor(track.id, file.type);
      // `Bun.write` streams the File blob to disk without buffering the
      // entire upload in memory, matching the behavior promised in
      // doc 02 §6.
      await Bun.write(dest, file);
      const size = file.size;
      await tracks.update(track.id, {
        mime_type: file.type || track.mime_type,
        size_bytes: size,
        storage_path: dest,
      });
      return { ok: true, size_bytes: size };
    })
    .get("/tracks/:id/audio", async ({ params, request, set }) => {
      const track = await tracks.get(params.id);
      if (!track) throw new AdminError(404, "Track not found");
      if (track.source_type === "url") {
        set.status = 302;
        set.headers["location"] = track.source_url ?? "";
        return "";
      }
      const file = resolveAudioPath(track.id, track.mime_type);
      if (!file) throw new AdminError(404, "Audio file missing");
      const mime = track.mime_type ?? AUDIO_MIME[extForMime(track.mime_type)] ?? "application/octet-stream";
      set.headers["content-type"] = mime;
      set.headers["accept-ranges"] = "bytes";
      // `Bun.file()` honors `Range` automatically when wrapped in a Response.
      const range = request.headers.get("range");
      if (range) {
        const fileSize = fs.statSync(file).size;
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Number(match[2]) : fileSize - 1;
          if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < fileSize) {
            set.status = 206;
            set.headers["content-range"] = `bytes ${start}-${end}/${fileSize}`;
            const fh = Bun.file(file);
            return new Response(fh.slice(start, end + 1));
          }
        }
      }
      return new Response(Bun.file(file));
    })
    .get("/tracks/:id/play", async ({ params, query }) => {
      const track = await tracks.get(params.id);
      if (!track) throw new AdminError(404, "Track not found");
      const position = Number(query.position_ms ?? 0);
      const completed = query.completed === "1" || query.completed === "true";
      const entry = await history.record({ track_id: track.id, position_ms: Number.isFinite(position) ? position : 0, completed });
      return entry;
    })

    // ── Playlists ──
    .get("/playlists", () => playlists.list())
    .get("/playlists/:id", async ({ params }) => {
      const playlist = await playlists.getWithTracks(params.id);
      if (!playlist) throw new AdminError(404, "Playlist not found");
      return playlist;
    })
    .post("/playlists", async ({ body, set }) => {
      const parsed = musicPlaylistCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const name = ensureSafeTitle(parsed.data.name);
      if (await playlists.getByName(name)) throw new AdminError(409, "Playlist already exists");
      const created = await playlists.create({ name, description: ensureSafeDescription(parsed.data.description) });
      for (const entry of parsed.data.tracks ?? []) await playlists.addTrack(created.id, entry.track_id);
      await audit.record("created", "music_playlist", created.id, { name: created.name });
      set.status = 201;
      return await playlists.getWithTracks(created.id) ?? created;
    })
    .patch("/playlists/:id", async ({ params, body }) => {
      const parsed = musicPlaylistUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const cur = await playlists.get(params.id);
      if (!cur) throw new AdminError(404, "Playlist not found");
      const updated = await playlists.update(params.id, {
        ...(parsed.data.name !== undefined ? { name: ensureSafeTitle(parsed.data.name) } : {}),
        ...(parsed.data.description !== undefined ? { description: ensureSafeDescription(parsed.data.description) } : {}),
      });
      if (parsed.data.tracks) {
        // Verify every track exists before reordering so we don't end up with
        // a playlist that references missing tracks.
        for (const entry of parsed.data.tracks) {
          if (!await tracks.get(entry.track_id)) throw new AdminError(400, `Unknown track ${entry.track_id}`);
        }
        await playlists.setTracks(params.id, parsed.data.tracks.map((entry) => entry.track_id));
      }
      await audit.record("updated", "music_playlist", params.id, { fields: Object.keys(parsed.data) });
      return await playlists.getWithTracks(params.id) ?? updated;
    })
    .delete("/playlists/:id", async ({ params }) => {
      const cur = await playlists.get(params.id);
      if (!cur) throw new AdminError(404, "Playlist not found");
      await playlists.remove(params.id);
      await audit.record("deleted", "music_playlist", params.id, { name: cur.name });
      return { ok: true };
    })
    .post("/playlists/:id/tracks", async ({ params, body }) => {
      const playlist = await playlists.get(params.id);
      if (!playlist) throw new AdminError(404, "Playlist not found");
      const payload = body as { track_id?: unknown } | null;
      const trackId = typeof payload?.track_id === "string" ? payload.track_id : null;
      if (!trackId) throw new AdminError(400, "track_id required");
      if (!await tracks.get(trackId)) throw new AdminError(400, `Unknown track ${trackId}`);
      await playlists.addTrack(params.id, trackId);
      return playlists.tracks(params.id);
    })
    .delete("/playlists/:id/tracks/:trackId", async ({ params }) => {
      const playlist = await playlists.get(params.id);
      if (!playlist) throw new AdminError(404, "Playlist not found");
      await playlists.removeTrack(params.id, params.trackId);
      return playlists.tracks(params.id);
    });
}

/**
 * YouTube import endpoints. Backed by the Invidious HTTP API; see
 * `src/utils/invidious.ts` for instance selection + failover. Mounted at
 * `/api/music/youtube` so the existing `/api/music/*` allowlist keeps these
 * public for the dashboard.
 */
export function youtubeRoutes(db: Database) {
  const tracks = new MusicTracksRepo(db);
  const playlists = new MusicPlaylistsRepo(db);
  const audit = new AuditRepo(db);

  return new Elysia({ prefix: "/api/music/youtube" })
    .get("/search", async ({ query, set }) => {
      const parsed = youtubeSearchQuerySchema.safeParse({
        q: typeof query.q === "string" ? query.q : "",
        page: typeof query.page === "string" ? Number(query.page) : undefined,
      });
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid query");
      try {
        const items = await searchVideos(parsed.data.q, parsed.data.page ?? 1);
        return { items };
      } catch (err) {
        log.warn("invidious search failed", { err: err instanceof Error ? err.message : String(err) });
        set.status = 503;
        return { error: "Invidious search unavailable" };
      }
    })
    .get("/suggestions", async ({ query, set }) => {
      const q = typeof query.q === "string" ? query.q.trim() : "";
      if (!q) return { suggestions: [] };
      try {
        const suggestions = await suggestVideos(q);
        return { suggestions };
      } catch (err) {
        log.warn("invidious suggestions failed", { err: err instanceof Error ? err.message : String(err) });
        set.status = 503;
        return { error: "Invidious suggestions unavailable" };
      }
    })
    .post("/import", async ({ body, set }) => {
      const parsed = youtubeImportSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const candidate = parsed.data.video_id ?? parsed.data.url ?? "";
      const videoId = parsed.data.video_id && isValidVideoId(parsed.data.video_id)
        ? parsed.data.video_id
        : extractVideoId(candidate);
      if (!videoId) throw new AdminError(400, "Could not extract a YouTube video id from the input");
      try {
        const imported = await importFromVideoId(videoId);
        if (!imported) throw new AdminError(502, "No playable audio format found for this video");
        const created = await tracks.create({
          title: imported.title,
          artist: imported.artist,
          duration_sec: imported.duration_sec,
          mime_type: imported.mime_type,
          size_bytes: imported.size_bytes,
          source_type: "url",
          source_url: imported.source_url,
          thumbnail_url: imported.thumbnail_url,
        });
        await audit.record("created", "youtube_import", created.id, { video_id: videoId, title: created.title });
        if (parsed.data.playlist_id) {
          if (!await playlists.get(parsed.data.playlist_id)) throw new AdminError(404, "Playlist not found");
          await playlists.addTrack(parsed.data.playlist_id, created.id);
        }
        set.status = 201;
        return created;
      } catch (err) {
        if (err instanceof AdminError) throw err;
        log.warn("invidious import failed", { err: err instanceof Error ? err.message : String(err), video_id: videoId });
        set.status = 503;
        return { error: "Invidious import unavailable" };
      }
    })
    .get("/config", () => ({
      instances: config.invidiousInstances,
      timeout_ms: config.invidiousTimeoutMs,
    }));
}