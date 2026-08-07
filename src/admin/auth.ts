import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { config } from "../config";
import { SettingsRepo } from "../store/repos/settings";
import {
  createSessionToken,
  verifySessionToken,
  sessionCookie,
  clearSessionCookie,
  loginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "../session";
import { timingSafeEqual } from "../utils/id";
import { passwordChangeSchema } from "../shared/schemas";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";

async function hashPassword(pw: string): Promise<string> {
  return Bun.password.hash(pw, { algorithm: "bcrypt", cost: 10 });
}

/** True when no dashboard password is configured anywhere (env or stored). */
export function dashboardPasswordUnset(settings: SettingsRepo): boolean {
  return !config.dashboardPassword && !settings.get("dashboard_password_hash");
}

/**
 * Refuse to start with passwordless mode exposed beyond loopback. Either set
 * DASHBOARD_PASSWORD in .env or bind to 127.0.0.1 / ::1 / localhost.
 */
export function assertNoPasswordSafeToExpose(host: string): void {
  const settingsRef = (globalThis as { __miraisSettings?: SettingsRepo }).__miraisSettings;
  if (settingsRef && dashboardPasswordUnset(settingsRef)) {
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!loopback) {
      throw new Error(
        `Refusing to start: no dashboard password is set and HOST=${host} is not loopback. ` +
          `Either set DASHBOARD_PASSWORD in .env or bind to 127.0.0.1 / ::1.`,
      );
    }
  }
}

export function authRoutes(db: Database) {
  const settings = new SettingsRepo(db);
  (globalThis as { __miraisSettings?: SettingsRepo }).__miraisSettings = settings;

  return new Elysia({ prefix: "/api/auth" })
    .post("/login", async ({ body, set, request }) => {
      const bodyObj = (body ?? {}) as { password?: string; remember?: boolean };
      const ip = request.headers.get("x-forwarded-for") ?? "local";

      const stored = settings.get("dashboard_password_hash");
      const envPassword = config.dashboardPassword;
      const passwordUnset = !stored && !envPassword;

      if (passwordUnset) {
        // No password anywhere — issue a session automatically. The startup
        // assertion guarantees we only reach this branch when listening on
        // loopback, so this stays safe.
        const ttl = bodyObj.remember ? 24 * 30 : config.sessionTtlHours;
        set.headers["set-cookie"] = sessionCookie(await createSessionToken(ttl), ttl);
        return { ok: true, setup_required: false, passwordless: true };
      }

      if (!loginAllowed(ip)) {
        set.status = 429;
        return { error: "Too many attempts. Try again in a few minutes." };
      }
      const candidate = bodyObj.password ?? "";
      let ok = false;
      if (stored) {
        ok = await Bun.password.verify(candidate, stored);
      } else if (envPassword) {
        ok = timingSafeEqual(candidate, envPassword);
      }
      if (!ok) {
        recordLoginFailure(ip);
        log.warn("dashboard login failed");
        set.status = 401;
        return { error: "Invalid password" };
      }
      recordLoginSuccess(ip);
      const ttl = bodyObj.remember ? 24 * 30 : undefined;
      set.headers["set-cookie"] = sessionCookie(await createSessionToken(ttl), ttl);
      return { ok: true, setup_required: false, passwordless: false };
    })
    .post("/logout", ({ set }) => {
      set.headers["set-cookie"] = clearSessionCookie();
      return { ok: true };
    })
    .get("/check", async ({ request }) => {
      const cookie = request.headers.get("cookie") ?? "";
      const m = /mirais_session=([^;]+)/.exec(cookie);
      const valid = m?.[1] ? await verifySessionToken(m[1]) : false;
      const stored = settings.get("dashboard_password_hash");
      const passwordless = !stored && !config.dashboardPassword;
      return {
        authenticated: valid,
        setup_required: passwordless,
        passwordless,
      };
    })
    .post("/setup", async ({ body, set }) => {
      // Allowed only when no password is currently set. Useful when you
      // later decide to turn passwordless mode back into a password.
      if (settings.get("dashboard_password_hash") || config.dashboardPassword) {
        set.status = 409;
        return { error: "A dashboard password is already configured" };
      }
      const { password } = (body ?? {}) as { password?: string };
      if (!password || password.length < 6) {
        set.status = 400;
        return { error: "Password must be at least 6 characters" };
      }
      settings.set("dashboard_password_hash", await hashPassword(password));
      log.info("dashboard password set (post-setup)");
      set.headers["set-cookie"] = sessionCookie(await createSessionToken());
      return { ok: true };
    })
    .post("/change-password", async ({ body, set, request }) => {
      const cookie = request.headers.get("cookie") ?? "";
      const m = /mirais_session=([^;]+)/.exec(cookie);
      if (!m?.[1] || !(await verifySessionToken(m[1]))) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      const parsed = passwordChangeSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const stored = settings.get("dashboard_password_hash");
      if (stored && !(await Bun.password.verify(parsed.data.current, stored))) {
        set.status = 401;
        return { error: "Current password is incorrect" };
      }
      if (!stored && config.dashboardPassword && !timingSafeEqual(parsed.data.current, config.dashboardPassword)) {
        set.status = 401;
        return { error: "Current password is incorrect" };
      }
      settings.set("dashboard_password_hash", await hashPassword(parsed.data.next));
      log.info("dashboard password changed");
      return { ok: true };
    })
    .post("/disable", async ({ set, request }) => {
      // Drop the stored password and clear the env-bound one by writing
      // an empty marker into settings. The server will then fall back to
      // passwordless mode on the next restart (still loopback-only).
      const cookie = request.headers.get("cookie") ?? "";
      const m = /mirais_session=([^;]+)/.exec(cookie);
      if (!m?.[1] || !(await verifySessionToken(m[1]))) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      settings.set("dashboard_password_hash", "");
      log.info("dashboard password disabled (server still uses DASHBOARD_PASSWORD until restart)");
      return { ok: true, restart_required: true };
    });
}