/**
 * Patch Factory Droid's `~/.factory/config.json`. Factory stores custom
 * models under `customModels[]`; we add a Mirais entry rather than mutate
 * an existing one so the user's other custom models are preserved.
 */
import fs from "node:fs";
import path from "node:path";
import type { JsonPatcher, Resetter, ToolApplyResult, Lister } from "./shared";
import { resolveConfigDir, writeIfChanged } from "./shared";

const MARKER = "MIRAIS_MANAGED";

function resolveFactoryPath(): string {
  return path.join(resolveConfigDir(".factory"), "config.json");
}

function buildEntry(miraisUrl: string, apiKey: string, modelId: string): Record<string, unknown> {
  return {
    modelString: modelId,
    baseUrl: miraisUrl,
    apiKey,
    provider: "openai",
    [MARKER]: 1,
  };
}

export function applyFactoryDroid(
  dryRun: boolean,
  miraisUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ToolApplyResult> {
  const filePath = resolveFactoryPath();
  let before: Record<string, unknown> | null = null;
  if (fs.existsSync(filePath)) {
    try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
    catch { before = null; }
  }
  const entry = buildEntry(miraisUrl, apiKey, modelId);
  const custom = Array.isArray((before ?? {}).customModels) ? [...((before ?? {}).customModels as unknown[])] : [];
  const filtered = custom.filter((m) => !(typeof m === "object" && m !== null && (m as Record<string, unknown>)[MARKER] === 1));
  filtered.push(entry);
  const after: Record<string, unknown> = { ...(before ?? {}), customModels: filtered };
  if (dryRun) {
    console.log(`[factory-droid] dry-run — would patch ${filePath}`);
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

export function resetFactoryDroid(): Promise<ToolApplyResult> {
  const filePath = resolveFactoryPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath, message: "No config.json" });
  let before: Record<string, unknown>;
  try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
  catch { return Promise.resolve({ applied: false, filePath, message: "Malformed" }); }
  if (!Array.isArray(before.customModels)) return Promise.resolve({ applied: false, filePath, message: "No customModels" });
  const filtered = (before.customModels as unknown[]).filter((m) => !(typeof m === "object" && m !== null && (m as Record<string, unknown>)[MARKER] === 1));
  if (filtered.length === before.customModels.length) {
    return Promise.resolve({ applied: false, filePath, message: "No MIRAIS_MANAGED entry" });
  }
  before.customModels = filtered;
  fs.writeFileSync(filePath, JSON.stringify(before, null, 2));
  return Promise.resolve({ applied: true, filePath, message: "Stripped Mirais custom model entry" });
}

export function listFactoryDroid(): Promise<{ applied: boolean; filePath: string }> {
  const filePath = resolveFactoryPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath });
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const applied = Array.isArray(parsed.customModels) && (parsed.customModels as Array<Record<string, unknown>>).some((m) => m[MARKER] === 1);
    return Promise.resolve({ applied, filePath });
  } catch { return Promise.resolve({ applied: false, filePath }); }
}

export const apply: JsonPatcher = (dryRun) => applyFactoryDroid(
  dryRun,
  process.env.MIRAIS_URL ?? "http://127.0.0.1:1463/v1",
  process.env.MIRAIS_GATEWAY_KEY ?? "",
  process.env.MIRAIS_MODEL ?? "openai/gpt-5",
);
export const reset: Resetter = resetFactoryDroid;
export const list: Lister = listFactoryDroid;
