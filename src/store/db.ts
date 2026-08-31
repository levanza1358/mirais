import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/logger";

let db: Database | null = null;

export function getDb(dbPath: string): Database {
  if (db) return db;
  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(d: Database) {
  d.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const applied = new Set(
    (d.query("SELECT name FROM _migrations").all() as Array<{ name: string }>).map((r) => r.name),
  );

  const dir = path.join(import.meta.dir, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const rawSql = fs.readFileSync(path.join(dir, file), "utf8");
    const sql = rawSql
      .replace(/^(?:\s*--[^\r\n]*(?:\r?\n|$))*/, "")
      .replace(/^\s*BEGIN(?:\s+TRANSACTION)?\s*;?/i, "")
      .replace(/COMMIT\s*;?\s*$/i, "");
    d.transaction(() => {
      d.exec(sql);
      d.query("INSERT INTO _migrations (name) VALUES (?)").run(file);
    })();
    log.info("migration applied", { name: file });
  }

  // Earlier versions could mark a migration as applied without executing its
  // SQL. Recover existing installations that have that bad 0013 record: the
  // migration is idempotent, so rerunning it only creates missing Music tables.
  const musicTable = d.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'music_playlists'",
  ).get();
  if (!musicTable && applied.has("0013_music.sql")) {
    d.exec(fs.readFileSync(path.join(dir, "0013_music.sql"), "utf8"));
    log.warn("recovered missing Music tables from applied migration");
  }
}

export function closeDb() {
  db?.close();
  db = null;
}
