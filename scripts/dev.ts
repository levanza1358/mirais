// Dev launcher: backend (:1463) + Vite dashboard dev server, cross-platform.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const root = path.join(import.meta.dir, "..");
const hasDashboard = fs.existsSync(path.join(root, "dashboard", "package.json"));

const procs: Array<{ name: string; proc: ReturnType<typeof spawn> }> = [];

function run(name: string, cmd: string, args: string[], cwd: string) {
  const proc = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  procs.push({ name, proc });
  proc.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown(code ?? 0);
  });
}

function shutdown(code: number) {
  for (const p of procs) p.proc.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("server", "bun", ["--watch", "src/server.ts"], root);
if (hasDashboard) {
  run("dashboard", "bun", ["run", "dev"], path.join(root, "dashboard"));
} else {
  console.log("[dev] dashboard/ not found — backend only. Scaffold the dashboard to enable the Vite dev server.");
}
