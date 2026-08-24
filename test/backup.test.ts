import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { gunzipFile, gzipFile, isSqliteFile } from "../src/utils/backup";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("compressed backup materializes as SQLite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirais-backup-"));
  dirs.push(dir);
  const source = path.join(dir, "source.db");
  const compressed = `${source}.gz`;
  const restored = path.join(dir, "restored.db");
  const db = new Database(source);
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('theme', 'dark');");
  db.close();

  await gzipFile(source, compressed);
  await gunzipFile(compressed, restored);

  expect(isSqliteFile(restored)).toBe(true);
  const restoredDb = new Database(restored, { readonly: true });
  expect(restoredDb.query("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({ value: "dark" });
  restoredDb.close();
});