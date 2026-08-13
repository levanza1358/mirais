import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Search,
  Music as MusicIcon,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Heart,
  X,
  ListMusic,
  Disc3,
  GripVertical,
  Shuffle,
} from "lucide-react";
import { music as musicApi, type MusicSearchResult } from "../api";
import { Card, Input, Skeleton, Badge, Button } from "../components/ui";
import { trackFromSearch, useMusicPlayer, type MusicTrack } from "../hooks/useMusicPlayer";

function fmtTime(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const RESULTS_PER_PAGE = 20;
const MAX_RESULTS_PAGE = 20;

export default function Music() {
  const qc = useQueryClient();
  const player = useMusicPlayer();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [trendingPage, setTrendingPage] = useState(1);
  const [searchPage, setSearchPage] = useState(1);
  const [playerHeight, setPlayerHeight] = useState(42);
  const splitDrag = useRef<number | null>(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setSearchPage(1);
  }, [debounced]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("mirais.music.player-height");
      if (saved) setPlayerHeight(Math.max(25, Math.min(75, Number(saved) || 42)));
    } catch {
      // Ignore unavailable local storage.
    }
  }, []);

  const onSplitPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    splitDrag.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onSplitPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (splitDrag.current !== event.pointerId) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.height <= 0) return;
    const nextHeight = Math.max(25, Math.min(75, ((event.clientY - bounds.top) / bounds.height) * 100));
    setPlayerHeight(nextHeight);
    try { window.localStorage.setItem("mirais.music.player-height", String(nextHeight)); } catch { /* ignore */ }
  };

  const onSplitPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (splitDrag.current !== event.pointerId) return;
    splitDrag.current = null;
    try { window.localStorage.setItem("mirais.music.player-height", String(playerHeight)); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (debounced) return;
    setTrendingPage(1);
  }, [debounced]);

  const searchQ = useQuery({
    queryKey: ["music-search", debounced, searchPage],
    queryFn: () => musicApi.search(debounced, RESULTS_PER_PAGE, searchPage),
    enabled: debounced.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    placeholderData: (prev) => prev,
  });

  const trendingQ = useQuery({
    queryKey: ["music-trending", trendingPage],
    queryFn: () => musicApi.trending(RESULTS_PER_PAGE, trendingPage, false),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

  // Bypass the server-side trending cache and force a fresh fetch. We
  // re-use the same TanStack query key so the UI updates in place.
  const refreshTrending = useCallback(async () => {
    if (trendingQ.isFetching) return;
    await qc.fetchQuery({
      queryKey: ["music-trending", trendingPage],
      queryFn: () => musicApi.trending(RESULTS_PER_PAGE, trendingPage, true),
      staleTime: 0,
      gcTime: 0,
    });
    // Mark the cached query as fresh so a plain refetch() afterwards
    // doesn't get treated as a no-op until the next stale window.
    await qc.invalidateQueries({ queryKey: ["music-trending"], refetchType: "none" });
  }, [qc, trendingPage, trendingQ.isFetching]);

  const activeList = useMemo(() => {
    const source = debounced ? (searchQ.data?.results ?? []) : (trendingQ.data?.results ?? []);
    // Filter out live performances, covers, remixes, and karaoke so the
    // feed stays focused on official audio / video uploads.
    return source.filter((item) => {
      const title = item.title.toLowerCase();
      return !/(live|cover|remix|karaoke|reaction)/i.test(title);
    });
  }, [debounced, searchQ.data?.results, trendingQ.data?.results]);

  useEffect(() => {
    if (!debounced) return;
    if ((searchQ.data?.results?.length ?? 0) < RESULTS_PER_PAGE) return;
    const nextPage = Math.min(MAX_RESULTS_PAGE, searchPage + 1);
    if (nextPage === searchPage) return;
    void qc.prefetchQuery({
      queryKey: ["music-search", debounced, nextPage],
      queryFn: () => musicApi.search(debounced, RESULTS_PER_PAGE, nextPage),
      staleTime: 5 * 60_000,
    });
  }, [debounced, qc, searchPage, searchQ.data?.results?.length]);

  const playTrack = (result: MusicSearchResult) => {
    const queue = activeList
      .map(trackFromSearch)
      .filter((track) => track.source_id !== result.id);
    player.play(trackFromSearch(result), queue);
  };

  const isCurrentTrack = (sourceId: string) => player.current?.source_id === sourceId;
  const playOrToggleTrack = (result: MusicSearchResult) => {
    if (isCurrentTrack(result.id)) {
      player.toggle();
      return;
    }
    playTrack(result);
  };

  const isFav = (sourceId: string) => player.favorites.some((f) => f.source_id === sourceId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 pb-2 lg:h-[calc(100dvh-3rem)]">
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-text-muted">Mirais dashboard</p>
          <h1 className="text-xl font-semibold tracking-tight">Music</h1>
        </div>
        <Badge tone="accent"><MusicIcon size={11} /> {player.favorites.length} favorites</Badge>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        {/* ── Left column: track list ───────────────────────────────── */}
        <Card className="flex min-h-0 min-w-0 flex-col p-2 sm:p-3">
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
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
              {debounced
                ? (searchQ.data ? `Page ${searchPage} · ${activeList.length} results via ${searchQ.data.source}${searchQ.isFetching ? " · refreshing" : ""}` : "Searching…")
                : (trendingQ.data ? `Trending now · ${activeList.length} tracks via ${trendingQ.data.source}` : "Loading trending…")}
            </p>
            <button
              type="button"
              onClick={() => void refreshTrending()}
              disabled={trendingQ.isFetching}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-bg-base/40 text-text-muted transition-colors hover:border-accent/40 hover:text-text-primary disabled:opacity-60"
              aria-label="Refresh trending feed"
              title={trendingQ.isFetching ? "Refreshing…" : "Refresh trending feed"}
            >
              <RefreshCw size={13} className={trendingQ.isFetching ? "animate-spin" : ""} />
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
                      <li key={r.id} className={`grid grid-cols-[1.25rem_4rem_minmax(0,1fr)] items-center gap-2 px-2 py-2 transition-colors sm:flex ${isCurrentTrack(r.id) ? "bg-accent/15 ring-1 ring-inset ring-accent/30" : "hover:bg-bg-raised/40"}`}>
                        <span className="w-5 shrink-0 text-center text-[11px] font-mono text-text-muted">{((searchPage - 1) * RESULTS_PER_PAGE) + i + 1}</span>
                        <button type="button" onClick={() => playOrToggleTrack(r)} className="shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-accent" aria-label={`${isCurrentTrack(r.id) && player.isPlaying ? "Pause" : "Play"} ${r.title}`}>
                          <img src={r.thumbnail_url ?? ""} alt="" className="h-10 w-16 rounded object-cover bg-bg-raised" loading="lazy" referrerPolicy="no-referrer" />
                        </button>
                        <button type="button" onClick={() => playOrToggleTrack(r)} className="min-w-0 flex-1 text-left focus:outline-none focus:ring-2 focus:ring-accent" aria-label={`${isCurrentTrack(r.id) && player.isPlaying ? "Pause" : "Play"} ${r.title}`}>
                          <p className="truncate text-sm">{r.title}</p>
                          <p className="truncate text-[11px] text-text-muted">{r.channel ?? "—"} · {fmtTime(r.duration_sec)}</p>
                        </button>
                        <div className="col-span-3 flex justify-end gap-1 sm:col-auto sm:ml-auto">
                          <Button size="sm" onClick={() => playOrToggleTrack(r)} title={isCurrentTrack(r.id) && player.isPlaying ? "Pause" : "Play"}>{isCurrentTrack(r.id) && player.isPlaying ? <Pause size={12} /> : <Play size={12} />}</Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => player.toggleFavorite(trackFromSearch(r))}
                            aria-pressed={isFav(r.id)}
                            title={isFav(r.id) ? "Remove from favorites" : "Add to favorites"}
                          >
                            <Heart size={12} className={isFav(r.id) ? "text-danger" : ""} fill={isFav(r.id) ? "currentColor" : "none"} />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <ResultsPager page={searchPage} onPageChange={setSearchPage} />
                </>
              )
            ) : trendingQ.isLoading ? (
              <div className="space-y-1 p-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : activeList.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-text-muted">Trending feed is empty. Try searching above.</p>
            ) : (
              <>
                <ul className="divide-y divide-border/60">
                  {activeList.map((r, i) => (
                    <li key={r.id} className={`grid grid-cols-[1.25rem_4rem_minmax(0,1fr)] items-center gap-2 px-2 py-2 transition-colors sm:flex ${isCurrentTrack(r.id) ? "bg-accent/15 ring-1 ring-inset ring-accent/30" : "hover:bg-bg-raised/40"}`}>
                      <span className="w-5 shrink-0 text-center text-[11px] font-mono text-text-muted">{((trendingPage - 1) * RESULTS_PER_PAGE) + i + 1}</span>
                      <button type="button" onClick={() => playOrToggleTrack(r)} className="shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-accent" aria-label={`${isCurrentTrack(r.id) && player.isPlaying ? "Pause" : "Play"} ${r.title}`}>
                        <img src={r.thumbnail_url ?? ""} alt="" className="h-10 w-16 rounded object-cover bg-bg-raised" loading="lazy" referrerPolicy="no-referrer" />
                      </button>
                      <button type="button" onClick={() => playOrToggleTrack(r)} className="min-w-0 flex-1 text-left focus:outline-none focus:ring-2 focus:ring-accent" aria-label={`${isCurrentTrack(r.id) && player.isPlaying ? "Pause" : "Play"} ${r.title}`}>
                        <p className="truncate text-sm">{r.title}</p>
                        <p className="truncate text-[11px] text-text-muted">{r.channel ?? "—"} · {fmtTime(r.duration_sec)}</p>
                      </button>
                      <div className="col-span-3 flex justify-end gap-1 sm:col-auto sm:ml-auto">
                        <Button size="sm" onClick={() => playOrToggleTrack(r)} title={isCurrentTrack(r.id) && player.isPlaying ? "Pause" : "Play"}>{isCurrentTrack(r.id) && player.isPlaying ? <Pause size={12} /> : <Play size={12} />}</Button>
                        <Button size="sm" variant="ghost" onClick={() => player.playNext(trackFromSearch(r))} title="Play next"><SkipForward size={12} /></Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => player.toggleFavorite(trackFromSearch(r))}
                          aria-pressed={isFav(r.id)}
                          title={isFav(r.id) ? "Remove from favorites" : "Add to favorites"}
                        >
                          <Heart size={12} className={isFav(r.id) ? "text-danger" : ""} fill={isFav(r.id) ? "currentColor" : "none"} />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
                <ResultsPager page={trendingPage} onPageChange={setTrendingPage} />
              </>
            )}
          </div>
        </Card>

        {/* ── Right column: video player (top) + favorites (bottom) ── */}
        <div
          className="grid min-h-0 overflow-hidden"
          style={{ gridTemplateRows: `${playerHeight}fr 10px ${100 - playerHeight}fr` }}
        >
          <InlinePlayer
            track={player.current}
            isPlaying={player.isPlaying}
            isBuffering={player.isBuffering}
            currentTime={player.currentTime}
            duration={player.duration}
            historyLength={player.history.length}
            queueLength={player.queue.length}
            onToggle={player.toggle}
            onNext={player.next}
            onPrevious={player.previous}
            onSeek={player.seek}
            onClear={player.clear}
            onToggleShuffle={player.toggleShuffle}
            isShuffle={player.shuffle}
            onToggleFavorite={() => player.current && player.toggleFavorite(player.current)}
            isFavorite={!!player.current && isFav(player.current.source_id)}
          />

          <div
            role="separator"
            aria-label="Resize video player and favorites"
            aria-orientation="horizontal"
            onPointerDown={onSplitPointerDown}
            onPointerMove={onSplitPointerMove}
            onPointerUp={onSplitPointerUp}
            onPointerCancel={onSplitPointerUp}
            className="group relative z-10 flex cursor-row-resize items-center justify-center touch-none"
          >
            <span className="h-1 w-16 rounded-full bg-border transition-colors group-hover:bg-accent" />
          </div>

          <Card className="flex min-h-0 flex-col overflow-hidden p-2 sm:p-3">
            <div className="mb-2 flex shrink-0 items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Heart size={14} className="text-danger" fill="currentColor" />
                Favorites
              </h2>
              <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                {player.favorites.length} saved
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-bg-base/40">
              {player.favorites.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-text-muted">
                  No favorites yet — tap the heart on any track.
                </p>
              ) : (
                <FavoritesList
                  items={player.favorites}
                  onPlay={(item) => player.replayTrack(item)}
                  onPlayNext={(item) => player.playNext(item)}
                  onRemove={(item) => player.toggleFavorite(item)}
                  onReorder={(from, to) => player.reorderFavorites(from, to)}
                  currentSourceId={player.current?.source_id}
                  isPlaying={player.isPlaying}
                  onToggleCurrent={player.toggle}
                />
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FavoritesList({
  items,
  onPlay,
  onPlayNext,
  onRemove,
  onReorder,
  currentSourceId,
  isPlaying,
  onToggleCurrent,
}: {
  items: MusicTrack[];
  onPlay: (item: MusicTrack) => void;
  onPlayNext: (item: MusicTrack) => void;
  onRemove: (item: MusicTrack) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  currentSourceId?: string;
  isPlaying: boolean;
  onToggleCurrent: () => void;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  return (
    <ul className="divide-y divide-border/60">
      {items.map((item, index) => {
        const isDragging = draggingIndex === index;
        const isDragOver = dragOverIndex === index && draggingIndex !== null && draggingIndex !== index;
        return (
          <li
            key={`${item.source_id}-fav-${index}`}
            draggable
            onDragStart={(e) => {
              setDraggingIndex(index);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(index));
            }}
            onDragOver={(e) => {
              if (draggingIndex === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverIndex !== index) setDragOverIndex(index);
            }}
            onDragLeave={() => {
              if (dragOverIndex === index) setDragOverIndex(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const raw = e.dataTransfer.getData("text/plain");
              const from = Number(raw);
              if (Number.isInteger(from) && from !== index) {
                onReorder(from, index);
              }
              setDraggingIndex(null);
              setDragOverIndex(null);
            }}
            onDragEnd={() => {
              setDraggingIndex(null);
              setDragOverIndex(null);
            }}
            className={`flex items-center gap-2 px-2 py-2 transition-colors ${
              isDragging ? "opacity-40" : ""
            } ${isDragOver || item.source_id === currentSourceId ? "bg-accent/15 ring-1 ring-inset ring-accent/30" : "hover:bg-bg-raised/40"}`}
          >
            <button
              type="button"
              draggable
              onDragStart={(e) => e.stopPropagation()}
              aria-label="Drag to reorder"
              title="Drag to reorder"
              className="flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary active:cursor-grabbing"
            >
              <GripVertical size={12} />
            </button>
            <button type="button" onClick={() => item.source_id === currentSourceId ? onToggleCurrent() : onPlay(item)} className="shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-accent" aria-label={`${item.source_id === currentSourceId && isPlaying ? "Pause" : "Play"} ${item.title}`}>
              {item.thumbnail_url ? (
                <img src={item.thumbnail_url} alt="" className="h-10 w-16 rounded object-cover bg-bg-raised" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="h-10 w-16 rounded bg-bg-raised" />
              )}
            </button>
            <button type="button" onClick={() => item.source_id === currentSourceId ? onToggleCurrent() : onPlay(item)} className="min-w-0 flex-1 text-left focus:outline-none focus:ring-2 focus:ring-accent" aria-label={`${item.source_id === currentSourceId && isPlaying ? "Pause" : "Play"} ${item.title}`}>
              <p className="truncate text-sm">{item.title}</p>
              <p className="truncate text-[11px] text-text-muted">{item.channel ?? "—"} · {fmtTime(item.duration_sec)}</p>
            </button>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" onClick={() => item.source_id === currentSourceId ? onToggleCurrent() : onPlay(item)} title={item.source_id === currentSourceId && isPlaying ? "Pause" : "Play"}>{item.source_id === currentSourceId && isPlaying ? <Pause size={12} /> : <Play size={12} />}</Button>
              <Button size="sm" variant="ghost" onClick={() => onPlayNext(item)} title="Play next"><SkipForward size={12} /></Button>
              <Button size="sm" variant="ghost" onClick={() => onRemove(item)} aria-label="Remove from favorites" title="Remove">
                <X size={12} />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ResultsPager({ page, onPageChange }: { page: number; onPageChange: (page: number) => void }) {
  const pages = Array.from(
    { length: Math.min(5, MAX_RESULTS_PAGE) },
    (_, index) => Math.min(MAX_RESULTS_PAGE - 4, Math.max(1, page - 2)) + index,
  );

  return (
    <div className="flex items-center justify-between gap-2 border-t border-border/60 px-2 py-2">
      <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page === 1} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-bg-raised px-2 text-xs text-text-muted hover:text-text-primary disabled:opacity-40" aria-label="Previous results page"><ChevronLeft size={14} /><span className="hidden sm:inline">Prev</span></button>
      <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden">
        {pages.map((item) => (
          <button key={item} type="button" onClick={() => onPageChange(item)} className={`h-8 min-w-8 shrink-0 rounded-lg px-2 text-xs transition-colors ${item === page ? "bg-accent text-white" : "bg-bg-raised text-text-muted hover:text-text-primary"}`}>{item}</button>
        ))}
      </div>
      <button type="button" onClick={() => onPageChange(Math.min(MAX_RESULTS_PAGE, page + 1))} disabled={page === MAX_RESULTS_PAGE} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-bg-raised px-2 text-xs text-text-muted hover:text-text-primary disabled:opacity-40" aria-label="Next results page"><span className="hidden sm:inline">Next</span><ChevronRight size={14} /></button>
    </div>
  );
}

function InlinePlayer({
  track,
  isPlaying,
  isBuffering,
  currentTime,
  duration,
  historyLength,
  queueLength,
  onToggle,
  onNext,
  onPrevious,
  onSeek,
  onClear,
  onToggleShuffle,
  isShuffle,
  onToggleFavorite,
  isFavorite,
}: {
  track: MusicTrack | null;
  isPlaying: boolean;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  historyLength: number;
  queueLength: number;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (t: number) => void;
  onClear: () => void;
  onToggleShuffle: () => void;
  isShuffle: boolean;
  onToggleFavorite: () => void;
  isFavorite: boolean;
}) {
  const videoFrame = useRef<HTMLVideoElement>(null);
  const lastSyncedVideoTime = useRef<number | null>(null);
  const effectiveDuration = duration || track?.duration_sec || 0;

  const sendVideoCommand = useCallback((func: "playVideo" | "pauseVideo" | "seekTo", args: (number | boolean)[] = []) => {
    const video = videoFrame.current;
    if (!video) return;
    if (func === "playVideo") void video.play().catch(() => undefined);
    if (func === "pauseVideo") video.pause();
    if (func === "seekTo" && args[0] !== undefined && Math.abs(video.currentTime - Number(args[0])) >= 0.5) video.currentTime = Number(args[0]);
  }, []);

  useEffect(() => {
    if (!track) return;
    sendVideoCommand(isPlaying ? "playVideo" : "pauseVideo");
  }, [isPlaying, sendVideoCommand, track]);

  useEffect(() => {
    if (!track || Math.abs((lastSyncedVideoTime.current ?? currentTime) - currentTime) < 2) return;
    lastSyncedVideoTime.current = currentTime;
    sendVideoCommand("seekTo", [currentTime, true]);
  }, [currentTime, sendVideoCommand, track]);

  const synchronizeVideo = () => {
    if (!track) return;
    lastSyncedVideoTime.current = currentTime;
    sendVideoCommand("seekTo", [currentTime, true]);
    sendVideoCommand(isPlaying ? "playVideo" : "pauseVideo");
  };

  return (
    <Card className="flex min-h-0 flex-col overflow-y-auto p-2 sm:p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Disc3 size={14} className="text-accent" />
          Video player
        </h2>
        <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
          {isBuffering ? "buffering" : isPlaying ? "playing" : track ? "paused" : "idle"}
        </span>
      </div>
      {!track ? (
        <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-border/70 bg-bg-base/40 text-xs text-text-muted">
          <div className="flex flex-col items-center gap-1">
            <Disc3 size={28} className="opacity-50" />
            <span>Pick a track on the left to start playing.</span>
          </div>
        </div>
      ) : (
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-bg-base/60 lg:aspect-[16/7]">
          {track ? (
            <video
              key={track.source_id}
              ref={videoFrame}
              src={musicApi.videoStreamUrl(track.source_id)}
              className="pointer-events-none h-full w-full border-0"
              muted
              playsInline
              preload="auto"
              onLoad={synchronizeVideo}
              onCanPlay={synchronizeVideo}
            />
          ) : null}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3">
            <p className="truncate text-sm font-medium text-white">{track.title}</p>
            <p className="truncate text-[11px] text-white/80">{track.channel ?? "—"}</p>
          </div>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="w-9 shrink-0 text-[10px] text-text-muted md:text-[11px]">{fmtTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(effectiveDuration, 1)}
          step={1}
          value={Math.min(currentTime, Math.max(effectiveDuration, 1))}
          onChange={(e) => onSeek(Number(e.currentTarget.value))}
          disabled={!track || effectiveDuration <= 0}
          aria-label="Seek playback"
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-raised accent-accent disabled:cursor-not-allowed disabled:opacity-40"
        />
        <span className="w-9 shrink-0 text-right text-[10px] text-text-muted md:text-[11px]">{fmtTime(effectiveDuration)}</span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={onPrevious} disabled={historyLength === 0} aria-label="Previous" title="Previous">
            <SkipBack size={13} />
          </Button>
          <Button size="sm" onClick={onToggle} disabled={!track} aria-label={isPlaying ? "Pause" : "Play"} title={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </Button>
          <Button size="sm" variant="outline" onClick={onNext} disabled={queueLength === 0} aria-label="Next" title="Next">
            <SkipForward size={13} />
          </Button>
          <Button
            size="sm"
            variant={isShuffle ? "outline" : "ghost"}
            onClick={onToggleShuffle}
            aria-pressed={isShuffle}
            aria-label={isShuffle ? "Disable shuffle" : "Enable shuffle"}
            title={isShuffle ? "Shuffle on" : "Shuffle off"}
            className={isShuffle ? "border-accent/60 bg-accent/15 text-accent" : undefined}
          >
            <Shuffle size={13} />
          </Button>
          <Button
            size="sm"
            variant={isFavorite ? "outline" : "ghost"}
            onClick={onToggleFavorite}
            disabled={!track}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Heart size={13} className={isFavorite ? "text-danger" : ""} fill={isFavorite ? "currentColor" : "none"} />
          </Button>
        </div>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={!track} aria-label="Stop" title="Stop">
          <X size={13} />
        </Button>
      </div>
      {queueLength > 0 ? (
        <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-text-muted">
          <ListMusic size={10} className="mr-0.5 inline-block align-middle" /> {queueLength} in queue
        </p>
      ) : null}
    </Card>
  );
}