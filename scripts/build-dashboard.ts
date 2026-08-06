// Build the dashboard into dashboard/dist (cross-platform).
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const root = path.join(import.meta.dir, "..");
const dashDir = path.join(root, "dashboard");

if (!fs.existsSync(path.join(dashDir, "package.json"))) {
  console.error("dashboard/ not found — nothing to build.");
  process.exit(1);
}

const bun = process.platform === "win32" ? "bun.exe" : "bun";

if (!fs.existsSync(path.join(dashDir, "node_modules"))) {
  console.log("Installing dashboard dependencies...");
  const install = spawnSync(bun, ["install"], { cwd: dashDir, stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

console.log("Building dashboard...");
const build = spawnSync(bun, ["run", "build"], { cwd: dashDir, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

console.log("Dashboard built → dashboard/dist");
