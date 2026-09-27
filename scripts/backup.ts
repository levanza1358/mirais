import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";
import { exportAccountBackup } from "../src/admin/account-backup";
import { getDb } from "../src/store/db";
import { ProvidersRepo } from "../src/store/repos/providers";

const backupsDir = path.join(path.dirname(config.dbPath), "backups");
fs.mkdirSync(backupsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(backupsDir, `mirais-accounts-${stamp}.json`);
const db = await getDb();
const backup = await exportAccountBackup(new ProvidersRepo(db));
fs.writeFileSync(dest, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
await db.close();

console.log(`Backup written → ${dest}`);
