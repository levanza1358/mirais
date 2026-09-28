/**
 * Node.js wrapper for the Atria session-cookie capturer.
 *
 * Atria's token balance only exists behind an `HttpOnly` Logto cookie, and the
 * sign-in form is captcha-gated, so the cookie cannot be minted server-side.
 * Instead a persistent Camoufox profile signs in once and the cookie jar is
 * harvested on every later run — no devtools, no copy-paste, works for any
 * number of accounts.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const projectRoot = path.resolve(__dirname, "..", "..");
const venvDir = path.join(projectRoot, ".venv");
const venvPython = path.join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const profileDir = path.join(projectRoot, ".atria-profile");
// PYTHONUTF8 keeps the browser's Unicode startup banner from crashing on the
// Windows cp1252 console. Deliberately NOT setting CAMOUFOX_CACHE_DIR: the
// package must resolve its own install directory (see capture-session.py).
const captureEnv = { ...process.env, ATRIA_PROFILE_DIR: profileDir, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

export interface AtriaCaptureResult {
  success: boolean;
  /** Ready-to-store `Cookie` header values, longest-lived first. */
  cookies: string[];
  signed_in: boolean;
  expires_at: string | null;
  verified?: boolean;
  error: string | null;
}

export interface AtriaCaptureOptions {
  /** Verify the harvested cookie against the console before returning it. */
  check?: boolean;
  /** Force a visible browser window (needed for the very first sign-in). */
  headed?: boolean;
  timeoutMs?: number;
}

export interface AtriaCaptureDependency {
  key: "python" | "packages" | "browser" | "profile";
  label: string;
  ok: boolean;
  detail: string;
}

export interface AtriaCaptureDependencyReport {
  ok: boolean;
  checks: AtriaCaptureDependency[];
}

function runPython(args: string[], timeoutMs: number): Promise<{ code: number | null; output: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(venvPython, args, { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], env: captureEnv, windowsHide: true });
    let output = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { proc.kill(); resolve({ code: null, output: output.trim(), stderr: stderr.trim() }); }, timeoutMs);
    proc.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.trim(), stderr: stderr.trim() }); });
    proc.on("error", (error) => { clearTimeout(timer); resolve({ code: null, output: "", stderr: error.message }); });
  });
}

/**
 * Ask Camoufox where its browser actually is, instead of guessing.
 *
 * `python -m camoufox path` prints the resolved install directory, honouring
 * whatever channel/version is pinned. This is the same path the library will
 * use at launch, so a positive answer here means the browser really is usable —
 * no more false "not downloaded yet" from checking a directory the package
 * never reads.
 */
async function camoufoxBrowserDetail(): Promise<{ ok: boolean; detail: string }> {
  const probe = await runPython(
    ["-m", "camoufox", "path"],
    20_000,
  );
  if (probe.code !== 0) {
    return { ok: false, detail: "Run: .venv\\Scripts\\python -m camoufox fetch" };
  }
  // The CLI may print banners around the path; take the last line that looks
  // like a filesystem path.
  const candidate = probe.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(" ") && /[\\/]/.test(line))
    .pop();
  if (!candidate) {
    return { ok: false, detail: "Run: .venv\\Scripts\\python -m camoufox fetch" };
  }
  // `camoufox path` prints the cache root (the parent of `browsers/`), which is
  // exactly the directory `hasBrowserUnder` expects. The legacy flat layout
  // keeps `version.json` directly in that same root.
  const usable = await hasBrowserUnder(candidate) || await exists(path.join(candidate, "version.json"));
  return usable
    ? { ok: true, detail: `Found ${candidate}` }
    : { ok: false, detail: `Installed at ${candidate} but unusable — re-run: python -m camoufox fetch` };
}

async function hasBrowserUnder(root: string): Promise<boolean> {
  if (!root) return false;
  // Versioned layout: browsers/<repo>/<version>/version.json
  try {
    const reposRoot = path.join(root, "browsers");
    const repos = await fsp.readdir(reposRoot, { withFileTypes: true });
    for (const repo of repos) {
      if (!repo.isDirectory()) continue;
      const versions = await fsp.readdir(path.join(reposRoot, repo.name), { withFileTypes: true });
      for (const version of versions) {
        if (version.isDirectory() && await exists(path.join(reposRoot, repo.name, version.name, "version.json"))) return true;
      }
    }
  } catch { /* no versioned layout here */ }
  return false;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function hasSavedProfile(): Promise<boolean> {
  try {
    await fsp.access(profileDir);
    const entries = await fsp.readdir(profileDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** Report whether the capture pipeline can run, for the dashboard's status card. */
export async function checkAtriaCaptureDependencies(): Promise<AtriaCaptureDependencyReport> {
  const python = await runPython(["--version"], 10_000);
  const packages = python.code === 0
    ? await runPython(["-c", "import camoufox; print('OK')"], 15_000)
    : { code: null, output: "Python is not available", stderr: "" };
  const [browserReport, profile] = await Promise.all([camoufoxBrowserDetail(), hasSavedProfile()]);
  const checks: AtriaCaptureDependency[] = [
    { key: "python", label: "Python", ok: python.code === 0, detail: python.code === 0 ? `${python.output} (.venv)` : "Local .venv is missing" },
    { key: "packages", label: "Python packages", ok: packages.code === 0, detail: packages.code === 0 ? "camoufox installed" : "camoufox is missing" },
    { key: "browser", label: "Camoufox browser", ok: browserReport.ok, detail: browserReport.detail },
    { key: "profile", label: "Atria profile", ok: profile, detail: profile ? "Session saved" : "Sign-in not performed yet" },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

/**
 * Harvest the Atria console cookie from the persistent browser profile.
 *
 * The Python side writes a single JSON object to stdout; progress goes to
 * stderr so this parser only ever sees the structured result.
 */
export async function captureAtriaSession(options: AtriaCaptureOptions = {}): Promise<AtriaCaptureResult> {
  const script = path.join(__dirname, "capture-session.py");
  const args = [script, options.check ? "--check" : "--capture"];
  if (options.headed) args.push("--headed");

  const { output, stderr } = await runPython(args, options.timeoutMs ?? 360_000);
  const parsed = parseCaptureJson(output);
  if (!parsed) {
    // Prefer stderr for the message: that is where the Python side narrates
    // what actually went wrong (missing sign-in, browser launch failure, …).
    const detail = stderr || output || "capture returned no output";
    return { success: false, cookies: [], signed_in: false, expires_at: null, error: detail.slice(0, 500) };
  }
  return {
    success: parsed.success === true,
    cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
    signed_in: parsed.signed_in === true,
    expires_at: parsed.expires_at ?? null,
    verified: parsed.verified,
    error: parsed.error ?? null,
  };
}

/**
 * Pull the structured result out of the capture process' stdout.
 *
 * The Python side emits exactly one JSON object, but a browser library (or a
 * stray print) can append noise after it, so scanning for the first `{` and
 * handing the rest to `JSON.parse` is not enough. Walk every top-level object
 * and keep the last one that parses.
 */
function parseCaptureJson(output: string): Partial<AtriaCaptureResult> | null {
  let result: Partial<AtriaCaptureResult> | null = null;
  for (let i = output.indexOf("{"); i !== -1; i = output.indexOf("{", i + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < output.length; j += 1) {
      const char = output[j];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            result = JSON.parse(output.slice(i, j + 1)) as Partial<AtriaCaptureResult>;
          } catch { /* not a complete object — keep scanning */ }
          break;
        }
      }
    }
  }
  return result;
}

export { venvPython, profileDir };
