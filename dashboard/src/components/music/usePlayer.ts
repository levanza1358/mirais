import { create } from "zustand";
import { MusicTrack as MusicTrack } from "../../api";

export type RepeatMode = "off" | "one" | "all";

interface PlayerState {
  queue: MusicTrack[];
  history: MusicTrack[];
  currentIndex: number;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  shuffle: boolean;
  shuffleOrder: number[];
  repeat: RepeatMode;
  volume: number;
  /** Audio element the store drives. Components render the <audio> tag and
   * call `bindAudio(audio)` from `useAudioElement`. */
  audio: HTMLAudioElement | null;

  playTrack: (track: MusicTrack, queue?: MusicTrack[]) => void;
  setQueue: (tracks: MusicTrack[], startIndex?: number) => void;
  toggle: () => void;
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  bindAudio: (audio: HTMLAudioElement | null) => void;
  /** Read by the audio element's `onTimeUpdate` so the store can publish
   * position to subscribers without React re-rendering per tick. */
  setPosition: (ms: number, duration?: number) => void;
  onEnded: () => void;
}

/**
 * Single Zustand store for the player. Pattern adapted from the Metrolist
 * recommendation (queue + history + currentIndex + repeat + shuffle).
 * The store deliberately doesn't drive React updates on every `timeupdate`
 * tick — components subscribe with selectors so the slider can use a
 * separate rAF loop.
 */
export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  history: [],
  currentIndex: -1,
  positionMs: 0,
  durationMs: 0,
  isPlaying: false,
  shuffle: false,
  shuffleOrder: [],
  repeat: "off",
  volume: 0.8,
  audio: null,

  playTrack: (track, queue) => {
    const nextQueue = queue ?? [track];
    const idx = nextQueue.findIndex((t) => t.id === track.id);
    set({
      queue: nextQueue,
      history: [...get().history, get().queue[get().currentIndex] ?? track].filter(Boolean),
      currentIndex: idx >= 0 ? idx : 0,
      positionMs: 0,
      durationMs: (track.duration_sec ?? 0) * 1000,
      isPlaying: true,
    });
    const audio = get().audio;
    if (audio) {
      audio.src = track.source_type === "url" ? track.source_url ?? "" : `/api/music/tracks/${track.id}/audio`;
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    }
  },

  setQueue: (tracks, startIndex = 0) => {
    if (!tracks.length) {
      set({ queue: [], currentIndex: -1, isPlaying: false });
      const audio = get().audio;
      if (audio) { audio.pause(); audio.removeAttribute("src"); }
      return;
    }
    const clamped = Math.min(Math.max(0, startIndex), tracks.length - 1);
    const start = tracks[clamped]!;
    set({ queue: tracks, history: [], currentIndex: clamped, positionMs: 0, isPlaying: true });
    const audio = get().audio;
    if (audio) {
      audio.src = start.source_type === "url" ? start.source_url ?? "" : `/api/music/tracks/${start.id}/audio`;
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    }
  },

  toggle: () => {
    const audio = get().audio;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => undefined);
      set({ isPlaying: true });
    } else {
      audio.pause();
      set({ isPlaying: false });
    }
  },

  play: () => {
    const audio = get().audio;
    if (!audio) return;
    void audio.play().catch(() => undefined);
    set({ isPlaying: true });
  },

  pause: () => {
    const audio = get().audio;
    if (!audio) return;
    audio.pause();
    set({ isPlaying: false });
  },

  next: () => {
    const { queue, currentIndex, repeat } = get();
    if (!queue.length || currentIndex < 0) return;
    let nextIndex = currentIndex + 1;
    if (nextIndex >= queue.length) {
      if (repeat === "all") nextIndex = 0;
      else { get().pause(); set({ isPlaying: false }); return; }
    }
    const track = queue[nextIndex]!;
    set({ currentIndex: nextIndex, positionMs: 0, durationMs: (track.duration_sec ?? 0) * 1000, history: [...get().history, queue[currentIndex]!] });
    const audio = get().audio;
    if (audio) {
      audio.src = track.source_type === "url" ? track.source_url ?? "" : `/api/music/tracks/${track.id}/audio`;
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    }
  },

  prev: () => {
    const audio = get().audio;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    const { history } = get();
    if (!history.length) {
      if (audio) audio.currentTime = 0;
      return;
    }
    const prev = history[history.length - 1]!;
    const newHistory = history.slice(0, -1);
    const idx = get().queue.findIndex((t) => t.id === prev.id);
    set({ currentIndex: idx, history: newHistory, positionMs: 0 });
    if (audio) {
      audio.src = prev.source_type === "url" ? prev.source_url ?? "" : `/api/music/tracks/${prev.id}/audio`;
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    }
  },

  seek: (ms) => {
    const audio = get().audio;
    if (audio) audio.currentTime = ms / 1000;
    set({ positionMs: ms });
  },

  setVolume: (v) => {
    const audio = get().audio;
    if (audio) audio.volume = Math.min(1, Math.max(0, v));
    set({ volume: v });
  },

  toggleShuffle: () => {
    const shuffle = !get().shuffle;
    const queue = get().queue;
    const order = shuffle && queue.length > 1
      ? fisherYates(queue.length).map((value, idx) => ({ value, idx })).sort((a, b) => a.value - b.value).map((entry) => entry.idx)
      : [];
    set({ shuffle, shuffleOrder: order });
  },

  cycleRepeat: () => {
    const cur = get().repeat;
    set({ repeat: cur === "off" ? "all" : cur === "all" ? "one" : "off" });
  },

  bindAudio: (audio) => {
    set({ audio });
    if (audio) audio.volume = get().volume;
  },

  setPosition: (ms, duration) => {
    const patch: Partial<PlayerState> = { positionMs: ms };
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) patch.durationMs = duration;
    set(patch);
  },

  onEnded: () => {
    const { repeat } = get();
    if (repeat === "one") {
      const audio = get().audio;
      if (audio) { audio.currentTime = 0; void audio.play().catch(() => undefined); }
      return;
    }
    get().next();
  },
}));

function fisherYates(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

export function currentTrack(state: PlayerState): MusicTrack | null {
  return state.currentIndex >= 0 ? state.queue[state.currentIndex] ?? null : null;
}