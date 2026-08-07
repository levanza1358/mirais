import type { Database } from "bun:sqlite";
import { ulid, nowIso } from "../../utils/id";

export interface MusicTrack {
  id: string;
  playlist_id: string;
  source: string;
  source_id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  position: number;
  created_at: string;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  tracks?: MusicTrack[];
}

export class MusicRepo {
  constructor(private db: Database) {}

  listPlaylists(): MusicPlaylist[] {
    return this.db.query("SELECT * FROM music_playlists ORDER BY created_at ASC").all() as MusicPlaylist[];
  }

  getPlaylist(id: string): MusicPlaylist | null {
    const row = this.db.query("SELECT * FROM music_playlists WHERE id = ?").get(id) as MusicPlaylist | null;
    if (!row) return null;
    row.tracks = this.listTracks(id);
    return row;
  }

  createPlaylist(name: string): MusicPlaylist {
    const id = ulid();
    this.db.query("INSERT INTO music_playlists (id, name) VALUES (?, ?)").run(id, name.trim() || "Untitled");
    return this.getPlaylist(id)!;
  }

  renamePlaylist(id: string, name: string): MusicPlaylist | null {
    this.db.query("UPDATE music_playlists SET name = ?, updated_at = ? WHERE id = ?").run(name.trim() || "Untitled", nowIso(), id);
    return this.getPlaylist(id);
  }

  deletePlaylist(id: string): { ok: boolean } {
    this.db.query("DELETE FROM music_playlists WHERE id = ?").run(id);
    return { ok: true };
  }

  listTracks(playlistId: string): MusicTrack[] {
    return this.db
      .query("SELECT * FROM music_tracks WHERE playlist_id = ? ORDER BY position ASC, created_at ASC")
      .all(playlistId) as MusicTrack[];
  }

  addTrack(
    playlistId: string,
    input: { source?: string; sourceId: string; title: string; channel?: string | null; durationSec?: number | null; thumbnailUrl?: string | null },
  ): MusicTrack {
    const id = ulid();
    const maxRow = this.db
      .query("SELECT COALESCE(MAX(position), -1) AS m FROM music_tracks WHERE playlist_id = ?")
      .get(playlistId) as { m: number };
    const position = maxRow.m + 1;
    this.db
      .query(
        "INSERT INTO music_tracks (id, playlist_id, source, source_id, title, channel, duration_sec, thumbnail_url, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, playlistId, input.source ?? "youtube", input.sourceId, input.title, input.channel ?? null, input.durationSec ?? null, input.thumbnailUrl ?? null, position);
    this.db.query("UPDATE music_playlists SET updated_at = ? WHERE id = ?").run(nowIso(), playlistId);
    return this.db.query("SELECT * FROM music_tracks WHERE id = ?").get(id) as MusicTrack;
  }

  removeTrack(trackId: string): { ok: boolean } {
    const row = this.db.query("SELECT playlist_id FROM music_tracks WHERE id = ?").get(trackId) as { playlist_id: string } | null;
    if (!row) return { ok: false };
    this.db.query("DELETE FROM music_tracks WHERE id = ?").run(trackId);
    this.db.query("UPDATE music_playlists SET updated_at = ? WHERE id = ?").run(nowIso(), row.playlist_id);
    return { ok: true };
  }

  reorderTrack(playlistId: string, trackId: string, newPosition: number): { ok: boolean } {
    if (!Number.isInteger(newPosition) || newPosition < 0) return { ok: false };
    this.db.query("UPDATE music_tracks SET position = ? WHERE id = ? AND playlist_id = ?").run(newPosition, trackId, playlistId);
    this.db.query("UPDATE music_playlists SET updated_at = ? WHERE id = ?").run(nowIso(), playlistId);
    return { ok: true };
  }
}