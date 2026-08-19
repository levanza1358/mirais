import { Elysia } from "elysia";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { getDb } from "./store/db";
import { authRoutes } from "./admin/auth";
import { oauthRoutes } from "./admin/oauth";
import { providerRoutes } from "./admin/providers";
import { aliasRoutes, comboRoutes, keyRoutes } from "./admin/routes";
import { settingsRoutes, statsRoutes, logRoutes, healthRoutes } from "./admin/settings";
import { proxyRoutes } from "./admin/proxies";
import { backupRoutes } from "./admin/backups";
import { musicRoutes } from "./admin/musicRoutes";
import { xaiAdminRoutes } from "./admin/xai-routes";
import { v1Routes } from "./proxy/routes";
import { GatewayError, AdminError } from "./shared/errors";
import { LogsRepo } from "./store/repos/logs";
import { SettingsRepo } from "./store/repos/settings";
import { ProvidersRepo } from "./store/repos/providers";
import { baseUrlFor } from "./proxy/router";
import { codexQuotaDetail, ensureFreshToken, fetchCodexUsage, isCodexQuotaExhausted, isOAuthAccount } from "./proxy/codex";
import { isCodeBuddyProviderType, codeBuddyChatUrl, CODEBUDDY_MODELS } from "./admin/codebuddy-provider";
import { log, setLogLevel } from "./utils/logger";

function classifyWarmupStatus(ok: boolean, status: number, detail?: string | null): "healthy" | "rate_limited" | "failing" {
  if (ok) return "healthy";
  const lower = (detail ?? "").toLowerCase();
  if (status === 429 || /quota|credits exhausted|rate limit|rate_limit|too many requests/.test(lower)) {
    return "rate_limited";
  }
  // 426 is not a failure of the account, it's a version enforcement issue
  if (status === 426 || /426|version|upgrade|outdated/.test(lower)) {
    return "failing";
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
        let planType: string | null | undefined;
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
          } else if (p.type === "xai" && acc.auth_kind === "oauth") {
            // xAI OAuth accounts use Grok CLI endpoint (not api.x.ai)
            const { ensureFreshXaiToken, xaiHeaders } = await import("./proxy/xai");
            const accessToken = await ensureFreshXaiToken(providersRepo, acc);
            // Retry once on transient connect failures (network burst after a
            // proxy scrape can briefly make the Grok endpoint unreachable).
            const GROK_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
            let res: Response | null = null;
            let lastErr: unknown = null;
            for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
              if (attempt > 0) await Bun.sleep(500 * attempt);
              try {
                res = await fetch(GROK_MODELS_URL, {
                  headers: xaiHeaders(accessToken, false, undefined, acc),
                  signal: AbortSignal.timeout(20_000),
                });
              } catch (err) {
                lastErr = err;
              }
            }
            if (!res) {
              throw lastErr instanceof Error ? lastErr : new Error("Unable to connect to Grok endpoint");
            }
            ok = res.ok;
            status = res.status;
            if (res.status === 426) {
              detail = "Grok CLI 426: Version enforcement. Use API key instead.";
            } else {
              detail = res.ok ? "Grok CLI login active" : `HTTP ${res.status}`;
            }
          } else if (p.type === "blackbox") {
            // Blackbox has no /models endpoint — warmup via a tiny chat completion.
            const res = await fetch(`${baseUrlFor(p)}/chat/completions`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Authorization: `Bearer ${acc.api_key}`,
              },
              body: JSON.stringify({
                model: "blackboxai/openai/gpt-5.5",
                max_tokens: 8,
                messages: [{ role: "user", content: "Reply with exactly: warmup ok" }],
              }),
              signal: AbortSignal.timeout(20_000),
            });
            ok = res.ok;
            status = res.status;
            detail = res.ok ? "Blackbox chat warmup ok" : `HTTP ${res.status}`;
          } else if (isOAuthAccount(acc)) {
            const accessToken = await ensureFreshToken(providersRepo, acc as never);
            const usage = await fetchCodexUsage(acc as never, accessToken);
            planType = usage.plan_type;
            if (isCodexQuotaExhausted(usage)) {
              ok = false;
              status = 429;
              detail = codexQuotaDetail(usage);
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
          ...(planType !== undefined ? { planType } : {}),
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
  .use(musicRoutes(db))
  .use(xaiAdminRoutes(db))
  .use(statsRoutes(db))
  .use(logRoutes(db))
  .use(v1Routes(db))
  // ── static dashboard + SPA fallback ──
  // Wildcard route registered LAST so all /api/* routes match first. Any
  // request that still falls through here (i.e. not an API path) is treated
  // as a dashboard asset / SPA route. We explicitly short-circuit /api/* so
  // a typo'd endpoint doesn't accidentally serve HTML.
  .get("/*", ({ path: p, set }) => {
    if (!hasDashboard) {
      set.status = 200;
      set.headers["content-type"] = "text/plain; charset=utf-8";
      return "Mirais is running. Dashboard not built yet — run `bun run build` or use `bun run dev` for the Vite dev server.";
    }
    if (p.startsWith("/api/")) {
      set.status = 404;
      set.headers["content-type"] = "application/json; charset=utf-8";
      return JSON.stringify({ error: "Not found" });
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
    if (ext === ".html") {
      // HTML selects the current hashed Vite assets, so force browsers and
      // reverse proxies to revalidate it after every Mirais update.
      set.headers["cache-control"] = "no-cache";
    } else {
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
    }
    return fs.readFileSync(file);
  })
  .listen({ port: config.port, hostname: config.host });

log.info("mirais started", {
  url: `http://${config.host}:${config.port}`,
  dashboard: hasDashboard ? "serving built dashboard" : "not built",
  db: config.dbPath,
  dashboard_auth: "disabled",
});

// Dashboard authentication has been removed entirely. All administrative
// endpoints are exposed without a password or session. The operator is
// expected to gate network access (reverse proxy, firewall, VPN) instead
// of relying on app-level authentication. The /api/auth/* endpoints remain
// in place as no-ops for backwards compatibility with the dashboard build.

export type App = typeof app;
export { app };
