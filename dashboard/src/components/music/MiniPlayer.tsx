import { useNavigate } from "react-router-dom";
import { Play, Pause, SkipForward, SkipBack, Music2 } from "lucide-react";
import { usePlayer, currentTrack } from "../music/usePlayer";
import { Button } from "../ui";

/**
 * Sticky bottom bar shown whenever a track is loaded. Tap the artwork/title
 * area to open the full Now Playing screen; the controls interact with the
 * single shared audio element via the player store.
 */
export function MiniPlayer() {
  const navigate = useNavigate();
  const track = usePlayer((s) => currentTrack(s));
  const isPlaying = usePlayer((s) => s.isPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);

  if (!track) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
        <button
          type="button"
          onClick={() => navigate("/dashboard/music/now-playing")}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-label="Open now playing"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-bg-raised text-text-muted">
            {track.thumbnail_url ? (
              <img src={track.thumbnail_url} alt="" className="h-10 w-10 rounded-md object-cover" />
            ) : (
              <Music2 size={16} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text-primary">{track.title}</p>
            <p className="truncate text-xs text-text-muted">{track.artist ?? "Unknown artist"}</p>
          </div>
        </button>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={() => prev()} aria-label="Previous track">
            <SkipBack size={16} />
          </Button>
          <Button
            size="icon"
            onClick={() => toggle()}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => next()} aria-label="Next track">
            <SkipForward size={16} />
          </Button>
        </div>
      </div>
    </div>
  );
}