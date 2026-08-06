import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { config } from "../config";
import { SettingsRepo } from "../store/repos/settings";
import { createSessionToken, verifySessionToken, sessionCookie, clearSessionCookie, loginAllowed, recordLoginFailure, recordLoginSuccess } from "../session";
import { timingSafeEqual } from "../utils/id";
import { passwordChangeSchema } from "../shared/schemas";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";

async function hashPassword(pw: string): Promise<string> {
  return Bun.password.hash(pw, { algorithm: "bcrypt", cost: 10 });
}

export function authRoutes(db: Database) {
  const settings = new SettingsRepo(db);

  return new Elysia({ prefix: "/api/auth" })
    .post("/login", async ({ body, set, request }) => {
      const { password, remember } = (body ?? {}) as { password?: string; remember?: boolean };
      const ip = request.headers.get("x-forwarded-for") ?? "local";
      if (!loginAllowed(ip)) {
        set.status = 429;
        return { error: "Too many attempts. Try again in a few minutes." };
      }
      const stored = settings.get("dashboard_password_hash");
      const candidate = password ?? "";
      const envPassword = config.dashboardPassword;
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
      // "Never ask password" → 30-day session; otherwise the standard TTL
      // (default 12h, configurable via SESSION_TTL_HOURS — keep it ≤ 6h for
      // short-lived logins if desired).
      const ttl = remember ? 24 * 30 : undefined;
      set.headers["set-cookie"] = sessionCookie(await createSessionToken(ttl), ttl);
      return { ok: true, setup_required: !stored && !envPassword };
    })
    .post("/logout", ({ set }) => {
      set.headers["set-cookie"] = clearSessionCookie();
      return { ok: true };
    })
    .get("/check", async ({ request }) => {
      // Always 200: the SPA needs to distinguish "no password set" from
      // "not logged in" without leaking anything sensitive.
      const cookie = request.headers.get("cookie") ?? "";
      const m = /mirais_session=([^;]+)/.exec(cookie);
      const valid = m?.[1] ? await verifySessionToken(m[1]) : false;
      const stored = settings.get("dashboard_password_hash");
      return { authenticated: valid, setup_required: !stored && !config.dashboardPassword };
    })
    .post("/setup", async ({ body, set }) => {
      // only allowed when no password has ever been set
      if (settings.get("dashboard_password_hash")) {
        set.status = 409;
        return { error: "Password already configured" };
      }
      const { password } = (body ?? {}) as { password?: string };
      if (!password || password.length < 6) {
        set.status = 400;
        return { error: "Password must be at least 6 characters" };
      }
      settings.set("dashboard_password_hash", await hashPassword(password));
      log.info("dashboard password set (first-run setup)");
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
    });
}
