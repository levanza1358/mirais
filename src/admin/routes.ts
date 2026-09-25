import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { AliasesRepo, CombosRepo } from "../store/repos/routing";
import { KeysRepo } from "../store/repos/keys";
import { AuditRepo } from "../store/repos/audit";
import { aliasCreateSchema, comboCreateSchema, comboUpdateSchema, keyCreateSchema, keyUpdateSchema } from "../shared/schemas";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";
import { ProvidersRepo } from "../store/repos/providers";
import { SettingsRepo } from "../store/repos/settings";
import { normalizeRoutingPolicy, Router } from "../proxy/router";
import { executeRequest } from "../proxy/executor";
import type { CanonicalRequest, RoutingPolicy } from "../shared/types";

export function aliasRoutes(db: Database) {
  const repo = new AliasesRepo(db);
  const audit = new AuditRepo(db);
  return new Elysia({ prefix: "/api/aliases" })
    .get("/", () => repo.list())
    .post("/", ({ body }) => {
      const parsed = aliasCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      if (repo.getByAlias(parsed.data.alias)) throw new AdminError(409, "Alias already exists");
      const alias = repo.create(parsed.data.alias, parsed.data.target);
      audit.record("created", "alias", alias.id, { alias: alias.alias, target: alias.target });
      return alias;
    })
    .delete("/:id", ({ params }) => {
      repo.remove(params.id);
      audit.record("deleted", "alias", params.id);
      return { ok: true };
    });
}

export function comboRoutes(db: Database) {
  const repo = new CombosRepo(db);
  const audit = new AuditRepo(db);
  const providers = new ProvidersRepo(db);
  const router = new Router(providers, new AliasesRepo(db), repo);
  const settings = new SettingsRepo(db);
  return new Elysia({ prefix: "/api/combos" })
    .get("/", () => repo.list())
    .post("/", ({ body }) => {
      const parsed = comboCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      if (repo.getByName(parsed.data.name)) throw new AdminError(409, "Combo already exists");
      const combo = repo.create(parsed.data.name, parsed.data.chain, parsed.data.strategy);
      audit.record("created", "combo", combo.id, { name: combo.name, strategy: combo.strategy, entries: parsed.data.chain.length });
      log.info("combo created", { name: combo.name, entries: parsed.data.chain.length });
      return combo;
    })
    .patch("/:id", ({ params, body }) => {
      const parsed = comboUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const combo = repo.update(params.id, parsed.data);
      if (!combo) throw new AdminError(404, "Combo not found");
      audit.record("updated", "combo", combo.id, { fields: Object.keys(parsed.data) });
      return combo;
    })
    .post("/:id/test", async ({ params }) => {
      const combo = repo.get(params.id);
      if (!combo) throw new AdminError(404, "Combo not found");
      const policy = normalizeRoutingPolicy(settings.getJson<Partial<RoutingPolicy>>("routing_policy"));
      try {
        const route = router.resolveWithPolicy(`combo:${combo.name}`, policy);
        const request: CanonicalRequest = {
          model: `combo:${combo.name}`,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 8,
          stream: false,
          reasoning: { enabled: false },
        };
        const candidates = [];
        for (const [index, candidate] of route.candidates.entries()) {
          const started = Date.now();
          try {
            const result = await executeRequest(request, [candidate], {}, providers, policy);
            candidates.push({
              position: index,
              provider: candidate.provider.name,
              model: candidate.modelId,
              available_accounts: candidate.accounts.length,
              healthy_accounts: candidate.accounts.filter((account) => account.last_warmup_status === "healthy").length,
              ok: true,
              status: 200,
              latency_ms: result.kind === "json" ? result.latencyMs : Date.now() - started,
              account: result.accountLabel,
            });
          } catch (error) {
            candidates.push({
              position: index,
              provider: candidate.provider.name,
              model: candidate.modelId,
              available_accounts: candidate.accounts.length,
              healthy_accounts: candidate.accounts.filter((account) => account.last_warmup_status === "healthy").length,
              ok: false,
              status: error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500,
              latency_ms: Date.now() - started,
              detail: error instanceof Error ? error.message : "Provider test failed",
            });
          }
        }
        return {
          combo: combo.name,
          requested_model: `combo:${combo.name}`,
          ok: candidates.every((candidate) => candidate.ok),
          candidates,
        };
      } catch (error) {
        throw new AdminError(error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 400,
          error instanceof Error ? error.message : "Combo cannot be resolved");
      }
    })
    .delete("/:id", ({ params }) => {
      repo.remove(params.id);
      audit.record("deleted", "combo", params.id);
      return { ok: true };
    });
}

export function keyRoutes(db: Database) {
  const repo = new KeysRepo(db);
  const audit = new AuditRepo(db);
  return new Elysia({ prefix: "/api/keys" })
    .get("/", () => repo.list().map((k) => ({ ...k, key: k.key_plain ?? null })))
    .post("/", ({ body, set }) => {
      const parsed = keyCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      let created;
      try {
        created = repo.create(parsed.data);
      } catch (error) {
        throw new AdminError(409, error instanceof Error ? error.message : "Unable to create key");
      }
      const { record, plaintext } = created;
      audit.record("created", "gateway_key", record.id, { label: record.label });
      log.info("gateway key created", { label: record.label });
      set.status = 201;
      const { key_hash, ...rest } = record;
      void key_hash;
      return { ...rest, key: record.key_plain ?? plaintext, plaintext };
    })
    .patch("/:id", ({ params, body }) => {
      const parsed = keyUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const record = repo.update(params.id, parsed.data);
      if (!record) throw new AdminError(404, "Key not found");
      audit.record("updated", "gateway_key", record.id, { fields: Object.keys(parsed.data) });
      const { key_hash, ...rest } = record;
      void key_hash;
      return { ...rest, key: record.key_plain };
    })
    .delete("/:id", ({ params }) => {
      const record = repo.get(params.id);
      if (!record) throw new AdminError(404, "Key not found");
      repo.remove(params.id);
      audit.record("deleted", "gateway_key", params.id, { label: record.label });
      return { ok: true };
    })
    .post("/:id/rotate", ({ params }) => {
      const rotated = repo.rotate(params.id);
      if (!rotated) throw new AdminError(404, "Key not found");
      audit.record("rotated", "gateway_key", rotated.record.id, { label: rotated.record.label });
      log.info("gateway key rotated", { label: rotated.record.label });
      const { key_hash, ...rest } = rotated.record;
      void key_hash;
      return { ...rest, key: rotated.record.key_plain ?? rotated.plaintext, plaintext: rotated.plaintext };
    });
}
