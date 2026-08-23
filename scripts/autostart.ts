/**
 * Autostart on boot.
 *
 * Two mechanisms, chosen by platform:
 *
 * - **Windows** — a launcher in the per-user Startup folder. Task Scheduler
 *   would start Mirais before login, but creating a task needs admin
 *   elevation; the Startup folder does not. Runs after login in the user's
 *   session so `bun` resolves from PATH.
 * - **Linux** — a systemd unit, which is what a VPS actually wants: it starts
 *   at boot without a login session and restarts on failure. Writing the unit
 *   needs root, so the dashboard can only manage it when Mirais runs as root
 *   or has passwordless sudo.
 *
 * Shared by the CLI (`mirais autostart on|off`) and the admin API so both
 * agree on the file locations and the enabled/disabled check.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureEnvFile, repoRoot } from "./env-file";

export const serviceName = "mirais";
const systemdUnitPath = `/etc/systemd/system/${serviceName}.service`;

export type AutostartMethod = "windows-startup" | "systemd" | "unsupported";

export interface AutostartStatus {
  platform: string;
  method: AutostartMethod;
  enabled: boolean;
  /** False when this process cannot change the setting (e.g. no root on Linux). */
  manageable: boolean;
  /** Where the autostart entry lives, or why it cannot be managed. */
  detail: string;
}

function windowsStartupLauncher(): string {
  const startupDir = path.join(
    process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
  );
  return path.join(startupDir, "Mirais.cmd");
}

function run(cmd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (c) => { output += String(c); });
    child.stderr?.on("data", (c) => { output += String(c); });
    child.on("error", (err) => resolve({ code: 1, output: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

/** Prefix for privileged commands: nothing as root, `sudo -n` otherwise. */
async function privileged(args: string[]): Promise<{ code: number; output: string }> {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (isRoot) return run(args[0]!, args.slice(1));
  // -n never prompts, so a missing sudo rule fails fast instead of hanging.
  return run("sudo", ["-n", ...args]);
}

async function canManageSystemd(): Promise<boolean> {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  const { code } = await run("sudo", ["-n", "true"]);
  return code === 0;
}

export async function autostartStatus(): Promise<AutostartStatus> {
  if (process.platform === "win32") {
    const launcher = windowsStartupLauncher();
    return {
      platform: process.platform,
      method: "windows-startup",
      enabled: fs.existsSync(launcher),
      manageable: true,
      detail: launcher,
    };
  }

  if (process.platform === "linux") {
    const { code } = await run("systemctl", ["is-enabled", serviceName]);
    const manageable = await canManageSystemd();
    return {
      platform: process.platform,
      method: "systemd",
      enabled: code === 0,
      manageable,
      detail: manageable
        ? systemdUnitPath
        : "needs root or passwordless sudo — run `mirais autostart on` in a terminal instead",
    };
  }

  return {
    platform: process.platform,
    method: "unsupported",
    enabled: false,
    manageable: false,
    detail: `automatic startup is not wired up for ${process.platform}; start Mirais from your own service manager`,
  };
}

/** Enable or disable start-on-boot. Throws with an actionable message on failure. */
export async function setAutostart(mode: "on" | "off"): Promise<AutostartStatus> {
  ensureEnvFile();

  if (process.platform === "win32") {
    const launcher = windowsStartupLauncher();
    const startupDir = path.dirname(launcher);
    if (mode === "on") {
      // Don't mkdir a directory that already exists: on this path Windows
      // reports EEXIST even with `recursive: true`, because the per-user
      // Start Menu tree is a known folder rather than a plain directory.
      if (!fs.existsSync(startupDir)) fs.mkdirSync(startupDir, { recursive: true });
      // `start` already redirects its own output to the log file, so the
      // launcher needs no redirect — keeping the cmd /c string free of nested
      // quotes (which would break when repoRoot contains spaces).
      fs.writeFileSync(
        launcher,
        `@echo off\r\ncd /d "${repoRoot}"\r\nstart "" /min cmd /c "bun run scripts\\cli.ts start"\r\n`,
      );
    } else {
      try { fs.unlinkSync(launcher); } catch { /* already gone */ }
    }
    return autostartStatus();
  }

  if (process.platform !== "linux") {
    throw new Error(`automatic startup is not supported on ${process.platform}`);
  }

  if (!(await canManageSystemd())) {
    throw new Error("root or passwordless sudo is required — run `mirais autostart on` in a terminal instead");
  }

  if (mode === "on") {
    const bunPath = process.env.BUN_BIN ?? process.execPath;
    const unit = `[Unit]
Description=Mirais AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${bunPath} run start
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
    // /etc is not writable without root, so stage the unit in the data dir and
    // copy it into place with the same privilege escalation as systemctl.
    const staged = path.join(repoRoot, ".mirais-autostart.service");
    fs.writeFileSync(staged, unit);
    try {
      const copy = await privileged(["cp", staged, systemdUnitPath]);
      if (copy.code !== 0) throw new Error(`could not write ${systemdUnitPath}: ${copy.output}`);
    } finally {
      try { fs.unlinkSync(staged); } catch { /* ignore */ }
    }
    const reload = await privileged(["systemctl", "daemon-reload"]);
    if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed: ${reload.output}`);
    const enable = await privileged(["systemctl", "enable", "--now", serviceName]);
    if (enable.code !== 0) throw new Error(`systemctl enable failed: ${enable.output}`);
  } else {
    await privileged(["systemctl", "disable", "--now", serviceName]);
    await privileged(["rm", "-f", systemdUnitPath]);
    await privileged(["systemctl", "daemon-reload"]);
  }

  return autostartStatus();
}
