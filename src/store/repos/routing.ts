import type { Database } from "bun:sqlite";
import { ulid } from "../../utils/id";
import type { Alias, Combo, ComboEntry } from "../../shared/types";

export class AliasesRepo {
  constructor(private db: Database) {}

  list(): Alias[] {
    return this.db.query("SELECT * FROM aliases ORDER BY alias ASC").all() as Alias[];
  }

  getByAlias(alias: string): Alias | null {
    return (this.db.query("SELECT * FROM aliases WHERE alias = ?").get(alias) as Alias) ?? null;
  }

  create(alias: string, target: string): Alias {
    const id = ulid();
    this.db.query("INSERT INTO aliases (id, alias, target) VALUES (?, ?, ?)").run(id, alias, target);
    return this.db.query("SELECT * FROM aliases WHERE id = ?").get(id) as Alias;
  }

  remove(id: string) {
    this.db.query("DELETE FROM aliases WHERE id = ?").run(id);
  }
}

export class CombosRepo {
  constructor(private db: Database) {}

  list(): Array<Combo & { entries: ComboEntry[] }> {
    const combos = this.db.query("SELECT * FROM combos ORDER BY name ASC").all() as Combo[];
    return combos.map((c) => ({
      ...c,
      entries: this.db
        .query("SELECT * FROM combo_entries WHERE combo_id = ? ORDER BY position ASC")
        .all(c.id) as ComboEntry[],
    }));
  }

  get(id: string): (Combo & { entries: ComboEntry[] }) | null {
    const combo = this.db.query("SELECT * FROM combos WHERE id = ?").get(id) as Combo | null;
    if (!combo) return null;
    const entries = this.db
      .query("SELECT * FROM combo_entries WHERE combo_id = ? ORDER BY position ASC")
      .all(combo.id) as ComboEntry[];
    return { ...combo, entries };
  }

  getByName(name: string): (Combo & { entries: ComboEntry[] }) | null {
    const c = this.db.query("SELECT * FROM combos WHERE name = ?").get(name) as Combo | null;
    if (!c) return null;
    const entries = this.db
      .query("SELECT * FROM combo_entries WHERE combo_id = ? ORDER BY position ASC")
      .all(c.id) as ComboEntry[];
    return { ...c, entries };
  }

  create(name: string, chain: string[], strategy = "sequential"): Combo {
    const id = ulid();
    const tx = this.db.transaction(() => {
      this.db.query("INSERT INTO combos (id, name, strategy) VALUES (?, ?, ?)").run(id, name, strategy);
      chain.forEach((target, i) => {
        this.db.query("INSERT INTO combo_entries (id, combo_id, position, target) VALUES (?, ?, ?, ?)").run(ulid(), id, i, target);
      });
    });
    tx();
    return this.db.query("SELECT * FROM combos WHERE id = ?").get(id) as Combo;
  }

  update(id: string, patch: { name?: string; strategy?: string; chain?: string[] }): Combo | null {
    const cur = this.db.query("SELECT * FROM combos WHERE id = ?").get(id) as Combo | null;
    if (!cur) return null;
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE combos SET name = ?, strategy = ?, updated_at = ? WHERE id = ?")
        .run(patch.name ?? cur.name, patch.strategy ?? cur.strategy, new Date().toISOString(), id);
      if (patch.chain) {
        this.db.query("DELETE FROM combo_entries WHERE combo_id = ?").run(id);
        patch.chain.forEach((target, i) => {
          this.db
            .query("INSERT INTO combo_entries (id, combo_id, position, target) VALUES (?, ?, ?, ?)")
            .run(ulid(), id, i, target);
        });
      }
    });
    tx();
    return this.db.query("SELECT * FROM combos WHERE id = ?").get(id) as Combo;
  }

  remove(id: string) {
    this.db.query("DELETE FROM combos WHERE id = ?").run(id);
  }
}
