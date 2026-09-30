/**
 * Restore provider accounts from a JSON backup written by `scripts/backup.ts`
 * into the active SQLite database (one-file, `DATA_DIR/mirais.db`).
 *
 * Usage:
 *   bun run scripts/restore.ts <path-to-backup.json>
 *   bun run scripts/restore.ts                       # restore newest backup in DATA_DIR/backups
 *
 * `importAccountBackup` is idempotent: it skips accounts whose API key or
 * label already exists for that provider. Existing rows are never overwritten.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";
import { getDb } from "../src/store/db";
import { ProvidersRepo } from "../src/store/repos/providers";
import { importAccountBackup, type AccountBackup } from "../src/admin/account-backup";

function pickBackup(): string {
  const dir = path.join(config.dataDir, "backups");
  if (!fs.existsSync(dir)) {
    throw new Error(`No backups directory at ${dir}. Run \`bun run scripts/backup.ts\` first.`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("mirais-accounts-") && f.endsWith(".json"))
    .sort();
  const newest = files.at(-1);
  if (!newest) throw new Error(`No backups found under ${dir}`);
  return path.join(dir, newest);
}

const arg = process.argv[2];
const source = arg ? path.resolve(arg) : pickBackup();
if (!fs.existsSync(source)) throw new Error(`Backup not found: ${source}`);

const backup = JSON.parse(fs.readFileSync(source, "utf8")) as AccountBackup;
const db = await getDb(config.dbFile);
try {
  const result = await importAccountBackup(new ProvidersRepo(db), backup);
  console.log(`Restored from ${source} → imported=${result.imported} skipped=${result.skipped}`);
} finally {
  await db.close();
}