import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Database as SqliteDatabase } from "bun:sqlite";
import { config } from "../config";
import { log } from "../utils/logger";
import { closeDb } from "../store/db";

const BACKUP_PREFIX = "mirais-";
const BACKUP_SUFFIX = ".db";

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
    .filter((e) => e.isFile() && e.name.startsWith(BACKUP_PREFIX) && e.name.endsWith(BACKUP_SUFFIX))
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

function createSnapshot(): BackupEntry {
  const dest = path.join(backupsDir(), snapshotName());
  // VACUUM INTO is safe with concurrent readers, but mirrors a single
  // consistent snapshot at the moment the statement runs.
  const src = new SqliteDatabase(config.dbPath, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}';`);
  } finally {
    src.close();
  }
  const stat = fs.statSync(dest);
  return {
    id: path.basename(dest),
    filename: path.basename(dest),
    size_bytes: stat.size,
    created_at: stat.mtime.toISOString(),
  };
}

/** Lightweight SQLite file sanity check before accepting an upload. */
function looksLikeSqlite(filename: string, buf: Uint8Array): boolean {
  if (!filename.toLowerCase().endsWith(".db")) return false;
  if (buf.length < 100) return false;
  // SQLite files start with the magic "SQLite format 3\x00" string.
  const header = Buffer.from(buf.subarray(0, 16)).toString("ascii");
  return header.startsWith("SQLite format 3");
}

function resolveBackup(id: string): string {
  // Defensive: prevent path traversal.
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error("Invalid backup id");
  }
  if (!id.startsWith(BACKUP_PREFIX) || !id.endsWith(BACKUP_SUFFIX)) {
    throw new Error("Invalid backup id");
  }
  const full = path.join(backupsDir(), id);
  if (!fs.existsSync(full)) throw new Error("Backup not found");
  return full;
}

export function backupRoutes(_db: Database) {
  return new Elysia({ prefix: "/api/backups" })
    .get("/", () => ({ backups: listBackups() }))
    .post("/", () => {
      const entry = createSnapshot();
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
      const buf = new Uint8Array(await file.arrayBuffer());
      if (!looksLikeSqlite(file.name, buf)) {
        set.status = 400;
        return { error: "File is not a SQLite database (missing magic header)" };
      }
      const safeBase = path.basename(file.name).replace(/[^A-Za-z0-9._-]/g, "_");
      const id = `${BACKUP_PREFIX}${Date.now()}-${safeBase.endsWith(BACKUP_SUFFIX) ? safeBase : safeBase + BACKUP_SUFFIX}`;
      const dest = path.join(backupsDir(), id);
      fs.writeFileSync(dest, buf);
      const stat = fs.statSync(dest);
      log.info("backup uploaded", { id, size_bytes: stat.size });
      return {
        id,
        filename: id,
        size_bytes: stat.size,
        created_at: stat.mtime.toISOString(),
      } satisfies BackupEntry;
    })
    .post("/:id/restore", ({ params, set }) => {
      try {
        const src = resolveBackup(params.id);
        const stat = fs.statSync(src);
        if (stat.size < 100) {
          set.status = 400;
          return { error: "Backup file is too small to be a database" };
        }
        // Close the active DB handle so the file can be replaced on
        // Windows (open files cannot be overwritten).
        try { closeDb(); } catch { /* ignore — best effort */ }
        // Snapshot the current DB next to backups dir for one-step undo.
        const fallback = path.join(backupsDir(), `pre-restore-${Date.now()}.db`);
        try {
          fs.copyFileSync(config.dbPath, fallback);
        } catch { /* first run might fail; continue anyway */ }
        fs.copyFileSync(src, config.dbPath);
        log.warn("backup restored; restarting server", { id: params.id, fallback });
        // The dashboard may be running without the CLI supervisor. Start a
        // replacement process explicitly; merely exiting here leaves Mirais
        // stopped after a restore.
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
        return { ok: true, restarting: true, fallback: path.basename(fallback) };
      } catch (err) {
        set.status = 404;
        return { error: err instanceof Error ? err.message : "Restore failed" };
      }
    });
}