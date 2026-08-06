// Backup the SQLite database to DATA_DIR/backups/mirais-<timestamp>.db
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";

const backupsDir = path.join(path.dirname(config.dbPath), "backups");
fs.mkdirSync(backupsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(backupsDir, `mirais-${stamp}.db`);

const src = new Database(config.dbPath, { readonly: true });
src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}';`);
src.close();

console.log(`Backup written → ${dest}`);
