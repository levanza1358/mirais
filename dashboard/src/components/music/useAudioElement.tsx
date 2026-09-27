import { useEffect } from "react";
import { usePlayer, currentTrack } from "./usePlayer";
import { MusicTrack } from "../../api";

/**
 * Bind the player store to a single `<audio>` element. The element is created
 * once at app root (Layout) and shared across pages so playback survives
 * navigation between Providers, Combos, etc.
 *
 * The store exposes `audio` so other components can play/pause/seek via the
 * store; this hook just forwards store state into the DOM element and back.
 */
export function useAudioElement() {
  const bind = usePlayer((s) => s.bindAudio);
  const setPosition = usePlayer((s) => s.setPosition);
  const onEnded = usePlayer((s) => s.onEnded);
  const setVolume = usePlayer((s) => s.setVolume);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.volume = 0.8;
    bind(audio);
    const onTime = () => setPosition(audio.currentTime * 1000, Number.isFinite(audio.duration) ? audio.duration * 1000 : undefined);
    const onLoaded = () => setPosition(audio.currentTime * 1000, audio.duration * 1000);
    const onVolume = () => setVolume(audio.volume);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("durationchange", onLoaded);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("volumechange", onVolume);
    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("durationchange", onLoaded);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("volumechange", onVolume);
      bind(null);
    };
  }, [bind, setPosition, onEnded, setVolume]);

  return null;
}

/** Convenience selector so the MiniPlayer / NowPlaying pages don't reach
 * into store internals. */
export function useCurrentTrack(): MusicTrack | null {
  return usePlayer((state) => {
    const track = currentTrack(state);
    return track ? { ...track, positionMs: state.positionMs, durationMs: state.durationMs } as unknown as MusicTrack : null;
  });
}