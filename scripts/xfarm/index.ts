/**
 * Node.js wrapper for xAI Farm Python script.
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

interface PythonCommand {
  command: string;
  prefix: string[];
}

let farmPython: Promise<PythonCommand> | null = null;

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

export interface XaiFarmInstallReport {
  success: boolean;
  checks: XaiFarmDependencyStatus[];
  error?: string;
}

export type XaiFarmInstallProgress = (progress: number, stage: string) => void;

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

async function resolveFarmPython(): Promise<PythonCommand> {
  farmPython ??= Promise.resolve({ command: venvPython, prefix: [] });
  return farmPython;
}

async function runPython(args: string[], timeoutMs: number) {
  const python = await resolveFarmPython();
  return runCommand(python.command, [...python.prefix, ...args], timeoutMs);
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
  const python = await resolveFarmPython();

  return new Promise((resolve) => {
    const proc = spawn(python.command, [...python.prefix, ...args], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...farmEnv, ...(options.debug ? { XAI_FARM_DEBUG: "1" } : {}) },
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
    const proc = spawn(command, args, { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], env: farmEnv, windowsHide: true });
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

async function hasCamoufoxBrowser(): Promise<boolean> {
  try {
    const versions = await fsp.readdir(path.join(camoufoxCacheDir, "browsers", "official"), { withFileTypes: true });
    return versions.some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

export async function checkXaiFarmDependencies(imapConfigured: boolean): Promise<XaiFarmDependencyReport> {
  const python = await runPython(["--version"], 10_000);
  const packages = python.code === 0
    ? await runPython(["-c", "import browserforge, camoufox, dotenv; print('OK')"], 15_000)
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
      detail: python.code === 0 ? `${python.output} (.venv)` : "Local .venv is missing; install it from the dashboard",
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
  await fsp.mkdir(camoufoxCacheDir, { recursive: true });
  const result = await runPython([
    "-c",
    "import runpy,sys; from pathlib import Path; import camoufox.pkgman as p; p.INSTALL_DIR=Path(sys.argv[1]); sys.argv=['camoufox','fetch']; runpy.run_module('camoufox',run_name='__main__')",
    camoufoxCacheDir,
  ], 300_000);
  if (result.code !== 0) return { success: false, error: result.output || "camoufox fetch failed" };
  if (!(await hasCamoufoxBrowser())) return { success: false, error: "camoufox fetch completed but the browser cache was not detected" };
  return { success: true };
}

async function createXaiFarmVenv(): Promise<string | null> {
  const candidates: PythonCommand[] = process.platform === "win32"
    ? [{ command: "py", prefix: ["-3"] }, { command: "python", prefix: [] }]
    : [{ command: "python3", prefix: [] }, { command: "python", prefix: [] }];
  for (const candidate of candidates) {
    const version = await runCommand(candidate.command, [...candidate.prefix, "--version"], 10_000);
    if (version.code !== 0) continue;
    const result = await runCommand(candidate.command, [...candidate.prefix, "-m", "venv", venvDir], 120_000);
    if (result.code === 0) return null;
    return result.output || "Failed to create local .venv";
  }
  return "Python 3 is required to create the local .venv";
}

export async function installXaiFarmMissingDependencies(
  imapConfigured: boolean,
  onProgress: XaiFarmInstallProgress = () => {},
): Promise<XaiFarmInstallReport> {
  onProgress(5, "Checking local runtime");
  let report = await checkXaiFarmDependencies(imapConfigured);
  const pythonMissing = report.checks.some((check) => check.key === "python" && !check.ok);
  if (pythonMissing) {
    onProgress(10, "Creating local Python environment");
    const error = await createXaiFarmVenv();
    if (error) return { success: false, checks: report.checks, error };
    onProgress(30, "Local Python environment created");
    report = await checkXaiFarmDependencies(imapConfigured);
  }

  const packagesMissing = report.checks.some((check) => check.key === "packages" && !check.ok);
  if (packagesMissing) {
    onProgress(35, "Installing Python packages");
    const result = await runPython(["-m", "pip", "install", "-r", path.join(__dirname, "requirements.txt")], 600_000);
    if (result.code !== 0) return { success: false, checks: report.checks, error: result.output || "Python package installation failed" };
    onProgress(65, "Python packages installed");
    report = await checkXaiFarmDependencies(imapConfigured);
  }

  const browserMissing = report.checks.some((check) => check.key === "browser" && !check.ok);
  if (browserMissing) {
    onProgress(70, "Downloading Camoufox browser");
    const result = await installXaiFarmBrowser();
    if (!result.success) return { success: false, checks: report.checks, error: result.error || "Camoufox browser installation failed" };
    onProgress(95, "Verifying installation");
    report = await checkXaiFarmDependencies(imapConfigured);
  }

  onProgress(100, "Installation complete");
  return { success: true, checks: report.checks };
}
