import { Play, Pause, SkipForward, SkipBack, X, Volume2, VolumeX, ChevronUp, ChevronDown, Disc3, ListMusic, Repeat, Repeat1, Shuffle, Trash2, Heart } from "lucide-react";
import { useMusicPlayer } from "../hooks/useMusicPlayer";

function fmtTime(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Persists across route changes — sits above the page content in a fixed
 * strip at the bottom of the viewport. Stays hidden when there's no track
 * (so it doesn't take space on cold open).
 */
export default function MusicMiniPlayer() {
  const player = useMusicPlayer();
  if (!player.current && !player.visible) return null;

  const track = player.current;
  const duration = player.duration || track?.duration_sec || 0;

  if (!player.visible && track) {
    return (
      <button
        type="button"
        onClick={player.show}
        className="fixed bottom-16 right-3 z-[150] flex max-w-[220px] items-center gap-2 rounded-full border border-border/80 bg-bg-surface/95 px-3 py-2 text-left shadow-[0_18px_44px_rgba(0,0,0,0.42)] backdrop-blur-xl md:bottom-3"
        aria-label="Show music player"
      >
        <span className={`flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 text-accent ${player.isPlaying ? "animate-[spin_4s_linear_infinite]" : ""}`}>
          <Disc3 size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-text-primary">{track.title}</span>
          <span className="block truncate text-[10px] text-text-muted">{track.channel ?? "Now playing"}</span>
        </span>
        <span className="rounded-full bg-bg-raised/70 px-2 py-1 text-[10px] text-text-muted">{player.queue.length}</span>
      </button>
    );
  }

  return (
    <div
      role="region"
      aria-label="Music player"
      className={`fixed inset-x-3 z-[150] rounded-2xl border border-border/80 bg-bg-surface/95 backdrop-blur-xl shadow-[0_18px_44px_rgba(0,0,0,0.42)] transition-all ${player.visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0 pointer-events-none"} bottom-16 md:bottom-3`}
    >
      <div className="flex items-center gap-2 px-2.5 py-2 md:gap-3 md:px-3 md:py-2.5">
        {track?.thumbnail_url ? (
          <img
            src={track.thumbnail_url}
            alt=""
            className="h-9 w-9 shrink-0 rounded-lg object-cover md:h-10 md:w-10"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="h-9 w-9 shrink-0 rounded-lg bg-bg-raised md:h-10 md:w-10" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-tight md:text-sm">{track?.title ?? "Nothing playing"}</p>
          <p className="truncate text-[10px] text-text-muted md:text-[11px]">
            {track?.channel ?? "—"} · {fmtTime(track?.duration_sec)}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="w-9 shrink-0 text-[10px] text-text-muted md:text-[11px]">{fmtTime(player.currentTime)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 1)}
              step={1}
              value={Math.min(player.currentTime, Math.max(duration, 1))}
              onChange={(e) => player.seek(Number(e.currentTarget.value))}
              disabled={!track || duration <= 0}
              aria-label="Seek playback"
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-raised accent-accent disabled:cursor-not-allowed disabled:opacity-40"
            />
            <span className="w-9 shrink-0 text-right text-[10px] text-text-muted md:text-[11px]">{fmtTime(duration)}</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 md:gap-1">
          <button
            type="button"
            onClick={player.previous}
            disabled={player.history.length === 0}
            className="hidden h-8 w-8 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary disabled:opacity-40 md:flex md:h-9 md:w-9"
            aria-label="Previous track"
          >
            <SkipBack size={14} />
          </button>
          <button
            type="button"
            onClick={player.toggle}
            disabled={!track}
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent transition-colors hover:bg-accent/25 disabled:opacity-40 md:h-9 md:w-9"
            aria-label={player.isPlaying ? "Pause" : "Play"}
          >
            {player.isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            type="button"
            onClick={player.next}
            disabled={player.queue.length === 0}
            className="hidden h-8 w-8 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary disabled:opacity-40 md:flex md:h-9 md:w-9"
            aria-label="Next track"
            title={player.queue.length ? `Up next: ${player.queue[0]?.title}` : "Queue empty"}
          >
            <SkipForward size={14} />
          </button>
          <button
            type="button"
            onClick={player.toggleQueue}
            className="hidden h-8 w-8 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary md:flex md:h-9 md:w-9"
            aria-label="Show queue"
            title={player.queue.length ? `Queue (${player.queue.length})` : "Queue empty"}
          >
            <ListMusic size={14} />
          </button>
          <button
            type="button"
            onClick={player.toggleShuffle}
            className={`hidden h-8 w-8 items-center justify-center rounded-xl transition-colors md:flex md:h-9 md:w-9 ${player.shuffle ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-bg-raised hover:text-text-primary"}`}
            aria-label="Toggle shuffle"
          >
            <Shuffle size={14} />
          </button>
          <button
            type="button"
            onClick={player.cycleRepeatMode}
            className={`hidden h-8 w-8 items-center justify-center rounded-xl transition-colors md:flex md:h-9 md:w-9 ${player.repeatMode !== "off" ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-bg-raised hover:text-text-primary"}`}
            aria-label="Cycle repeat mode"
          >
            {player.repeatMode === "one" ? <Repeat1 size={14} /> : <Repeat size={14} />}
          </button>
          <button
            type="button"
            onClick={() => track && player.toggleFavorite(track)}
            className={`hidden h-8 w-8 items-center justify-center rounded-xl transition-colors md:flex md:h-9 md:w-9 ${track && player.favorites.some((item) => item.source_id === track.source_id) ? "bg-danger/15 text-danger" : "text-text-muted hover:bg-bg-raised hover:text-text-primary"}`}
            aria-label="Toggle favorite"
          >
            <Heart size={14} fill={track && player.favorites.some((item) => item.source_id === track.source_id) ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            onClick={player.toggleVisible}
            className="hidden h-8 w-8 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary md:flex md:h-9 md:w-9"
            aria-label={player.visible ? "Hide player" : "Show player"}
          >
            {player.visible ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          <button
            type="button"
            onClick={player.clear}
            disabled={!track}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary disabled:opacity-40 md:h-9 md:w-9"
            aria-label="Stop and clear"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="hidden items-center gap-2 px-3 pb-2 text-[10px] uppercase tracking-[0.18em] text-text-muted md:flex">
        <button type="button" onClick={player.toggleMute} className="inline-flex items-center gap-1 text-text-muted hover:text-text-primary">
          {player.muted || player.volume === 0 ? <VolumeX size={11} /> : <Volume2 size={11} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={player.muted ? 0 : player.volume}
          onChange={(e) => player.setVolume(Number(e.currentTarget.value))}
          className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-bg-raised accent-accent"
          aria-label="Volume"
        />
        <span>{player.isBuffering ? "buffering" : player.queue.length ? `${player.queue.length} in queue` : "queue"}</span>
      </div>
      {player.showQueue ? (
        <div className="border-t border-border/60 px-3 py-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-text-primary">Up next</p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={player.clearQueue} className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"><Trash2 size={12} /> Clear</button>
              <button type="button" onClick={player.closeQueue} className="text-[11px] text-text-muted hover:text-text-primary">Close</button>
            </div>
          </div>
          {player.queue.length === 0 ? (
            <p className="text-xs text-text-muted">Queue kosong.</p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {player.queue.map((item, index) => (
                <li key={`${item.source_id}-${index}`} className="flex items-center gap-2 rounded-xl bg-bg-base/50 px-2 py-2">
                  {item.thumbnail_url ? (
                    <img src={item.thumbnail_url} alt="" className="h-9 w-9 rounded-lg object-cover" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="h-9 w-9 rounded-lg bg-bg-raised" />
                  )}
                  <button type="button" onClick={() => player.jumpToQueue(index)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-xs text-text-primary">{item.title}</p>
                    <p className="truncate text-[10px] text-text-muted">{item.channel ?? "—"} · {fmtTime(item.duration_sec)}</p>
                  </button>
                  <button type="button" onClick={() => player.removeFromQueue(index)} className="rounded-lg p-1 text-text-muted hover:bg-bg-raised hover:text-danger" aria-label="Remove from queue">
                    <X size={12} />
                  </button>
                  <span className="text-[10px] text-text-muted">#{index + 1}</span>
                </li>
              ))}
            </ul>
          )}
          {player.recentlyPlayed.length ? (
            <div className="mt-3 border-t border-border/60 pt-3">
              <p className="mb-2 text-xs font-semibold text-text-primary">Recently played</p>
              <ul className="max-h-32 space-y-1 overflow-y-auto pr-1">
                {player.recentlyPlayed.map((item, index) => (
                  <li key={`${item.source_id}-recent-${index}`} className="flex items-center gap-2 rounded-xl bg-bg-base/40 px-2 py-2">
                    <button type="button" onClick={() => player.replayTrack(item)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-xs text-text-primary">{item.title}</p>
                      <p className="truncate text-[10px] text-text-muted">{item.channel ?? "—"}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {player.favorites.length ? (
            <div className="mt-3 border-t border-border/60 pt-3">
              <p className="mb-2 text-xs font-semibold text-text-primary">Favorites</p>
              <ul className="max-h-32 space-y-1 overflow-y-auto pr-1">
                {player.favorites.map((item, index) => (
                  <li key={`${item.source_id}-fav-${index}`} className="flex items-center gap-2 rounded-xl bg-bg-base/40 px-2 py-2">
                    <button type="button" onClick={() => player.replayTrack(item)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-xs text-text-primary">{item.title}</p>
                      <p className="truncate text-[10px] text-text-muted">{item.channel ?? "—"}</p>
                    </button>
                    <Heart size={12} className="text-danger" fill="currentColor" />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}