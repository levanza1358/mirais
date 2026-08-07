/**
 * Best-effort installer for optional runtime helpers (yt-dlp, ffmpeg).
 *
 * Mirais itself doesn't need these to start — but the Music page does. If
 * yt-dlp is missing we still serve (the Music code falls back to Invidious
 * public instances), but search/stream quality drops sharply. So we try to
 * install it once and quietly continue on failure.
 *
 * Runs cross-platform. Idempotent — does nothing when the binary is
 * already present on PATH.
 */
import { spawn, spawnSync } from "node:child_process";

export interface InstallReport {
  tool: string;
  ok: boolean;
  via: string | null;
  message: string;
}

function which(bin: string): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(probe, [bin], { stdio: ["ignore", "pipe", "ignore"] });
  if (res.status === 0) {
    const out = res.stdout.toString("utf8").trim().split(/\r?\n/)[0];
    return out ?? null;
  }
  return null;
}

async function run(command: string, args: string[], cwd?: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => resolve({ ok: false, message: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, message: stderr.trim() || `${command} exited with code ${code ?? 1}` }));
  });
}

/** Install yt-dlp if missing. Returns a status report. */
export async function ensureYtDlp(): Promise<InstallReport> {
  if (which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: "already-installed", message: "yt-dlp already on PATH" };

  if (process.platform === "win32") {
    // 1. winget — best, no extra toolchain.
    if (which("winget")) {
      const res = await run("winget", ["install", "--id", "yt-dlp.yt-dlp", "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]);
      if (res.ok && which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: "winget", message: "installed via winget" };
    }
    // 2. scoop — common alternative.
    if (which("scoop")) {
      const res = await run("scoop", ["install", "yt-dlp"]);
      if (res.ok && which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: "scoop", message: "installed via scoop" };
    }
    // 3. pip user install — fallback.
    if (which("pip") || which("pip3")) {
      const pip = which("pip") ? "pip" : "pip3";
      const res = await run(pip, ["install", "--user", "yt-dlp"]);
      if (res.ok && which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: pip, message: "installed via pip --user" };
    }
    return { tool: "yt-dlp", ok: false, via: null, message: "could not install yt-dlp — install winget, scoop, or Python pip and re-run `mirais fix`." };
  }

  // Linux / macOS
  if (process.platform === "linux") {
    // 1. pipx — clean isolated install.
    if (which("pipx")) {
      const res = await run("pipx", ["install", "yt-dlp"]);
      if (res.ok && which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: "pipx", message: "installed via pipx" };
    }
    // 2. apt — works on Ubuntu/Debian without extra tooling.
    if (which("apt-get")) {
      const res = await run("sudo", ["apt-get", "install", "-y", "yt-dlp"]);
      if (res.ok && which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: "apt-get", message: "installed via apt-get" };
    }
    // 3. dnf — Fedora/RHEL.
    if (which("dnf")) {
      const res = await run("sudo", ["dnf", "install", "-y", "yt-dlp"]);
      if (res.ok && which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: "dnf", message: "installed via dnf" };
    }
    // 4. pip --user fallback.
    if (which("pip3") || which("pip")) {
      const pip = which("pip3") ? "pip3" : "pip";
      const res = await run(pip, ["install", "--user", "--break-system-packages", "yt-dlp"]).catch(() =>
        run(pip, ["install", "--user", "yt-dlp"]),
      );
      if (res.ok && which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: pip, message: "installed via pip --user" };
    }
    return { tool: "yt-dlp", ok: false, via: null, message: "could not install yt-dlp — install pipx, python3-pip, or use apt and re-run `mirais fix`." };
  }

  if (process.platform === "darwin") {
    if (which("brew")) {
      const res = await run("brew", ["install", "yt-dlp"]);
      if (res.ok && which("yt-dlp")) return { tool: "yt-dlp", ok: true, via: "brew", message: "installed via brew" };
    }
  }
  return { tool: "yt-dlp", ok: false, via: null, message: "unsupported platform for auto-install; install yt-dlp manually." };
}

/** Install ffmpeg (recommended for richer audio extraction). Optional. */
export async function ensureFfmpeg(): Promise<InstallReport> {
  if (which("ffmpeg")) return { tool: "ffmpeg", ok: true, via: "already-installed", message: "ffmpeg already on PATH" };

  if (process.platform === "win32") {
    if (which("winget")) {
      const res = await run("winget", ["install", "--id", "Gyan.FFmpeg", "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]);
      if (res.ok && which("ffmpeg")) return { tool: "ffmpeg", ok: true, via: "winget", message: "installed via winget" };
    }
    if (which("choco")) {
      const res = await run("choco", ["install", "-y", "ffmpeg"]);
      if (res.ok && which("ffmpeg")) return { tool: "ffmpeg", ok: true, via: "choco", message: "installed via choco" };
    }
  } else if (process.platform === "linux") {
    if (which("apt-get")) {
      const res = await run("sudo", ["apt-get", "install", "-y", "ffmpeg"]);
      if (res.ok && which("ffmpeg")) return { tool: "ffmpeg", ok: true, via: "apt-get", message: "installed via apt-get" };
    }
    if (which("dnf")) {
      const res = await run("sudo", ["dnf", "install", "-y", "ffmpeg"]);
      if (res.ok && which("ffmpeg")) return { tool: "ffmpeg", ok: true, via: "dnf", message: "installed via dnf" };
    }
  } else if (process.platform === "darwin" && which("brew")) {
    const res = await run("brew", ["install", "ffmpeg"]);
    if (res.ok && which("ffmpeg")) return { tool: "ffmpeg", ok: true, via: "brew", message: "installed via brew" };
  }
  return { tool: "ffmpeg", ok: false, via: null, message: "ffmpeg not installed (optional — yt-dlp works without it for audio)." };
}

/** Run all extras in a sensible order, logging each result. */
export async function ensureExtras(): Promise<InstallReport[]> {
  const reports: InstallReport[] = [];
  for (const installer of [ensureYtDlp, ensureFfmpeg]) {
    const report = await installer();
    reports.push(report);
    const prefix = report.ok ? "✓" : "✗";
    console.log(`[extras] ${prefix} ${report.tool}: ${report.message}${report.via ? ` (${report.via})` : ""}`);
  }
  return reports;
}

/** Quiet variant for install/update flows that want a clean terminal. */
export async function ensureExtrasQuiet(): Promise<InstallReport[]> {
  const reports: InstallReport[] = [];
  for (const installer of [ensureYtDlp, ensureFfmpeg]) {
    reports.push(await installer());
  }
  return reports;
}