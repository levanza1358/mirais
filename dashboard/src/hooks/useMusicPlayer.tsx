import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MusicSearchResult } from "../api";

function logWarn(message: string, meta?: Record<string, unknown>) {
  if (typeof console !== "undefined") {
    console.warn(`[music] ${message}`, meta ?? {});
  }
}
function logError(message: string, meta?: Record<string, unknown>) {
  if (typeof console !== "undefined") {
    console.error(`[music] ${message}`, meta ?? {});
  }
}

const PLAYER_PREFS_KEY = "mirais.music.player.preferences";
const PLAYER_SNAPSHOT_KEY = "mirais.music.player.snapshot";
const MUSIC_TAB_LOCK_KEY = "mirais.music.player.active-tab";
const SNAPSHOT_THROTTLE_MS = 1000;
const TAB_LOCK_TTL_MS = 8_000;
const TAB_LOCK_RENEW_MS = 3_000;

function musicTabId(): string {
  try {
    const existing = window.sessionStorage.getItem(MUSIC_TAB_LOCK_KEY);
    if (existing) return existing;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    window.sessionStorage.setItem(MUSIC_TAB_LOCK_KEY, id);
    return id;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

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
  /** Last playback error message (e.g. stream failure). Cleared on next play. */
  error: string | null;
  history: MusicTrack[];
  recentlyPlayed: MusicTrack[];
  favorites: MusicTrack[];
  shuffle: boolean;
  repeatMode: "off" | "all" | "one";
  volume: number;
  muted: boolean;
  /** "player" exposes the full controls; "dock" stays as a small floating pill. */
  presentation: "hidden" | "dock" | "player";
  /** Convenience accessor preserved for backwards compatibility with existing UI. */
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
  reorderFavorites: (fromIndex: number, toIndex: number) => void;
  replayTrack: (track: MusicTrack) => void;
  show: () => void;
  hide: () => void;
  toggleVisible: () => void;
  dismissError: () => void;
}

const PlayerContext = createContext<(PlayerState & PlayerControls) | null>(null);

export function MusicPlayerProvider({ children, streamUrlFor }: { children: ReactNode; streamUrlFor: (videoId: string) => string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tabIdRef = useRef(musicTabId());
  const ownsMusicTabRef = useRef(false);
  const [state, setState] = useState<PlayerState>({ current: null, queue: [], isPlaying: false, currentTime: 0, duration: 0, isBuffering: false, showQueue: false, error: null, history: [], recentlyPlayed: [], favorites: [], shuffle: false, repeatMode: "off", volume: 1, muted: false, presentation: "hidden", visible: false });

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

  // Persist the currently playing track + queue + history so a manual
  // refresh (F5) doesn't drop the playlist. We throttle time updates to
  // once per second so we don't write localStorage on every animation
  // frame. Settings (volume / shuffle / favorites / etc.) live in a
  // separate key so they can be flushed more aggressively without
  // dragging the audio position with them.
  // Drop anything that isn't a plain serializable value so a stray React
// fiber / DOM node reference (from React DevTools, an extension, or a
// future code path that accidentally stores one) cannot crash the player
// by throwing inside JSON.stringify. Numbers/strings/booleans/null pass
// through; arrays/objects are walked recursively.
function plainClone(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(plainClone);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cloned = plainClone(v);
      if (cloned !== undefined) out[k] = cloned;
    }
    return out;
  }
  return undefined;
}

// Track whether we've already attempted to restore from a snapshot.
  // We can't auto-delete the snapshot in the saver effect on first mount
  // because the audio element setup effect runs later and needs to read
  // the snapshot first.
  const restoredRef = useRef(false);

  // The browser may open the dashboard in multiple tabs, but only one tab
  // may hydrate or control the music player at a time. A short, renewable
  // localStorage lease also survives a normal F5 reload without allowing a
  // second tab to start a duplicate player.
  useEffect(() => {
    const claimTab = () => {
      try {
        const raw = window.localStorage.getItem(MUSIC_TAB_LOCK_KEY);
        const lock = raw ? JSON.parse(raw) as { tabId?: string; expiresAt?: number } : null;
        const now = Date.now();
        const canClaim = !lock || !lock.tabId || !lock.expiresAt || lock.expiresAt <= now || lock.tabId === tabIdRef.current;
        if (canClaim) {
          window.localStorage.setItem(MUSIC_TAB_LOCK_KEY, JSON.stringify({ tabId: tabIdRef.current, expiresAt: now + TAB_LOCK_TTL_MS }));
          ownsMusicTabRef.current = true;
        } else {
          ownsMusicTabRef.current = false;
          audioRef.current?.pause();
        }
      } catch {
        // If storage is unavailable, retain normal single-document playback.
        ownsMusicTabRef.current = true;
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== MUSIC_TAB_LOCK_KEY || !event.newValue) return;
      try {
        const lock = JSON.parse(event.newValue) as { tabId?: string };
        if (lock.tabId && lock.tabId !== tabIdRef.current) {
          ownsMusicTabRef.current = false;
          audioRef.current?.pause();
        }
      } catch { /* ignore */ }
    };
    claimTab();
    const renew = window.setInterval(claimTab, TAB_LOCK_RENEW_MS);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(renew);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    // Don't write/clear until the restore effect has had a chance to run.
    if (!restoredRef.current) return;
    if (!state.current) {
      try { window.localStorage.removeItem(PLAYER_SNAPSHOT_KEY); } catch { /* ignore */ }
      return;
    }
    const write = () => {
      try {
        const snapshot = plainClone({
          current: state.current,
          queue: state.queue,
          history: state.history,
          currentTime: state.currentTime,
          duration: state.duration,
          isPlaying: state.isPlaying,
          presentation: state.presentation,
          muted: state.muted,
          volume: state.volume,
          shuffle: state.shuffle,
          repeatMode: state.repeatMode,
          savedAt: Date.now(),
        });
        window.localStorage.setItem(PLAYER_SNAPSHOT_KEY, JSON.stringify(snapshot));
      } catch {
        /* ignore quota / private mode */
      }
    };
    write();
    const t = setTimeout(write, SNAPSHOT_THROTTLE_MS);
    return () => clearTimeout(t);
  }, [state.current, state.currentTime, state.duration, state.history, state.isPlaying, state.muted, state.presentation, state.queue, state.repeatMode, state.shuffle, state.volume]);

  useEffect(() => {
    try {
      const payload = plainClone({
        shuffle: state.shuffle,
        repeatMode: state.repeatMode,
        volume: state.volume,
        muted: state.muted,
        recentlyPlayed: state.recentlyPlayed.slice(0, 12),
        favorites: state.favorites.slice(0, 50),
      });
      window.localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(payload));
    } catch {
      /* ignore quota / private mode */
    }
  }, [state.favorites, state.muted, state.recentlyPlayed, state.repeatMode, state.shuffle, state.volume]);

  // Ensure a single audio element survives page changes.
  useEffect(() => {
    if (audioRef.current) return;
    const audio = new Audio();
    audio.preload = "auto";
    // No crossOrigin: the stream proxy redirects to YouTube/Invidious CDNs
    // which do not advertise CORS. Setting crossOrigin="anonymous" caused
    // playback to silently fail and the UI to render over an empty audio
    // element (the "black screen" complaint).
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
    audio.addEventListener("pause", () => {
      setState((prev) => (prev.isPlaying ? { ...prev, isPlaying: false, isBuffering: false } : prev));
    });
    audio.addEventListener("error", () => {
      const code = audio.error?.code ?? 0;
      const message =
        code === 4 ? "Audio source not supported by this browser."
        : code === 3 ? "Audio decoding failed."
        : code === 2 ? "Network error while loading audio."
        : code === 1 ? "Audio playback aborted."
        : "Audio playback failed.";
      logError("music audio error", { code });
      setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false, error: message }));
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || (e.target instanceof HTMLElement && e.target.closest('[role="combobox"]'))) return;
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

    // Restore the last playback snapshot after F5 / hard reload. We can't
    // resume before the page gains a user gesture — browsers block autoplay
    // with sound — so we hydrate state immediately but only call
    // audio.play() once the first interaction (click / keydown / touch)
    // happens. The UI surfaces a "Tap to resume" prompt via the buffering
    // state so the user knows their session is intact.
    try {
      const raw = window.localStorage.getItem(PLAYER_SNAPSHOT_KEY);
      if (raw) {
        const snapshot = JSON.parse(raw) as {
          current?: MusicTrack | null;
          queue?: MusicTrack[];
          history?: MusicTrack[];
          currentTime?: number;
          duration?: number;
          isPlaying?: boolean;
          presentation?: "hidden" | "dock" | "player";
          muted?: boolean;
          volume?: number;
          shuffle?: boolean;
          repeatMode?: "off" | "all" | "one";
        };
        if (snapshot.current && ownsMusicTabRef.current) {
          audio.volume = typeof snapshot.volume === "number" ? snapshot.volume : audio.volume;
          audio.muted = !!snapshot.muted;
          audio.src = streamUrlFor(snapshot.current.source_id);
          const restoreTime = (event: Event) => {
            const target = event.target as HTMLAudioElement;
            if (typeof snapshot.currentTime === "number" && Number.isFinite(snapshot.currentTime) && snapshot.currentTime > 0) {
              try { target.currentTime = snapshot.currentTime; } catch { /* ignore */ }
            }
            target.removeEventListener("loadedmetadata", restoreTime);
          };
          audio.addEventListener("loadedmetadata", restoreTime);
          setState((prev) => ({
            ...prev,
            current: snapshot.current ?? null,
            queue: Array.isArray(snapshot.queue) ? snapshot.queue : [],
            history: Array.isArray(snapshot.history) ? snapshot.history : [],
            currentTime: typeof snapshot.currentTime === "number" ? snapshot.currentTime : 0,
            duration: typeof snapshot.duration === "number" ? snapshot.duration : snapshot.current?.duration_sec ?? 0,
            isPlaying: !!snapshot.isPlaying,
            isBuffering: !!snapshot.isPlaying,
            presentation: snapshot.presentation ?? "player",
            visible: (snapshot.presentation ?? "player") === "player",
            shuffle: typeof snapshot.shuffle === "boolean" ? snapshot.shuffle : prev.shuffle,
            repeatMode: snapshot.repeatMode ?? prev.repeatMode,
          }));
          if (snapshot.isPlaying) {
            const resumeOnGesture = () => {
              if (audio.paused) void audio.play().catch(() => undefined);
              window.removeEventListener("pointerdown", resumeOnGesture);
              window.removeEventListener("keydown", resumeOnGesture);
            };
            void audio.play().catch(() => {
              window.addEventListener("pointerdown", resumeOnGesture, { once: true });
              window.addEventListener("keydown", resumeOnGesture, { once: true });
            });
          }
        }
      }
    } catch {
      /* corrupt snapshot — ignore */
    }
    // Mark that future state updates should be written back to localStorage.
    restoredRef.current = true;

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      audio.pause();
      audio.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = useCallback(
    (track: MusicTrack, queue?: MusicTrack[]) => {
      if (!ownsMusicTabRef.current) return;
      setState((prev) => {
        // When playback was started from the dock (or is currently in dock
        // mode), keep it collapsed. Otherwise present the expanded player.
        const nextPresentation: PlayerState["presentation"] =
          prev.current && prev.presentation === "dock" ? "dock" : "player";
        return {
          ...prev,
          current: track,
          queue: prev.shuffle ? shuffleList(queue ?? prev.queue) : (queue ?? prev.queue),
          isPlaying: true,
          currentTime: 0,
          duration: track.duration_sec ?? 0,
          isBuffering: true,
          showQueue: false,
          history: prev.current && prev.current.source_id !== track.source_id ? [...prev.history, prev.current] : prev.history,
          recentlyPlayed: prev.current ? [prev.current, ...prev.recentlyPlayed.filter((item) => item.source_id !== prev.current?.source_id)].slice(0, 12) : prev.recentlyPlayed,
          presentation: nextPresentation,
          visible: nextPresentation === "player",
          error: null,
        };
      });
      const audio = audioRef.current;
      if (audio) {
        audio.volume = state.volume;
        audio.muted = state.muted;
        audio.src = streamUrlFor(track.source_id);
        void audio.play().catch((err) => {
          const message = err instanceof Error ? err.message : "Playback rejected by browser";
          logWarn("music play rejected", { message });
          setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false, error: message }));
        });
      }
    },
    [state.muted, state.volume, streamUrlFor],
  );

  const pause = useCallback(() => {
    if (!ownsMusicTabRef.current) return;
    audioRef.current?.pause();
    setState((prev) => ({ ...prev, isPlaying: false }));
  }, []);

  const resume = useCallback(() => {
    if (!ownsMusicTabRef.current) return;
    audioRef.current?.play().catch(() => undefined);
    setState((prev) => ({ ...prev, isPlaying: true, isBuffering: true }));
  }, []);

  const toggle = useCallback(() => {
    if (!ownsMusicTabRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
    setState((prev) => ({ ...prev, isPlaying: audio.paused ? false : true }));
  }, []);

  const next = useCallback(() => {
    if (!ownsMusicTabRef.current) return;
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
    if (!ownsMusicTabRef.current) return;
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
    if (!ownsMusicTabRef.current) return;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    setState((prev) => ({
      ...prev,
      current: null,
      queue: [],
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      isBuffering: false,
      showQueue: false,
      history: [],
      presentation: "hidden",
      visible: false,
      error: null,
    }));
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = Number.isFinite(audio.duration) ? audio.duration : (state.duration || time);
    const nextTime = Math.max(0, Math.min(time, max));
    audio.currentTime = nextTime;
    setState((prev) => ({ ...prev, currentTime: nextTime }));
  }, [state.duration]);

  const openQueue = useCallback(() => setState((prev) => ({ ...prev, showQueue: true, presentation: "player", visible: true })), []);
  const closeQueue = useCallback(() => setState((prev) => ({ ...prev, showQueue: false })), []);
  const toggleQueue = useCallback(() => setState((prev) => ({ ...prev, showQueue: !prev.showQueue, presentation: "player", visible: true })), []);
  const playNext = useCallback((track: MusicTrack) => setState((prev) => ({ ...prev, queue: [track, ...prev.queue] })), []);
  const removeFromQueue = useCallback((index: number) => setState((prev) => ({ ...prev, queue: prev.queue.filter((_, i) => i !== index) })), []);
  const clearQueue = useCallback(() => setState((prev) => ({ ...prev, queue: [], showQueue: false })), []);
  const jumpToQueue = useCallback((index: number) => {
    if (!ownsMusicTabRef.current) return;
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
  const reorderFavorites = useCallback((fromIndex: number, toIndex: number) => {
    setState((prev) => {
      const list = prev.favorites;
      if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length || fromIndex === toIndex) {
        return prev;
      }
      const next = list.slice();
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return prev;
      next.splice(toIndex, 0, moved);
      return { ...prev, favorites: next };
    });
  }, []);
  const replayTrack = useCallback((track: MusicTrack) => {
    const audio = audioRef.current;
    if (audio) {
      audio.src = streamUrlFor(track.source_id);
      void audio.play().catch((err) => {
        const message = err instanceof Error ? err.message : "Playback rejected by browser";
        logWarn("music replay rejected", { message });
        setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false, error: message }));
      });
    }
    setState((prev) => ({
      ...prev,
      current: track,
      isPlaying: true,
      currentTime: 0,
      duration: track.duration_sec ?? 0,
      isBuffering: true,
      presentation: "player",
      visible: true,
      error: null,
    }));
  }, [streamUrlFor]);

  const show = useCallback(() => setState((prev) => {
    if (!prev.current) return prev;
    return { ...prev, presentation: "player", visible: true };
  }), []);
  const hide = useCallback(() => setState((prev) => {
    if (!prev.current) return prev;
    return { ...prev, presentation: "dock", visible: false };
  }), []);
  const toggleVisible = useCallback(() => setState((prev) => {
    if (!prev.current) return prev;
    const next = prev.presentation === "player" ? "dock" : "player";
    return { ...prev, presentation: next, visible: next === "player" };
  }), []);
  const dismissError = useCallback(() => setState((prev) => ({ ...prev, error: null })), []);

  const value = useMemo(
    () => ({ ...state, play, pause, resume, toggle, next, clear, seek, openQueue, closeQueue, toggleQueue, previous, playNext, removeFromQueue, clearQueue, jumpToQueue, toggleShuffle, cycleRepeatMode, setVolume, toggleMute, toggleFavorite, reorderFavorites, replayTrack, show, hide, toggleVisible, dismissError }),
    [state, play, pause, resume, toggle, next, clear, seek, openQueue, closeQueue, toggleQueue, previous, playNext, removeFromQueue, clearQueue, jumpToQueue, toggleShuffle, cycleRepeatMode, setVolume, toggleMute, toggleFavorite, reorderFavorites, replayTrack, show, hide, toggleVisible, dismissError],
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