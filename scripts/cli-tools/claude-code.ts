/**
 * Patch Claude Code's `~/.claude/settings.local.json` so the CLI routes
 * through Mirais. We write `env.ANTHROPIC_BASE_URL` and
 * `env.ANTHROPIC_AUTH_TOKEN` under a `MIRAIS_MANAGED: 1` marker so
 * `--reset` can undo our changes without disturbing anything else the user
 * added.
 *
 * We prefer `settings.local.json` (git-ignored, local-only) over the
 * canonical `settings.json` (team-shared) so operators don't accidentally
 * commit their gateway keys.
 */
import fs from "node:fs";
import path from "node:path";
import type { JsonPatcher, Resetter, ToolApplyResult, Lister } from "./shared";
import { patchJsonFile, resolveConfigDir, stripManaged } from "./shared";

const SCOPE = ["env"];
const MARKER = "MIRAIS_MANAGED";

function resolveSettingsPath(): string {
  return path.join(resolveConfigDir(".claude"), "settings.local.json");
}

function buildBlock(miraisUrl: string, apiKey: string): Record<string, unknown> {
  return {
    ANTHROPIC_BASE_URL: miraisUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
}

/**
 * Read the file (or start from empty), apply a managed patch, write back.
 * `dryRun` prints the diff without touching disk; otherwise the file is
 * replaced atomically.
 */
export function applyClaudeCode(
  dryRun: boolean,
  miraisUrl: string,
  apiKey: string,
): Promise<ToolApplyResult> {
  const filePath = resolveSettingsPath();
  const block = buildBlock(miraisUrl, apiKey);
  let before: Record<string, unknown> | null = null;
  if (fs.existsSync(filePath)) {
    try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
    catch { before = null; }
  }
  if (dryRun) {
    // Synthesize an after for the printout but do not write.
    const after = before ? { ...before } : ({} as Record<string, unknown>);
    let cursor: Record<string, unknown> = after;
    for (let i = 0; i < SCOPE.length; i += 1) {
      const key = SCOPE[i]!;
      if (i === SCOPE.length - 1) {
        const existing = (cursor[key] ?? {}) as Record<string, unknown>;
        cursor[key] = { ...existing, ...block, [MARKER]: 1 };
      } else {
        if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
        cursor = cursor[key] as Record<string, unknown>;
      }
    }
    console.log(`[claude-code] dry-run — would patch ${filePath}`);
    console.log("--- before ---");
    console.log(JSON.stringify(before, null, 2));
    console.log("--- after ----");
    console.log(JSON.stringify(after, null, 2));
    return Promise.resolve({
      applied: false,
      filePath,
      message: `dry-run: would patch ${filePath}`,
    });
  }
  patchJsonFile<Record<string, unknown>>(filePath, SCOPE, block, MARKER, true);
  return Promise.resolve({
    applied: true,
    filePath,
    message: `Wrote env.ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN to ${filePath}`,
  });
}

export function resetClaudeCode(): Promise<ToolApplyResult> {
  const filePath = resolveSettingsPath();
  if (!fs.existsSync(filePath)) {
    return Promise.resolve({ applied: false, filePath, message: `No settings file at ${filePath}` });
  }
  let before: Record<string, unknown>;
  try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
  catch { return Promise.resolve({ applied: false, filePath, message: `${filePath} is malformed; cannot reset` }); }
  const after = stripManaged(before, SCOPE, MARKER);
  fs.writeFileSync(filePath, JSON.stringify(after, null, 2));
  return Promise.resolve({
    applied: true,
    filePath,
    message: `Stripped MIRAIS_MANAGED block from ${filePath}`,
  });
}

export function listClaudeCode(): Promise<{ applied: boolean; filePath: string }> {
  const filePath = resolveSettingsPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath });
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
  catch { return Promise.resolve({ applied: false, filePath }); }
  const env = parsed.env as Record<string, unknown> | undefined;
  return Promise.resolve({ applied: env?.[MARKER] === 1, filePath });
}

/** Default wiring used by `mirais tools claude-code`. */
export const apply: JsonPatcher = (dryRun) => applyClaudeCode(
  dryRun,
  process.env.MIRAIS_URL ?? "http://127.0.0.1:1463",
  process.env.MIRAIS_GATEWAY_KEY ?? "",
);
export const reset: Resetter = resetClaudeCode;
export const list: Lister = listClaudeCode;
