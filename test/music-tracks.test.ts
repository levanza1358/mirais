import { describe, expect, test, beforeEach } from "bun:test";
import { freshDb } from "./helpers";
import { MusicPlaylistsRepo, MusicTracksRepo, PlayHistoryRepo } from "../src/store/repos/music";

async function setup() {
  const db = await freshDb();
  return {
    db,
    tracks: new MusicTracksRepo(db),
    playlists: new MusicPlaylistsRepo(db),
    history: new PlayHistoryRepo(db),
  };
}

describe("MusicTracksRepo", () => {
  test("creates and fetches a track", async () => {
    const { tracks } = await setup();
    const track = await tracks.create({
      title: "Sample",
      artist: "Anthropic",
      album: "Demos",
      duration_sec: 12,
      mime_type: "audio/mpeg",
      size_bytes: 1024,
      source_type: "file",
      storage_path: "/var/music/sample.mp3",
    });
    expect(track.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect((await tracks.get(track.id))?.title).toBe("Sample");
  });

  test("lists with search filters by title/artist/album", async () => {
    const { tracks } = await setup();
    await tracks.create({ title: "Alpha song", artist: "Foo", source_type: "file", storage_path: "/x" });
    await tracks.create({ title: "Beta song", artist: "Bar", album: "B-sides", source_type: "file", storage_path: "/x" });
    const { items, total } = await tracks.list({ q: "Beta" });
    expect(total).toBe(1);
    expect(items[0]?.title).toBe("Beta song");
    const filteredByAlbum = await tracks.list({ album: "B-sides" });
    expect(filteredByAlbum.items.length).toBe(1);
  });

  test("update and remove mutate rows", async () => {
    const { tracks } = await setup();
    const track = await tracks.create({ title: "T", source_type: "file", storage_path: "/x" });
    const updated = await tracks.update(track.id, { title: "T2", artist: "A" });
    expect(updated?.title).toBe("T2");
    expect(updated?.artist).toBe("A");
    const removed = await tracks.remove(track.id);
    expect(removed?.id).toBe(track.id);
    expect(await tracks.get(track.id)).toBeNull();
  });
});

describe("MusicPlaylistsRepo", () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { env = await setup(); });

  test("create + unique name enforcement via lookup", async () => {
    const { playlists } = env;
    const created = await playlists.create({ name: "my-mix" });
    expect(created.name).toBe("my-mix");
    expect((await playlists.getByName("my-mix"))?.id).toBe(created.id);
    expect(await playlists.getByName("missing")).toBeNull();
  });

  test("add / remove / setTracks keeps ordering", async () => {
    const { playlists, tracks } = env;
    const playlist = await playlists.create({ name: "list" });
    const t1 = await tracks.create({ title: "t1", source_type: "file", storage_path: "/a" });
    const t2 = await tracks.create({ title: "t2", source_type: "file", storage_path: "/b" });
    const t3 = await tracks.create({ title: "t3", source_type: "file", storage_path: "/c" });
    await playlists.addTrack(playlist.id, t1.id);
    await playlists.addTrack(playlist.id, t2.id);
    await playlists.addTrack(playlist.id, t3.id);
    expect((await playlists.tracks(playlist.id)).map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);

    await playlists.removeTrack(playlist.id, t2.id);
    expect((await playlists.tracks(playlist.id)).map((t) => t.id)).toEqual([t1.id, t3.id]);

    await playlists.setTracks(playlist.id, [t3.id, t1.id]);
    const reordered = await playlists.getWithTracks(playlist.id);
    expect(reordered?.tracks.map((t) => t.id)).toEqual([t3.id, t1.id]);
    expect(reordered?.tracks[0]?.position).toBe(0);
    expect(reordered?.tracks[1]?.position).toBe(1);
  });

  test("cascade delete removes entries when track is removed", async () => {
    const { playlists, tracks } = env;
    const playlist = await playlists.create({ name: "list" });
    const t = await tracks.create({ title: "t", source_type: "file", storage_path: "/x" });
    await playlists.addTrack(playlist.id, t.id);
    await tracks.remove(t.id);
    expect(await playlists.tracks(playlist.id)).toHaveLength(0);
  });
});

describe("PlayHistoryRepo", () => {
  test("records a play and exposes it via recent", async () => {
    const { history, tracks } = await setup();
    const t = await tracks.create({ title: "t", source_type: "file", storage_path: "/x" });
    const entry = await history.record({ track_id: t.id, position_ms: 12_345, completed: false });
    expect(entry.track_id).toBe(t.id);
    expect((await history.recent())[0]?.id).toBe(entry.id);
  });
});