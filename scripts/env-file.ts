import fs from "node:fs";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dir, "..");
export const envFilePath = path.join(repoRoot, ".env");
export const envExamplePath = path.join(repoRoot, ".env.example");

export function ensureEnvFile(): void {
  if (!fs.existsSync(envFilePath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envFilePath);
  }
}

export function readEnvFile(filePath = envFilePath): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    out[key] = value;
  }
  return out;
}

export function updateEnvFile(updates: Record<string, string>, filePath = envFilePath): void {
  ensureEnvFile();
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next = existing.map((line) => {
    const idx = line.indexOf("=");
    if (idx <= 0) return line;
    const key = line.slice(0, idx).trim();
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  fs.writeFileSync(filePath, `${next.filter(Boolean).join("\n")}\n`);
}