import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config";
import { gzipFile } from "../src/utils/backup";

const backupsDir = path.join(path.dirname(config.dbPath), "backups");
fs.mkdirSync(backupsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(backupsDir, `mirais-${stamp}.db.gz`);
const snapshot = path.join(backupsDir, `.mirais-${stamp}.db`);

const src = new Database(config.dbPath, { readonly: true });
try {
	src.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}';`);
} finally {
	src.close();
}
try {
	await gzipFile(snapshot, dest);
} finally {
	fs.rmSync(snapshot, { force: true });
}

console.log(`Backup written → ${dest}`);
