/**
 * YouTube search + stream resolver.
 *
 * Primary backend: `yt-dlp` (must be on PATH) — most stable, full metadata,
 * supports many sources. We invoke it with `--dump-json` so we don't have to
 * touch the audio bytes ourselves (the proxy in routes.ts handles bytes).
 *
 * Fallback: a small roster of public Invidious instances that speak the
 * same JSON-ish search/stream shape. Invidious is read-only by design and
 * the instances can be flaky — we cycle through them on failure.
 *
 * No media is ever persisted by Mirais; bytes only flow through the proxy
 * to satisfy a browser request and are dropped on connection close.
 */
import { spawn } from "node:child_process";
import { log } from "../utils/logger";

export interface MusicSearchResult {
  id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  source: "youtube";
}

/** Default roster of public Invidious instances — overridable via env if needed. */
const INVIDIOUS_INSTANCES: string[] = [
  "https://inv.nadeko.net",
  "https://invidious.fdn.fr",
  "https://yewtu.be",
  "https://invidious.privacydev.net",
];

const YT_DLP_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function runYtDlp(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr: stderr + "\n[yt-dlp killed after timeout]" });
    }, YT_DLP_TIMEOUT_MS);
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + `\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function extractIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] ?? null;
    if (u.hostname.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = /^\/(?:shorts|embed)\/([^/?]+)/.exec(u.pathname);
      if (m) return m[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function mapDlpJson(entry: { id?: string; title?: string; uploader?: string; channel?: string; duration?: number; thumbnails?: Array<{ url?: string }> }): MusicSearchResult | null {
  if (!entry?.id || !entry?.title) return null;
  return {
    id: entry.id,
    title: entry.title,
    channel: entry.uploader ?? entry.channel ?? null,
    duration_sec: typeof entry.duration === "number" ? Math.round(entry.duration) : null,
    thumbnail_url: entry.thumbnails?.[0]?.url ?? null,
    source: "youtube",
  };
}

export async function searchMusic(query: string, limit = 20): Promise<{ source: "yt-dlp" | "invidious"; results: MusicSearchResult[] }> {
  const trimmed = query.trim();
  if (!trimmed) return { source: "yt-dlp", results: [] };

  // Try yt-dlp first — it returns one JSON object per line when given --dump-json.
  const dlp = await runYtDlp([
    "--dump-json",
    "--default-search", "ytsearch",
    "--playlist-end", String(Math.max(1, Math.min(limit, 25))),
    "--no-warnings",
    "--flat-playlist",
    `ytsearch${Math.max(1, Math.min(limit, 25))}:${trimmed}`,
  ]);
  if (dlp.ok) {
    const out: MusicSearchResult[] = [];
    for (const line of dlp.stdout.split("\n")) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      try {
        const parsed = JSON.parse(trimmedLine) as Parameters<typeof mapDlpJson>[0];
        const mapped = mapDlpJson(parsed);
        if (mapped) out.push(mapped);
        if (out.length >= limit) break;
      } catch {
        /* skip non-JSON line */
      }
    }
    if (out.length) return { source: "yt-dlp", results: out };
  } else {
    log.debug("yt-dlp unavailable, falling back to invidious", { stderr: dlp.stderr.slice(0, 200) });
  }

  // Fallback: cycle through Invidious instances.
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const res = await withTimeout(
        fetch(`${base}/api/v1/search?q=${encodeURIComponent(trimmed)}&type=video&page=1`, {
          headers: { "user-agent": "Mozilla/5.0 Mirais" },
        }),
        FETCH_TIMEOUT_MS,
        `invidious search (${base})`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as Array<{ videoId?: string; title?: string; author?: string; lengthSeconds?: number; videoThumbnails?: Array<{ url?: string }> }>;
      const mapped: MusicSearchResult[] = data
        .filter((e) => e.videoId && e.title)
        .map((e): MusicSearchResult => ({
          id: e.videoId!,
          title: e.title!,
          channel: e.author ?? null,
          duration_sec: e.lengthSeconds ?? null,
          thumbnail_url: e.videoThumbnails?.[0]?.url ?? null,
          source: "youtube",
        }))
        .slice(0, limit);
      if (mapped.length) return { source: "invidious", results: mapped };
    } catch (err) {
      log.debug("invidious instance failed", { base, err: err instanceof Error ? err.message : String(err) });
    }
  }

  return { source: "yt-dlp", results: [] };
}

/** Resolve an audio stream URL for a YouTube video id. Returns a redirect URL. */
export async function resolveAudioStreamUrl(videoId: string): Promise<{ url: string; contentType?: string; via: "yt-dlp" | "invidious" } | null> {
  if (!/^[A-Za-z0-9_-]{6,15}$/.test(videoId)) return null;

  // Try yt-dlp first.
  const dlp = await runYtDlp([
    "--get-url",
    "--format", "bestaudio/best",
    "--no-warnings",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  if (dlp.ok) {
    const url = dlp.stdout.trim().split("\n")[0] ?? "";
    if (url.startsWith("http")) return { url, via: "yt-dlp" };
  } else {
    log.debug("yt-dlp unavailable for stream resolution", { stderr: dlp.stderr.slice(0, 200) });
  }

  // Fallback to Invidious.
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const res = await withTimeout(
        fetch(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats`, {
          headers: { "user-agent": "Mozilla/5.0 Mirais" },
        }),
        FETCH_TIMEOUT_MS,
        `invidious video (${base})`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { adaptiveFormats?: Array<{ type?: string; url?: string }> };
      const audio = (data.adaptiveFormats ?? [])
        .filter((f) => f.type?.startsWith("audio/") && f.url)
        .sort((a, b) => (Number(b.type?.includes("audio/mp4")) - Number(a.type?.includes("audio/mp4"))))[0];
      if (audio?.url) return { url: audio.url, contentType: audio.type, via: "invidious" };
    } catch {
      /* try next instance */
    }
  }

  return null;
}

export function videoIdFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9_-]{6,15}$/.test(trimmed)) return trimmed;
  return extractIdFromUrl(trimmed);
}

/**
 * Fetch trending music videos. Mirais tries yt-dlp first
 * (`https://www.youtube.com/feed/trending?bp=4gINGgt5dG1hX2NoYXJ0cw%3D%3D`
 * which filters to the Music category). Invidious has a stable
 * `/api/v1/trending?type=music` endpoint that we use as a fallback. Both
 * sources are public and don't need API keys.
 */
export async function fetchTrending(limit = 20): Promise<{ source: "yt-dlp" | "invidious"; results: MusicSearchResult[] }> {
  const safeLimit = Math.max(1, Math.min(limit, 50));

  // 1. yt-dlp — flat-playlist dump of the trending Music feed.
  const dlp = await runYtDlp([
    "--dump-json",
    "--flat-playlist",
    "--no-warnings",
    "--playlist-end", String(safeLimit),
    "https://www.youtube.com/feed/trending?bp=4gINGgt5dG1hX2NoYXJ0cw%3D%3D",
  ]);
  if (dlp.ok) {
    const out: MusicSearchResult[] = [];
    for (const line of dlp.stdout.split("\n")) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      try {
        const parsed = JSON.parse(trimmedLine) as Parameters<typeof mapDlpJson>[0];
        const mapped = mapDlpJson(parsed);
        if (mapped) out.push(mapped);
        if (out.length >= safeLimit) break;
      } catch {
        /* skip non-JSON line */
      }
    }
    if (out.length) return { source: "yt-dlp", results: out };
  } else {
    log.debug("yt-dlp unavailable for trending, falling back to invidious", { stderr: dlp.stderr.slice(0, 200) });
  }

  // 2. Invidious — public trending JSON endpoint, type=music.
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const res = await withTimeout(
        fetch(`${base}/api/v1/trending?type=music&region=US`, {
          headers: { "user-agent": "Mozilla/5.0 Mirais" },
        }),
        FETCH_TIMEOUT_MS,
        `invidious trending (${base})`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as Array<{
        videoId?: string;
        title?: string;
        author?: string;
        lengthSeconds?: number;
        videoThumbnails?: Array<{ url?: string }>;
      }>;
      const mapped: MusicSearchResult[] = data
        .filter((e) => e.videoId && e.title)
        .map((e): MusicSearchResult => ({
          id: e.videoId!,
          title: e.title!,
          channel: e.author ?? null,
          duration_sec: e.lengthSeconds ?? null,
          thumbnail_url: e.videoThumbnails?.[0]?.url ?? null,
          source: "youtube",
        }))
        .slice(0, safeLimit);
      if (mapped.length) return { source: "invidious", results: mapped };
    } catch (err) {
      log.debug("invidious instance failed for trending", { base, err: err instanceof Error ? err.message : String(err) });
    }
  }

  return { source: "yt-dlp", results: [] };
}