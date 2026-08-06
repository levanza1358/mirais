import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const installInfoDir = process.platform === "win32"
  ? path.join(process.env.ProgramData ?? "C:\\ProgramData", "Mirais")
  : path.join(os.homedir(), ".config", "mirais");

const installInfoPath = path.join(installInfoDir, "install.json");

export function writeInstallInfo(root: string): void {
  fs.mkdirSync(installInfoDir, { recursive: true });
  fs.writeFileSync(installInfoPath, JSON.stringify({ root: path.resolve(root) }, null, 2));
}

export function readInstallRoot(fallback?: string): string {
  try {
    const raw = fs.readFileSync(installInfoPath, "utf8");
    const parsed = JSON.parse(raw) as { root?: string };
    if (parsed.root) return path.resolve(parsed.root);
  } catch {
    // ignore
  }
  return fallback ? path.resolve(fallback) : path.resolve(import.meta.dir, "..");
}

export { installInfoPath };