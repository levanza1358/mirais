import { config } from "./config";
import { timingSafeEqual } from "./utils/id";
import { log } from "./utils/logger";

const COOKIE_NAME = "mirais_session";

interface SessionPayload {
  iat: number;
  exp: number;
}

function toB64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function fromB64(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Buffer.from(sig).toString("base64url");
}

export async function createSessionToken(ttlHours?: number): Promise<string> {
  const ttl = ttlHours ?? config.sessionTtlHours;
  const payload: SessionPayload = {
    iat: Date.now(),
    exp: Date.now() + ttl * 3600_000,
  };
  const body = toB64(JSON.stringify(payload));
  const sig = await hmac(body);
  return `${body}.${sig}`;
}

export async function verifySessionToken(token: string): Promise<boolean> {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(body);
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(fromB64(body)) as SessionPayload;
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, ttlHours?: number): string {
  const maxAge = (ttlHours ?? config.sessionTtlHours) * 3600;
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

// ── login rate limiting: 5 attempts / 5 min per IP ──
const attempts = new Map<string, { count: number; resetAt: number }>();

export function loginAllowed(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) return true;
  return a.count < 5;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
  } else {
    a.count += 1;
  }
}

export function recordLoginSuccess(ip: string): void {
  attempts.delete(ip);
}

/**
 * Global before-handle guard: protects all /api/* routes except /api/auth/*
 * and /api/health. Must be registered directly on the root app (not inside a
 * scoped plugin) so it applies to every admin route.
 */
export async function sessionGuardHandle(ctx: { request: Request; path: string; set: { status?: number | string } }): Promise<{ error: string } | undefined> {
  const { request, path, set } = ctx;
  if (!path.startsWith("/api/")) return undefined;
  if (path.startsWith("/api/auth/") || path === "/api/health") return undefined;

  const token = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (!token || !(await verifySessionToken(token))) {
    set.status = 401;
    log.debug("unauthorized admin access", { path });
    return { error: "Unauthorized" };
  }
  return undefined;
}

export { COOKIE_NAME };
