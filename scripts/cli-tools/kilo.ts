/**
 * Patch Kilo Code's `~/.kilo/config.json`. Kilo's shape mirrors Cline's
 * `openAi*` block; we write the same five keys under the managed marker.
 */
import fs from "node:fs";
import path from "node:path";
import type { JsonPatcher, Resetter, ToolApplyResult, Lister } from "./shared";
import { resolveConfigDir, writeIfChanged } from "./shared";

const MARKER = "MIRAIS_MANAGED";
const MANAGED_KEYS = ["apiProvider", "openAiBaseUrl", "openAiApiKey", "openAiModelId"];

function resolveKiloPath(): string {
  return path.join(resolveConfigDir(".kilo"), "config.json");
}

function buildBlock(miraisUrl: string, apiKey: string, modelId: string): Record<string, unknown> {
  return {
    apiProvider: "openai",
    openAiBaseUrl: miraisUrl,
    openAiApiKey: apiKey,
    openAiModelId: modelId,
  };
}

export function applyKilo(
  dryRun: boolean,
  miraisUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ToolApplyResult> {
  const filePath = resolveKiloPath();
  let before: Record<string, unknown> | null = null;
  if (fs.existsSync(filePath)) {
    try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
    catch { before = null; }
  }
  const block = buildBlock(miraisUrl, apiKey, modelId);
  const after: Record<string, unknown> = { ...(before ?? {}), ...block, [MARKER]: 1 };
  if (dryRun) {
    console.log(`[kilo] dry-run — would patch ${filePath}`);
    console.log("--- before ---");
    console.log(JSON.stringify(before, null, 2));
    console.log("--- after ----");
    console.log(JSON.stringify(after, null, 2));
    return Promise.resolve({ applied: false, filePath, message: "dry-run" });
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(after, null, 2));
  return Promise.resolve({ applied: true, filePath, message: `Wrote openAiBaseUrl + openAiApiKey to ${filePath}` });
}

export function resetKilo(): Promise<ToolApplyResult> {
  const filePath = resolveKiloPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath, message: "No config.json" });
  let before: Record<string, unknown>;
  try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
  catch { return Promise.resolve({ applied: false, filePath, message: "Malformed" }); }
  if (before[MARKER] !== 1) return Promise.resolve({ applied: false, filePath, message: "No MIRAIS_MANAGED block" });
  for (const key of [...MANAGED_KEYS, MARKER]) delete before[key];
  fs.writeFileSync(filePath, JSON.stringify(before, null, 2));
  return Promise.resolve({ applied: true, filePath, message: "Stripped MIRAIS_MANAGED block" });
}

export function listKilo(): Promise<{ applied: boolean; filePath: string }> {
  const filePath = resolveKiloPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath });
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return Promise.resolve({ applied: parsed[MARKER] === 1, filePath });
  } catch { return Promise.resolve({ applied: false, filePath }); }
}

export const apply: JsonPatcher = (dryRun) => applyKilo(
  dryRun,
  process.env.MIRAIS_URL ?? "http://127.0.0.1:1463/v1",
  process.env.MIRAIS_GATEWAY_KEY ?? "",
  process.env.MIRAIS_MODEL ?? "openai/gpt-5",
);
export const reset: Resetter = resetKilo;
export const list: Lister = listKilo;
