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

/** Resolve the absolute path of an executable. Cross-platform: tries
 *  process.execPath siblings, then well-known install paths, then bare
 *  command via shell. Returns null if not found. */
function resolveExecutable(name: string): string | null {
  const candidates: string[] = [];
  const path = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of path.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      candidates.push(`${dir}${dir.endsWith(process.platform === "win32" ? "\\" : "/") ? "" : (process.platform === "win32" ? "\\" : "/")}${name}${ext}`);
    }
  }
  // Common install locations that PATH sometimes misses (Windows pip --user,
  // Linux pipx, macOS brew).
  const extras = process.platform === "win32"
    ? [
        `${process.env.APPDATA ?? ""}\\Python\\Python311\\Scripts\\${name}.exe`,
        `${process.env.APPDATA ?? ""}\\Python\\Python312\\Scripts\\${name}.exe`,
        `${process.env.APPDATA ?? ""}\\Python\\Python313\\Scripts\\${name}.exe`,
        `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Python\\Python311\\Scripts\\${name}.exe`,
        `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Python\\Python312\\Scripts\\${name}.exe`,
        `C:\\Python311\\Scripts\\${name}.exe`,
        `C:\\Python312\\Scripts\\${name}.exe`,
        `C:\\Python313\\Scripts\\${name}.exe`,
      ]
    : process.platform === "darwin"
    ? [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
    : [`/home/${process.env.USER ?? "root"}/.local/bin/${name}`, `/root/.local/bin/${name}`, `/usr/local/bin/${name}`];
  candidates.push(...extras.filter(Boolean));
  for (const c of candidates) {
    try {
      // sync fs check via spawnSync with --version (handles shebang).
      // `windowsHide` keeps the helper from flashing a console window when
      // the candidate turns out to be a .cmd / .bat wrapper.
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const res = spawnSync(c, ["--version"], { stdio: "ignore", windowsHide: true });
      if (res.status === 0) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface MusicSearchResult {
  id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  source: "youtube";
}

const TRENDING_QUERY_POOL = [
  "official music video indonesia terbaru",
  "lagu indonesia viral official audio",
  "jpop official music video",
  "japanese pop official mv",
  "western pop official music video",
  "global pop hit official video",
  "billboard hot 100 official music video",
  "spotify viral songs official mv",
];

const TRENDING_BLOCKLIST = [
  /\bmix\b/i,
  /\bplaylist\b/i,
  /\bfull album\b/i,
  /\bnonstop\b/i,
  /\brelax(?:ation)?\b/i,
  /\bstudy\b/i,
  /\bsleep\b/i,
  /\bkaraoke\b/i,
  /\bcover\b/i,
  /\blive\b/i,
  /\bcompilation\b/i,
  /\b1 hour\b/i,
  /\b2 hour\b/i,
  /\b3 hour\b/i,
  /\b2026\b.*\bplaylist\b/i,
  /\btop hits?\b/i,
  /\btrending songs?\b/i,
  /\btiktok songs?\b/i,
];

const MIN_TRENDING_DURATION_SEC = 110;
const MAX_TRENDING_DURATION_SEC = 510;
// Trending cache: stored per (limit × page) so different page sizes don't
// share stale state. The dashboard's Refresh button sends `force=1` to
// invalidate the cached fetch and re-run yt-dlp / Invidious discovery.
const TRENDING_CACHE_TTL_MS = 10 * 60_000;
const trendingCache = new Map<string, {
  expiresAt: number;
  source: "yt-dlp" | "invidious";
  results: MusicSearchResult[];
}>();
function trendingCacheKey(limit: number, page: number): string {
  return `${Math.max(1, Math.min(limit, 50))}:${Math.max(1, Math.min(page, 20))}`;
}
function invalidateTrendingCache(): void {
  trendingCache.clear();
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
    const bin = resolveExecutable("yt-dlp");
    if (!bin) {
      log.warn("yt-dlp not found on PATH; install via `mirais extras`");
      resolve({
        ok: false,
        stdout: "",
        stderr: "yt-dlp executable not found on PATH (Windows users may need pip --user install which puts scripts under %APPDATA%\\Python\\PythonXXX\\Scripts)",
      });
      return;
    }
    // windowsHide stops Windows from spawning a console window each time
    // yt-dlp is invoked (this was the source of the black console popping
    // up over the dashboard every time the user opened Music). On Linux
    // and macOS the option is ignored.
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

function isGoodTrendingCandidate(track: MusicSearchResult): boolean {
  if (!track.title || track.duration_sec == null) return false;
  if (track.duration_sec < MIN_TRENDING_DURATION_SEC || track.duration_sec > MAX_TRENDING_DURATION_SEC) return false;
  const title = track.title.toLowerCase();
  const channel = (track.channel ?? "").toLowerCase();
  return !TRENDING_BLOCKLIST.some((re) => re.test(title) || re.test(channel));
}

function dedupeTracks(tracks: MusicSearchResult[]): MusicSearchResult[] {
  const seen = new Set<string>();
  const out: MusicSearchResult[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

export async function searchMusic(query: string, limit = 20, page = 1): Promise<{ source: "yt-dlp" | "invidious"; results: MusicSearchResult[] }> {
  const trimmed = query.trim();
  if (!trimmed) return { source: "yt-dlp", results: [] };
  const safeLimit = Math.max(1, Math.min(limit, 30));
  const safePage = Math.max(1, Math.min(page, 20));
  const fetchCount = safeLimit * safePage;
  const offset = (safePage - 1) * safeLimit;

  // Try yt-dlp first — it returns one JSON object per line when given --dump-json.
  const dlp = await runYtDlp([
    "--dump-json",
    "--default-search", "ytsearch",
    "--playlist-end", String(fetchCount),
    "--no-warnings",
    "--flat-playlist",
    `ytsearch${fetchCount}:${trimmed}`,
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
        if (out.length >= fetchCount) break;
      } catch {
        /* skip non-JSON line */
      }
    }
    if (out.length) return { source: "yt-dlp", results: out.slice(offset, offset + safeLimit) };
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
        .slice(offset, offset + safeLimit);
      if (mapped.length) return { source: "invidious", results: mapped };
    } catch (err) {
      log.debug("invidious instance failed", { base, err: err instanceof Error ? err.message : String(err) });
    }
  }

  return { source: "yt-dlp", results: [] };
}

// Short-lived cache of resolved stream URLs. yt-dlp's "--get-url" call is
// the slowest step of every stream request (~1-3s per video) — without
// this, refreshing the dashboard (which re-fetches /api/music/stream for
// the restored snapshot) hits yt-dlp again on every reload. Cached for
// the lifetime that the upstream CDN URL is realistically valid. If the
// stream later returns 403 (expired signature), the dashboard falls back
// to a fresh resolve via the audio error handler.
const STREAM_URL_CACHE_TTL_MS = 5 * 60_000;
const streamUrlCache = new Map<string, { url: string; contentType?: string; via: "yt-dlp" | "invidious"; expiresAt: number }>();

/** Resolve an audio stream URL for a YouTube video id. Returns a redirect URL. */
export async function resolveAudioStreamUrl(videoId: string): Promise<{ url: string; contentType?: string; via: "yt-dlp" | "invidious" } | null> {
  if (!/^[A-Za-z0-9_-]{6,15}$/.test(videoId)) return null;

  const cached = streamUrlCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, contentType: cached.contentType, via: cached.via };
  }

  // Try yt-dlp first.
  const dlp = await runYtDlp([
    "--get-url",
    "--format", "bestaudio/best",
    "--no-warnings",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  if (dlp.ok) {
    const url = dlp.stdout.trim().split("\n")[0] ?? "";
    if (url.startsWith("http")) {
      streamUrlCache.set(videoId, { url, via: "yt-dlp", expiresAt: Date.now() + STREAM_URL_CACHE_TTL_MS });
      return { url, via: "yt-dlp" };
    }
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
      if (audio?.url) {
        streamUrlCache.set(videoId, { url: audio.url, contentType: audio.type, via: "invidious", expiresAt: Date.now() + STREAM_URL_CACHE_TTL_MS });
        return { url: audio.url, contentType: audio.type, via: "invidious" };
      }
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
 * Fetch trending music videos. Mirais tries yt-dlp first using a
 * `ytsearch` query that surfaces the most-viewed music uploads. We then
 * sort by view count so the list reflects "trending" rather than a static
 * ranking. Invidious has a stable `/api/v1/trending?type=music` endpoint
 * that we use as a fallback — both sources are public and don't need keys.
 *
 * Note: yt-dlp cannot extract YouTube's `/feed/trending?bp=...` URL as a
 * playlist (it's a "tab", not a list), so we approximate trending by
 * searching for `ytsearch` and re-sorting by view_count.
 */
export async function fetchTrending(limit = 20, page = 1, force = false): Promise<{ source: "yt-dlp" | "invidious"; results: MusicSearchResult[] }> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const safePage = Math.max(1, Math.min(page, 20));
  const offset = (safePage - 1) * safeLimit;
  const cacheKey = trendingCacheKey(safeLimit, safePage);

  if (!force) {
    const cached = trendingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() && cached.results.length >= offset + 1) {
      return {
        source: cached.source,
        results: cached.results.slice(offset, offset + safeLimit),
      };
    }
  } else {
    // Force-refresh: drop every cached page so all dashboards see the
    // freshly fetched results on the next request.
    invalidateTrendingCache();
  }

  const queries = shuffleInPlace([...TRENDING_QUERY_POOL]).slice(0, 4);
  const collected: MusicSearchResult[] = [];
  for (const query of queries) {
    const dlp = await runYtDlp([
      "--dump-json",
      "--flat-playlist",
      "--no-warnings",
      "--playlist-end", String(Math.max(20, (offset + safeLimit) * 2)),
      "--default-search", "ytsearch",
      `ytsearch${Math.max(20, (offset + safeLimit) * 2)}:${query}`,
    ]);
    if (!dlp.ok) {
      log.warn("yt-dlp trending query failed", { query, stderr: dlp.stderr.slice(0, 300) });
      continue;
    }
    for (const line of dlp.stdout.split("\n")) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      try {
        const parsed = JSON.parse(trimmedLine) as Parameters<typeof mapDlpJson>[0];
        const mapped = mapDlpJson(parsed);
        if (mapped && isGoodTrendingCandidate(mapped)) collected.push(mapped);
      } catch {
        /* skip non-JSON line */
      }
    }
  }
  const randomized = shuffleInPlace(dedupeTracks(collected));
  if (randomized.length) {
    trendingCache.set(trendingCacheKey(safeLimit, safePage), {
      expiresAt: Date.now() + TRENDING_CACHE_TTL_MS,
      source: "yt-dlp",
      results: randomized,
    });
    return { source: "yt-dlp", results: randomized.slice(offset, offset + safeLimit) };
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
        }));
      if (mapped.length) {
        const unique = dedupeTracks(mapped);
        trendingCache.set(trendingCacheKey(safeLimit, safePage), {
          expiresAt: Date.now() + TRENDING_CACHE_TTL_MS,
          source: "invidious",
          results: unique,
        });
        return { source: "invidious", results: unique.slice(offset, offset + safeLimit) };
      }
    } catch (err) {
      log.debug("invidious instance failed for trending", { base, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return { source: "yt-dlp", results: [] };
}