-- Music player: playlists + tracks. Mirais only stores metadata + the source
-- identifier (YouTube video id). The actual audio bytes are streamed through
-- `/api/music/stream/:id`, which fetches from yt-dlp / Invidious and proxies
-- the range request — no media is ever cached on disk by Mirais.

CREATE TABLE IF NOT EXISTS music_playlists (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS music_tracks (
  id            TEXT PRIMARY KEY,
  playlist_id   TEXT NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'youtube',
  source_id     TEXT NOT NULL,           -- e.g. YouTube video id
  title         TEXT NOT NULL,
  channel       TEXT,
  duration_sec  INTEGER,
  thumbnail_url TEXT,
  position      INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS music_tracks_playlist_idx
  ON music_tracks (playlist_id, position);