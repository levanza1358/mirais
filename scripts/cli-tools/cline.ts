/**
 * Patch Cline's `~/.cline/config.json`. Cline v3+ reads the OpenAI-style
 * settings block from there. We patch `apiProvider`, `openAiBaseUrl`,
 * `openAiApiKey`, `openAiModelId` under the marker scope.
 *
 * Some Cline installs use a different path (MCP server config under
 * `saoudrizwan.claude-dev/settings/`); for v1 we only patch the simpler
 * `~/.cline/config.json` route — it works for the vast majority of
 * Cline users without us having to guess the VS Code extension layout.
 */
import fs from "node:fs";
import path from "node:path";
import type { JsonPatcher, Resetter, ToolApplyResult, Lister } from "./shared";
import { patchJsonFile, resolveConfigDir, stripManaged } from "./shared";

const MARKER = "MIRAIS_MANAGED";

function resolveClinePath(): string {
  return path.join(resolveConfigDir(".cline"), "config.json");
}

function buildBlock(miraisUrl: string, apiKey: string, modelId: string): Record<string, unknown> {
  return {
    apiProvider: "OpenAI",
    openAiBaseUrl: miraisUrl,
    openAiApiKey: apiKey,
    openAiModelId: modelId,
  };
}

export function applyCline(
  dryRun: boolean,
  miraisUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ToolApplyResult> {
  const filePath = resolveClinePath();
  const block = buildBlock(miraisUrl, apiKey, modelId);
  if (dryRun) {
    let before: Record<string, unknown> | null = null;
    if (fs.existsSync(filePath)) {
      try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
      catch { before = null; }
    }
    const after = { ...(before ?? {}), ...block, [MARKER]: 1 };
    console.log(`[cline] dry-run — would patch ${filePath}`);
    console.log("--- before ---");
    console.log(JSON.stringify(before, null, 2));
    console.log("--- after ----");
    console.log(JSON.stringify(after, null, 2));
    return Promise.resolve({ applied: false, filePath, message: "dry-run" });
  }
  // Cline's top-level schema is flat — no scope prefix needed.
  patchJsonFile<Record<string, unknown>>(filePath, [], { ...block, [MARKER]: 1 }, MARKER, true);
  return Promise.resolve({ applied: true, filePath, message: `Wrote openAiBaseUrl + openAiApiKey + openAiModelId to ${filePath}` });
}

export function resetCline(): Promise<ToolApplyResult> {
  const filePath = resolveClinePath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath, message: "No config.json" });
  let before: Record<string, unknown>;
  try { before = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>; }
  catch { return Promise.resolve({ applied: false, filePath, message: "Malformed config.json" }); }
  if (before[MARKER] !== 1) return Promise.resolve({ applied: false, filePath, message: "No MIRAIS_MANAGED block" });
  // Top-level patch — strip the managed block entirely.
  const after = { ...before };
  for (const key of ["apiProvider", "openAiBaseUrl", "openAiApiKey", "openAiModelId", MARKER]) {
    delete (after as Record<string, unknown>)[key];
  }
  fs.writeFileSync(filePath, JSON.stringify(after, null, 2));
  return Promise.resolve({ applied: true, filePath, message: "Stripped MIRAIS_MANAGED block" });
}

export function listCline(): Promise<{ applied: boolean; filePath: string }> {
  const filePath = resolveClinePath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath });
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return Promise.resolve({ applied: parsed[MARKER] === 1, filePath });
  } catch { return Promise.resolve({ applied: false, filePath }); }
}

export const apply: JsonPatcher = (dryRun) => applyCline(
  dryRun,
  process.env.MIRAIS_URL ?? "http://127.0.0.1:1463/v1",
  process.env.MIRAIS_GATEWAY_KEY ?? "",
  process.env.MIRAIS_MODEL ?? "openai/gpt-5",
);
export const reset: Resetter = resetCline;
export const list: Lister = listCline;
