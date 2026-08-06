import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { AliasesRepo, CombosRepo } from "../store/repos/routing";
import { KeysRepo } from "../store/repos/keys";
import { aliasCreateSchema, comboCreateSchema, comboUpdateSchema, keyCreateSchema, keyUpdateSchema } from "../shared/schemas";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";

export function aliasRoutes(db: Database) {
  const repo = new AliasesRepo(db);
  return new Elysia({ prefix: "/api/aliases" })
    .get("/", () => repo.list())
    .post("/", ({ body }) => {
      const parsed = aliasCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      if (repo.getByAlias(parsed.data.alias)) throw new AdminError(409, "Alias already exists");
      return repo.create(parsed.data.alias, parsed.data.target);
    })
    .delete("/:id", ({ params }) => {
      repo.remove(params.id);
      return { ok: true };
    });
}

export function comboRoutes(db: Database) {
  const repo = new CombosRepo(db);
  return new Elysia({ prefix: "/api/combos" })
    .get("/", () => repo.list())
    .post("/", ({ body }) => {
      const parsed = comboCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      if (repo.getByName(parsed.data.name)) throw new AdminError(409, "Combo already exists");
      const c = repo.create(parsed.data.name, parsed.data.chain, parsed.data.strategy);
      log.info("combo created", { name: c.name, entries: parsed.data.chain.length });
      return c;
    })
    .patch("/:id", ({ params, body }) => {
      const parsed = comboUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const c = repo.update(params.id, parsed.data);
      if (!c) throw new AdminError(404, "Combo not found");
      return c;
    })
    .delete("/:id", ({ params }) => {
      repo.remove(params.id);
      return { ok: true };
    });
}

export function keyRoutes(db: Database) {
  const repo = new KeysRepo(db);
  return new Elysia({ prefix: "/api/keys" })
    .get("/", () => repo.list())
    .post("/", ({ body, set }) => {
      const parsed = keyCreateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      let created;
      try {
        created = repo.create(parsed.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to create key";
        throw new AdminError(409, message);
      }
      const { record, plaintext } = created;
      log.info("gateway key created", { label: record.label });
      set.status = 201;
      const { key_hash, ...rest } = record;
      void key_hash;
      return { ...rest, plaintext }; // plaintext shown exactly once
    })
    .patch("/:id", ({ params, body }) => {
      const parsed = keyUpdateSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const rec = repo.update(params.id, parsed.data);
      if (!rec) throw new AdminError(404, "Key not found");
      const { key_hash, ...rest } = rec;
      void key_hash;
      return rest;
    })
    .post("/:id/rotate", ({ params }) => {
      const rotated = repo.rotate(params.id);
      if (!rotated) throw new AdminError(404, "Key not found");
      log.info("gateway key rotated", { label: rotated.record.label });
      const { key_hash, ...rest } = rotated.record;
      void key_hash;
      return { ...rest, plaintext: rotated.plaintext };
    });
}
