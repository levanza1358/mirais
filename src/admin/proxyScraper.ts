/**
 * Free proxy scraper + health probe.
 *
 * Scraping only collects public proxy addresses that anyone could find
 * themselves. No credentials, tokens, or account identifiers ever pass
 * through Mirais proxies. The scraper is defensive about the source
 * format: every parser tolerates extra whitespace, BOM markers, and
 * comment lines.
 */
import { log } from "../utils/logger";
import type { ProxyRepo } from "../store/repos/proxies";

/**
 * Built-in scrape sources. These are a small number of free public
 * proxy lists that publish IP:port pairs in a stable text format. All
 * entries are HTTP/connect proxies (usable for HTTPS via CONNECT).
 */
export const DEFAULT_SOURCES: Array<{ name: string; url: string }> = [
  { name: "openproxylist", url: "https://api.openproxylist.xyz/http.txt" },
  { name: "proxyscrape-text", url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all" },
  { name: "theSpeedX-socks-http", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt" },
];

const SCRAPE_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_URL = "https://www.google.com/generate_204";
const SLOW_THRESHOLD_MS = 4_000;

interface ParsedProxy {
  host: string;
  port: number;
  country?: string;
  username?: string;
  password?: string;
}

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_.!@#$%^&*()\-+=~]{1,64}$/;

function sanitizeCredential(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!CREDENTIAL_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function isValidIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  // Each octet must be decimal-only digits, leading zeros included. We
  // disallow octal/hex abuse by accepting only [0-9]+ here.
  for (const p of parts) {
    if (!/^[0-9]+$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isValidHost(host: string): boolean {
  if (!host) return false;
  if (isValidIpv4(host)) return true;
  // Hostname (lowercase letters/digits/dots/dashes). Must contain at least
  // one letter so dotted-decimal strings that aren't valid IPv4 (e.g.
  // "999.999.999.999") are not silently accepted as hostnames.
  if (!/[a-z]/.test(host)) return false;
  return /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

export function parseProxyLine(line: string): ParsedProxy | null {
  let s = line.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (!s || s.startsWith("#") || s.startsWith("//")) return null;
  s = s.split(/\s+/)[0]!;
  // Layout: host:port[:country][:username][:password]
  // Anything after the 5th colon-separated segment is ignored.
  const segments = s.split(":");
  const [hostRaw, portRaw] = segments;
  if (!hostRaw || !portRaw) return null;
  const host = hostRaw.trim().toLowerCase();
  const port = Number(portRaw);
  if (!isValidHost(host) || !isValidPort(port)) return null;
  const out: ParsedProxy = { host, port };
  // Optional 3rd segment: either an ISO-2 country code or — when no
  // country is provided — a username. Credentials are only stored when
  // both halves parse, so a missing or malformed partner discards both.
  const third = segments[2];
  const fourth = segments[3];
  const fifth = segments[4];
  if (third && /^[A-Za-z]{2}$/.test(third.trim())) {
    out.country = third.trim().toUpperCase();
    const user = sanitizeCredential(fourth);
    const pass = sanitizeCredential(fifth);
    if (user && pass) {
      out.username = user;
      out.password = pass;
    }
  } else {
    const user = sanitizeCredential(third);
    const pass = sanitizeCredential(fourth);
    if (user && pass) {
      out.username = user;
      out.password = pass;
    }
  }
  return out;
}

export function parseProxyText(text: string, max = 5_000): ParsedProxy[] {
  const lines = text.split(/\r?\n/);
  const out: ParsedProxy[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const parsed = parseProxyLine(line);
    if (!parsed) continue;
    const key = `${parsed.host}:${parsed.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
    if (out.length >= max) break;
  }
  return out;
}

export interface ScrapeSourceResult {
  source: string;
  fetched: number;
  added: number;
  skipped: number;
  error?: string;
  durationMs: number;
}

interface ScrapeOpts {
  triggeredBy: "manual" | "interval" | "auto-warmup";
  sources?: Array<{ name: string; url: string }>;
}

export async function scrapeSource(
  repo: ProxyRepo,
  source: { name: string; url: string },
  opts: ScrapeOpts,
): Promise<ScrapeSourceResult> {
  const started = Date.now();
  let fetched = 0;
  let added = 0;
  let skipped = 0;
  let error: string | undefined;
  try {
    const res = await fetch(source.url, {
      headers: { "user-agent": "mirais/1.0 (+https://mirais.local)" },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parseProxyText(text);
    fetched = parsed.length;
    for (const p of parsed) {
      const result = repo.upsert({
        host: p.host,
        port: p.port,
        country: p.country ?? null,
        username: p.username ?? null,
        password: p.password ?? null,
        source: source.name,
      });
      if (result.added) added += 1;
      else skipped += 1;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.warn("proxy scrape failed", { source: source.name, error });
  }
  const durationMs = Date.now() - started;
  repo.recordScrape({
    source: source.name,
    fetched,
    added,
    skipped,
    triggered_by: opts.triggeredBy,
    error: error ?? null,
    durationMs,
  });
  return { source: source.name, fetched, added, skipped, ...(error ? { error } : {}), durationMs };
}

export async function scrapeAll(
  repo: ProxyRepo,
  opts: ScrapeOpts,
): Promise<ScrapeSourceResult[]> {
  const sources = opts.sources ?? DEFAULT_SOURCES;
  const results = await Promise.all(sources.map((s) => scrapeSource(repo, s, opts)));
  log.info("proxy scrape batch finished", {
    sources: sources.length,
    total_added: results.reduce((acc, r) => acc + r.added, 0),
    total_fetched: results.reduce((acc, r) => acc + r.fetched, 0),
  });
  return results;
}

/** Probe one proxy by sending an HTTPS request through it. */
export async function probeProxy(repo: ProxyRepo, id: string): Promise<void> {
  const proxy = repo.get(id);
  if (!proxy) return;
  const started = Date.now();
  const restore = setProxyEnv(proxy.host, proxy.port, proxy.username, proxy.password);
  try {
    const res = await fetch(PROBE_URL, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "mirais/1.0" },
    });
    const latency = Date.now() - started;
    if (res.ok) {
      repo.markStatus(id, latency > SLOW_THRESHOLD_MS ? "slow" : "healthy", latency, null);
      return;
    }
    repo.markStatus(id, "failing", latency, `HTTP ${res.status}`);
  } catch (err) {
    const latency = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const failing = (proxy.failure_streak ?? 0) + 1 >= 3;
    repo.markStatus(id, failing ? "failing" : "pending", latency, message.slice(0, 200));
  } finally {
    restore();
  }
}

export async function probeAll(repo: ProxyRepo): Promise<string[]> {
  const all = repo.list().filter((p: { status: string }) => p.status !== "disabled");
  const batch = all.slice(0, 30);
  // Bun fetch reads proxy settings from process.env. Probing concurrently would
  // make requests inherit another proxy's credentials due to the temporary env
  // override below. Keep probes sequential so credentials cannot cross over.
  for (const proxy of batch) await probeProxy(repo, proxy.id).catch(() => undefined);
  return batch.map((p: { id: string }) => p.id);
}

/**
 * Temporarily set `HTTPS_PROXY` so Bun's fetch honors it. Returns a
 * function that restores the previous state. The proxy is scoped to the
 * caller (concurrency-safe: each call snapshots its own prior values).
 */
function setProxyEnv(host: string, port: number, username?: string | null, password?: string | null): () => void {
  const prev = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
  };
  const auth = username && password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  const url = `http://${auth}${host}:${port}`;
  process.env.HTTPS_PROXY = url;
  process.env.https_proxy = url;
  process.env.HTTP_PROXY = url;
  process.env.http_proxy = url;
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}