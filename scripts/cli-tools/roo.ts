/**
 * Patch Roo Code's `~/.roo/config.json`. Same shape as Kilo — top-level
 * `openAi*` block. Roo also accepts a `sidebarModelId`; we set it to the
 * same model id so the sidebar preview uses Mirais from the start.
 */
import fs from "node:fs";
import path from "node:path";
import type { JsonPatcher, Resetter, ToolApplyResult, Lister } from "./shared";
import { resolveConfigDir, writeIfChanged } from "./shared";

const MARKER = "MIRAIS_MANAGED";
const MANAGED_KEYS = ["apiProvider", "openAiBaseUrl", "openAiApiKey", "openAiModelId", "sidebarModelId"];

function resolveRooPath(): string {
  return path.join(resolveConfigDir(".roo"), "config.json");
}

function buildBlock(miraisUrl: string, apiKey: string, modelId: string): Record<string, unknown> {
  return {
    apiProvider: "openai",
    openAiBaseUrl: miraisUrl,
    openAiApiKey: apiKey,
    openAiModelId: modelId,
    sidebarModelId: modelId,
  };
}

export function applyRoo(
  dryRun: boolean,
  miraisUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ToolApplyResult> {
  const filePath = resolveRooPath();
  let before: Record<string, unknown> | null = null;
  if (fs.existsSync(filePath)) {
    try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
    catch { before = null; }
  }
  const block = buildBlock(miraisUrl, apiKey, modelId);
  const after: Record<string, unknown> = { ...(before ?? {}), ...block, [MARKER]: 1 };
  if (dryRun) {
    console.log(`[roo] dry-run — would patch ${filePath}`);
    console.log("--- before ---");
    console.log(JSON.stringify(before, null, 2));
    console.log("--- after ----");
    console.log(JSON.stringify(after, null, 2));
    return Promise.resolve({ applied: false, filePath, message: "dry-run" });
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(after, null, 2));
  return Promise.resolve({ applied: true, filePath, message: `Wrote openAi* block to ${filePath}` });
}

export function resetRoo(): Promise<ToolApplyResult> {
  const filePath = resolveRooPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath, message: "No config.json" });
  let before: Record<string, unknown>;
  try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
  catch { return Promise.resolve({ applied: false, filePath, message: "Malformed" }); }
  if (before[MARKER] !== 1) return Promise.resolve({ applied: false, filePath, message: "No MIRAIS_MANAGED block" });
  for (const key of [...MANAGED_KEYS, MARKER]) delete before[key];
  fs.writeFileSync(filePath, JSON.stringify(before, null, 2));
  return Promise.resolve({ applied: true, filePath, message: "Stripped MIRAIS_MANAGED block" });
}

export function listRoo(): Promise<{ applied: boolean; filePath: string }> {
  const filePath = resolveRooPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath });
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return Promise.resolve({ applied: parsed[MARKER] === 1, filePath });
  } catch { return Promise.resolve({ applied: false, filePath }); }
}

export const apply: JsonPatcher = (dryRun) => applyRoo(
  dryRun,
  process.env.MIRAIS_URL ?? "http://127.0.0.1:1463/v1",
  process.env.MIRAIS_GATEWAY_KEY ?? "",
  process.env.MIRAIS_MODEL ?? "openai/gpt-5",
);
export const reset: Resetter = resetRoo;
export const list: Lister = listRoo;
