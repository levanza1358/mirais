import { useEffect } from "react";
import { usePlayer, currentTrack } from "./usePlayer";

/**
 * Mirror the player store into the browser Media Session API so OS-level
 * controls (lock screen, headset buttons, browser media keys) work.
 * Browser support is broad enough that we don't need feature detection
 * beyond `('mediaSession' in navigator)`; unsupported browsers silently
 * no-op.
 */
export function useMediaSession() {
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const toggle = usePlayer((s) => s.toggle);
  const seek = usePlayer((s) => s.seek);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const handlers: Record<string, () => void> = {
      play: () => toggle(),
      pause: () => toggle(),
      nexttrack: () => next(),
      previoustrack: () => prev(),
      seekbackward: () => {
        const cur = usePlayer.getState();
        seek(Math.max(0, cur.positionMs - 10_000));
      },
      seekforward: () => {
        const cur = usePlayer.getState();
        seek(Math.min(cur.durationMs || cur.positionMs + 10_000, cur.positionMs + 10_000));
      },
    };
    const supported: string[] = [];
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler);
        supported.push(action);
      } catch {
        /* unsupported on this browser */
      }
    }
    return () => {
      for (const action of supported) navigator.mediaSession.setActionHandler(action as MediaSessionAction, null);
    };
  }, [next, prev, toggle, seek]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    return usePlayer.subscribe((state) => {
      const track = currentTrack(state);
      navigator.mediaSession.metadata = track
        ? new MediaMetadata({
            title: track.title,
            artist: track.artist ?? "Unknown artist",
            album: track.album ?? undefined,
            artwork: track.thumbnail_url ? [{ src: track.thumbnail_url }] : undefined,
          })
        : null;
      navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
      if (Number.isFinite(state.durationMs) && state.durationMs > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration: state.durationMs / 1000,
            playbackRate: 1,
            position: state.positionMs / 1000,
          });
        } catch {
          /* some browsers reject while paused */
        }
      }
    });
  }, []);
}