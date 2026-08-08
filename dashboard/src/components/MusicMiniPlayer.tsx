import { Play, Pause, SkipForward, SkipBack, X, Volume2, VolumeX, ChevronDown, Disc3, ListMusic, Repeat, Repeat1, Shuffle, Trash2, Heart, AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useMusicPlayer } from "../hooks/useMusicPlayer";

function fmtTime(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Music player surface. Three presentation states:
 *  - "hidden": no track loaded yet
 *  - "dock": floating compact pill above the page chrome (mobile + desktop)
 *  - "player": full bar/panel with transport, queue, and metadata
 *
 * The dock and the full player share the same audio context — they only
 * differ in visual chrome, so playback never gets interrupted when the user
 * switches between them.
 */
export default function MusicMiniPlayer() {
  const player = useMusicPlayer();
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 767px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  if (!player.current && player.presentation === "hidden") return null;
  const track = player.current;
  if (!track) return null;
  const duration = player.duration || track.duration_sec || 0;

  // Dock: floating compact pill above the dashboard chrome. Tap to expand.
  if (player.presentation === "dock") {
    return (
      <button
        type="button"
        onClick={player.show}
        className="fixed right-3 bottom-20 z-[150] flex max-w-[260px] items-center gap-2 rounded-full border border-border/80 bg-bg-surface/95 px-3 py-2 text-left shadow-[0_18px_44px_rgba(0,0,0,0.42)] backdrop-blur-xl md:bottom-3"
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
      className="fixed inset-x-3 z-[150] flex max-h-[calc(100dvh-7.5rem)] flex-col overflow-hidden rounded-2xl border border-border/80 bg-bg-surface/95 backdrop-blur-xl shadow-[0_18px_44px_rgba(0,0,0,0.42)] transition-all bottom-20 p-2 md:bottom-3 md:p-3"
    >
      {player.error ? (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{player.error}</span>
          <button type="button" onClick={player.dismissError} className="shrink-0 rounded-md p-1 text-danger/80 hover:bg-danger/15" aria-label="Dismiss error">
            <X size={12} />
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2 md:gap-3">
        {track.thumbnail_url ? (
          <img
            src={track.thumbnail_url}
            alt=""
            className="h-10 w-10 shrink-0 rounded-lg object-cover md:h-11 md:w-11"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-lg bg-bg-raised md:h-11 md:w-11" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-tight md:text-sm">{track.title}</p>
          <p className="truncate text-[10px] text-text-muted md:text-[11px]">
            {track.channel ?? "—"} · {fmtTime(track.duration_sec)}
            {player.isBuffering && !player.isPlaying ? " · tap play to resume" : player.isBuffering ? " · buffering" : ""}
          </p>
        </div>
        <div className="flex items-center gap-0.5 md:gap-1">
          {isMobile ? (
            <>
              <button type="button" onClick={player.previous} disabled={player.history.length === 0} className="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary disabled:opacity-40" aria-label="Previous track">
                <SkipBack size={15} />
              </button>
              <button type="button" onClick={player.toggle} disabled={!track} className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-white shadow-[0_10px_22px_rgba(124,92,255,0.35)] transition-transform active:scale-95 disabled:opacity-40" aria-label={player.isPlaying ? "Pause" : "Play"}>
                {player.isPlaying ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button type="button" onClick={player.next} className="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary" aria-label="Next track">
                <SkipForward size={15} />
              </button>
              <button type="button" onClick={player.toggleQueue} aria-pressed={player.showQueue} className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${player.showQueue ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-bg-raised hover:text-text-primary"}`} aria-label="Toggle queue">
                <ListMusic size={15} />
              </button>
              <button type="button" onClick={player.hide} className="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary" aria-label="Minimize to dock">
                <ChevronDown size={15} />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={player.toggleShuffle} aria-pressed={player.shuffle} className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${player.shuffle ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-bg-raised hover:text-text-primary"}`} aria-label="Toggle shuffle">
                <Shuffle size={14} />
              </button>
              <button type="button" onClick={player.previous} disabled={player.history.length === 0} className="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary disabled:opacity-40" aria-label="Previous track">
                <SkipBack size={14} />
              </button>
              <button type="button" onClick={player.toggle} disabled={!track} className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-white shadow-[0_10px_22px_rgba(124,92,255,0.35)] transition-transform active:scale-95 disabled:opacity-40" aria-label={player.isPlaying ? "Pause" : "Play"}>
                {player.isPlaying ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button type="button" onClick={player.next} className="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary" aria-label="Next track">
                <SkipForward size={14} />
              </button>
              <button type="button" onClick={player.cycleRepeatMode} aria-label="Cycle repeat mode" className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${player.repeatMode !== "off" ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-bg-raised hover:text-text-primary"}`}>
                {player.repeatMode === "one" ? <Repeat1 size={14} /> : <Repeat size={14} />}
              </button>
              <button type="button" onClick={player.toggleQueue} aria-pressed={player.showQueue} className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${player.showQueue ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-bg-raised hover:text-text-primary"}`} aria-label="Toggle queue">
                <ListMusic size={14} />
              </button>
              <button type="button" onClick={() => player.toggleFavorite(track)} disabled={!track} aria-pressed={player.favorites.some((fav) => fav.source_id === track.source_id)} className="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary disabled:opacity-40" aria-label="Favorite track">
                <Heart size={14} className={player.favorites.some((fav) => fav.source_id === track.source_id) ? "text-danger" : ""} fill={player.favorites.some((fav) => fav.source_id === track.source_id) ? "currentColor" : "none"} />
              </button>
              <button type="button" onClick={player.hide} className="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-raised hover:text-text-primary" aria-label="Minimize to dock">
                <ChevronDown size={14} />
              </button>
            </>
          )}
        </div>
      </div>

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

      <div className="mt-2 hidden items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-text-muted md:flex">
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
        <button type="button" onClick={player.clear} className="ml-auto inline-flex items-center gap-1 text-text-muted hover:text-danger" aria-label="Stop and clear">
          <X size={11} /> Stop
        </button>
        <span>{player.isBuffering ? "buffering" : player.queue.length ? `${player.queue.length} in queue` : "queue empty"}</span>
      </div>

      {isMobile ? (
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-text-muted">
          <button type="button" onClick={player.toggleShuffle} aria-pressed={player.shuffle} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${player.shuffle ? "bg-accent/20 text-accent" : "hover:text-text-primary"}`}>
            <Shuffle size={11} /> Shuffle
          </button>
          <button type="button" onClick={player.cycleRepeatMode} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${player.repeatMode !== "off" ? "bg-accent/20 text-accent" : "hover:text-text-primary"}`}>
            {player.repeatMode === "one" ? <Repeat1 size={11} /> : <Repeat size={11} />} {player.repeatMode === "off" ? "Off" : player.repeatMode === "one" ? "One" : "All"}
          </button>
          <button type="button" onClick={() => player.toggleFavorite(track)} aria-pressed={player.favorites.some((fav) => fav.source_id === track.source_id)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:text-text-primary">
            <Heart size={11} className={player.favorites.some((fav) => fav.source_id === track.source_id) ? "text-danger" : ""} fill={player.favorites.some((fav) => fav.source_id === track.source_id) ? "currentColor" : "none"} /> {player.favorites.some((fav) => fav.source_id === track.source_id) ? "Saved" : "Save"}
          </button>
          <button type="button" onClick={player.clear} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:text-danger">
            <X size={11} /> Stop
          </button>
        </div>
      ) : null}

      {player.showQueue ? (
        <div className="mt-2 min-h-0 flex-1 overflow-hidden border-t border-border/60 pt-3">
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
            <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
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
              <ul className="max-h-28 space-y-1 overflow-y-auto pr-1">
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
              <ul className="max-h-28 space-y-1 overflow-y-auto pr-1">
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