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
import { ensureEnvFile, readEnvFile, repoRoot, updateEnvFile } from "./env-file";

const pidFile = path.join(config.dataDir, "mirais.pid");
const logFile = path.join(config.dataDir, "mirais.log");
const serverEntry = path.join(import.meta.dir, "..", "src", "server.ts");
const healthHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
const baseUrl = `http://${healthHost}:${config.port}`;
const displayUrl = `http://${config.host}:${config.port}`;
const serviceName = "mirais";

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

async function updateApp(): Promise<void> {
  await shell("git", ["pull", "--ff-only", "origin", "main"]);
  await shell("bun", ["install"]);
  await shell("bun", ["install"], path.join(repoRoot, "dashboard"));
  await shell("bun", ["run", "build"]);
  await restart();
  console.log("mirais updated");
}

async function restart(): Promise<void> {
  await stop();
  await start();
}

async function autostart(mode: "on" | "off"): Promise<void> {
  ensureEnvFile();
  if (process.platform === "win32") {
    const taskName = "Mirais";
    if (mode === "on") {
      const command = `PowerShell -NoProfile -ExecutionPolicy Bypass -Command \"Set-Location '${repoRoot.replace(/'/g, "''")}'; bun run scripts/cli.ts start\"`;
      await shell("schtasks", ["/Create", "/F", "/SC", "ONSTART", "/RL", "HIGHEST", "/TN", taskName, "/TR", command]);
      console.log("mirais autostart enabled (Task Scheduler)");
    } else {
      await shell("schtasks", ["/Delete", "/F", "/TN", taskName]);
      console.log("mirais autostart disabled");
    }
    return;
  }

  const servicePath = `/etc/systemd/system/${serviceName}.service`;
  if (mode === "on") {
    const bunPath = process.env.BUN_BIN ?? `${process.env.HOME ?? "/root"}/.bun/bin/bun`;
    const unit = `[Unit]\nDescription=Mirais AI Gateway\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${repoRoot}\nExecStart=${bunPath} run start\nRestart=on-failure\nRestartSec=3\nEnvironment=NODE_ENV=production\n\n[Install]\nWantedBy=multi-user.target\n`;
    fs.writeFileSync(servicePath, unit);
    await shell("sudo", ["systemctl", "daemon-reload"]);
    await shell("sudo", ["systemctl", "enable", "--now", serviceName]);
    console.log("mirais autostart enabled (systemd)");
  } else {
    await shell("sudo", ["systemctl", "disable", "--now", serviceName]);
    try { fs.unlinkSync(servicePath); } catch { /* ignore */ }
    await shell("sudo", ["systemctl", "daemon-reload"]);
    console.log("mirais autostart disabled");
  }
}

async function expose(mode: "on" | "off"): Promise<void> {
  updateEnvFile({ HOST: mode === "on" ? "0.0.0.0" : "127.0.0.1" });
  console.log(`mirais network binding set to ${mode === "on" ? "0.0.0.0" : "127.0.0.1"} — restart Mirais to apply`);
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
    if (mode !== "on" && mode !== "off") {
      console.log("Usage: mirais autostart <on|off>");
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
  default:
    console.log("Usage: mirais <start|stop|restart|status|update|autostart on|off|expose on|off>");
    process.exitCode = cmd ? 1 : 0;
}
