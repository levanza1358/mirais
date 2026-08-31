import { z } from "zod";
import net from "node:net";

/**
 * Upstream URL safety.
 *
 * Provider and account base URLs are operator-supplied and are fetched *with
 * the account credential attached*. Validating them with `z.string().url()`
 * alone accepts `http://169.254.169.254/...` (cloud metadata), `http://10.0.0.5`
 * (internal services), and loopback addresses — so a malicious or mistaken
 * base URL turns the gateway into a credential-carrying SSRF proxy.
 *
 * Mirais binds to a trusted network by design and its admin API is
 * unauthenticated, so this is defence in depth rather than a tenant boundary.
 * It is still worth having: the cost is a blocklist, and the failure mode it
 * prevents is credential exfiltration.
 */

/** Loopback, link-local, and RFC1918 style ranges that must never be fetched. */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;                          // 0.0.0.0/8 "this host"
  if (a === 10) return true;                         // private
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true;                         // multicast + reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80")) return true;          // link-local
  if (/^f[cd]/.test(lower)) return true;              // unique local fc00::/7
  if (lower.startsWith("ff")) return true;            // multicast
  // IPv4-mapped (::ffff:10.0.0.1) inherits the IPv4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
  return false;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal"]);

/**
 * True when a hostname must not be fetched as an upstream. Hostnames that are
 * not literal IPs are checked by name only — resolving them here would still
 * leave a DNS-rebinding window, so `assertSafeUpstreamUrl` is also applied at
 * request time rather than only at configuration time.
 */
export function isBlockedUpstreamHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  const version = net.isIP(host.replace(/^\[|\]$/g, ""));
  if (version === 4) return isBlockedIPv4(host);
  if (version === 6) return isBlockedIPv6(host);
  return false;
}

export interface UpstreamUrlOptions {
  /**
   * Allow loopback and private addresses. Needed for genuinely local
   * upstreams such as the GitHub Copilot sidecar and Ollama.
   */
  allowPrivate?: boolean;
}

/**
 * Throws when `url` is not a safe upstream target. Returns the parsed URL so
 * callers can reuse it.
 */
export function assertSafeUpstreamUrl(url: string, options: UpstreamUrlOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme '${parsed.protocol}' — only http and https are allowed`);
  }
  if (!options.allowPrivate && isBlockedUpstreamHost(parsed.hostname)) {
    throw new Error(`Host '${parsed.hostname}' is not an allowed upstream (loopback, private, or link-local address)`);
  }
  return parsed;
}

export function isSafeUpstreamUrl(url: string, options: UpstreamUrlOptions = {}): boolean {
  try {
    assertSafeUpstreamUrl(url, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * A zod schema for operator-supplied base URLs. Private hosts are permitted
 * because self-hosted upstreams (Ollama, the Copilot sidecar, a LAN proxy) are
 * legitimate; the scheme check and the request-time redirect guard still apply.
 */
export const upstreamBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Base URL must use http or https");

/**
 * Follow redirects manually so credentials are never replayed to a host the
 * operator did not configure. `fetch` with the default `redirect: "follow"`
 * forwards the Authorization header across hops, which is exactly how an
 * open-redirect on a trusted upstream becomes credential exfiltration.
 */
export async function fetchNoCrossHostRedirect(
  url: string,
  init: RequestInit,
  maxRedirects = 3,
  options: UpstreamUrlOptions = {},
): Promise<Response> {
  const origin = assertSafeUpstreamUrl(url, options);
  let current = origin.toString();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    const next = new URL(location, current);
    if (next.host !== origin.host) {
      await res.body?.cancel();
      throw new Error(`Upstream redirected to a different host (${next.host}); refusing to forward credentials`);
    }
    try {
      assertSafeUpstreamUrl(next.toString(), options);
    } catch (error) {
      await res.body?.cancel();
      throw error;
    }
    await res.body?.cancel();
    current = next.toString();
  }
  throw new Error(`Upstream exceeded ${maxRedirects} redirects`);
}
