import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Database as SqliteDatabase, type SQLQueryBindings } from "bun:sqlite";
import { config } from "../config";
import { log } from "../utils/logger";
import { closeDb } from "../store/db";
import { gunzipFile, gzipFile, isSqliteFile } from "../utils/backup";
const BACKUP_PREFIX = "mirais-";
const BACKUP_SUFFIX = ".db.gz";
const LEGACY_BACKUP_SUFFIX = ".db";

export interface BackupEntry {
  id: string;
  filename: string;
  size_bytes: number;
  created_at: string;
}

function backupsDir(): string {
  const dir = path.join(path.dirname(config.dbPath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackups(): BackupEntry[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith(BACKUP_PREFIX) && (e.name.endsWith(BACKUP_SUFFIX) || e.name.endsWith(LEGACY_BACKUP_SUFFIX)))
    .map((e) => e.name);
  return entries
    .map((filename) => {
      const full = path.join(dir, filename);
      const stat = fs.statSync(full);
      return {
        id: filename,
        filename,
        size_bytes: stat.size,
        created_at: stat.mtime.toISOString(),
      } satisfies BackupEntry;
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function snapshotName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`;
}

async function createSnapshot(): Promise<BackupEntry> {
  const dest = path.join(backupsDir(), snapshotName());
  const snapshot = `${dest.slice(0, -3)}tmp`;
  const src = new SqliteDatabase(config.dbPath, { readonly: true });
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
  const stat = fs.statSync(dest);
  return {
    id: path.basename(dest),
    filename: path.basename(dest),
    size_bytes: stat.size,
    created_at: stat.mtime.toISOString(),
  };
}

function isCompressedBackup(file: string): boolean {
  return file.toLowerCase().endsWith(BACKUP_SUFFIX);
}

async function materializeBackup(source: string): Promise<{ path: string; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(backupsDir(), ".restore-"));
  const destination = path.join(dir, "backup.db");
  try {
    if (isCompressedBackup(source)) await gunzipFile(source, destination);
    else fs.copyFileSync(source, destination);
    if (!isSqliteFile(destination)) throw new Error("File is not a SQLite database (missing magic header)");
    return { path: destination, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function resolveBackup(id: string): string {
  // Defensive: prevent path traversal.
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error("Invalid backup id");
  }
  if (!id.startsWith(BACKUP_PREFIX) || (!id.endsWith(BACKUP_SUFFIX) && !id.endsWith(LEGACY_BACKUP_SUFFIX))) {
    throw new Error("Invalid backup id");
  }
  const full = path.join(backupsDir(), id);
  if (!fs.existsSync(full)) throw new Error("Backup not found");
  return full;
}

/** Natural key per table, used to deduplicate rows during a merge restore. */
const TABLE_KEYS: Record<string, string[]> = {
  providers: ["name"],
  provider_accounts: ["api_key", "provider_id"],
  provider_models: ["provider_id", "model_id"],
  aliases: ["alias"],
  combos: ["name"],
  combo_entries: ["combo_id", "position"],
  gateway_keys: ["key_plain", "key_hash"],
  settings: ["key"],
};

/** Merge the backup DB into the live DB, deduplicating by natural key. */
function mergeBackup(srcPath: string, live: SqliteDatabase): { added: Record<string, number>; skipped: Record<string, number> } {
  const src = new SqliteDatabase(srcPath, { readonly: true });
  const added: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  try {
    for (const table of Object.keys(TABLE_KEYS)) {
      const exists = live.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) continue;
      const srcExists = src.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!srcExists) continue;

      const cols = (live.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      const srcCols = (src.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      const common = cols.filter((c) => srcCols.includes(c));
      if (!common.length) continue;
      const colList = common.map((c) => `"${c}"`).join(", ");
      const keys = TABLE_KEYS[table]!.filter((k) => common.includes(k));

      const rows = src.query(`SELECT ${colList} FROM "${table}"`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        if (keys.length) {
          const where = keys.map((k) => `"${k}" = ?`).join(" AND ");
          const params = keys.map((k) => row[k]);
          const existing = live.query(`SELECT 1 FROM "${table}" WHERE ${where}`).get(...(params as SQLQueryBindings[]));
          if (existing) {
            skipped[table] = (skipped[table] ?? 0) + 1;
            continue;
          }
        } else {
          // No natural key — skip rows whose primary key already exists.
          const id = row["id"];
          if (id != null && live.query(`SELECT 1 FROM "${table}" WHERE id = ?`).get(id as SQLQueryBindings)) {
            skipped[table] = (skipped[table] ?? 0) + 1;
            continue;
          }
        }
        const placeholders = common.map(() => "?").join(", ");
        const values = common.map((c) => (row[c] ?? null) as SQLQueryBindings);
        live.query(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`).run(...values);
        added[table] = (added[table] ?? 0) + 1;
      }
    }
  } finally {
    src.close();
  }
  return { added, skipped };
}

export function backupRoutes(_db: Database) {
  return new Elysia({ prefix: "/api/backups" })
    .get("/", () => ({ backups: listBackups() }))
    .post("/", async () => {
      const entry = await createSnapshot();
      log.info("backup created", { id: entry.id, size_bytes: entry.size_bytes });
      return entry;
    })
    .get("/:id/download", ({ params, set }) => {
      try {
        const full = resolveBackup(params.id);
        set.headers["content-type"] = "application/octet-stream";
        set.headers["content-disposition"] = `attachment; filename="${path.basename(full)}"`;
        return Bun.file(full);
      } catch (err) {
        set.status = 404;
        return { error: err instanceof Error ? err.message : "Not found" };
      }
    })
    .delete("/:id", ({ params, set }) => {
      try {
        const full = resolveBackup(params.id);
        fs.unlinkSync(full);
        log.info("backup deleted", { id: params.id });
        return { ok: true };
      } catch (err) {
        set.status = 404;
        return { error: err instanceof Error ? err.message : "Not found" };
      }
    })
    .post("/upload", async ({ request, set }) => {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        set.status = 400;
        return { error: "Missing 'file' field" };
      }
      const compressed = isCompressedBackup(file.name);
      if (!compressed && !file.name.toLowerCase().endsWith(LEGACY_BACKUP_SUFFIX)) {
        set.status = 400;
        return { error: "Backup must be a .db.gz or .db file" };
      }
      const safeBase = path.basename(file.name).replace(/[^A-Za-z0-9._-]/g, "_");
      const suffix = compressed ? BACKUP_SUFFIX : LEGACY_BACKUP_SUFFIX;
      const id = `${BACKUP_PREFIX}${Date.now()}-${safeBase.endsWith(suffix) ? safeBase : safeBase + suffix}`;
      const dest = path.join(backupsDir(), id);
      fs.writeFileSync(dest, new Uint8Array(await file.arrayBuffer()));
      try {
        const materialized = await materializeBackup(dest);
        materialized.cleanup();
      } catch (err) {
        fs.rmSync(dest, { force: true });
        set.status = 400;
        return { error: err instanceof Error ? err.message : "Invalid backup" };
      }
      const stat = fs.statSync(dest);
      log.info("backup uploaded", { id, size_bytes: stat.size });
      return {
        id,
        filename: id,
        size_bytes: stat.size,
        created_at: stat.mtime.toISOString(),
      } satisfies BackupEntry;
    })
    .post("/:id/restore", async ({ params, body, set }) => {
      try {
        const src = resolveBackup(params.id);
        const materialized = await materializeBackup(src);
        const mode = (body as { mode?: string } | undefined)?.mode === "merge" ? "merge" : "overwrite";
        try {
          const fallback = path.join(backupsDir(), `pre-restore-${Date.now()}.db.gz`);
          try {
            await gzipFile(config.dbPath, fallback);
          } catch { /* first run might fail; continue anyway */ }

          if (mode === "merge") {
            const live = new SqliteDatabase(config.dbPath);
            try {
              live.exec("PRAGMA foreign_keys = ON;");
              live.exec("PRAGMA busy_timeout = 5000;");
              const result = mergeBackup(materialized.path, live);
              log.warn("backup merged", { id: params.id, ...result });
              return { ok: true, mode: "merge", added: result.added, skipped: result.skipped };
            } finally {
              live.close();
            }
          }

          try { closeDb(); } catch { /* ignore — best effort */ }
          fs.copyFileSync(materialized.path, config.dbPath);
          log.warn("backup restored; restarting server", { id: params.id, fallback });
          setTimeout(() => {
            try {
              const serverEntry = path.join(import.meta.dir, "..", "server.ts");
              const child = spawn(process.execPath, ["run", serverEntry], {
                detached: true,
                stdio: "ignore",
                cwd: path.join(import.meta.dir, "..", ".."),
                env: process.env,
              });
              child.unref();
              fs.mkdirSync(config.dataDir, { recursive: true });
              fs.writeFileSync(path.join(config.dataDir, "mirais.pid"), String(child.pid));
            } finally {
              process.exit(0);
            }
          }, 150);
          return { ok: true, mode: "overwrite", restarting: true, fallback: path.basename(fallback) };
        } finally {
          materialized.cleanup();
        }
      } catch (err) {
        set.status = 404;
        return { error: err instanceof Error ? err.message : "Restore failed" };
      }
    });
}