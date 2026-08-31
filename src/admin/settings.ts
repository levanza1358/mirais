import { Elysia } from "elysia";
import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { SettingsRepo } from "../store/repos/settings";
import { LogsRepo } from "../store/repos/logs";
import { ProvidersRepo } from "../store/repos/providers";
import { settingsUpdateSchema } from "../shared/schemas";
import { AdminError } from "../shared/errors";
import { config } from "../config";
import { log } from "../utils/logger";
import { normalizeRoutingPolicy } from "../proxy/router";
import { cooldownSnapshot } from "../proxy/executor";
import { totalInFlight } from "../ratelimit";
import { autostartStatus, setAutostart } from "../../scripts/autostart";
import { getAppVersion } from "../version";

function fsSyncExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function fsSyncSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/**
 * Process memory. `rss` is what the OS accounts for; `heap_used` is what the JS
 * heap holds. A growing `external`/`array_buffers` with a flat heap points at
 * stream buffers rather than a JS leak.
 */
function memorySnapshot() {
  const m = process.memoryUsage();
  return {
    rss_bytes: m.rss,
    heap_used_bytes: m.heapUsed,
    heap_total_bytes: m.heapTotal,
    external_bytes: m.external,
    array_buffers_bytes: m.arrayBuffers,
  };
}

export function settingsRoutes(db: Database) {
  const settings = new SettingsRepo(db);

  const currentNetworkBinding = () => {
    const saved = settings.getJson<{ exposed?: boolean; host?: string }>("network_binding");
    if (saved?.host === "0.0.0.0" || saved?.host === "127.0.0.1") {
      return { exposed: saved.host === "0.0.0.0", host: saved.host as "0.0.0.0" | "127.0.0.1" };
    }
    return { exposed: config.host === "0.0.0.0", host: config.host === "127.0.0.1" ? "127.0.0.1" as const : "0.0.0.0" as const };
  };

  return new Elysia({ prefix: "/api/settings" })
    .get("/", () => ({
      token_saver: settings.getJson("token_saver"),
      token_saver_providers: settings.getJson("token_saver_providers") ?? null,
      terse_mode: settings.getJson("terse_mode"),
      headroom: settings.getJson("headroom"),
      ponytail: settings.getJson("ponytail"),
      log_retention_days: Number(settings.get("log_retention_days") ?? 30),
      session_remember_default: settings.get("session_remember_default") === "1",
      network_binding: currentNetworkBinding(),
      model_sync_mode: settings.getJson("model_sync_mode") ?? "curated",
      routing_policy: normalizeRoutingPolicy(settings.getJson("routing_policy")),
      ui: settings.getJson("ui"),
      xai_imap: settings.getJson("xai_imap"),
      env: {
        port: config.port,
        host: config.host,
        track_payloads: config.trackPayloads,
        upstream_timeout_ms: config.upstreamTimeoutMs,
      },
    }))
    .patch("/", ({ body }) => {
      const parsed = settingsUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      if (parsed.data.token_saver) settings.setJson("token_saver", parsed.data.token_saver);
      if (parsed.data.token_saver_providers !== undefined) {
        settings.setJson("token_saver_providers", parsed.data.token_saver_providers);
      }
      if (parsed.data.terse_mode) settings.setJson("terse_mode", parsed.data.terse_mode);
      if (parsed.data.headroom) settings.setJson("headroom", parsed.data.headroom);
      if (parsed.data.ponytail) settings.setJson("ponytail", parsed.data.ponytail);
      if (parsed.data.log_retention_days !== undefined) {
        settings.set("log_retention_days", String(parsed.data.log_retention_days));
      }
      if (parsed.data.session_remember_default !== undefined) {
        settings.set("session_remember_default", parsed.data.session_remember_default ? "1" : "0");
      }
      if (parsed.data.network_binding) settings.setJson("network_binding", parsed.data.network_binding);
      if (parsed.data.model_sync_mode !== undefined) {
        settings.setJson("model_sync_mode", parsed.data.model_sync_mode);
      }
      if (parsed.data.routing_policy) {
        const current = normalizeRoutingPolicy(settings.getJson("routing_policy"));
        settings.setJson("routing_policy", normalizeRoutingPolicy({ ...current, ...parsed.data.routing_policy }));
      }
      if (parsed.data.ui) settings.setJson("ui", parsed.data.ui);
      if (parsed.data.xai_imap) settings.setJson("xai_imap", parsed.data.xai_imap);
      log.info("settings updated", { keys: Object.keys(parsed.data) });
      return { ok: true };
    });
}

export function statsRoutes(db: Database) {
  const logs = new LogsRepo(db);
  const days = (raw: unknown) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.floor(n) : 7;
  };
  return new Elysia({ prefix: "/api/stats" })
    .get("/summary", ({ query }) => logs.statsSummary(days(query.days)))
    .get("/timeseries", ({ query }) => logs.statsTimeseries(days(query.days)))
    .get("/by-model", ({ query }) => logs.statsByModel(days(query.days)))
    .get("/by-provider", ({ query }) => logs.statsByProvider(days(query.days)));
}

export function logRoutes(db: Database) {
  const logs = new LogsRepo(db);
  const days = (raw: unknown) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : 7;
  };
  return new Elysia({ prefix: "/api/logs" })
    .get("/", ({ query }) =>
      logs.list({
        page: Math.max(1, Number.isFinite(Number(query.page)) ? Number(query.page) : 1),
        limit: Math.min(200, Math.max(1, Number.isFinite(Number(query.limit)) ? Number(query.limit) : 50)),
        model: query.model,
        provider: query.provider,
        status: query.status,
        keyId: query.key_id,
        from: query.from,
        to: query.to,
        kind: query.kind,
      }),
    )
    .get("/usage", ({ query }) => logs.usageAggregate(days(query.days)))
    .delete("/usage", () => ({ ok: true, cleared: logs.clearAll() }))
    .get("/:id", ({ params }) => {
      const entry = logs.getById(params.id);
      if (!entry) throw new AdminError(404, "Log not found");
      return entry;
    });
}

export function autostartRoutes() {
  return new Elysia({ prefix: "/api/autostart" })
    .get("/", () => autostartStatus())
    .post("/", async ({ body }) => {
      const enabled = (body as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== "boolean") throw new AdminError(400, "Body must be { enabled: boolean }");
      try {
        return await setAutostart(enabled ? "on" : "off");
      } catch (err) {
        throw new AdminError(400, err instanceof Error ? err.message : "Could not change autostart");
      }
    });
}

export function healthRoutes(db: Database) {
  const providers = new ProvidersRepo(db);
  const version = getAppVersion().version;
  return new Elysia()
    .get("/health", () => ({
      status: "ok",
      version,
      uptime_sec: Math.floor((Date.now() - config.startedAt) / 1000),
    }))
    .get("/api/health", () => {
      const list = providers.list();
      return {
        status: "ok",
        version,
        uptime_sec: Math.floor((Date.now() - config.startedAt) / 1000),
        providers: {
          total: list.length,
          enabled: list.filter((p) => p.enabled).length,
          accounts: list.reduce((n, p) => n + providers.listAccounts(p.id).filter((a) => a.enabled).length, 0),
        },
        // Surface where the on-disk DB actually lives so the dashboard can
        // tell the operator whether they're connected to the right Mirais
        // instance (matters when several VPS installs run side by side, or
        // when systemd's WorkingDirectory moves the relative ./data path).
        storage: {
          data_dir: config.dataDir,
          db_path: config.dbPath,
          db_exists: fsSyncExists(config.dbPath),
          size_bytes: fsSyncSize(config.dbPath),
        },
        // Runtime health. In-flight counts were already tracked for per-key
        // concurrency limits but never exposed, which made it impossible to
        // tell a hung stream apart from an idle gateway.
        runtime: {
          memory: memorySnapshot(),
          in_flight: totalInFlight(),
          active_cooldowns: cooldownSnapshot().length,
        },
      };
    });
}
