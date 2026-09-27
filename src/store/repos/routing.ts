import type { Database } from "../sql";
import { ulid, nowIso } from "../../utils/id";
import type { Alias, Combo, ComboEntry } from "../../shared/types";

export class AliasesRepo {
  constructor(private db: Database) {}

  list(): Promise<Alias[]> {
    return this.db.query("SELECT * FROM aliases ORDER BY alias ASC").all<Alias>();
  }

  getByAlias(alias: string): Promise<Alias | null> {
    return this.db.query("SELECT * FROM aliases WHERE alias = ?").get<Alias>(alias);
  }

  async create(alias: string, target: string): Promise<Alias> {
    const id = ulid();
    await this.db.query("INSERT INTO aliases (id, alias, target, created_at) VALUES (?, ?, ?, ?)").run(id, alias, target, nowIso());
    const created = await this.db.query("SELECT * FROM aliases WHERE id = ?").get<Alias>(id);
    if (!created) throw new Error("Created alias could not be loaded");
    return created;
  }

  async remove(id: string): Promise<void> {
    await this.db.query("DELETE FROM aliases WHERE id = ?").run(id);
  }
}

export class CombosRepo {
  constructor(private db: Database) {}

  async list(): Promise<Array<Combo & { entries: ComboEntry[] }>> {
    const combos = await this.db.query("SELECT * FROM combos ORDER BY name ASC").all<Combo>();
    return Promise.all(combos.map(async (combo) => ({
      ...combo,
      entries: await this.db
        .query("SELECT * FROM combo_entries WHERE combo_id = ? ORDER BY position ASC")
        .all<ComboEntry>(combo.id),
    })));
  }

  async get(id: string): Promise<(Combo & { entries: ComboEntry[] }) | null> {
    const combo = await this.db.query("SELECT * FROM combos WHERE id = ?").get<Combo>(id);
    if (!combo) return null;
    const entries = await this.db
      .query("SELECT * FROM combo_entries WHERE combo_id = ? ORDER BY position ASC")
      .all<ComboEntry>(combo.id);
    return { ...combo, entries };
  }

  async getByName(name: string): Promise<(Combo & { entries: ComboEntry[] }) | null> {
    const c = await this.db.query("SELECT * FROM combos WHERE name = ?").get<Combo>(name);
    if (!c) return null;
    const entries = await this.db
      .query("SELECT * FROM combo_entries WHERE combo_id = ? ORDER BY position ASC")
      .all<ComboEntry>(c.id);
    return { ...c, entries };
  }

  async create(name: string, chain: string[], strategy = "sequential"): Promise<Combo> {
    const id = ulid();
    const tx = this.db.transaction(async (db) => {
      const createdAt = nowIso();
      await db.query("INSERT INTO combos (id, name, strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, name, strategy, createdAt, createdAt);
      for (const [position, target] of chain.entries()) {
        await db.query("INSERT INTO combo_entries (id, combo_id, position, target) VALUES (?, ?, ?, ?)").run(ulid(), id, position, target);
      }
    });
    await tx();
    const created = await this.db.query("SELECT * FROM combos WHERE id = ?").get<Combo>(id);
    if (!created) throw new Error("Created combo could not be loaded");
    return created;
  }

  async update(id: string, patch: { name?: string; strategy?: string; chain?: string[] }): Promise<Combo | null> {
    const cur = await this.db.query("SELECT * FROM combos WHERE id = ?").get<Combo>(id);
    if (!cur) return null;
    const tx = this.db.transaction(async (db) => {
      await db
        .query("UPDATE combos SET name = ?, strategy = ?, updated_at = ? WHERE id = ?")
        .run(patch.name ?? cur.name, patch.strategy ?? cur.strategy, new Date().toISOString(), id);
      if (patch.chain) {
        await db.query("DELETE FROM combo_entries WHERE combo_id = ?").run(id);
        for (const [position, target] of patch.chain.entries()) {
          await db
            .query("INSERT INTO combo_entries (id, combo_id, position, target) VALUES (?, ?, ?, ?)")
            .run(ulid(), id, position, target);
        }
      }
    });
    await tx();
    return this.db.query("SELECT * FROM combos WHERE id = ?").get<Combo>(id);
  }

  async remove(id: string): Promise<void> {
    await this.db.query("DELETE FROM combos WHERE id = ?").run(id);
  }
}
