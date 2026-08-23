import { Elysia } from "elysia";
import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { config } from "../config";
import { AdminError } from "../shared/errors";
import { SettingsRepo } from "../store/repos/settings";
import { log } from "../utils/logger";

const COOKIE = "mirais_session";
const HASH_KEY = "dashboard_password_hash";
const SECRET_KEY = "session_secret";
const HOURS_KEY = "dashboard_session_hours";
const DEFAULT_PASSWORD = "12345678";
const REMEMBER_TTL_HOURS = 24 * 30;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;

const attempts = new Map<string, { count: number; resetAt: number }>();

/**
 * Paths that stay reachable without a dashboard session. The gateway proxy
 * (`/v1/*`) is never covered here: it authenticates with gateway keys, so a
 * dashboard password never affects API clients.
 */
function isPublicPath(path: string): boolean {
  if (!path.startsWith("/api/")) return true;
  return path.startsWith("/api/auth/") || path === "/api/health";
}

function storedHash(settings: SettingsRepo): string | null {
  const existing = settings.get(HASH_KEY);
  if (existing) return existing;
  if (existing === "") return null; // explicitly disabled by the operator
  const hash = Bun.password.hashSync(config.dashboardPassword ?? DEFAULT_PASSWORD);
  settings.set(HASH_KEY, hash);
  log.info("dashboard password initialised", { source: config.dashboardPassword ? "DASHBOARD_PASSWORD" : "default" });
  return hash;
}

/** How long a normal (non-remembered) session stays valid. */
function sessionHours(settings: SettingsRepo): number {
  const saved = Number(settings.get(HOURS_KEY));
  return Number.isFinite(saved) && saved > 0 ? saved : config.sessionTtlHours;
}

/** Signing key rotates with the password, so a change revokes every session. */
function signingKey(settings: SettingsRepo, hash: string): string {
  let secret = settings.get(SECRET_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    settings.set(SECRET_KEY, secret);
  }
  return `${secret}:${hash}`;
}

function sign(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function issue(key: string, ttlHours: number): { token: string; maxAge: number } {
  const maxAge = Math.floor(ttlHours * 3600);
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + maxAge * 1000 })).toString("base64url");
  return { token: `${payload}.${sign(payload, key)}`, maxAge };
}

function isValidToken(token: string, key: string): boolean {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = Buffer.from(sign(payload, key));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

function cookieValue(header: string | null): string | null {
  for (const part of header?.split(";") ?? []) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function cookieHeader(token: string, maxAge: number): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function throttle(ip: string): void {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= Date.now()) return;
  if (entry.count >= MAX_ATTEMPTS) {
    throw new AdminError(429, `Too many attempts. Try again in ${Math.ceil((entry.resetAt - Date.now()) / 1000)}s`);
  }
}

function recordFailure(ip: string): void {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= Date.now()) attempts.set(ip, { count: 1, resetAt: Date.now() + ATTEMPT_WINDOW_MS });
  else entry.count += 1;
}

export function passwordEnabled(db: Database): boolean {
  return storedHash(new SettingsRepo(db)) !== null;
}

export function hasValidSession(db: Database, request: Request): boolean {
  const settings = new SettingsRepo(db);
  const hash = storedHash(settings);
  if (!hash) return true;
  const token = cookieValue(request.headers.get("cookie"));
  return token !== null && isValidToken(token, signingKey(settings, hash));
}

/** Rejects unauthenticated `/api/*` traffic once a password is configured. */
export function sessionGuard(db: Database) {
  return new Elysia({ name: "session-guard" }).onBeforeHandle({ as: "global" }, ({ request, path }) => {
    if (isPublicPath(path)) return;
    if (!hasValidSession(db, request)) throw new AdminError(401, "Authentication required");
  });
}

export function authRoutes(db: Database) {
  const settings = new SettingsRepo(db);

  return new Elysia({ prefix: "/api/auth" })
    .get("/check", ({ request }) => {
      const hash = storedHash(settings);
      return {
        password_set: hash !== null,
        authenticated: hasValidSession(db, request),
        session_hours: sessionHours(settings),
        setup_required: false,
        passwordless: hash === null,
      };
    })
    .post("/login", ({ body, set, request, server }) => {
      const hash = storedHash(settings);
      if (!hash) return { ok: true, passwordless: true };
      const ip = server?.requestIP(request)?.address ?? "unknown";
      throttle(ip);
      const { password, remember } = (body ?? {}) as { password?: unknown; remember?: unknown };
      if (typeof password !== "string" || !Bun.password.verifySync(password, hash)) {
        recordFailure(ip);
        throw new AdminError(401, "Wrong password");
      }
      attempts.delete(ip);
      const ttl = remember === true ? REMEMBER_TTL_HOURS : sessionHours(settings);
      const { token, maxAge } = issue(signingKey(settings, hash), ttl);
      set.headers["set-cookie"] = cookieHeader(token, maxAge);
      return { ok: true };
    })
    .post("/logout", ({ set }) => {
      set.headers["set-cookie"] = cookieHeader("", 0);
      return { ok: true };
    })
    .post("/session-hours", ({ body, request }) => {
      if (!hasValidSession(db, request)) throw new AdminError(401, "Authentication required");
      const hours = Number((body as { hours?: unknown } | null)?.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > REMEMBER_TTL_HOURS) {
        throw new AdminError(400, `Session hours must be between 1 and ${REMEMBER_TTL_HOURS}`);
      }
      settings.set(HOURS_KEY, String(hours));
      log.info("dashboard session lifetime updated", { hours });
      return { ok: true, session_hours: hours };
    })
    .post("/password", ({ body, set, request }) => {
      const current = storedHash(settings);
      if (current && !hasValidSession(db, request)) throw new AdminError(401, "Authentication required");
      const { current_password: currentPassword, new_password: next } = (body ?? {}) as {
        current_password?: unknown;
        new_password?: unknown;
      };
      if (current && !(typeof currentPassword === "string" && Bun.password.verifySync(currentPassword, current))) {
        throw new AdminError(401, "Wrong current password");
      }
      if (next === null || next === "") {
        settings.set(HASH_KEY, "");
        set.headers["set-cookie"] = cookieHeader("", 0);
        log.info("dashboard password removed");
        return { ok: true, password_set: false };
      }
      if (typeof next !== "string" || next.length < 8) throw new AdminError(400, "Password must be at least 8 characters");
      const hash = Bun.password.hashSync(next);
      settings.set(HASH_KEY, hash);
      const { token, maxAge } = issue(signingKey(settings, hash), sessionHours(settings));
      set.headers["set-cookie"] = cookieHeader(token, maxAge);
      log.info("dashboard password updated");
      return { ok: true, password_set: true };
    });
}
