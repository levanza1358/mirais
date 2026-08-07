import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MusicSearchResult } from "../api";

export interface MusicTrack {
  id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  source_id: string;
}

interface PlayerState {
  /** Current playing track (or the one selected from search). null = nothing. */
  current: MusicTrack | null;
  /** Queue of upcoming tracks (linear). */
  queue: MusicTrack[];
  isPlaying: boolean;
  /** "expanded" controls the visible mini player height; "minimized" hides it. */
  visible: boolean;
}

interface PlayerControls {
  play: (track: MusicTrack, queue?: MusicTrack[]) => void;
  pause: () => void;
  resume: () => void;
  toggle: () => void;
  next: () => void;
  clear: () => void;
  show: () => void;
  hide: () => void;
  toggleVisible: () => void;
}

const PlayerContext = createContext<(PlayerState & PlayerControls) | null>(null);

export function MusicPlayerProvider({ children, streamUrlFor }: { children: ReactNode; streamUrlFor: (videoId: string) => string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<PlayerState>({ current: null, queue: [], isPlaying: false, visible: false });

  // Ensure a single audio element survives page changes.
  useEffect(() => {
    if (audioRef.current) return;
    const audio = new Audio();
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    audioRef.current = audio;
    audio.addEventListener("ended", () => {
      // Auto-advance through queue if available.
      setState((prev) => {
        if (!prev.current) return prev;
        const [head, ...tail] = prev.queue;
        if (!head) return { ...prev, current: null, isPlaying: false, queue: [] };
        if (audioRef.current) {
          audioRef.current.src = streamUrlFor(head.source_id);
          void audioRef.current.play().catch(() => undefined);
        }
        return { ...prev, current: head, queue: tail, isPlaying: true };
      });
    });
    return () => {
      audio.pause();
      audio.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = useCallback(
    (track: MusicTrack, queue?: MusicTrack[]) => {
      setState((prev) => ({
        current: track,
        queue: queue ?? prev.queue,
        isPlaying: true,
        visible: true,
      }));
      const audio = audioRef.current;
      if (audio) {
        audio.src = streamUrlFor(track.source_id);
        void audio.play().catch(() => undefined);
      }
    },
    [streamUrlFor],
  );

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((prev) => ({ ...prev, isPlaying: false }));
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play().catch(() => undefined);
    setState((prev) => ({ ...prev, isPlaying: true }));
  }, []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
    setState((prev) => ({ ...prev, isPlaying: audio.paused ? false : true }));
  }, []);

  const next = useCallback(() => {
    setState((prev) => {
      if (!prev.current) return prev;
      const [head, ...tail] = prev.queue;
      if (!head) return { ...prev, current: null, isPlaying: false, queue: [] };
      const audio = audioRef.current;
      if (audio) {
        audio.src = streamUrlFor(head.source_id);
        void audio.play().catch(() => undefined);
      }
      return { ...prev, current: head, queue: tail, isPlaying: true };
    });
  }, [streamUrlFor]);

  const clear = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    setState({ current: null, queue: [], isPlaying: false, visible: false });
  }, []);

  const show = useCallback(() => setState((prev) => ({ ...prev, visible: true })), []);
  const hide = useCallback(() => setState((prev) => ({ ...prev, visible: false })), []);
  const toggleVisible = useCallback(() => setState((prev) => ({ ...prev, visible: !prev.visible })), []);

  const value = useMemo(
    () => ({ ...state, play, pause, resume, toggle, next, clear, show, hide, toggleVisible }),
    [state, play, pause, resume, toggle, next, clear, show, hide, toggleVisible],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function useMusicPlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("useMusicPlayer must be used within MusicPlayerProvider");
  return ctx;
}

/** Helper to coerce a search result into the player's track shape. */
export function trackFromSearch(r: MusicSearchResult): MusicTrack {
  return {
    id: r.id,
    title: r.title,
    channel: r.channel,
    duration_sec: r.duration_sec,
    thumbnail_url: r.thumbnail_url,
    source_id: r.id,
  };
}