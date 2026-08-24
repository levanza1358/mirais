import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { AdminError } from "../shared/errors";
import { accountBackupSchema } from "../shared/schemas";
import { ProvidersRepo } from "../store/repos/providers";
import { log } from "../utils/logger";
import { exportAccountBackup, importAccountBackup } from "./account-backup";

const BACKUP_PREFIX = "mirais-accounts-";
const BACKUP_SUFFIX = ".json";

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

function toEntry(filename: string): BackupEntry {
  const stat = fs.statSync(path.join(backupsDir(), filename));
  return { id: filename, filename, size_bytes: stat.size, created_at: stat.mtime.toISOString() };
}

function listBackups(): BackupEntry[] {
  return fs.readdirSync(backupsDir(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(BACKUP_PREFIX) && entry.name.endsWith(BACKUP_SUFFIX))
    .map((entry) => toEntry(entry.name))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function resolveBackup(id: string): string {
  if (id.includes("..") || id.includes("/") || id.includes("\\") || !id.startsWith(BACKUP_PREFIX) || !id.endsWith(BACKUP_SUFFIX)) {
    throw new Error("Invalid backup id");
  }
  const full = path.join(backupsDir(), id);
  if (!fs.existsSync(full)) throw new Error("Backup not found");
  return full;
}

function parseBackup(input: string) {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new AdminError(400, "Backup must be valid JSON");
  }
  const parsed = accountBackupSchema.safeParse(value);
  if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid account backup");
  return parsed.data;
}

export function backupRoutes(db: Database) {
  const repo = new ProvidersRepo(db);
  return new Elysia({ prefix: "/api/backups" })
    .get("/", () => ({ backups: listBackups() }))
    .post("/", () => {
      const filename = `${BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}${BACKUP_SUFFIX}`;
      fs.writeFileSync(path.join(backupsDir(), filename), `${JSON.stringify(exportAccountBackup(repo), null, 2)}\n`, { mode: 0o600 });
      const entry = toEntry(filename);
      log.info("account backup created", { id: entry.id, size_bytes: entry.size_bytes });
      return entry;
    })
    .get("/:id/download", ({ params, set }) => {
      try {
        const full = resolveBackup(params.id);
        set.headers["content-type"] = "application/json";
        set.headers["content-disposition"] = `attachment; filename="${path.basename(full)}"`;
        return Bun.file(full);
      } catch (err) {
        throw new AdminError(404, err instanceof Error ? err.message : "Backup not found");
      }
    })
    .delete("/:id", ({ params }) => {
      try {
        fs.unlinkSync(resolveBackup(params.id));
        log.info("account backup deleted", { id: params.id });
        return { ok: true };
      } catch (err) {
        throw new AdminError(404, err instanceof Error ? err.message : "Backup not found");
      }
    })
    .post("/upload", async ({ request }) => {
      const file = (await request.formData()).get("file");
      if (!(file instanceof File)) throw new AdminError(400, "Missing 'file' field");
      if (!file.name.toLowerCase().endsWith(BACKUP_SUFFIX)) throw new AdminError(400, "Backup must be a .json file");
      const backup = parseBackup(await file.text());
      const filename = `${BACKUP_PREFIX}${Date.now()}-${path.basename(file.name).replace(/[^A-Za-z0-9._-]/g, "_")}`;
      fs.writeFileSync(path.join(backupsDir(), filename), `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
      const entry = toEntry(filename);
      log.info("account backup uploaded", { id: entry.id, size_bytes: entry.size_bytes });
      return entry;
    })
    .post("/:id/restore", ({ params }) => {
      let backup;
      try {
        backup = parseBackup(fs.readFileSync(resolveBackup(params.id), "utf8"));
      } catch (err) {
        if (err instanceof AdminError) throw err;
        throw new AdminError(404, err instanceof Error ? err.message : "Backup not found");
      }
      const result = importAccountBackup(repo, backup);
      log.info("account backup restored", { id: params.id, ...result });
      return { ok: true, ...result };
    });
}
