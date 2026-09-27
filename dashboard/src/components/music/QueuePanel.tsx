import { Play, Trash2 } from "lucide-react";
import { usePlayer, currentTrack } from "../music/usePlayer";
import { MusicTrack } from "../../api";
import { Button } from "../ui";

interface QueuePanelProps {
  tracks: MusicTrack[];
  /** Called when the user asks to remove a track from the queue. */
  onRemove?: (trackId: string) => void;
}

/**
 * Simple text list with play/remove. Sort/reorder lives on the playlist
 * detail page; the queue itself is a flat index the store walks linearly.
 */
export function QueuePanel({ tracks, onRemove }: QueuePanelProps) {
  const setQueue = usePlayer((s) => s.setQueue);
  const currentIndex = usePlayer((s) => s.currentIndex);
  const track = usePlayer((s) => currentTrack(s));

  if (!tracks.length) {
    return <p className="text-xs text-text-muted">Queue is empty.</p>;
  }

  return (
    <ol className="divide-y divide-border/60">
      {tracks.map((t, index) => {
        const active = track?.id === t.id && currentIndex === index;
        return (
          <li key={`${t.id}-${index}`} className={`flex items-center gap-3 px-2 py-2 ${active ? "bg-accent/10" : ""}`}>
            <span className="w-6 text-right text-xs tabular-nums text-text-muted">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t.title}</p>
              <p className="truncate text-xs text-text-muted">{t.artist ?? "Unknown artist"}</p>
            </div>
            <Button size="icon" variant="ghost" onClick={() => setQueue(tracks, index)} aria-label={`Play ${t.title}`}>
              <Play size={14} />
            </Button>
            {onRemove && (
              <Button size="icon" variant="ghost" onClick={() => onRemove(t.id)} aria-label={`Remove ${t.title}`}>
                <Trash2 size={14} />
              </Button>
            )}
          </li>
        );
      })}
    </ol>
  );
}