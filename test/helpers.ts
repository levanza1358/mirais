import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

/** Fresh in-memory DB with all migrations applied — one per test file. */
export function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const dir = path.join(import.meta.dir, "..", "src", "store", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    db.query("INSERT INTO _migrations (name) VALUES (?)").run(file);
  }
  return db;
}
