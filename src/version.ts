import fs from "node:fs";
import path from "node:path";

interface BuildMeta {
  version: string;
  builtAt: string;
  gitSha: string | null;
}

let cachedMeta: BuildMeta | null = null;

/**
 * Returns the Mirais backend version. Prefers the build-time metadata
 * written by the installer / build script, and falls back to the
 * backend package.json so the value is always meaningful.
 */
export function getAppVersion(): BuildMeta {
  if (cachedMeta) return cachedMeta;
  const root = path.join(import.meta.dir, "..");
  let pkgVersion = "0.0.0";
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    pkgVersion = (JSON.parse(raw) as { version?: string }).version ?? pkgVersion;
  } catch {
    // ignore — fall through to defaults
  }
  let builtAt = new Date().toISOString();
  let gitSha: string | null = null;
  try {
    const raw = fs.readFileSync(path.join(root, "data", "build.json"), "utf8");
    const data = JSON.parse(raw) as Partial<BuildMeta>;
    if (data.version) pkgVersion = data.version;
    if (data.builtAt) builtAt = data.builtAt;
    if (data.gitSha) gitSha = data.gitSha;
  } catch {
    // ignore — file is optional
  }
  try {
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref:")) {
      const ref = head.slice(5);
      try {
        gitSha = fs.readFileSync(path.join(root, ".git", ref), "utf8").trim().slice(0, 12);
      } catch { /* ignore */ }
    } else if (/^[0-9a-f]{7,}$/.test(head)) {
      gitSha = head.slice(0, 12);
    }
  } catch { /* not a git checkout — fine */ }
  cachedMeta = { version: pkgVersion, builtAt, gitSha };
  return cachedMeta;
}