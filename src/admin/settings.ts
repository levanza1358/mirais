import { Elysia } from "elysia";
import fs from "node:fs";
import type { Database } from "../store/sql";
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
import { AuditRepo } from "../store/repos/audit";
import { KeysRepo } from "../store/repos/keys";

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
  const audit = new AuditRepo(db);

  const currentNetworkBinding = async () => {
    const saved = await settings.getJson<{ exposed?: boolean; host?: string }>("network_binding");
    if (saved?.host === "0.0.0.0" || saved?.host === "127.0.0.1") {
      return { exposed: saved.host === "0.0.0.0", host: saved.host as "0.0.0.0" | "127.0.0.1" };
    }
    return { exposed: config.host === "0.0.0.0", host: config.host === "127.0.0.1" ? "127.0.0.1" as const : "0.0.0.0" as const };
  };

  return new Elysia({ prefix: "/api/settings" })
    .get("/", async () => ({
      token_saver: await settings.getJson("token_saver"),
      token_saver_providers: await settings.getJson("token_saver_providers") ?? null,
      terse_mode: await settings.getJson("terse_mode"),
      headroom: await settings.getJson("headroom"),
      ponytail: await settings.getJson("ponytail"),
      reasoning: await settings.getJson("reasoning"),
      log_retention_days: Number(await settings.get("log_retention_days") ?? 30),
      session_remember_default: await settings.get("session_remember_default") === "1",
      network_binding: await currentNetworkBinding(),
      model_sync_mode: await settings.getJson("model_sync_mode") ?? "curated",
      model_sync_prune: await settings.getJson<boolean>("model_sync_prune") ?? false,
      routing_policy: normalizeRoutingPolicy(await settings.getJson("routing_policy")),
      ui: await settings.getJson("ui"),
      xai_imap: await settings.getJson("xai_imap"),
      invidious: {
        instances: config.invidiousInstances,
        timeout_ms: config.invidiousTimeoutMs,
      },
      env: {
        port: config.port,
        host: config.host,
        track_payloads: config.trackPayloads,
        upstream_timeout_ms: config.upstreamTimeoutMs,
      },
    }))
    .patch("/", async ({ body }) => {
      const parsed = settingsUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      if (parsed.data.token_saver) await settings.setJson("token_saver", parsed.data.token_saver);
      if (parsed.data.token_saver_providers !== undefined) {
        await settings.setJson("token_saver_providers", parsed.data.token_saver_providers);
      }
      if (parsed.data.terse_mode) await settings.setJson("terse_mode", parsed.data.terse_mode);
      if (parsed.data.headroom) await settings.setJson("headroom", parsed.data.headroom);
      if (parsed.data.ponytail) await settings.setJson("ponytail", parsed.data.ponytail);
      if (parsed.data.reasoning) await settings.setJson("reasoning", parsed.data.reasoning);
      if (parsed.data.log_retention_days !== undefined) {
        await settings.set("log_retention_days", String(parsed.data.log_retention_days));
      }
      if (parsed.data.session_remember_default !== undefined) {
        await settings.set("session_remember_default", parsed.data.session_remember_default ? "1" : "0");
      }
      if (parsed.data.network_binding) await settings.setJson("network_binding", parsed.data.network_binding);
      if (parsed.data.model_sync_mode !== undefined) {
        await settings.setJson("model_sync_mode", parsed.data.model_sync_mode);
      }
      if (parsed.data.model_sync_prune !== undefined) {
        await settings.setJson("model_sync_prune", parsed.data.model_sync_prune);
      }
      if (parsed.data.routing_policy) {
        const current = normalizeRoutingPolicy(await settings.getJson("routing_policy"));
        await settings.setJson("routing_policy", normalizeRoutingPolicy({ ...current, ...parsed.data.routing_policy }));
      }
      if (parsed.data.ui) await settings.setJson("ui", parsed.data.ui);
      if (parsed.data.xai_imap) await settings.setJson("xai_imap", parsed.data.xai_imap);
      log.info("settings updated", { keys: Object.keys(parsed.data) });
      await audit.record("updated", "settings", null, { fields: Object.keys(parsed.data) });
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

export function providerHealthRoutes(db: Database) {
  const logs = new LogsRepo(db);
  return new Elysia({ prefix: "/api/provider-health" })
    .get("/", ({ query }) => logs.providerHealth(Number(query.days) || 7));
}

export function logRoutes(db: Database) {
  const logs = new LogsRepo(db);
  const keys = new KeysRepo(db);
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
    .get("/usage-by-key", ({ query }) => {
      if (typeof query.key_id !== "string" || !query.key_id) throw new AdminError(400, "key_id is required");
      return logs.keyUsage(query.key_id);
    })
    .delete("/usage", async () => ({ ok: true, cleared: await logs.clearAll() }))
    .get("/:id/replay", async ({ params }) => {
      const replay = await logs.getReplayBody(params.id);
      if (!replay) throw new AdminError(409, "Replay is unavailable; enable TRACK_PAYLOADS=full and use a newly captured request");
      return replay;
    })
    .post("/:id/replay", async ({ params }) => {
      const replay = await logs.getReplayBody(params.id);
      if (!replay) throw new AdminError(409, "Replay is unavailable; enable TRACK_PAYLOADS=full and use a newly captured request");
      const key = (await keys.list())[0];
      if (!key?.key_plain || !key.enabled) throw new AdminError(409, "Replay requires an enabled gateway key");
      const response = await fetch(`http://127.0.0.1:${config.port}${replay.endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key.key_plain}`, "x-mirais-replay-of": params.id },
        body: JSON.stringify(replay.body),
      });
      const body = await response.json().catch(() => ({ error: `Replay returned HTTP ${response.status}` }));
      return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
    })
    .get("/:id", async ({ params }) => {
      const entry = await logs.getById(params.id);
      if (!entry) throw new AdminError(404, "Log not found");
      return entry;
    });
}

export function auditRoutes(db: Database) {
  const audit = new AuditRepo(db);
  return new Elysia({ prefix: "/api/audit" })
    .get("/", ({ query }) => audit.list(Number(query.page) || 1, Number(query.limit) || 50));
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
    .get("/api/health", async () => {
      const list = await providers.list();
      const accountCounts = await Promise.all(list.map(async (provider) =>
        (await providers.listAccounts(provider.id)).filter((account) => account.enabled).length,
      ));
      return {
        status: "ok",
        version,
        uptime_sec: Math.floor((Date.now() - config.startedAt) / 1000),
        providers: {
          total: list.length,
          enabled: list.filter((p) => p.enabled).length,
          accounts: accountCounts.reduce((total, count) => total + count, 0),
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
