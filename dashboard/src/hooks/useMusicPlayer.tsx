import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MusicSearchResult } from "../api";

const PLAYER_PREFS_KEY = "mirais.music.player.preferences";

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
  currentTime: number;
  duration: number;
  isBuffering: boolean;
  showQueue: boolean;
  history: MusicTrack[];
  recentlyPlayed: MusicTrack[];
  favorites: MusicTrack[];
  shuffle: boolean;
  repeatMode: "off" | "all" | "one";
  volume: number;
  muted: boolean;
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
  seek: (time: number) => void;
  openQueue: () => void;
  closeQueue: () => void;
  toggleQueue: () => void;
  previous: () => void;
  playNext: (track: MusicTrack) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  jumpToQueue: (index: number) => void;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleFavorite: (track: MusicTrack) => void;
  replayTrack: (track: MusicTrack) => void;
  show: () => void;
  hide: () => void;
  toggleVisible: () => void;
}

const PlayerContext = createContext<(PlayerState & PlayerControls) | null>(null);

export function MusicPlayerProvider({ children, streamUrlFor }: { children: ReactNode; streamUrlFor: (videoId: string) => string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<PlayerState>({ current: null, queue: [], isPlaying: false, currentTime: 0, duration: 0, isBuffering: false, showQueue: false, history: [], recentlyPlayed: [], favorites: [], shuffle: false, repeatMode: "off", volume: 1, muted: false, visible: false });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PLAYER_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        shuffle?: boolean;
        repeatMode?: "off" | "all" | "one";
        volume?: number;
        muted?: boolean;
        recentlyPlayed?: MusicTrack[];
        favorites?: MusicTrack[];
      };
      setState((prev) => ({
        ...prev,
        shuffle: parsed.shuffle ?? prev.shuffle,
        repeatMode: parsed.repeatMode ?? prev.repeatMode,
        volume: typeof parsed.volume === "number" ? parsed.volume : prev.volume,
        muted: typeof parsed.muted === "boolean" ? parsed.muted : prev.muted,
        recentlyPlayed: Array.isArray(parsed.recentlyPlayed) ? parsed.recentlyPlayed.slice(0, 12) : prev.recentlyPlayed,
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites.slice(0, 50) : prev.favorites,
      }));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify({
      shuffle: state.shuffle,
      repeatMode: state.repeatMode,
      volume: state.volume,
      muted: state.muted,
      recentlyPlayed: state.recentlyPlayed.slice(0, 12),
      favorites: state.favorites.slice(0, 50),
    }));
  }, [state.favorites, state.muted, state.recentlyPlayed, state.repeatMode, state.shuffle, state.volume]);

  // Ensure a single audio element survives page changes.
  useEffect(() => {
    if (audioRef.current) return;
    const audio = new Audio();
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    audio.volume = 1;
    audioRef.current = audio;
    audio.addEventListener("timeupdate", () => {
      setState((prev) => ({ ...prev, currentTime: audio.currentTime || 0 }));
    });
    audio.addEventListener("loadedmetadata", () => {
      setState((prev) => ({
        ...prev,
        duration: Number.isFinite(audio.duration) ? audio.duration : (prev.current?.duration_sec ?? 0),
        isBuffering: false,
      }));
    });
    audio.addEventListener("waiting", () => {
      setState((prev) => ({ ...prev, isBuffering: true }));
    });
    audio.addEventListener("playing", () => {
      setState((prev) => ({ ...prev, isPlaying: true, isBuffering: false }));
    });
    audio.addEventListener("ended", () => {
      // Auto-advance through queue if available.
      setState((prev) => {
        if (!prev.current) return prev;
        if (prev.repeatMode === "one") {
          if (audioRef.current) {
            audioRef.current.currentTime = 0;
            void audioRef.current.play().catch(() => undefined);
          }
          return { ...prev, currentTime: 0, isBuffering: true };
        }
        const [head, ...tail] = prev.queue;
        if (!head) {
          if (prev.repeatMode === "all" && prev.history.length > 0) {
            const replayQueue = [...prev.history, prev.current];
            const [replayHead, ...replayTail] = replayQueue;
            if (replayHead && audioRef.current) {
              audioRef.current.src = streamUrlFor(replayHead.source_id);
              void audioRef.current.play().catch(() => undefined);
            }
            return replayHead
              ? { ...prev, current: replayHead, queue: replayTail, history: [], isPlaying: true, currentTime: 0, duration: replayHead.duration_sec ?? 0, isBuffering: true }
              : prev;
          }
          return { ...prev, current: null, isPlaying: false, queue: [], currentTime: 0, duration: 0, isBuffering: false, showQueue: false, history: [] };
        }
        if (audioRef.current) {
          audioRef.current.src = streamUrlFor(head.source_id);
          void audioRef.current.play().catch(() => undefined);
        }
        return { ...prev, current: head, queue: tail, history: prev.current ? [...prev.history, prev.current] : prev.history, recentlyPlayed: prev.current ? [prev.current, ...prev.recentlyPlayed.filter((item) => item.source_id !== prev.current?.source_id)].slice(0, 12) : prev.recentlyPlayed, isPlaying: true, currentTime: 0, duration: head.duration_sec ?? 0, isBuffering: true };
      });
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (audio.paused) void audio.play().catch(() => undefined);
        else audio.pause();
      }
      if (e.code === "ArrowRight") audio.currentTime += 10;
      if (e.code === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 10);
      if (e.key.toLowerCase() === "m") audio.muted = !audio.muted;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      audio.pause();
      audio.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = useCallback(
    (track: MusicTrack, queue?: MusicTrack[]) => {
      setState((prev) => ({
        current: track,
        queue: prev.shuffle ? shuffleList(queue ?? prev.queue) : (queue ?? prev.queue),
        isPlaying: true,
        currentTime: 0,
        duration: track.duration_sec ?? 0,
        isBuffering: true,
        showQueue: false,
        history: prev.current && prev.current.source_id !== track.source_id ? [...prev.history, prev.current] : prev.history,
        recentlyPlayed: prev.current ? [prev.current, ...prev.recentlyPlayed.filter((item) => item.source_id !== prev.current?.source_id)].slice(0, 12) : prev.recentlyPlayed,
        visible: prev.current ? prev.visible : true,
        volume: prev.volume,
        muted: prev.muted,
      }));
      const audio = audioRef.current;
      if (audio) {
        audio.volume = state.volume;
        audio.muted = state.muted;
        audio.src = streamUrlFor(track.source_id);
        void audio.play().catch(() => undefined);
      }
    },
    [state.muted, state.volume, streamUrlFor],
  );

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((prev) => ({ ...prev, isPlaying: false }));
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play().catch(() => undefined);
    setState((prev) => ({ ...prev, isPlaying: true, isBuffering: true }));
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
      if (!head) return { ...prev, current: null, isPlaying: false, queue: [], currentTime: 0, duration: 0, isBuffering: false, showQueue: false };
      const audio = audioRef.current;
      if (audio) {
        audio.src = streamUrlFor(head.source_id);
        void audio.play().catch(() => undefined);
      }
      return { ...prev, current: head, queue: tail, history: prev.current ? [...prev.history, prev.current] : prev.history, recentlyPlayed: prev.current ? [prev.current, ...prev.recentlyPlayed.filter((item) => item.source_id !== prev.current?.source_id)].slice(0, 12) : prev.recentlyPlayed, isPlaying: true, currentTime: 0, duration: head.duration_sec ?? 0, isBuffering: true };
    });
  }, [streamUrlFor]);

  const previous = useCallback(() => {
    setState((prev) => {
      const history = [...prev.history];
      const back = history.pop();
      if (!back) return prev;
      const audio = audioRef.current;
      if (audio) {
        audio.src = streamUrlFor(back.source_id);
        void audio.play().catch(() => undefined);
      }
      return {
        ...prev,
        current: back,
        queue: prev.current ? [prev.current, ...prev.queue] : prev.queue,
        history,
        isPlaying: true,
        currentTime: 0,
        duration: back.duration_sec ?? 0,
        isBuffering: true,
      };
    });
  }, [streamUrlFor]);

  const clear = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    setState((prev) => ({ ...prev, current: null, queue: [], isPlaying: false, currentTime: 0, duration: 0, isBuffering: false, showQueue: false, history: [], visible: false }));
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = Number.isFinite(audio.duration) ? audio.duration : (state.duration || time);
    const nextTime = Math.max(0, Math.min(time, max));
    audio.currentTime = nextTime;
    setState((prev) => ({ ...prev, currentTime: nextTime }));
  }, [state.duration]);

  const openQueue = useCallback(() => setState((prev) => ({ ...prev, showQueue: true, visible: true })), []);
  const closeQueue = useCallback(() => setState((prev) => ({ ...prev, showQueue: false })), []);
  const toggleQueue = useCallback(() => setState((prev) => ({ ...prev, showQueue: !prev.showQueue, visible: true })), []);
  const playNext = useCallback((track: MusicTrack) => setState((prev) => ({ ...prev, queue: [track, ...prev.queue] })), []);
  const removeFromQueue = useCallback((index: number) => setState((prev) => ({ ...prev, queue: prev.queue.filter((_, i) => i !== index) })), []);
  const clearQueue = useCallback(() => setState((prev) => ({ ...prev, queue: [], showQueue: false })), []);
  const jumpToQueue = useCallback((index: number) => {
    setState((prev) => {
      const target = prev.queue[index];
      if (!target) return prev;
      const nextQueue = prev.queue.filter((_, i) => i !== index);
      const audio = audioRef.current;
      if (audio) {
        audio.src = streamUrlFor(target.source_id);
        void audio.play().catch(() => undefined);
      }
      return {
        ...prev,
        current: target,
        queue: prev.current ? [prev.current, ...nextQueue] : nextQueue,
        history: prev.current ? [...prev.history, prev.current] : prev.history,
        recentlyPlayed: prev.current ? [prev.current, ...prev.recentlyPlayed.filter((item) => item.source_id !== prev.current?.source_id)].slice(0, 12) : prev.recentlyPlayed,
        currentTime: 0,
        duration: target.duration_sec ?? 0,
        isPlaying: true,
        isBuffering: true,
      };
    });
  }, [streamUrlFor]);
  const toggleShuffle = useCallback(() => setState((prev) => ({ ...prev, shuffle: !prev.shuffle, queue: !prev.shuffle ? shuffleList(prev.queue) : prev.queue })), []);
  const cycleRepeatMode = useCallback(() => setState((prev) => ({ ...prev, repeatMode: prev.repeatMode === "off" ? "all" : prev.repeatMode === "all" ? "one" : "off" })), []);
  const setVolume = useCallback((volume: number) => {
    const audio = audioRef.current;
    const nextVolume = Math.max(0, Math.min(1, volume));
    if (audio) audio.volume = nextVolume;
    setState((prev) => ({ ...prev, volume: nextVolume, muted: nextVolume === 0 ? true : prev.muted && prev.volume === 0 ? false : prev.muted }));
  }, []);
  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (audio) audio.muted = !audio.muted;
    setState((prev) => ({ ...prev, muted: !prev.muted }));
  }, []);
  const toggleFavorite = useCallback((track: MusicTrack) => {
    setState((prev) => {
      const exists = prev.favorites.some((item) => item.source_id === track.source_id);
      return {
        ...prev,
        favorites: exists ? prev.favorites.filter((item) => item.source_id !== track.source_id) : [track, ...prev.favorites].slice(0, 50),
      };
    });
  }, []);
  const replayTrack = useCallback((track: MusicTrack) => {
    const audio = audioRef.current;
    if (audio) {
      audio.src = streamUrlFor(track.source_id);
      void audio.play().catch(() => undefined);
    }
    setState((prev) => ({
      ...prev,
      current: track,
      isPlaying: true,
      currentTime: 0,
      duration: track.duration_sec ?? 0,
      isBuffering: true,
      visible: true,
    }));
  }, [streamUrlFor]);

  const show = useCallback(() => setState((prev) => ({ ...prev, visible: true })), []);
  const hide = useCallback(() => setState((prev) => ({ ...prev, visible: false })), []);
  const toggleVisible = useCallback(() => setState((prev) => ({ ...prev, visible: !prev.visible })), []);

  const value = useMemo(
    () => ({ ...state, play, pause, resume, toggle, next, clear, seek, openQueue, closeQueue, toggleQueue, previous, playNext, removeFromQueue, clearQueue, jumpToQueue, toggleShuffle, cycleRepeatMode, setVolume, toggleMute, toggleFavorite, replayTrack, show, hide, toggleVisible }),
    [state, play, pause, resume, toggle, next, clear, seek, openQueue, closeQueue, toggleQueue, previous, playNext, removeFromQueue, clearQueue, jumpToQueue, toggleShuffle, cycleRepeatMode, setVolume, toggleMute, toggleFavorite, replayTrack, show, hide, toggleVisible],
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

function shuffleList<T>(items: T[]): T[] {
  const cloned = [...items];
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j]!, cloned[i]!];
  }
  return cloned;
}