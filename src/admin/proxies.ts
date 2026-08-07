import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ProxyRepo } from "../store/repos/proxies";
import { ProvidersRepo } from "../store/repos/providers";
import { GatewayError } from "../shared/errors";
import { DEFAULT_SOURCES, parseProxyLine, probeAll, probeProxy, scrapeAll } from "./proxyScraper";
import { log } from "../utils/logger";

class AdminError extends GatewayError {
  constructor(status: number, message: string) {
    super(status, "server_error", message);
  }
}

const intervalSchema = z.object({
  interval_minutes: z.number().int().min(5).max(1440),
  enabled: z.boolean(),
});

const assignmentSchema = z.object({
  provider_id: z.string().min(1),
  mode: z.enum(["direct", "pool", "scored"]),
});

export function proxyRoutes(db: Database) {
  const repo = new ProxyRepo(db);
  const providers = new ProvidersRepo(db);

  function loadConfig(): { enabled: boolean; interval_minutes: number } {
    const raw = db.query("SELECT value FROM settings WHERE key = ?").get("proxy_config") as { value: string } | null;
    if (!raw) return { enabled: false, interval_minutes: 60 };
    try { return JSON.parse(raw.value) as { enabled: boolean; interval_minutes: number }; } catch { return { enabled: false, interval_minutes: 60 }; }
  }

  function saveConfig(cfg: { enabled: boolean; interval_minutes: number }): void {
    db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("proxy_config", JSON.stringify(cfg));
  }

  return new Elysia({ prefix: "/api/proxies" })
    .get("/", ({ query }) => {
      const page = Number((query as Record<string, unknown>).page ?? 1);
      const pageSize = Number((query as Record<string, unknown>).page_size ?? 20);
      const paged = repo.listPaged(page, pageSize);
      return {
        sources: DEFAULT_SOURCES,
        proxies: paged.items,
        page: paged.page,
        page_size: paged.page_size,
        total: paged.total,
        total_pages: paged.total_pages,
        assignments: repo.listAssignments(),
        scrape_runs: repo.listScrapeRuns(),
        config: loadConfig(),
      };
    })
    .post("/scrape", async () => {
      const started = Date.now();
      const results = await scrapeAll(repo, { triggeredBy: "manual" });
      const probed = await probeAll(repo);
      const added = results.reduce((acc, r) => acc + r.added, 0);
      const fetched = results.reduce((acc, r) => acc + r.fetched, 0);
      log.info("proxy manual scrape complete", { added, fetched, probed: probed.length, durationMs: Date.now() - started });
      return { results, probed };
    })
    .post("/probe", async ({ body }) => {
      const parsed = z.object({ id: z.string().optional() }).safeParse(body);
      if (!parsed.success) throw new AdminError(400, "Invalid payload");
      if (parsed.data.id) {
        await probeProxy(repo, parsed.data.id);
        return { ok: true, probed: [parsed.data.id] };
      }
      const probed = await probeAll(repo);
      return { ok: true, probed };
    })
    .post("/", ({ body }) => {
      const parsed = z.object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
        username: z.string().min(1).max(64).optional(),
        password: z.string().min(1).max(64).optional(),
        source: z.string().min(1).max(64).default("manual"),
      }).safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      // Validate the line so users cannot inject garbage.
      if (!parseProxyLine(`${parsed.data.host}:${parsed.data.port}`)) throw new AdminError(400, "Host or port is invalid");
      if ((parsed.data.username && !parsed.data.password) || (!parsed.data.username && parsed.data.password)) {
        throw new AdminError(400, "Username and password must be provided together");
      }
      const result = repo.upsert({
        host: parsed.data.host,
        port: parsed.data.port,
        country: parsed.data.country?.toUpperCase() ?? null,
        username: parsed.data.username ?? null,
        password: parsed.data.password ?? null,
        source: parsed.data.source,
      });
      return result.record;
    })
    .post("/bulk", ({ body }) => {
      const parsed = z.object({
        lines: z.array(z.string().min(1)).min(1).max(2_000),
        source: z.string().min(1).max(64).default("manual"),
      }).safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      let added = 0;
      let skipped = 0;
      let invalid = 0;
      for (const line of parsed.data.lines) {
        const candidate = parseProxyLine(line);
        if (!candidate) { invalid += 1; continue; }
        const result = repo.upsert({
          host: candidate.host,
          port: candidate.port,
          country: candidate.country ?? null,
          username: candidate.username ?? null,
          password: candidate.password ?? null,
          source: parsed.data.source,
        });
        if (result.added) added += 1;
        else skipped += 1;
      }
      log.info("proxy bulk add", { received: parsed.data.lines.length, added, skipped, invalid, source: parsed.data.source });
      return { received: parsed.data.lines.length, added, skipped, invalid };
    })
    .delete("/:id", ({ params }) => {
      const ok = repo.delete(params.id);
      if (!ok) throw new AdminError(404, "Proxy not found");
      return { ok: true };
    })
    .post("/clear", () => {
      const removed = repo.clear();
      return { removed };
    })
    .post("/:id/toggle", ({ params }) => {
      const current = repo.get(params.id);
      if (!current) throw new AdminError(404, "Proxy not found");
      const next = current.status === "disabled" ? "pending" : "disabled";
      repo.markStatus(params.id, next, current.latency_ms, null);
      return repo.get(params.id);
    })
    .get("/assignments", () => {
      const all = repo.listAssignments();
      const providerList = providers.list().map((p) => ({ id: p.id, name: p.name, type: p.type }));
      return { assignments: all, providers: providerList };
    })
    .post("/assignments", ({ body }) => {
      const parsed = assignmentSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const id = parsed.data.provider_id === "*" ? "*" : parsed.data.provider_id;
      if (id !== "*") {
        const provider = providers.get(id);
        if (!provider) throw new AdminError(404, "Provider not found");
      }
      repo.setAssignment(id, parsed.data.mode);
      return repo.getAssignment(id);
    })
    .get("/config", () => loadConfig())
    .post("/config", ({ body }) => {
      const parsed = intervalSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      saveConfig({ enabled: parsed.data.enabled, interval_minutes: parsed.data.interval_minutes });
      return loadConfig();
    });
}