/**
 * mirais CLI — start / stop / restart / status / uninstall
 *
 * Manages the Mirais server as a background process using a PID file in DATA_DIR.
 * Cross-platform: works on Windows and Linux (no OS-specific APIs).
 *
 * Usage:
 *   bun run scripts/cli.ts start|stop|restart|status
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { config } from "../src/config";
import { closeDb, getDb } from "../src/store/db";
import { ensureEnvFile, readEnvFile, repoRoot, updateEnvFile } from "./env-file";
import { autostartStatus, setAutostart } from "./autostart";
import { readInstallRoot } from "./install-path";
import { ensureExtras, ensureExtrasQuiet, ensureYtDlp } from "./extras";

const installRoot = readInstallRoot(path.resolve(import.meta.dir, ".."));

const pidFile = path.join(config.dataDir, "mirais.pid");
const logFile = path.join(config.dataDir, "mirais.log");
const serverEntry = path.join(installRoot, "src", "server.ts");
const healthHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
const baseUrl = `http://${healthHost}:${config.port}`;
const displayUrl = `http://${config.host}:${config.port}`;

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, cross-platform
    return true;
  } catch {
    return false;
  }
}

async function httpOk(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpOk()) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function start(): Promise<void> {
  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.log(`mirais is already running (pid ${existing}) — ${baseUrl}`);
    return;
  }
  // stale pid file
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }

  fs.mkdirSync(config.dataDir, { recursive: true });
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, ["run", serverEntry], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
    cwd: path.join(import.meta.dir, ".."),
  });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(pidFile, String(child.pid));

  const ok = await waitForHealth(15_000);
  if (ok) {
    console.log(`mirais started (pid ${child.pid})`);
    console.log(`  url: ${displayUrl}`);
    console.log(`  log: ${logFile}`);
  } else {
    console.error(`mirais did not become healthy within 15s — check ${logFile}`);
    process.exitCode = 1;
  }
}

async function stop(): Promise<void> {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("mirais is not running");
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`failed to stop pid ${pid}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
  // wait for exit (up to 10s), then force-kill
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) break;
    await Bun.sleep(200);
  }
  if (isRunning(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
  console.log("mirais stopped");
}

async function status(): Promise<void> {
  const pid = readPid();
  const alive = pid !== null && isRunning(pid);
  const healthy = alive && (await httpOk());
  if (alive && healthy) {
    console.log(`mirais is running (pid ${pid}) — ${displayUrl} — healthy`);
  } else if (alive) {
    console.log(`mirais process exists (pid ${pid}) but ${baseUrl}/health is not responding`);
    process.exitCode = 1;
  } else {
    console.log("mirais is not running");
    process.exitCode = 3; // LSB convention: program not running
  }
}

function shell(command: string, args: string[], cwd = repoRoot): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? 1}`)));
  });
}

function appVersion(root: string): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Run a maintenance command without streaming its implementation details. */
function quietShell(command: string, args: string[], cwd = repoRoot): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe", shell: process.platform === "win32" });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed: ${output.trim().slice(-1_000) || `exit code ${code ?? 1}`}`));
    });
  });
}

async function updateApp(): Promise<void> {
  try {
    const previousVersion = appVersion(installRoot);
    await quietShell("git", ["pull", "--ff-only", "origin", "main"], installRoot);
    const nextVersion = appVersion(installRoot);
    console.log(`Mirais v${previousVersion} → v${nextVersion}`);
    console.log("Update in progress... please wait.");
    console.log("Clearing package and dashboard caches...");
    fs.rmSync(path.join(installRoot, "node_modules", ".cache"), { recursive: true, force: true });
    fs.rmSync(path.join(installRoot, "dashboard", "node_modules", ".cache"), { recursive: true, force: true });
    fs.rmSync(path.join(installRoot, "dashboard", "dist"), { recursive: true, force: true });
    await quietShell("bun", ["pm", "cache", "rm"], installRoot);
    await quietShell("bun", ["install"], installRoot);
    await quietShell("bun", ["install"], path.join(installRoot, "dashboard"));
    await quietShell("bun", ["run", "build"], installRoot);
    await restart();
    // Optional helpers are best-effort and must not make an application update
    // look failed. Their detailed output is intentionally suppressed here.
    try { await ensureExtrasQuiet(); } catch { /* optional */ }
    console.log(`Update successful. Check dashboard at ${displayUrl}`);
  } catch (err) {
    console.error(`Update failed. ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function fix(): Promise<void> {
  console.log("Mirais fix — updating source, dependencies, dashboard, and service");
  await shell("git", ["pull", "--ff-only", "origin", "main"], installRoot);
  await shell("bun", ["install"], installRoot);
  await shell("bun", ["install"], path.join(installRoot, "dashboard"));
  await shell("bun", ["run", "build"], installRoot);
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
  await ensureExtras();
  await start();
  console.log("Mirais fixed");
}

async function restart(): Promise<void> {
  await stop();
  await start();
}

async function autostart(mode: "on" | "off"): Promise<void> {
  const status = await setAutostart(mode);
  if (status.enabled) console.log(`mirais autostart enabled (${status.method}: ${status.detail})`);
  else console.log("mirais autostart disabled");
}

async function expose(mode: "on" | "off"): Promise<void> {
  updateEnvFile({ HOST: mode === "on" ? "0.0.0.0" : "127.0.0.1" });
  console.log(`mirais network binding set to ${mode === "on" ? "0.0.0.0" : "127.0.0.1"} — restart Mirais to apply`);
}

async function uninstall(): Promise<void> {
  if (process.argv[3] !== "--yes") {
    console.error("This permanently deletes Mirais, its database, logs, backups, and configuration.");
    console.error("Run `mirais uninstall --yes` to continue.");
    process.exitCode = 1;
    return;
  }

  await stop();
  try { await autostart("off"); } catch (err) {
    console.warn(`could not remove autostart entry: ${err instanceof Error ? err.message : err}`);
  }

  const installInfo = process.platform === "win32" ? path.join(process.env.ProgramData ?? "", "Mirais", "install.json") : null;
  const targets = [config.dataDir, installRoot];
  if (installInfo) targets.push(path.dirname(installInfo));
  for (const target of [...new Set(targets)]) {
    if (!target || !fs.existsSync(target)) continue;
    if (target === installRoot && path.resolve(target) === path.resolve(repoRoot)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`removed ${target}`);
  }
  console.log("Mirais uninstalled. The global launcher may need to be removed from PATH manually if it was installed separately.");
}

interface DoctorCheck {
  name: string;
  status: "ok" | "fixed" | "warn" | "error";
  detail?: string;
}

async function doctor(json = false): Promise<void> {
  const checks: DoctorCheck[] = [];
  const say = (line: string, stream: "out" | "err" = "out") => {
    if (json) return;
    if (stream === "err") console.error(line);
    else console.log(line);
  };

  say("Mirais doctor — checking installation, database, and service");
  let failed = false;
  const check = async (label: string, ok: boolean, repair?: () => Promise<void> | void) => {
    say(`${ok ? "OK" : "ERROR"}  ${label}`);
    if (ok) {
      checks.push({ name: label, status: "ok" });
      return;
    }
    if (repair) {
      try {
        await repair();
        say(`FIXED ${label}`);
        checks.push({ name: label, status: "fixed" });
        return;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failed = true;
        say(`FAIL  repair ${label}: ${detail}`, "err");
        checks.push({ name: label, status: "error", detail });
        return;
      }
    }
    failed = true;
    checks.push({ name: label, status: "error" });
  };

  const envPath = path.join(repoRoot, ".env");
  await check("installation root", fs.existsSync(installRoot));
  await check(".env file", fs.existsSync(envPath), () => ensureEnvFile());
  await check("dashboard build", fs.existsSync(path.join(installRoot, "dashboard", "dist", "index.html")), async () => {
    await shell("bun", ["run", "build"]);
  });

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "backups"), { recursive: true });
  const dbExists = fs.existsSync(config.dbPath);
  await check("database file", dbExists, () => {
    const database = getDb(config.dbPath);
    database.close();
    closeDb();
  });
  if (dbExists) {
    try {
      const database = new Database(config.dbPath, { readonly: true });
      const result = database.query("PRAGMA integrity_check").get() as { integrity_check?: string };
      database.close();
      await check("database integrity", result.integrity_check === "ok");
    } catch (err) {
      await check(`database integrity (${err instanceof Error ? err.message : String(err)})`, false);
    }
  }

  const pid = readPid();
  if (pid && !isRunning(pid)) {
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    say("FIXED stale PID file removed");
    checks.push({ name: "service process", status: "fixed", detail: "stale PID file removed" });
  } else {
    await check("service process", !!pid && isRunning(pid));
  }

  // yt-dlp is optional — the Music page falls back to Invidious when it's
  // missing. Doctor still surfaces it so the user knows the upgrade path.
  const ytdlp = await ensureYtDlp();
  say(`${ytdlp.ok ? "OK" : "WARN"}  yt-dlp (Music) — ${ytdlp.message}${ytdlp.via ? ` [${ytdlp.via}]` : ""}`);
  checks.push({ name: "yt-dlp (Music)", status: ytdlp.ok ? "ok" : "warn", detail: ytdlp.message });

  if (json) {
    console.log(JSON.stringify({
      ok: !failed,
      version: appVersion(installRoot),
      installRoot,
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      url: displayUrl,
      checks,
    }, null, 2));
  } else if (failed) {
    console.log("Doctor found issues. Safe repairs were applied where possible; run `mirais restart` and inspect data/mirais.log.");
  } else {
    console.log("Doctor found no issues.");
  }
  if (failed) process.exitCode = 1;
}

const cmd = process.argv[2];
switch (cmd) {
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "restart": await restart(); break;
  case "status": await status(); break;
  case "update": await updateApp(); break;
  case "autostart": {
    const mode = process.argv[3];
    if (mode === undefined || mode === "status") {
      const s = await autostartStatus();
      console.log(`mirais autostart ${s.enabled ? "enabled" : "disabled"} (${s.method}: ${s.detail})`);
      break;
    }
    if (mode !== "on" && mode !== "off") {
      console.log("Usage: mirais autostart <on|off|status>");
      process.exitCode = 1;
      break;
    }
    await autostart(mode);
    break;
  }
  case "expose": {
    const mode = process.argv[3];
    if (mode !== "on" && mode !== "off") {
      console.log("Usage: mirais expose <on|off>");
      process.exitCode = 1;
      break;
    }
    await expose(mode);
    break;
  }
  case "uninstall": await uninstall(); break;
  case "doctor":
    if (process.argv[3] === "--fix") await fix();
    else await doctor(process.argv.includes("--json"));
    break;
  case "fix": await fix(); break;
  case "extras": await ensureExtras(); break;
  default:
    console.log("Usage: mirais <start|stop|restart|status|doctor [--fix|--json]|fix|update|extras|autostart on|off|status|expose on|off|uninstall --yes>");
    process.exitCode = cmd ? 1 : 0;
}
