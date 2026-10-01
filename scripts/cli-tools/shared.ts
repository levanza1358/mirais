/**
 * Shared helpers for `mirais tools <tool>` — path resolution, marker-based
 * JSON patch, dry-run diff display. Each tool-specific module uses these so
 * the patch logic stays consistent: writes are scoped under a `MIRAIS_MANAGED`
 * marker so `--reset` can strip exactly what Mirais added without nuking the
 * user's other config.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type HomeResolver = () => string;
export type ConfigPathResolver = () => string;

/**
 * Resolve the user's tool config dir.
 *   - If `MIRAIS_CONFIG_HOME` ends with `.claude`/`.codex`/etc. we use it as-is.
 *   - Otherwise we treat `MIRAIS_CONFIG_HOME` as the parent and append the
 *     tool dir — this matches the convention `~/.config/foo` on Linux and
 *     `%USERPROFILE%\.foo` on Windows.
 */
export function resolveConfigDir(toolDir: string): string {
  const explicit = process.env.MIRAIS_CONFIG_HOME;
  if (explicit) {
    // Operators can point MIRAIS_CONFIG_HOME directly at the tool dir for
    // tests, or at the parent for normal usage. Auto-detect by checking
    // whether the trailing segment already matches the tool dir.
    const base = path.basename(explicit);
    if (base === toolDir) return explicit;
    return path.join(explicit, toolDir);
  }
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE ?? os.homedir();
    return path.join(home, toolDir);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, toolDir);
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, toolDir);
}

/** Pretty-print a JSON diff for `--dry-run`. */
export function printJsonDiff(label: string, before: unknown, after: unknown): void {
  console.log(`[${label}]`);
  console.log("--- before ---");
  console.log(JSON.stringify(before, null, 2));
  console.log("--- after ----");
  console.log(JSON.stringify(after, null, 2));
}

/**
 * Patch a JSON config file under the `MIRAIS_MANAGED: 1` marker. The marker
 * scope is whatever JSON path the caller specifies (e.g. `["env"]` for
 * Claude Code's settings.json). User-added keys outside the scope are
 * preserved.
 */
export function patchJsonFile<T extends Record<string, unknown>>(
  filePath: string,
  scope: string[],
  miraisBlock: Record<string, unknown>,
  markerKey = "MIRAIS_MANAGED",
  atomic = true,
): { before: T | null; after: T; written: boolean } {
  let before: T | null = null;
  if (fs.existsSync(filePath)) {
    try {
      before = JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
      // Malformed JSON — overwrite as a fresh file rather than crashing.
      before = null;
    }
  }
  const after: T = (before ?? ({} as T));

  // Empty scope = merge the managed block directly onto the root object.
  if (scope.length === 0) {
    Object.assign(after, { ...miraisBlock, [markerKey]: 1 } as Record<string, unknown>);
  } else {
    // Walk scope, creating intermediate objects if needed.
    let cursor: Record<string, unknown> = after;
    for (let i = 0; i < scope.length; i += 1) {
      const key = scope[i]!;
      if (i === scope.length - 1) {
        const existing = (cursor[key] ?? {}) as Record<string, unknown>;
        cursor[key] = { ...existing, ...miraisBlock, [markerKey]: 1 };
      } else {
        if (typeof cursor[key] !== "object" || cursor[key] === null) {
          cursor[key] = {};
        }
        cursor = cursor[key] as Record<string, unknown>;
      }
    }
  }

  if (atomic) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(after, null, 2));
    fs.renameSync(tmp, filePath);
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(after, null, 2));
  }
  return { before, after, written: true };
}

/** Strip exactly the keys Mirais added (identified by the marker key). */
export function stripManaged<T extends Record<string, unknown>>(
  before: T,
  scope: string[],
  markerKey = "MIRAIS_MANAGED",
): T {
  const after = JSON.parse(JSON.stringify(before)) as T;
  let parent: Record<string, unknown> | null = null;
  let lastKey: string | null = null;
  let cursor: Record<string, unknown> = after;
  for (const key of scope) {
    parent = cursor;
    lastKey = key;
    const next = cursor[key];
    if (typeof next !== "object" || next === null) return after;
    cursor = next as Record<string, unknown>;
  }
  if (parent && lastKey !== null && cursor[markerKey] === 1) {
    delete (parent as Record<string, unknown>)[lastKey];
  }
  return after;
}

/** Best-effort, idempotent write — used by individual tools for non-JSON files. */
export function writeIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === content) return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

export interface ToolApplyResult {
  applied: boolean;
  filePath: string;
  message: string;
}

export type JsonPatcher = (dryRun: boolean) => Promise<ToolApplyResult>;
export type Resetter = () => Promise<ToolApplyResult>;
export type Lister = () => Promise<{ applied: boolean; filePath: string }>;
