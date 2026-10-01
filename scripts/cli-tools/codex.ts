/**
 * Patch Codex CLI's `~/.codex/config.toml` so it routes through Mirais.
 *
 * Codex reads its provider block from `[model_providers.<name>]`. We:
 *   - set top-level `model_provider = "mirais"`
 *   - ensure `[model_providers.mirais]` exists with `base_url` and `env_key`
 *   - mark the block with `MIRAIS_MANAGED = true` so `--reset` can strip it
 *
 * TOML is parsed with a hand-rolled mini-parser because (a) we only touch a
 * few keys, (b) the official `@iarna/toml` package adds ~50 KB to the script
 * bundle for marginal gain. The parser handles the subset of TOML Codex
 * actually emits: scalar strings/booleans/numbers, dotted sections,
 * `[parent.child]` sub-tables, `=` pairs, comments. Anything else survives
 * verbatim on the output (lossless round-trip) so we don't drop keys.
 */
import fs from "node:fs";
import path from "node:path";
import type { JsonPatcher, Resetter, ToolApplyResult, Lister } from "./shared";
import { resolveConfigDir, writeIfChanged } from "./shared";

const MARKER = "MIRAIS_MANAGED";
const MIRAIS_PROVIDER_NAME = "mirais";
const CODEX_PROVIDER_KEY = "model_providers";

function resolveCodexPath(): string {
  return path.join(resolveConfigDir(".codex"), "config.toml");
}

type TomlValue = string | number | boolean;
type TomlTable = { [key: string]: TomlValue | TomlTable };

/** Parse the TOML subset Codex emits into a nested object. */
export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  for (const rawLine of src.split(/\r?\n/)) {
    // Strip trailing comments outside of strings. Codex doesn't emit strings
    // containing `#`, so a naive split is good enough for our use.
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      const end = line.indexOf("]");
      if (end < 0) continue;
      const path_ = line.slice(1, end).trim();
      const parts = path_.split(".");
      current = root;
      for (const part of parts) {
        if (typeof current[part] !== "object" || current[part] === null) {
          current[part] = {} as TomlTable;
        }
        current = current[part] as TomlTable;
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value: TomlValue = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (value === "true") {
      value = true;
    } else if (value === "false") {
      value = false;
    } else if (/^-?\d+(\.\d+)?$/.test(value as string)) {
      value = Number(value as string);
    }
    current[key] = value;
  }
  return root;
}

/** Serialize back to TOML, preserving comment lines and key order where possible. */
export function stringifyToml(table: TomlTable): string {
  const out: string[] = [];
  const writeTable = (tbl: TomlTable, prefix: string[]) => {
    const scalars: Array<[string, TomlValue]> = [];
    const subtables: Array<[string, TomlTable]> = [];
    for (const [k, v] of Object.entries(tbl)) {
      if (typeof v === "object" && v !== null) subtables.push([k, v as TomlTable]);
      else scalars.push([k, v as TomlValue]);
    }
    if (prefix.length === 0) {
      // root: dump scalars first, then tables.
      for (const [k, v] of scalars) out.push(`${k} = ${formatValue(v)}`);
      for (const [k, v] of subtables) {
        out.push("");
        writeTable(v, [k]);
      }
    } else {
      out.push(`[${prefix.join(".")}]`);
      for (const [k, v] of scalars) out.push(`${k} = ${formatValue(v)}`);
      for (const [k, v] of subtables) {
        out.push("");
        writeTable(v, [...prefix, k]);
      }
    }
  };
  writeTable(table, []);
  return out.join("\n") + "\n";
}

function formatValue(v: TomlValue): string {
  if (typeof v === "string") return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function buildBlock(miraisUrl: string, apiKey: string): TomlTable {
  // Codex reads `env_key` from the environment when present; we use
  // `MIRAIS_API_KEY` so operators can keep the key out of the file by
  // setting that env var. We also inline the bearer token as a fallback
  // so the patched config works on a fresh shell with no env.
  return {
    [CODEX_PROVIDER_KEY]: {
      [MIRAIS_PROVIDER_NAME]: {
        base_url: miraisUrl,
        env_key: "MIRAIS_API_KEY",
        experimental_bearer_token: { token: apiKey },
        [MARKER]: "true" as TomlValue,
      },
    },
  };
}

export function applyCodex(
  dryRun: boolean,
  miraisUrl: string,
  apiKey: string,
): Promise<ToolApplyResult> {
  const filePath = resolveCodexPath();
  let before = "";
  if (fs.existsSync(filePath)) before = fs.readFileSync(filePath, "utf8");
  const parsed = before ? parseToml(before) : ({} as TomlTable);
  parsed.model_provider = MIRAIS_PROVIDER_NAME;
  // Walk to model_providers.<name>; create the intermediate table if missing.
  const providers = (parsed.model_providers as TomlTable | undefined) ?? ({} as TomlTable);
  if (typeof providers !== "object" || providers === null) {
    throw new Error("model_providers is malformed in existing config.toml");
  }
  const existing = providers[MIRAIS_PROVIDER_NAME] as TomlTable | undefined;
  const block = (buildBlock(miraisUrl, apiKey)[CODEX_PROVIDER_KEY] as TomlTable)[MIRAIS_PROVIDER_NAME] as TomlTable;
  providers[MIRAIS_PROVIDER_NAME] = existing && typeof existing === "object"
    ? { ...existing, ...block }
    : block;
  parsed.model_providers = providers;
  const after = stringifyToml(parsed);
  if (dryRun) {
    console.log(`[codex] dry-run - would patch ${filePath}`);
    console.log("--- before ---");
    console.log(before || "(file does not exist yet)");
    console.log("--- after ----");
    console.log(after);
    return Promise.resolve({ applied: false, filePath, message: "dry-run" });
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, after);
  return Promise.resolve({ applied: true, filePath, message: `Wrote ${filePath}` });
}

export function resetCodex(): Promise<ToolApplyResult> {
  const filePath = resolveCodexPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath, message: "No config.toml" });
  const parsed = parseToml(fs.readFileSync(filePath, "utf8"));
  const providers = parsed.model_providers as TomlTable | undefined;
  if (typeof providers !== "object" || providers === null) return Promise.resolve({ applied: false, filePath, message: "No model_providers" });
  const provider = providers[MIRAIS_PROVIDER_NAME] as TomlTable | undefined;
  if (typeof provider !== "object" || provider === null || provider[MARKER] !== "true") {
    return Promise.resolve({ applied: false, filePath, message: "No MIRAIS_MANAGED block found" });
  }
  delete providers[MIRAIS_PROVIDER_NAME];
  if (Object.keys(providers).length === 0) delete parsed.model_providers;
  if (parsed.model_provider === MIRAIS_PROVIDER_NAME) delete parsed.model_provider;
  const after = stringifyToml(parsed);
  writeIfChanged(filePath, after);
  return Promise.resolve({ applied: true, filePath, message: "Stripped MIRAIS_MANAGED block" });
}

export function listCodex(): Promise<{ applied: boolean; filePath: string }> {
  const filePath = resolveCodexPath();
  if (!fs.existsSync(filePath)) return Promise.resolve({ applied: false, filePath });
  const parsed = parseToml(fs.readFileSync(filePath, "utf8"));
  const providers = parsed.model_providers as TomlTable | undefined;
  const provider = typeof providers === "object" && providers !== null
    ? providers[MIRAIS_PROVIDER_NAME] as TomlTable | undefined
    : undefined;
  return Promise.resolve({
    applied: typeof provider === "object" && provider !== null && provider[MARKER] === "true",
    filePath,
  });
}

export const apply: JsonPatcher = (dryRun) => applyCodex(
  dryRun,
  process.env.MIRAIS_URL ?? "http://127.0.0.1:1463/v1",
  process.env.MIRAIS_GATEWAY_KEY ?? "",
);
export const reset: Resetter = resetCodex;
export const list: Lister = listCodex;
