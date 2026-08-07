import { useEffect, useMemo, useState } from "react";
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
  Filter,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { music as musicApi, type MusicPlaylist, type MusicSearchResult } from "../api";
import { Button, Card, Input, Select, Skeleton, Badge, Switch, toast } from "../components/ui";
import { trackFromSearch, useMusicPlayer } from "../hooks/useMusicPlayer";

function fmtTime(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const MUSIC_PREFS_KEY = "mirais.music.preferences";
const QUICK_SEARCHES = ["indo", "japan", "barat", "viral", "official"];

export default function Music() {
  const qc = useQueryClient();
  const player = useMusicPlayer();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [trendingPage, setTrendingPage] = useState(1);
  const [searchPage, setSearchPage] = useState(1);
  const [durationFilter, setDurationFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [officialOnly, setOfficialOnly] = useState(false);
  const [hideAlt, setHideAlt] = useState(true);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MUSIC_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        durationFilter?: string;
        regionFilter?: string;
        officialOnly?: boolean;
        hideAlt?: boolean;
        recentSearches?: string[];
      };
      if (parsed.durationFilter) setDurationFilter(parsed.durationFilter);
      if (parsed.regionFilter) setRegionFilter(parsed.regionFilter);
      if (typeof parsed.officialOnly === "boolean") setOfficialOnly(parsed.officialOnly);
      if (typeof parsed.hideAlt === "boolean") setHideAlt(parsed.hideAlt);
      if (Array.isArray(parsed.recentSearches)) setRecentSearches(parsed.recentSearches.slice(0, 8));
    } catch {
      /* ignore corrupt local prefs */
    }
  }, []);

  useEffect(() => {
    const payload = { durationFilter, regionFilter, officialOnly, hideAlt, recentSearches: recentSearches.slice(0, 8) };
    window.localStorage.setItem(MUSIC_PREFS_KEY, JSON.stringify(payload));
  }, [durationFilter, regionFilter, officialOnly, hideAlt, recentSearches]);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setSearchPage(1);
  }, [debounced]);

  useEffect(() => {
    if (!debounced) return;
    setRecentSearches((prev) => [debounced, ...prev.filter((item) => item !== debounced)].slice(0, 8));
  }, [debounced]);

  useEffect(() => {
    if (debounced) return;
    setTrendingPage(1);
  }, [debounced]);

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
    queryKey: ["music-search", debounced, searchPage],
    queryFn: () => musicApi.search(debounced, 20, searchPage),
    enabled: debounced.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    placeholderData: (prev) => prev,
  });

  // Trending feed: refreshed once on mount and again when the user clicks
  // Refresh. Disabled while the user has a search query in flight so we
  // don't fight them for screen real-estate.
  const trendingQ = useQuery({
    queryKey: ["music-trending", trendingPage],
    queryFn: () => musicApi.trending(20, trendingPage),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

  const activeList = useMemo(() => {
    const source = debounced ? (searchQ.data?.results ?? []) : (trendingQ.data?.results ?? []);
    return source.filter((item) => {
      const title = item.title.toLowerCase();
      const channel = (item.channel ?? "").toLowerCase();
      const duration = item.duration_sec ?? 0;
      if (durationFilter === "short" && duration > 180) return false;
      if (durationFilter === "medium" && (duration < 181 || duration > 300)) return false;
      if (durationFilter === "long" && duration < 301) return false;
      if (officialOnly && !/(official|records|music|vevo|labels?)/i.test(`${item.title} ${item.channel ?? ""}`)) return false;
      if (hideAlt && /(live|cover|remix|karaoke|reaction)/i.test(title)) return false;
      if (regionFilter === "indo" && !/(indonesia|indo|tulus|mahalini|rizky|noah|virgoun|afgan|lyodra|nadin)/i.test(`${title} ${channel}`)) return false;
      if (regionFilter === "japan" && !/(yoasobi|japan|japanese|jpop|radwimps|official mv|niziu|illit|enhypen|newjeans|bts|j-hope)/i.test(`${title} ${channel}`)) return false;
      if (regionFilter === "barat" && /(indonesia|indo|japan|japanese|jpop)/i.test(`${title} ${channel}`)) return false;
      return true;
    });
  }, [debounced, durationFilter, hideAlt, officialOnly, regionFilter, searchQ.data?.results, trendingQ.data?.results]);

  useEffect(() => {
    if (!debounced) return;
    if ((searchQ.data?.results?.length ?? 0) < 20) return;
    const nextPage = Math.min(10, searchPage + 1);
    if (nextPage === searchPage) return;
    void qc.prefetchQuery({
      queryKey: ["music-search", debounced, nextPage],
      queryFn: () => musicApi.search(debounced, 20, nextPage),
      staleTime: 5 * 60_000,
    });
  }, [debounced, qc, searchPage, searchQ.data?.results?.length]);

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
    const queue = activeList
      .map(trackFromSearch)
      .filter((track) => track.source_id !== result.id);
    player.play(trackFromSearch(result), queue);
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
              {(searchQ.isFetching || trendingQ.isFetching) && <Loader2 size={14} className="animate-spin text-text-muted" />}
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {QUICK_SEARCHES.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setQuery(chip)}
                  className="rounded-full border border-border/70 bg-bg-surface px-3 py-1 text-[11px] text-text-muted transition-colors hover:border-accent/40 hover:text-text-primary"
                >
                  {chip}
                </button>
              ))}
              {recentSearches.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setQuery(item)}
                  className="rounded-full bg-bg-raised px-3 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary"
                  title="Recent search"
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="mb-3 grid gap-2 rounded-xl border border-border/60 bg-bg-base/30 p-2 md:grid-cols-4">
              <div className="flex items-center gap-2 text-xs text-text-muted"><Filter size={13} /> Filters</div>
              <Select value={durationFilter} onChange={(e) => setDurationFilter(e.target.value)} className="h-8 text-xs">
                <option value="all">All durations</option>
                <option value="short">Short &lt; 3m</option>
                <option value="medium">3–5m</option>
                <option value="long">5m+</option>
              </Select>
              <Select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} className="h-8 text-xs">
                <option value="all">All regions</option>
                <option value="indo">Indonesia</option>
                <option value="japan">Japan</option>
                <option value="barat">Barat</option>
              </Select>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-xs text-text-muted">
                <span>Official only</span>
                <Switch checked={officialOnly} onChange={setOfficialOnly} aria-label="Official only" />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-xs text-text-muted md:col-start-4">
                <span>Hide live/cover</span>
                <Switch checked={hideAlt} onChange={setHideAlt} aria-label="Hide live cover remix" />
              </div>
            </div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                {debounced
                  ? (searchQ.data ? `Page ${searchPage} · ${activeList.length} results via ${searchQ.data.source}${searchQ.isFetching ? " · refreshing" : ""}` : "Searching…")
                  : (trendingQ.data ? `Trending now · ${activeList.length} tracks via ${trendingQ.data.source}` : "Loading trending…")}
              </p>
              <button
                type="button"
                onClick={() => trendingQ.refetch()}
                disabled={trendingQ.isFetching}
                className="text-[10px] uppercase tracking-[0.18em] text-text-muted hover:text-text-primary disabled:opacity-40"
              >
                Refresh
              </button>
            </div>
            <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-bg-base/40">
              {debounced ? (
                searchQ.isLoading ? (
                  <div className="space-y-1 p-2">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : (searchQ.data?.results ?? []).length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-text-muted">No results. Try a different query.</p>
                ) : (
                  <>
                    <ul className="divide-y divide-border/60">
                      {activeList.map((r, i) => (
                        <li key={r.id} className="flex items-center gap-2 px-2 py-2 hover:bg-bg-raised/40">
                          <span className="w-5 shrink-0 text-center text-[11px] font-mono text-text-muted">{((searchPage - 1) * 20) + i + 1}</span>
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
                    <div className="flex flex-wrap items-center justify-center gap-1 border-t border-border/60 px-2 py-2">
                      <button type="button" onClick={() => setSearchPage((p) => Math.max(1, p - 1))} disabled={searchPage === 1} className="inline-flex h-8 items-center gap-1 rounded-lg bg-bg-raised px-2 text-xs text-text-muted hover:text-text-primary disabled:opacity-40"><ChevronLeft size={14} /> Prev</button>
                      {Array.from({ length: 10 }).map((_, idx) => {
                        const page = idx + 1;
                        const active = page === searchPage;
                        return (
                          <button
                            key={page}
                            type="button"
                            onClick={() => setSearchPage(page)}
                            className={`min-w-8 rounded-lg px-2 py-1 text-xs transition-colors ${active ? "bg-accent text-white" : "bg-bg-raised text-text-muted hover:text-text-primary"}`}
                          >
                            {page}
                          </button>
                        );
                      })}
                      <button type="button" onClick={() => setSearchPage((p) => Math.min(10, p + 1))} disabled={searchPage === 10} className="inline-flex h-8 items-center gap-1 rounded-lg bg-bg-raised px-2 text-xs text-text-muted hover:text-text-primary disabled:opacity-40">Next <ChevronRight size={14} /></button>
                    </div>
                  </>
                )
              ) : trendingQ.isLoading ? (
                <div className="space-y-1 p-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : activeList.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-text-muted">Trending feed is empty. Try searching above, or add tracks manually.</p>
              ) : (
                <>
                  <ul className="divide-y divide-border/60">
                    {activeList.map((r, i) => (
                      <li key={r.id} className="flex items-center gap-2 px-2 py-2 hover:bg-bg-raised/40">
                        <span className="w-5 shrink-0 text-center text-[11px] font-mono text-text-muted">{((trendingPage - 1) * 20) + i + 1}</span>
                        <img src={r.thumbnail_url ?? ""} alt="" className="h-10 w-16 shrink-0 rounded object-cover bg-bg-raised" loading="lazy" referrerPolicy="no-referrer" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{r.title}</p>
                          <p className="truncate text-[11px] text-text-muted">{r.channel ?? "—"} · {fmtTime(r.duration_sec)}</p>
                        </div>
                        <Button size="sm" onClick={() => playTrack(r)} title="Play"><Play size={12} /></Button>
                        <Button size="sm" variant="ghost" onClick={() => player.playNext(trackFromSearch(r))} title="Play next"><SkipForward size={12} /></Button>
                        <Button size="sm" variant="ghost" onClick={() => player.playNext(trackFromSearch(r))} title="Play next"><SkipForward size={12} /></Button>
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
                  <div className="flex flex-wrap items-center justify-center gap-1 border-t border-border/60 px-2 py-2">
                    <button type="button" onClick={() => setTrendingPage((p) => Math.max(1, p - 1))} disabled={trendingPage === 1} className="inline-flex h-8 items-center gap-1 rounded-lg bg-bg-raised px-2 text-xs text-text-muted hover:text-text-primary disabled:opacity-40"><ChevronLeft size={14} /> Prev</button>
                    {Array.from({ length: 10 }).map((_, idx) => {
                      const page = idx + 1;
                      const active = page === trendingPage;
                      return (
                        <button
                          key={page}
                          type="button"
                          onClick={() => setTrendingPage(page)}
                          className={`min-w-8 rounded-lg px-2 py-1 text-xs transition-colors ${active ? "bg-accent text-white" : "bg-bg-raised text-text-muted hover:text-text-primary"}`}
                        >
                          {page}
                        </button>
                      );
                    })}
                    <button type="button" onClick={() => setTrendingPage((p) => Math.min(10, p + 1))} disabled={trendingPage === 10} className="inline-flex h-8 items-center gap-1 rounded-lg bg-bg-raised px-2 text-xs text-text-muted hover:text-text-primary disabled:opacity-40">Next <ChevronRight size={14} /></button>
                  </div>
                </>
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