/**
 * Patch Continue's `~/.continue/config.json`. Continue reads the `models`
 * array; we add a Mirais entry rather than mutating an existing provider so
 * the user's other models stay untouched.
 */
import fs from "node:fs";
import path from "node:path";
import type { JsonPatcher, Resetter, ToolApplyResult, Lister } from "./shared";
import { resolveConfigDir, writeIfChanged } from "./shared";

const MARKER = "MIRAIS_MANAGED";

function resolveContinuePath(): string {
  return path.join(resolveConfigDir(".continue"), "config.json");
}

function buildModelEntry(miraisUrl: string, apiKey: string, modelId: string): Record<string, unknown> {
  return {
    title: "Mirais",
    provider: "openai",
    model: modelId,
    apiBase: miraisUrl,
    apiKey,
    [MARKER]: 1,
  };
}

export function applyContinue(
  dryRun: boolean,
  miraisUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ToolApplyResult> {
  const filePath = resolveContinuePath();
  let before: Record<string, unknown> | null = null;
  if (fs.existsSync(filePath)) {
    try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
    catch { before = null; }
  }
  const entry = buildModelEntry(miraisUrl, apiKey, modelId);
  const models = Array.isArray((before ?? {}).models) ? [...((before ?? {}).models as unknown[])] : [];
  // Drop any previous Mirais-managed entry so we don't duplicate.
  const filtered = models.filter((m) => !(typeof m === "object" && m !== null && (m as Record<string, unknown>)[MARKER] === 1));
  filtered.push(entry);
  const after: Record<string, unknown> = { ...(before ?? {}), models: filtered };
  if (dryRun) {
    console.log(`[continue] dry-run — would patch ${filePath}`);
    console.log("--- before ---");
    console.log(JSON.stringify(before, null, 2));
    console.log("--- after ----");
    console.log(JSON.stringify(after, null, 2));
    return Promise.resolve({ applied: false, filePath, message: "dry-run" });
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(after, null, 2));
  return Promise.resolve({ applied: true, filePath, message: `Patched ${filePath}` });
}

export function resetContinue(): Promise<ToolApplyResult> {
  const filePath = resolveContinuePath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath, message: "No config.json" });
  let before: Record<string, unknown>;
  try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
  catch { return Promise.resolve({ applied: false, filePath, message: "Malformed" }); }
  if (!Array.isArray(before.models)) return Promise.resolve({ applied: false, filePath, message: "No models array" });
  const filtered = (before.models as unknown[]).filter((m) => !(typeof m === "object" && m !== null && (m as Record<string, unknown>)[MARKER] === 1));
  if (filtered.length === before.models.length) {
    return Promise.resolve({ applied: false, filePath, message: "No MIRAIS_MANAGED entry" });
  }
  before.models = filtered;
  fs.writeFileSync(filePath, JSON.stringify(before, null, 2));
  return Promise.resolve({ applied: true, filePath, message: "Stripped Mirais model entry" });
}

export function listContinue(): Promise<{ applied: boolean; filePath: string }> {
  const filePath = resolveContinuePath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath });
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const applied = Array.isArray(parsed.models) && (parsed.models as Array<Record<string, unknown>>).some((m) => m[MARKER] === 1);
    return Promise.resolve({ applied, filePath });
  } catch { return Promise.resolve({ applied: false, filePath }); }
}

export const apply: JsonPatcher = (dryRun) => applyContinue(
  dryRun,
  process.env.MIRAIS_URL ?? "http://127.0.0.1:1463/v1",
  process.env.MIRAIS_GATEWAY_KEY ?? "",
  process.env.MIRAIS_MODEL ?? "openai/gpt-5",
);
export const reset: Resetter = resetContinue;
export const list: Lister = listContinue;
