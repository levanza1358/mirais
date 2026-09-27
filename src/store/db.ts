import { SQL } from "bun";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { log } from "../utils/logger";
import { Database } from "./sql";
import { ensurePortableMySql } from "./mysql-server";

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
  const credentials = await ensurePortableMySql(config.mysqlDir, config.mysqlPort);
  const client = new SQL({
    adapter: "mysql",
    hostname: "127.0.0.1",
    port: credentials.port,
    database: credentials.database,
    username: credentials.username,
    password: credentials.password,
    tls: true,
    max: 20,
    connectionTimeout: 30,
  });
  await client.connect();
  const database = new Database(client, "mysql");
  try {
    await migrate(database);
  } catch (error) {
    await database.close();
    throw error;
  }
  db = database;
  return database;
}

async function migrate(database: Database): Promise<void> {
  await database.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_migrations_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`);

  const applied = new Set((await database.query("SELECT name FROM _migrations").all<{ name: string }>()).map((row) => row.name));

  const dir = path.join(import.meta.dir, "mysql-migrations");
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
