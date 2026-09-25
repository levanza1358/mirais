-- Music feature removed. Delete legacy playlist metadata from existing installations.
DROP TABLE IF EXISTS music_tracks;
DROP TABLE IF EXISTS music_playlists;
