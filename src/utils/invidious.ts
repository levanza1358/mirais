import { config } from "../config";
import { log } from "./logger";

/**
 * Shape returned by `GET /api/v1/videos/{id}` and `/api/v1/search`. We only
 * declare the fields Mirais reads; Invidious returns more.
 */
export interface InvidiousVideo {
  type?: string;
  title?: string;
  videoId?: string;
  id?: string;
  author?: string;
  authorId?: string;
  lengthSeconds?: number;
  videoThumbnails?: Array<{ quality?: string; url?: string; width?: number; height?: number }>;
  adaptiveFormats?: Array<{
    type?: string;
    container?: string;
    encoding?: string;
    bitrate?: number | string;
    audioQuality?: string;
    url?: string;
  }>;
  formatStreams?: Array<{
    type?: string;
    container?: string;
    encoding?: string;
    bitrate?: number | string;
    url?: string;
  }>;
  description?: string;
  published?: number | string;
}

export interface InvidiousSearchResponse {
  items?: InvidiousVideo[];
}

/** Compact shape exposed to the dashboard for search results + suggestions. */
export interface YouTubeSearchResult {
  id: string;
  title: string;
  author: string;
  duration_sec: number | null;
  thumbnail_url: string | null;
}

/** Track-level pick exposed after `/import`. */
export interface YouTubeImport {
  id: string;
  title: string;
  artist: string;
  duration_sec: number;
  source_url: string;
  mime_type: string;
  thumbnail_url: string | null;
  size_bytes: number | null;
}

class AllInstancesFailedError extends Error {
  public readonly attempts: number;
  constructor(attempts: number) {
    super(`All ${attempts} Invidious instance(s) failed`);
    this.name = "AllInstancesFailedError";
    this.attempts = attempts;
  }
}

/**
 * Tracks per-instance health in memory so a flaky instance is skipped for a
 * short cooldown before being retried.
 */
const health = new Map<string, { failures: number; cooldownUntil: number }>();
const COOLDOWN_MS = 30_000;
const MAX_FAILURES_BEFORE_COOLDOWN = 2;

function isOnCooldown(instance: string): boolean {
  const entry = health.get(instance);
  return !!entry && entry.cooldownUntil > Date.now();
}

function noteSuccess(instance: string): void {
  health.delete(instance);
}

function noteFailure(instance: string): void {
  const entry = health.get(instance) ?? { failures: 0, cooldownUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES_BEFORE_COOLDOWN) {
    entry.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
  health.set(instance, entry);
}

export function invidiousInstances(): string[] {
  // Allow runtime override via settings later; for now read from env config.
  const fromConfig = config.invidiousInstances;
  if (fromConfig.length) return fromConfig;
  // Fallback to a known public instance when the operator hasn't configured
  // any. The operator can override via INV_INSTANCES.
  return ["https://inv.nadeko.net"];
}

/** Strip trailing slashes so `/api/v1/...` always concatenates cleanly. */
function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildUrl(instance: string, path: string, params: Record<string, string | number | undefined> = {}): string {
  const base = normalizeBase(instance);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `${base}${path}${query ? `?${query}` : ""}`;
}

async function invidiousFetchJson<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const instances = invidiousInstances().filter((instance) => !isOnCooldown(instance));
  if (!instances.length) throw new AllInstancesFailedError(invidiousInstances().length);
  let lastError: unknown = null;
  for (const instance of instances) {
    const url = buildUrl(instance, path, params);
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(config.invidiousTimeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        noteFailure(instance);
        lastError = new Error(`Invidious ${instance} responded ${res.status}`);
        continue;
      }
      noteSuccess(instance);
      return (await res.json()) as T;
    } catch (err) {
      noteFailure(instance);
      lastError = err;
    }
  }
  throw new AllInstancesFailedError(instances.length);
}

/** Search the public Invidious catalog. Returns up to 20 compact results. */
export async function searchVideos(q: string, page = 1): Promise<YouTubeSearchResult[]> {
  const data = await invidiousFetchJson<InvidiousSearchResponse>("/api/v1/search", { q, page, type: "video" });
  return (data.items ?? [])
    .map((video) => toSearchResult(video))
    .filter((item): item is YouTubeSearchResult => item !== null);
}

/** Autocomplete suggestions. Returns an empty array when the instance lacks
 * the endpoint — the dashboard just hides the dropdown in that case. */
export async function suggestVideos(q: string): Promise<string[]> {
  try {
    const suggestions = await invidiousFetchJson<{ suggestions?: string[] }>("/api/v1/search/suggestions", { q });
    return (suggestions.suggestions ?? []).slice(0, 8);
  } catch (err) {
    log.debug("invidious suggestions unavailable", { err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function getVideo(id: string): Promise<InvidiousVideo> {
  if (!isValidVideoId(id)) throw new Error(`Invalid YouTube video id: ${id}`);
  const data = await invidiousFetchJson<InvidiousVideo>(`/api/v1/videos/${id}`);
  return data;
}

/** Resolve a YouTube URL to its video id, or null when no match. */
export function extractVideoId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Already a bare id (11 chars, base64-ish).
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const seg = url.pathname.replace(/^\//, "").split("/")[0] ?? "";
      return isValidVideoId(seg) ? seg : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v");
        return isValidVideoId(id ?? "") ? id : null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      // /shorts/<id>, /embed/<id>, /live/<id>
      for (const tag of ["shorts", "embed", "live"]) {
        const idx = parts.indexOf(tag);
        if (idx >= 0) {
          const id = parts[idx + 1];
          if (isValidVideoId(id ?? "")) return id ?? null;
        }
      }
    }
  } catch {
    /* not a URL */
  }
  return null;
}

export function isValidVideoId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

/** Pick the best audio-only adaptive format. Invidious exposes a mix of
 * video+audio and audio-only progressive streams; we filter to the latter
 * and pick the highest bitrate (capped at 160k to keep memory reasonable). */
export function pickAudioUrl(video: InvidiousVideo): { url: string; mime: string; bitrate: number } | null {
  const candidates: Array<{ url: string; mime: string; bitrate: number }> = [];
  for (const format of video.adaptiveFormats ?? []) {
    const type = format.type ?? "";
    if (!type.startsWith("audio/")) continue;
    const url = format.url;
    if (!url) continue;
    const bitrate = typeof format.bitrate === "number" ? format.bitrate : Number(format.bitrate) || 0;
    candidates.push({ url, mime: type, bitrate });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.bitrate - b.bitrate);
  // Pick highest bitrate ≤ 160k; fall back to the lowest available.
  const under = candidates.filter((c) => c.bitrate <= 160_000).pop();
  return under ?? candidates[0]!;
}

/** Compact view used by `/api/music/youtube/search`. */
export function toSearchResult(video: InvidiousVideo): YouTubeSearchResult | null {
  const id = video.videoId ?? video.id;
  if (!isValidVideoId(id)) return null;
  return {
    id,
    title: video.title?.trim() || "(untitled)",
    author: video.author?.trim() ?? video.authorId ?? "",
    duration_sec: typeof video.lengthSeconds === "number" ? video.lengthSeconds : null,
    thumbnail_url: pickThumbnail(video),
  };
}

function pickThumbnail(video: InvidiousVideo): string | null {
  const list = video.videoThumbnails ?? [];
  if (!list.length) return null;
  // Prefer high-res; Invidious labels them like "maxresdefault" / "sddefault".
  const priority = ["maxresdefault", "sddefault", "hqdefault", "mqdefault", "default"];
  for (const label of priority) {
    const hit = list.find((thumb) => thumb.quality === label && thumb.url);
    if (hit?.url) return hit.url;
  }
  return list[list.length - 1]?.url ?? null;
}

/** Build the shape the music repo consumes. Returns null when no playable
 * audio format is exposed by the instance. */
export async function importFromVideoId(id: string): Promise<YouTubeImport | null> {
  const video = await getVideo(id);
  const audio = pickAudioUrl(video);
  if (!audio) return null;
  return {
    id,
    title: video.title?.trim() || "(untitled)",
    artist: video.author?.trim() ?? video.authorId ?? "Unknown channel",
    duration_sec: typeof video.lengthSeconds === "number" ? video.lengthSeconds : 0,
    source_url: audio.url,
    mime_type: audio.mime,
    thumbnail_url: pickThumbnail(video),
    size_bytes: null,
  };
}

export { AllInstancesFailedError };