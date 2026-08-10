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

function fsSyncExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function fsSyncSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
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
      terse_mode: settings.getJson("terse_mode"),
      log_retention_days: Number(settings.get("log_retention_days") ?? 30),
      session_remember_default: settings.get("session_remember_default") === "1",
      network_binding: currentNetworkBinding(),
      model_sync_mode: settings.getJson("model_sync_mode") ?? "curated",
      routing_policy: normalizeRoutingPolicy(settings.getJson("routing_policy")),
      ui: settings.getJson("ui"),
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
      if (parsed.data.terse_mode) settings.setJson("terse_mode", parsed.data.terse_mode);
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
      log.info("settings updated", { keys: Object.keys(parsed.data) });
      return { ok: true };
    });
}

export function statsRoutes(db: Database) {
  const logs = new LogsRepo(db);
  return new Elysia({ prefix: "/api/stats" })
    .get("/summary", ({ query }) => logs.statsSummary(Number(query.days ?? 7)))
    .get("/timeseries", ({ query }) => logs.statsTimeseries(Number(query.days ?? 7)))
    .get("/by-model", ({ query }) => logs.statsByModel(Number(query.days ?? 7)))
    .get("/by-provider", ({ query }) => logs.statsByProvider(Number(query.days ?? 7)));
}

export function logRoutes(db: Database) {
  const logs = new LogsRepo(db);
  return new Elysia({ prefix: "/api/logs" })
    .get("/", ({ query }) =>
      logs.list({
        page: Math.max(1, Number(query.page ?? 1)),
        limit: Math.min(200, Math.max(1, Number(query.limit ?? 50))),
        model: query.model,
        provider: query.provider,
        status: query.status,
        keyId: query.key_id,
        from: query.from,
        to: query.to,
        kind: query.kind,
      }),
    )
    .get("/usage", ({ query }) => logs.usageAggregate(Number(query.days ?? 7)))
    .delete("/usage", () => ({ ok: true, cleared: logs.clearAll() }))
    .get("/:id", ({ params }) => {
      const entry = logs.getById(params.id);
      if (!entry) throw new AdminError(404, "Log not found");
      return entry;
    });
}

export function healthRoutes(db: Database) {
  const providers = new ProvidersRepo(db);
  return new Elysia()
    .get("/health", () => ({
      status: "ok",
      version: config.version,
      uptime_sec: Math.floor((Date.now() - config.startedAt) / 1000),
    }))
    .get("/api/health", () => {
      const list = providers.list();
      return {
        status: "ok",
        version: config.version,
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
      };
    });
}
