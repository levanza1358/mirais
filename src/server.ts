import { Elysia } from "elysia";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { getDb } from "./store/db";
import { sessionGuardHandle } from "./session";
import { authRoutes } from "./admin/auth";
import { oauthRoutes } from "./admin/oauth";
import { providerRoutes } from "./admin/providers";
import { aliasRoutes, comboRoutes, keyRoutes } from "./admin/routes";
import { settingsRoutes, statsRoutes, logRoutes, healthRoutes } from "./admin/settings";
import { proxyRoutes } from "./admin/proxies";
import { backupRoutes } from "./admin/backups";
import { integrationRoutes } from "./admin/integrations";
import { v1Routes } from "./proxy/routes";
import { GatewayError, AdminError } from "./shared/errors";
import { LogsRepo } from "./store/repos/logs";
import { SettingsRepo } from "./store/repos/settings";
import { ProvidersRepo } from "./store/repos/providers";
import { baseUrlFor } from "./proxy/router";
import { ensureFreshToken, fetchCodexUsage, isOAuthAccount } from "./proxy/codex";
import { isCodeBuddyProviderType, codeBuddyChatUrl, CODEBUDDY_MODELS } from "./admin/providers";
import { log, setLogLevel } from "./utils/logger";
import { assertNoPasswordSafeToExpose } from "./admin/auth";
function classifyWarmupStatus(ok: boolean, status: number, detail?: string | null): "healthy" | "rate_limited" | "failing" {
  if (ok) return "healthy";
  const lower = (detail ?? "").toLowerCase();
  if (status === 429 || /quota|credits exhausted|rate limit|rate_limit|too many requests/.test(lower)) {
    return "rate_limited";
  }
  return "failing";
}

setLogLevel(config.logLevel);

const db = getDb(config.dbPath);

// ── retention purge (daily) ──
function purgeOldLogs() {
  const settings = new SettingsRepo(db);
  const days = Number(settings.get("log_retention_days") ?? 30);
  const removed = new LogsRepo(db).purgeOlderThan(days);
  if (removed > 0) log.info("purged old request logs", { removed, retention_days: days });
}

async function runAutoWarmups() {
  const settings = new SettingsRepo(db);
  const cfg = settings.getJson<{ enabled: boolean; interval_minutes: number }>("warmup_config") ?? { enabled: false, interval_minutes: 30 };
  if (!cfg.enabled) return;
  try {
    const providersRepo = new ProvidersRepo(db);
    const logsRepo = new LogsRepo(db);
    const list = providersRepo.list().filter((p) => p.enabled);
    for (const p of list) {
      const accounts = providersRepo.listAccounts(p.id).filter((a) => a.enabled);
      for (const acc of accounts) {
        const started = Date.now();
        let ok = false;
        let status = 0;
        let detail: string | null = null;
        try {
          if (isCodeBuddyProviderType(p.type)) {
            // CodeBuddy has no /models endpoint — warmup via chat completions
            const res = await fetch(codeBuddyChatUrl(p), {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Authorization: `Bearer ${acc.api_key}`,
                "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
                "X-Product": "SaaS",
                "X-IDE-Type": "CLI",
                "X-IDE-Name": "CLI",
                "x-requested-with": "XMLHttpRequest",
                "x-codebuddy-request": "1",
                accept: "text/event-stream",
              },
              body: JSON.stringify({
                model: (CODEBUDDY_MODELS[p.type] ?? ["glm-5.2"])[0] ?? "glm-5.2",
                max_tokens: 16,
                stream: true,
                messages: [
                  { role: "system", content: "You are a helpful AI assistant." },
                  { role: "user", content: "Reply with exactly: warmup ok" },
                ],
              }),
              signal: AbortSignal.timeout(20_000),
            });
            ok = res.ok;
            status = res.status;
            detail = res.ok ? "CodeBuddy chat warmup ok" : `HTTP ${res.status}`;
          } else if (isOAuthAccount(acc)) {
            const accessToken = await ensureFreshToken(providersRepo, acc as never);
            const usage = await fetchCodexUsage(acc as never, accessToken);
            if (usage.limit_reached) {
              ok = false;
              status = 429;
              detail = "Codex quota exhausted";
            } else {
              ok = true;
              status = 200;
              detail = "ChatGPT login active";
            }
          } else {
            const base = baseUrlFor(p);
            const headers: Record<string, string> = p.type === "anthropic"
              ? { "x-api-key": acc.api_key, "anthropic-version": "2023-06-01" }
              : { Authorization: `Bearer ${acc.api_key}` };
            const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) });
            ok = res.ok;
            status = res.status;
            detail = res.ok ? null : `HTTP ${res.status}`;
          }
        } catch (err) {
          ok = false;
          status = 0;
          detail = err instanceof Error ? err.message : String(err);
        }

        providersRepo.updateAccount(acc.id, {
          lastWarmupAt: new Date().toISOString(),
          lastWarmupStatus: classifyWarmupStatus(ok, status, detail),
          lastWarmupLatencyMs: Date.now() - started,
          lastWarmupDetail: detail,
        });

        logsRepo.insert({
          keyId: null,
          endpoint: "/providers/warmup/auto",
          requestedModel: `${p.name}:${acc.label}`,
          provider: p.name,
          model: null,
          attempts: 1,
          status: ok ? "success" : "error",
          httpStatus: status,
          error: ok ? null : detail,
          inputTokens: null,
          outputTokens: null,
          latencyMs: Date.now() - started,
          tokensSaved: 0,
          requestBody: `Auto warmup check for account ${acc.label}`,
          responseBody: ok ? `OK (${Date.now() - started}ms)` : `ERROR: ${detail ?? `HTTP ${status}`}`,
          kind: "warmup",
        });

        log.debug("auto warmup checked account", { provider: p.name, account: acc.label, ok });
      }
    }
  } catch (err) {
    log.warn("auto warmup scheduler failed", { err: err instanceof Error ? err.message : String(err) });
  }
}
purgeOldLogs();
setInterval(purgeOldLogs, 24 * 3600 * 1000).unref();
runAutoWarmups();
setInterval(() => {
  const cfg = new SettingsRepo(db).getJson<{ enabled: boolean; interval_minutes: number }>("warmup_config") ?? { enabled: false, interval_minutes: 30 };
  if (cfg.enabled) runAutoWarmups();
}, 60 * 1000).unref();

// ── dashboard static files ──
const dashboardDist = path.join(import.meta.dir, "..", "dashboard", "dist");
const hasDashboard = fs.existsSync(path.join(dashboardDist, "index.html"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const app = new Elysia()
  .onError(({ error, set, request }) => {
    if (error instanceof GatewayError) {
      set.status = error.status;
      return error.toJSON();
    }
    if (error instanceof AdminError) {
      set.status = error.status;
      return error.toJSON();
    }
    log.error("unhandled error", {
      err: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      path: new URL(request.url).pathname,
      method: request.method,
    });
    set.status = 500;
    return { error: { message: "Internal server error", type: "server_error", code: null } };
  })
  .onBeforeHandle(sessionGuardHandle)
  .use(healthRoutes(db))
  .use(authRoutes(db))
  .use(oauthRoutes(db))
  .use(providerRoutes(db))
  .use(aliasRoutes(db))
  .use(comboRoutes(db))
  .use(keyRoutes(db))
  .use(settingsRoutes(db))
  .use(proxyRoutes(db))
  .use(backupRoutes(db))
  .use(integrationRoutes(db))
  .use(statsRoutes(db))
  .use(logRoutes(db))
  .use(v1Routes(db))
  // ── static dashboard + SPA fallback ──
  .get("/*", ({ path: p, set }) => {
    if (!hasDashboard) {
      set.status = 200;
      set.headers["content-type"] = "text/plain; charset=utf-8";
      return "Mirais is running. Dashboard not built yet — run `bun run build` or use `bun run dev` for the Vite dev server.";
    }
    const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, "");
    let file = path.join(dashboardDist, safe === "/" ? "index.html" : safe);
    if (!file.startsWith(dashboardDist)) {
      set.status = 403;
      return "Forbidden";
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(dashboardDist, "index.html"); // SPA fallback
    }
    const ext = path.extname(file).toLowerCase();
    set.headers["content-type"] = MIME[ext] ?? "application/octet-stream";
    if (ext !== ".html") set.headers["cache-control"] = "public, max-age=31536000, immutable";
    return fs.readFileSync(file);
  })
  .listen({ port: config.port, hostname: config.host });

log.info("mirais started", {
  url: `http://${config.host}:${config.port}`,
  dashboard: hasDashboard ? "serving built dashboard" : "not built",
  db: config.dbPath,
  dashboard_password: !!config.dashboardPassword,
});

// Guardrail: refuse to expose passwordless mode to non-loopback addresses.
// Done after the routes are registered so the SettingsRepo global is set.
try {
  assertNoPasswordSafeToExpose(config.host);
} catch (err) {
  log.error("startup guard failed", { err: err instanceof Error ? err.message : String(err) });
  process.exit(2);
}

export type App = typeof app;
export { app };
