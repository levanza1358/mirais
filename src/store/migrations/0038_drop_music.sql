-- Drop the music library tables that 0036_music_init.sql created.
-- Safe on fresh installs (tables do not exist) and on installs that have
-- already had the legacy music_tracks / music_playlists dropped by 0032.
DROP TABLE IF EXISTS play_history;
DROP TABLE IF EXISTS playlist_tracks;
DROP TABLE IF EXISTS playlists;
DROP TABLE IF EXISTS tracks;