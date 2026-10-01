/**
 * `mirais tools` — auto-configure CLI tools (Claude Code, Codex, Cline, Kilo,
 * Roo, Continue, Factory Droid) and print setup guides for tools that don't
 * support a global override (Cursor, Antigravity, GitHub Copilot).
 *
 * Usage:
 *   mirais tools                       # interactive picker
 *   mirais tools <tool>                # apply one tool
 *   mirais tools <tool> --dry-run      # show diff without writing
 *   mirais tools <tool> --reset        # strip the MIRAIS_MANAGED block
 *   mirais tools list                  # list applied status per tool
 *
 * Each tool writes under a `MIRAIS_MANAGED: 1` marker so `--reset` strips
 * only what Mirais added. User config outside that scope is preserved.
 */
import * as claudeCode from "./claude-code";
import * as codex from "./codex";
import * as cline from "./cline";
import * as kilo from "./kilo";
import * as roo from "./roo";
import * as cont from "./continue";
import * as factoryDroid from "./factory-droid";
import * as guides from "./guides";
import type { JsonPatcher, Resetter, Lister, ToolApplyResult } from "./shared";

export const TOOLS = [
  { id: "claude-code", label: "Claude Code", apply: claudeCode.apply, reset: claudeCode.reset, list: claudeCode.list },
  { id: "codex", label: "OpenAI Codex CLI", apply: codex.apply, reset: codex.reset, list: codex.list },
  { id: "cline", label: "Cline", apply: cline.apply, reset: cline.reset, list: cline.list },
  { id: "continue", label: "Continue", apply: cont.apply, reset: cont.reset, list: cont.list },
  { id: "kilo", label: "Kilo Code", apply: kilo.apply, reset: kilo.reset, list: kilo.list },
  { id: "roo", label: "Roo Code", apply: roo.apply, reset: roo.reset, list: roo.list },
  { id: "factory-droid", label: "Factory Droid", apply: factoryDroid.apply, reset: factoryDroid.reset, list: factoryDroid.list },
] as const;

export const GUIDES = [
  { id: "cursor", label: "Cursor", apply: guides.applyCursor, reset: guides.resetGuide, list: guides.listGuide },
  { id: "antigravity", label: "Antigravity (intercept)", apply: guides.applyAntigravity, reset: guides.resetGuide, list: guides.listGuide },
  { id: "github-copilot", label: "GitHub Copilot (intercept)", apply: guides.applyGithubCopilot, reset: guides.resetGuide, list: guides.listGuide },
] as const;

export type ToolId = (typeof TOOLS)[number]["id"] | (typeof GUIDES)[number]["id"];
const ALL = [...TOOLS, ...GUIDES] as const;

function findTool(id: string): { apply: JsonPatcher; reset: Resetter; list: Lister; label: string } | null {
  for (const t of TOOLS) if (t.id === id) return t;
  for (const g of GUIDES) if (g.id === id) return g;
  return null;
}

function isToolId(id: string): id is ToolId {
  return ALL.some((t) => t.id === id);
}

export async function listTools(): Promise<void> {
  console.log("Mirais-managed CLI tool status:");
  for (const t of ALL) {
    const status = await t.list();
    console.log(`  ${status.applied ? "●" : "○"}  ${t.label.padEnd(28)} ${status.applied ? "applied" : "not applied"}  ${status.filePath}`);
  }
}

export async function runTools(args: string[]): Promise<number> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return 0;
  }
  if (subcommand === "list") {
    await listTools();
    return 0;
  }
  if (!isToolId(subcommand)) {
    console.error(`Unknown tool: ${subcommand}`);
    console.error(`Run \`mirais tools help\` for a list of supported tools.`);
    return 2;
  }
  const dryRun = args.includes("--dry-run");
  const reset = args.includes("--reset");
  const tool = findTool(subcommand);
  if (!tool) return 2;
  if (reset) {
    const result = await tool.reset();
    console.log(result.message);
    return result.applied ? 0 : 1;
  }
  const result = await tool.apply(dryRun);
  console.log(result.message);
  return result.applied ? 0 : 1;
}

function printHelp(): void {
  console.log("mirais tools — auto-configure CLI tools to route through Mirais");
  console.log("");
  console.log("Usage:");
  console.log("  mirais tools                       Interactive menu");
  console.log("  mirais tools <tool>                Apply <tool>");
  console.log("  mirais tools <tool> --dry-run      Show diff without writing");
  console.log("  mirais tools <tool> --reset        Strip the MIRAIS_MANAGED block");
  console.log("  mirais tools list                  Show applied status per tool");
  console.log("");
  console.log("Auto-configured tools:");
  for (const t of TOOLS) console.log(`  ${t.id.padEnd(20)} ${t.label}`);
  console.log("");
  console.log("Tools with no global config (printed as guides):");
  for (const g of GUIDES) console.log(`  ${g.id.padEnd(20)} ${g.label}`);
  console.log("");
  console.log("Environment overrides:");
  console.log("  MIRAIS_URL             Gateway base URL (default http://127.0.0.1:1463)");
  console.log("  MIRAIS_GATEWAY_KEY     Gateway key to embed (anonymous if unset)");
  console.log("  MIRAIS_MODEL           Model id hint (default openai/gpt-5)");
}
