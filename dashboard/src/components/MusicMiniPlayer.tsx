import { Play, Pause, SkipForward, X, Volume2, ChevronUp, ChevronDown } from "lucide-react";
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
        </div>
        <div className="flex items-center gap-0.5 md:gap-1">
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
        <Volume2 size={11} />
        <span>{player.queue.length ? `${player.queue.length} in queue` : "queue"}</span>
      </div>
    </div>
  );
}