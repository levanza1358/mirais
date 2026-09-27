-- 0036_music_init.sql
-- Self-hosted music library. Stores only metadata + a pointer to either a
-- file on disk (DATA_DIR/music/<id>.<ext>) or an external URL. Audio
-- decoding happens client-side; the backend never reads file contents.
-- Migration 0032 already dropped the legacy music_tracks / music_playlists
-- tables, so the new tables can reuse those names without conflict.

CREATE TABLE tracks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  artist        TEXT,
  album         TEXT,
  duration_sec  INTEGER,
  mime_type     TEXT,
  size_bytes    INTEGER,
  source_type   TEXT NOT NULL CHECK (source_type IN ('file', 'url')),
  storage_path  TEXT,
  source_url    TEXT,
  thumbnail_url TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tracks_artist ON tracks(artist);
CREATE INDEX idx_tracks_album  ON tracks(album);

CREATE TABLE playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);

CREATE TABLE play_history (
  id           TEXT PRIMARY KEY,
  track_id     TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at    TEXT NOT NULL DEFAULT (datetime('now')),
  position_ms  INTEGER NOT NULL DEFAULT 0,
  completed    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_play_history_track   ON play_history(track_id);
CREATE INDEX idx_play_history_played  ON play_history(played_at);