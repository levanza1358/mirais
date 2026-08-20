/**
 * Node.js wrapper for Copilot bulk login Python script.
 * Spawns Python process and returns parsed result.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const camoufoxCacheDir = path.join(projectRoot, ".camoufox");
const venvDir = path.join(projectRoot, ".venv");
const venvPython = path.join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const farmEnv = { ...process.env, CAMOUFOX_CACHE_DIR: camoufoxCacheDir, PYTHONUTF8: "1" };

export interface CopilotBulkResult {
  email: string;
  success: boolean;
  error?: string | null;
  account_id?: string | null;
}

export interface CopilotBulkOptions {
  accounts: string; // path to accounts file
  headless?: boolean;
  timeout?: number;
}

export async function runCopilotBulkLogin(options: CopilotBulkOptions): Promise<CopilotBulkResult[]> {
  const scriptPath = path.join(__dirname, "copilot-bulk-login.py");
  const outputPath = path.join(__dirname, `result_${Date.now()}.json`);

  const args = [scriptPath, "--accounts", options.accounts, "--output", outputPath];
  if (options.headless !== false) args.push("--headless");
  else args.push("--no-headless");

  return new Promise((resolve) => {
    const proc = spawn(venvPython, args, {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: farmEnv,
      timeout: options.timeout ?? 600_000,
      windowsHide: true,
    });

    let stderr = "";
    proc.stdout.on("data", (data) => console.log("[COPILOT-BULK]", data.toString().trim()));
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      console.error("[COPILOT-BULK ERROR]", data.toString().trim());
    });

    proc.on("close", async (code) => {
      try {
        const resultText = await fsp.readFile(outputPath, "utf-8");
        await fsp.unlink(outputPath).catch(() => {});
        const result = JSON.parse(resultText) as CopilotBulkResult[];
        resolve(result);
      } catch (err) {
        await fsp.unlink(outputPath).catch(() => {});
        resolve([{
          email: "unknown",
          success: false,
          error: code === 0
            ? `Failed to parse result: ${err instanceof Error ? err.message : String(err)}`
            : `Python script exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
        }]);
      }
    });

    proc.on("error", (err) => resolve([{ email: "unknown", success: false, error: `Failed to spawn Python: ${err.message}` }]));
  });
}