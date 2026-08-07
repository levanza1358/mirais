import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Play,
  Pause,
  SkipForward,
  Search,
  Plus,
  Trash2,
  Music as MusicIcon,
  ListMusic,
  Loader2,
} from "lucide-react";
import { music as musicApi, type MusicPlaylist, type MusicSearchResult } from "../api";
import { Button, Card, Input, Skeleton, Badge, toast } from "../components/ui";
import { trackFromSearch, useMusicPlayer } from "../hooks/useMusicPlayer";

function fmtTime(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function Music() {
  const qc = useQueryClient();
  const player = useMusicPlayer();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  const playlistsQ = useQuery({
    queryKey: ["music-playlists"],
    queryFn: () => musicApi.listPlaylists().then((r) => r.playlists),
  });

  const playlistQ = useQuery({
    queryKey: ["music-playlist", selectedPlaylistId],
    queryFn: () => musicApi.getPlaylist(selectedPlaylistId!),
    enabled: !!selectedPlaylistId,
  });

  const searchQ = useQuery({
    queryKey: ["music-search", debounced],
    queryFn: () => musicApi.search(debounced, 12),
    enabled: debounced.length > 0,
  });

  const createPlaylist = useMutation({
    mutationFn: (name: string) => musicApi.createPlaylist(name),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["music-playlists"] });
      setSelectedPlaylistId(p.id);
      toast(`Created playlist "${p.name}"`);
    },
    onError: (e) => toast(e.message, "error"),
  });

  const deletePlaylist = useMutation({
    mutationFn: (id: string) => musicApi.deletePlaylist(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["music-playlists"] });
      setSelectedPlaylistId(null);
    },
  });

  const addTrack = useMutation({
    mutationFn: (input: { playlistId: string; result: MusicSearchResult }) =>
      musicApi.addTrack(input.playlistId, {
        url: `https://www.youtube.com/watch?v=${input.result.id}`,
        title: input.result.title,
        channel: input.result.channel ?? undefined,
        durationSec: input.result.duration_sec ?? undefined,
        thumbnailUrl: input.result.thumbnail_url ?? undefined,
      }),
    onSuccess: (_t, vars) => {
      qc.invalidateQueries({ queryKey: ["music-playlist", vars.playlistId] });
      toast(`Added "${vars.result.title}"`);
    },
    onError: (e) => toast(e.message, "error"),
  });

  const removeTrack = useMutation({
    mutationFn: (trackId: string) => musicApi.removeTrack(trackId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["music-playlist", selectedPlaylistId] }),
  });

  const playTrack = (result: MusicSearchResult) => {
    player.play(trackFromSearch(result));
  };

  const playPlaylist = (playlist: MusicPlaylist) => {
    const tracks = (playlist.tracks ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      channel: t.channel,
      duration_sec: t.duration_sec,
      thumbnail_url: t.thumbnail_url,
      source_id: t.source_id,
    }));
    if (!tracks.length) return;
    const [head, ...rest] = tracks;
    player.play(head, rest);
  };

  const playlists = playlistsQ.data ?? [];
  const currentPlaylist = playlistQ.data ?? null;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-text-muted">Mirais dashboard</p>
          <h1 className="text-xl font-semibold tracking-tight">Music</h1>
        </div>
        <Badge tone="accent"><MusicIcon size={11} /> {playlists.length} playlists</Badge>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_1fr]">
        {/* ── Playlists ─────────────────────────────────────────────── */}
        <Card className="flex min-h-0 flex-col p-3 max-h-48 overflow-hidden lg:max-h-none">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold"><ListMusic size={14} /> Playlists</h2>
            <CreatePlaylistButton onCreate={(name) => createPlaylist.mutate(name)} pending={createPlaylist.isPending} />
          </div>
          <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-bg-base/40 p-1">
            {playlistsQ.isLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : playlists.length === 0 ? (
              <p className="px-2 py-4 text-center text-[11px] text-text-muted">No playlists yet — create one to start saving tracks.</p>
            ) : (
              <ul className="space-y-0.5">
                {playlists.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedPlaylistId(p.id)}
                      className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${selectedPlaylistId === p.id ? "bg-accent/15 text-text-primary" : "text-text-muted hover:bg-bg-raised/60 hover:text-text-primary"}`}
                    >
                      <span className="truncate">{p.name}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete playlist "${p.name}"?`)) deletePlaylist.mutate(p.id);
                        }}
                        className="rounded p-1 text-text-muted hover:bg-bg-raised hover:text-danger"
                        aria-label="Delete playlist"
                      >
                        <Trash2 size={12} />
                      </button>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* ── Main panel ─────────────────────────────────────────────── */}
        <div className="grid min-h-0 gap-3 lg:grid-cols-[1fr_1fr]">
          <Card className="flex min-h-0 flex-col p-3">
            <div className="mb-2 flex items-center gap-2">
              <Search size={14} className="text-text-muted" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search YouTube… (try a song title or artist)"
                className="flex-1"
              />
              {searchQ.isFetching && <Loader2 size={14} className="animate-spin text-text-muted" />}
            </div>
            <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-text-muted">
              {searchQ.data ? `via ${searchQ.data.source}` : "YouTube (yt-dlp → Invidious fallback)"}
            </p>
            <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-bg-base/40">
              {!debounced ? (
                <p className="px-3 py-6 text-center text-xs text-text-muted">Type to search for music.</p>
              ) : searchQ.isLoading ? (
                <div className="space-y-1 p-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : (searchQ.data?.results ?? []).length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-text-muted">No results. Try a different query.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {(searchQ.data?.results ?? []).map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-2 py-2 hover:bg-bg-raised/40">
                      <img src={r.thumbnail_url ?? ""} alt="" className="h-10 w-16 shrink-0 rounded object-cover bg-bg-raised" loading="lazy" referrerPolicy="no-referrer" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{r.title}</p>
                        <p className="truncate text-[11px] text-text-muted">{r.channel ?? "—"} · {fmtTime(r.duration_sec)}</p>
                      </div>
                      <Button size="sm" onClick={() => playTrack(r)} title="Play"><Play size={12} /></Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!selectedPlaylistId || addTrack.isPending}
                        onClick={() => selectedPlaylistId && addTrack.mutate({ playlistId: selectedPlaylistId, result: r })}
                        title={selectedPlaylistId ? "Add to current playlist" : "Select a playlist first"}
                      >
                        <Plus size={12} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card className="flex min-h-0 flex-col p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                {currentPlaylist ? currentPlaylist.name : "Select a playlist"}
              </h2>
              {currentPlaylist?.tracks?.length ? (
                <Button size="sm" onClick={() => playPlaylist(currentPlaylist)}>
                  <Play size={12} /> Play all
                </Button>
              ) : null}
            </div>
            <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-bg-base/40">
              {!currentPlaylist ? (
                <p className="px-3 py-6 text-center text-xs text-text-muted">Pick a playlist on the left to see its tracks.</p>
              ) : (currentPlaylist.tracks ?? []).length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-text-muted">No tracks yet — search on the left and use the + button to add.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {(currentPlaylist.tracks ?? []).map((t, i) => (
                    <li key={t.id} className="flex items-center gap-2 px-2 py-2 hover:bg-bg-raised/40">
                      <span className="w-6 text-center text-[11px] text-text-muted">{i + 1}</span>
                      <img src={t.thumbnail_url ?? ""} alt="" className="h-10 w-16 shrink-0 rounded object-cover bg-bg-raised" loading="lazy" referrerPolicy="no-referrer" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{t.title}</p>
                        <p className="truncate text-[11px] text-text-muted">{t.channel ?? "—"} · {fmtTime(t.duration_sec)}</p>
                      </div>
                      <Button size="sm" onClick={() => player.play({
                        id: t.id,
                        title: t.title,
                        channel: t.channel,
                        duration_sec: t.duration_sec,
                        thumbnail_url: t.thumbnail_url,
                        source_id: t.source_id,
                      }, (currentPlaylist.tracks ?? []).slice(i + 1).map((nx) => ({
                        id: nx.id, title: nx.title, channel: nx.channel,
                        duration_sec: nx.duration_sec, thumbnail_url: nx.thumbnail_url,
                        source_id: nx.source_id,
                      })))} title="Play">
                        <Play size={12} />
                      </Button>
                      <button
                        type="button"
                        onClick={() => removeTrack.mutate(t.id)}
                        className="rounded p-1 text-text-muted hover:bg-bg-raised hover:text-danger"
                        aria-label="Remove from playlist"
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CreatePlaylistButton({ onCreate, pending }: { onCreate: (name: string) => void; pending?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus size={12} /> New
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) {
            onCreate(name.trim());
            setName("");
            setOpen(false);
          } else if (e.key === "Escape") {
            setOpen(false);
            setName("");
          }
        }}
        placeholder="Playlist name"
        className="h-8 w-32"
      />
      <Button
        size="sm"
        loading={pending}
        onClick={() => {
          if (name.trim()) {
            onCreate(name.trim());
            setName("");
            setOpen(false);
          }
        }}
      >
        Add
      </Button>
    </div>
  );
}