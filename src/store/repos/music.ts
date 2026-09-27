import type { Database } from "../sql";
import { ulid, nowIso } from "../../utils/id";

export type MusicSourceType = "file" | "url";

export interface MusicTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_sec: number | null;
  mime_type: string | null;
  size_bytes: number | null;
  source_type: MusicSourceType;
  storage_path: string | null;
  source_url: string | null;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlaylistTrackEntry {
  track_id: string;
  position: number;
}

export interface MusicPlaylistWithTracks extends MusicPlaylist {
  tracks: Array<MusicTrack & { position: number }>;
}

export interface PlayHistoryEntry {
  id: string;
  track_id: string;
  played_at: string;
  position_ms: number;
  completed: boolean;
}

export class MusicTracksRepo {
  constructor(private db: Database) {}

  async create(input: {
    title: string;
    artist?: string | null;
    album?: string | null;
    duration_sec?: number | null;
    mime_type?: string | null;
    size_bytes?: number | null;
    source_type: MusicSourceType;
    storage_path?: string | null;
    source_url?: string | null;
    thumbnail_url?: string | null;
  }): Promise<MusicTrack> {
    const id = ulid();
    await this.db
      .query(
        `INSERT INTO tracks (id, title, artist, album, duration_sec, mime_type, size_bytes, source_type, storage_path, source_url, thumbnail_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.artist ?? null,
        input.album ?? null,
        input.duration_sec ?? null,
        input.mime_type ?? null,
        input.size_bytes ?? null,
        input.source_type,
        input.storage_path ?? null,
        input.source_url ?? null,
        input.thumbnail_url ?? null,
        nowIso(),
        nowIso(),
      );
    const track = await this.get(id);
    if (!track) throw new Error("Created track could not be loaded");
    return track;
  }

  get(id: string): Promise<MusicTrack | null> {
    return this.db.query("SELECT * FROM tracks WHERE id = ?").get<MusicTrack>(id);
  }

  async list(filters: { q?: string; artist?: string; album?: string; limit?: number; offset?: number } = {}): Promise<{ items: MusicTrack[]; total: number }> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.q) {
      where.push("(title LIKE ? OR artist LIKE ? OR album LIKE ?)");
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    if (filters.artist) { where.push("artist = ?"); params.push(filters.artist); }
    if (filters.album)  { where.push("album = ?");  params.push(filters.album); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await this.db.query(`SELECT COUNT(*) AS c FROM tracks ${whereSql}`).get<{ c: number }>(...params);
    const total = count?.c ?? 0;
    const limit = Math.min(200, Math.max(1, filters.limit ?? 100));
    const offset = Math.max(0, filters.offset ?? 0);
    const items = await this.db
      .query(`SELECT * FROM tracks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all<MusicTrack>(...params, limit, offset);
    return { items, total };
  }

  async update(id: string, patch: Partial<Omit<MusicTrack, "id" | "created_at" | "updated_at">>): Promise<MusicTrack | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    await this.db
      .query(
        `UPDATE tracks
         SET title = ?, artist = ?, album = ?, duration_sec = ?, mime_type = ?, size_bytes = ?,
             source_type = ?, storage_path = ?, source_url = ?, thumbnail_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.title ?? cur.title,
        patch.artist !== undefined ? patch.artist : cur.artist,
        patch.album !== undefined ? patch.album : cur.album,
        patch.duration_sec !== undefined ? patch.duration_sec : cur.duration_sec,
        patch.mime_type !== undefined ? patch.mime_type : cur.mime_type,
        patch.size_bytes !== undefined ? patch.size_bytes : cur.size_bytes,
        patch.source_type ?? cur.source_type,
        patch.storage_path !== undefined ? patch.storage_path : cur.storage_path,
        patch.source_url !== undefined ? patch.source_url : cur.source_url,
        patch.thumbnail_url !== undefined ? patch.thumbnail_url : cur.thumbnail_url,
        nowIso(),
        id,
      );
    return this.get(id);
  }

  async remove(id: string): Promise<MusicTrack | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    await this.db.query("DELETE FROM tracks WHERE id = ?").run(id);
    return cur;
  }

  async count(): Promise<number> {
    const row = await this.db.query("SELECT COUNT(*) AS c FROM tracks").get<{ c: number }>();
    return row?.c ?? 0;
  }
}

export class MusicPlaylistsRepo {
  constructor(private db: Database) {}

  async create(input: { name: string; description?: string | null }): Promise<MusicPlaylist> {
    const id = ulid();
    await this.db
      .query("INSERT INTO playlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.name, input.description ?? null, nowIso(), nowIso());
    const playlist = await this.get(id);
    if (!playlist) throw new Error("Created playlist could not be loaded");
    return playlist;
  }

  get(id: string): Promise<MusicPlaylist | null> {
    return this.db.query("SELECT * FROM playlists WHERE id = ?").get<MusicPlaylist>(id);
  }

  getByName(name: string): Promise<MusicPlaylist | null> {
    return this.db.query("SELECT * FROM playlists WHERE name = ?").get<MusicPlaylist>(name);
  }

  list(): Promise<MusicPlaylist[]> {
    return this.db.query("SELECT * FROM playlists ORDER BY created_at DESC").all<MusicPlaylist>();
  }

  async update(id: string, patch: { name?: string; description?: string | null }): Promise<MusicPlaylist | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    await this.db
      .query("UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.name ?? cur.name,
        patch.description !== undefined ? patch.description : cur.description,
        nowIso(),
        id,
      );
    return this.get(id);
  }

  async remove(id: string): Promise<MusicPlaylist | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    await this.db.query("DELETE FROM playlists WHERE id = ?").run(id);
    return cur;
  }

  async addTrack(playlistId: string, trackId: string, position?: number): Promise<void> {
    const row = position === undefined ? await this.db
      .query("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_tracks WHERE playlist_id = ?")
      .get<{ p: number }>(playlistId) : null;
    const next = position ?? row?.p ?? 0;
    await this.db
      .query("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)")
      .run(playlistId, trackId, next);
  }

  async removeTrack(playlistId: string, trackId: string): Promise<void> {
    await this.db
      .query("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?")
      .run(playlistId, trackId);
  }

  /** Replace the entire ordered track list of a playlist. */
  setTracks(playlistId: string, trackIds: string[]): Promise<void> {
    const tx = this.db.transaction(async (db) => {
      await db.query("DELETE FROM playlist_tracks WHERE playlist_id = ?").run(playlistId);
      for (const [position, trackId] of trackIds.entries()) {
        await db
          .query("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)")
          .run(playlistId, trackId, position);
      }
    });
    return tx();
  }

  /** Tracks joined with playlist ordering. */
  tracks(playlistId: string): Promise<Array<MusicTrack & { position: number }>> {
    return this.db
      .query(
        `SELECT t.*, pt.position AS position
         FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?
         ORDER BY pt.position ASC`,
      )
      .all<MusicTrack & { position: number }>(playlistId);
  }

  async getWithTracks(id: string): Promise<MusicPlaylistWithTracks | null> {
    const playlist = await this.get(id);
    if (!playlist) return null;
    return { ...playlist, tracks: await this.tracks(id) };
  }
}

export class PlayHistoryRepo {
  constructor(private db: Database) {}

  async record(input: { track_id: string; position_ms?: number; completed?: boolean }): Promise<PlayHistoryEntry> {
    const id = ulid();
    const playedAt = nowIso();
    await this.db
      .query("INSERT INTO play_history (id, track_id, played_at, position_ms, completed) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.track_id, playedAt, input.position_ms ?? 0, input.completed ? 1 : 0);
    return {
      id,
      track_id: input.track_id,
      played_at: playedAt,
      position_ms: input.position_ms ?? 0,
      completed: !!input.completed,
    };
  }

  recent(limit = 50): Promise<PlayHistoryEntry[]> {
    return this.db
      .query("SELECT * FROM play_history ORDER BY played_at DESC LIMIT ?")
      .all<PlayHistoryEntry>(limit);
  }
}