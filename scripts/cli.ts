/**
 * mirais CLI — start / stop / restart / status
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
import { config } from "../src/config";

const pidFile = path.join(config.dataDir, "mirais.pid");
const logFile = path.join(config.dataDir, "mirais.log");
const serverEntry = path.join(import.meta.dir, "..", "src", "server.ts");
const baseUrl = `http://${config.host}:${config.port}`;

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
    console.log(`  url: ${baseUrl}`);
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
    console.log(`mirais is running (pid ${pid}) — ${baseUrl} — healthy`);
  } else if (alive) {
    console.log(`mirais process exists (pid ${pid}) but ${baseUrl}/health is not responding`);
    process.exitCode = 1;
  } else {
    console.log("mirais is not running");
    process.exitCode = 3; // LSB convention: program not running
  }
}

const cmd = process.argv[2];
switch (cmd) {
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "restart": await stop(); await start(); break;
  case "status": await status(); break;
  default:
    console.log("Usage: mirais <start|stop|restart|status>");
    process.exitCode = cmd ? 1 : 0;
}
