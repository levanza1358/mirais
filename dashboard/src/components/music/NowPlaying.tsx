import { useEffect, useState } from "react";
import { Play, Pause, SkipForward, SkipBack, Shuffle, Repeat, Music2, Volume2 } from "lucide-react";
import { usePlayer, currentTrack } from "../music/usePlayer";
import { formatDuration } from "../music/format";
import { Button } from "../ui";
import { QueuePanel } from "./QueuePanel";

/**
 * Full-screen Now Playing surface. Uses `rAF` to update the slider so the
 * parent React tree doesn't re-render on every `timeupdate` (the pattern the
 * Metrolist mini-player uses for its progress bar).
 */
export function NowPlaying() {
  const track = usePlayer((s) => currentTrack(s));
  const queue = usePlayer((s) => s.queue);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const volume = usePlayer((s) => s.volume);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const seek = usePlayer((s) => s.seek);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  const cycleRepeat = usePlayer((s) => s.cycleRepeat);

  // Slider is driven by rAF reading the store, not by re-rendering on
  // `positionMs`. The store still publishes position for the rest of the UI.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setElapsedMs(usePlayer.getState().positionMs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!track) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <Music2 size={40} className="text-text-muted" />
        <p className="text-sm text-text-muted">Pick a track to start listening.</p>
      </div>
    );
  }

  const total = durationMs || (track.duration_sec ?? 0) * 1000 || 0;
  const pct = total > 0 ? Math.min(100, (elapsedMs / total) * 100) : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col items-center gap-6">
        <div className="flex aspect-square w-full max-w-sm items-center justify-center overflow-hidden rounded-xl border border-border bg-bg-raised">
          {track.thumbnail_url ? (
            <img src={track.thumbnail_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <Music2 size={64} className="text-text-muted" />
          )}
        </div>
        <div className="text-center">
          <h2 className="text-xl font-semibold">{track.title}</h2>
          <p className="text-sm text-text-muted">{track.artist ?? "Unknown artist"}{track.album ? ` · ${track.album}` : ""}</p>
        </div>

        <div className="w-full">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-border">
            <div className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
            <input
              type="range"
              min={0}
              max={Math.max(1, total)}
              value={Math.min(elapsedMs, total)}
              onChange={(event) => seek(Number(event.target.value))}
              className="absolute inset-0 h-1.5 w-full cursor-pointer appearance-none bg-transparent opacity-0"
              aria-label="Seek"
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-text-muted">
            <span>{formatDuration(elapsedMs / 1000)}</span>
            <span>{formatDuration(total / 1000)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="icon" variant={shuffle ? "primary" : "ghost"} onClick={() => toggleShuffle()} aria-label="Toggle shuffle">
            <Shuffle size={16} />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => prev()} aria-label="Previous">
            <SkipBack size={18} />
          </Button>
          <Button size="icon" onClick={() => toggle()} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => next()} aria-label="Next">
            <SkipForward size={18} />
          </Button>
          <Button size="icon" variant={repeat !== "off" ? "primary" : "ghost"} onClick={() => cycleRepeat()} aria-label="Cycle repeat mode">
            <Repeat size={16} />
          </Button>
        </div>

        <div className="flex w-full max-w-sm items-center gap-2 text-text-muted">
          <Volume2 size={14} />
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(event) => setVolume(Number(event.target.value) / 100)}
            className="flex-1 accent-accent"
            aria-label="Volume"
          />
        </div>
      </div>

      <aside className="rounded-lg border border-border bg-bg-surface/60 p-4">
        <h3 className="mb-2 text-sm font-medium">Queue</h3>
        <QueuePanel tracks={queue} />
      </aside>
    </div>
  );
}