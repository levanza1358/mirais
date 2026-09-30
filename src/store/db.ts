import { SQL } from "bun";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { log } from "../utils/logger";
import { Database } from "./sql";

/**
 * Single-file SQLite database at `<DATA_DIR>/mirais.db`. The same schema lives
 * in `src/store/migrations/*.sql` (a SQLite-flavoured set) and is applied in
 * order from `_migrations`.
 *
 * No more `mysql-server.ts` / `.mysql/` portable directory: this build stores
 * everything in one file, atomic writes (WAL), single-user, no network port.
 */
let db: Database | null = null;
let opening: Promise<Database> | null = null;

export function getDb(_legacyPath?: string): Promise<Database> {
  if (db) return Promise.resolve(db);
  if (opening) return opening;
  const attempt = openDatabase();
  opening = attempt;
  return attempt.finally(() => {
    if (opening === attempt) opening = null;
  });
}

async function openDatabase(): Promise<Database> {
  const dbFile = path.join(config.dataDir, "mirais.db");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const client = new SQL({ adapter: "sqlite", filename: dbFile });
  await client.connect();
  const database = new Database(client, "sqlite");
  await database.exec("PRAGMA foreign_keys = ON;");
  await database.exec("PRAGMA journal_mode = WAL;");
  await database.exec("PRAGMA synchronous = NORMAL;");
  try {
    await migrate(database);
  } catch (error) {
    await database.close();
    throw error;
  }
  db = database;
  log.info("sqlite database opened", { path: dbFile });
  return database;
}

async function migrate(database: Database): Promise<void> {
  await database.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const applied = new Set((await database.query("SELECT name FROM _migrations").all<{ name: string }>()).map((row) => row.name));

  const dir = path.join(import.meta.dir, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    await database.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    await database.query("INSERT INTO _migrations (name) VALUES (?)").run(file);
    log.info("migration applied", { name: file });
  }
}

export async function closeDb(): Promise<void> {
  await db?.close();
  db = null;
}