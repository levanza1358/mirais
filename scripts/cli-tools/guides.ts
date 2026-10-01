/**
 * Markdown setup guides for tools we don't (and can't) auto-configure.
 * Cursor's API base is set per-feature in the UI, and Antigravity / Copilot
 * intercept live IDE traffic. We print a checklist of menu paths and the
 * exact values the operator needs to paste.
 */
import type { JsonPatcher, Resetter, ToolApplyResult, Lister } from "./shared";

const MARGINS = "+------------------------------------------+";

function printGuide(name: string, body: string): ToolApplyResult {
  console.log(MARGINS);
  console.log(`|  Setup guide: ${name.padEnd(28)} |`);
  console.log(MARGINS);
  console.log(body);
  return { applied: false, filePath: "(guide)", message: `Printed setup guide for ${name}` };
}

export function guideCursor(): ToolApplyResult {
  return printGuide("Cursor", [
    "Cursor uses per-feature API base overrides (no global config file).",
    "",
    "1. Open Cursor → Settings (Ctrl+,) → Models.",
    "2. Click 'OpenAI API Key' → 'Override OpenAI Base URL'.",
    "3. Set Base URL:  http://127.0.0.1:1463/v1",
    "4. Set API Key:   mirais-<your-gateway-key>",
    "5. Click the model dropdown → 'Manage Models' → enable any of the Mirais models.",
    "   (Or query `GET /v1/models` with the gateway key to enumerate them.)",
    "",
    "Optional: Settings → Beta → 'Allow OpenAI endpoint override' must be ON.",
  ].join("\n"));
}

export function guideAntigravity(): ToolApplyResult {
  return printGuide("Antigravity (IDE subscription intercept)", [
    "Antigravity doesn't expose a global API override. To route through Mirais:",
    "",
    "1. Configure Antigravity to use a custom OpenAI-compatible endpoint:",
    "   - File → Settings → Models → 'Custom OpenAI Compatible'.",
    "   - Set Endpoint: http://127.0.0.1:1463/v1",
    "   - Set API Key:  mirais-<your-gateway-key>",
    "2. Disable Antigravity's built-in model picker; rely on Mirais only.",
    "3. Mind the IDE's policy — your subscription may prohibit routing calls elsewhere.",
  ].join("\n"));
}

export function guideGithubCopilot(): ToolApplyResult {
  return printGuide("GitHub Copilot (IDE subscription intercept)", [
    "GitHub Copilot doesn't expose a global API override. To route through Mirais:",
    "",
    "1. Install the 'Mirais Proxy' companion extension (not yet shipped — placeholder).",
    "2. Or: configure Copilot to use a 'Custom OpenAI Compatible' backend if your",
    "   IDE supports it (VS Code forks like Cursor / Continue do; stock VS Code",
    "   + Copilot chat does not).",
    "3. If intercepting locally, point the local proxy at http://127.0.0.1:1463/v1.",
    "   Mirais ships an HTTP-sidecar for this in scripts/copilot-sidecar/.",
  ].join("\n"));
}

// Exported as the "apply" entry for these guides so the dispatcher can find them.
export const applyCursor: JsonPatcher = () => Promise.resolve(guideCursor());
export const applyAntigravity: JsonPatcher = () => Promise.resolve(guideAntigravity());
export const applyGithubCopilot: JsonPatcher = () => Promise.resolve(guideGithubCopilot());
export const resetGuide: Resetter = () => Promise.resolve({ applied: false, filePath: "(guide)", message: "Guides are read-only" });
export const listGuide: Lister = () => Promise.resolve({ applied: false, filePath: "(guide)" });
