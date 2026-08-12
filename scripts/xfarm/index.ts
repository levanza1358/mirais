/**
 * Node.js wrapper for xAI Farm Python script.
 * Spawns Python process and returns parsed result.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const camoufoxCacheDir = path.join(projectRoot, ".camoufox");

export interface XaiFarmDependencyStatus {
  key: "imap" | "python" | "packages" | "browser";
  label: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface XaiFarmDependencyReport {
  ok: boolean;
  checks: XaiFarmDependencyStatus[];
}

export interface XaiFarmResult {
  success: boolean;
  email?: string;
  password?: string;
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

export interface XaiFarmOptions {
  headless?: boolean;
  timeout?: number;
  debug?: boolean;
  config?: {
    enabled: boolean;
    gmail_username: string;
    gmail_app_password: string;
    email_domain: string;
    headless: boolean;
    otp_check_interval: number;
    otp_max_retries: number;
  };
  email?: string;
  password?: string;
}

export async function runXaiFarm(options: XaiFarmOptions = {}): Promise<XaiFarmResult> {
  const scriptPath = path.join(__dirname, "farm.py");
  const outputPath = path.join(__dirname, `result_${Date.now()}.json`);
  const configPath = options.config ? path.join(__dirname, `config_${Date.now()}.json`) : null;

  if (configPath && options.config) {
    await fsp.writeFile(configPath, JSON.stringify(options.config, null, 2));
  }

  const args = [scriptPath, "--output", outputPath];
  if (configPath) args.push("--config", configPath);
  if (options.email) args.push("--email", options.email);
  if (options.password) args.push("--password", options.password);

  return new Promise((resolve) => {
    const proc = spawn("python", args, {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.debug ? { XAI_FARM_DEBUG: "1" } : {}) },
      timeout: options.timeout ?? 300_000,
      // On Windows, spawn() defaults to opening a console window for the
      // child process. Farm runs are spawned from the dashboard server — hide
      // the child console so a Python window doesn't pop up on the desktop.
      windowsHide: true,
    });

    let stderr = "";
    proc.stdout.on("data", (data) => console.log("[XFARM]", data.toString().trim()));
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      console.error("[XFARM ERROR]", data.toString().trim());
    });

    proc.on("close", async (code) => {
      const cleanup = async () => {
        await fsp.unlink(outputPath).catch(() => {});
        if (configPath) await fsp.unlink(configPath).catch(() => {});
      };

      try {
        const resultText = await fsp.readFile(outputPath, "utf-8");
        await cleanup();
        const result = JSON.parse(resultText) as XaiFarmResult;
        resolve(result);
      } catch (err) {
        await cleanup();
        resolve({
          success: false,
          error: code === 0
            ? `Failed to parse result: ${err instanceof Error ? err.message : String(err)}`
            : `Python script exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
        });
      }
    });

    proc.on("error", (err) => resolve({ success: false, error: `Failed to spawn Python: ${err.message}` }));
  });
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true });
    let output = "";
    proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { output += chunk.toString(); });
    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ code: null, output: output || "Command timed out" });
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output: output.trim() });
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: null, output: error.message });
    });
  });
}

async function directoryHasOfficialBrowser(dir: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase().includes("official")) return true;
        if (await directoryHasOfficialBrowser(fullPath)) return true;
      }
    }
  } catch {
    // ignore inaccessible paths
  }
  return false;
}

async function hasCamoufoxBrowser(): Promise<boolean> {
  const candidates = [camoufoxCacheDir];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "camoufox"));
  } else if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, ".camoufox"));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && await directoryHasOfficialBrowser(candidate)) return true;
  }
  return false;
}

export async function checkXaiFarmDependencies(imapConfigured: boolean): Promise<XaiFarmDependencyReport> {
  const python = await runCommand("python", ["--version"], 10_000);
  const packages = python.code === 0
    ? await runCommand("python", ["-c", "import browserforge, camoufox, dotenv; print('OK')"], 15_000)
    : { code: null, output: "Python is not available" };
  const browserInstalled = await hasCamoufoxBrowser();
  const checks: XaiFarmDependencyStatus[] = [
    {
      key: "imap",
      label: "XAI IMAP Settings",
      ok: imapConfigured,
      detail: imapConfigured ? "Configured" : "Gmail, App Password, and verification URL are required",
      required: true,
    },
    {
      key: "python",
      label: "Python",
      ok: python.code === 0,
      detail: python.code === 0 ? python.output : "Python is not installed or not in PATH",
      required: true,
    },
    {
      key: "packages",
      label: "Python packages",
      ok: packages.code === 0,
      detail: packages.code === 0 ? "browserforge, camoufox, and dotenv installed" : "browserforge/camoufox/dotenv packages are missing",
      required: true,
    },
    {
      key: "browser",
      label: "Camoufox browser",
      ok: browserInstalled,
      detail: browserInstalled ? "Browser cache found" : "Camoufox browser is not installed",
      required: true,
    },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

export async function installXaiFarmBrowser(): Promise<XaiFarmResult> {
  process.env.CAMOUFOX_CACHE_DIR = camoufoxCacheDir;
  const result = await runCommand("python", ["-m", "camoufox", "fetch"], 300_000);
  if (result.code !== 0) return { success: false, error: result.output || "camoufox fetch failed" };
  if (!(await hasCamoufoxBrowser())) return { success: false, error: "camoufox fetch completed but the browser cache was not detected" };
  return { success: true };
}
