import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Elysia } from "elysia";
import type { Database } from "../store/sql";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";
import { atriaLoginSchema } from "../shared/schemas";
import { ProvidersRepo } from "../store/repos/providers";
import { isAtriaProvider } from "../proxy/atria-usage";

/**
 * Atria account auto-login (Google) → API key.
 *
 * Mirrors the copilot bulk-login pipeline: an in-memory job that spawns a Python
 * Camoufox driver per account, serially, and streams logs to the dashboard.
 * See docs/10-atria-auto-login.md.
 */

const farmDir = path.resolve("scripts", "atria-farm");
const loginScript = path.join(farmDir, "login-account.py");
const venvDir = path.resolve(".venv");
const venvPython = path.join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const profilesRoot = path.resolve(".atria-profiles");

/** Cap stored log lines so a 100-account run cannot grow unbounded. */
const MAX_LOG_LINES = 500;

interface AtriaLoginJob {
  id: string;
  providerId: string;
  startedAt: string;
  done: boolean;
  error: string | null;
  headed: boolean;
  results: Array<{ email: string; success: boolean; error?: string | null }>;
  logs: string[];
}

const jobs = new Map<string, AtriaLoginJob>();
const latestJob = new Map<string, string>(); // providerId -> jobId

export function _resetAtriaLoginStateForTests(): void {
  jobs.clear();
  latestJob.clear();
}

/** One profile directory per account; sharing would cross the Google sessions. */
function profileFor(email: string): string {
  const hash = crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
  return path.join(profilesRoot, hash);
}

/** Redact the account password from anything we log. */
function redact(message: string, password: string): string {
  if (!password) return message;
  return message.split(password).join("***");
}

/** Show enough of a key to confirm capture without leaking the whole secret. */
function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

interface DriverResult {
  success: boolean;
  email: string;
  api_key: string | null;
  error: string | null;
}

/** Parse the JSON object the driver prints on stdout (it may sit among banners). */
function parseDriverJson(output: string): Partial<DriverResult> | null {
  let parsed: Partial<DriverResult> | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < output.length; i += 1) {
    const char = output[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { if (depth === 0) start = i; depth += 1; continue; }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          parsed = JSON.parse(output.slice(start, i + 1)) as Partial<DriverResult>;
        } catch { /* not a complete object yet */ }
        start = -1;
      }
    }
  }
  return parsed;
}

function runDriver(
  job: AtriaLoginJob,
  email: string,
  password: string,
  emit: (line: string) => void,
): Promise<{ result: Partial<DriverResult> | null; exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const profile = profileFor(email);
    const args = [
      loginScript,
      "--email", email,
      "--password", password,
      "--profile", profile,
    ];
    if (job.headed) args.push("--headed");

    const proc: ChildProcess = spawn(venvPython, args, {
      cwd: farmDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill(), 300_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = redact(line.trim(), password);
        if (trimmed) emit(trimmed);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const result = parseDriverJson(stdout);
      if (!result?.api_key && !result?.error && stdout.trim()) {
        // The driver printed *something* on stdout but we could not read a result
        // object from it. Surface a trimmed preview so the failure is diagnosable
        // from the dashboard instead of an opaque "exit 0".
        emit(`[WARN] Could not parse the driver output (${stdout.length} bytes): ${stdout.slice(0, 300)}`);
      }
      resolve({ result, exitCode: code, stderr: redact(stderr, password) });
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      emit(`[ERROR] failed to start the browser driver: ${error.message}`);
      resolve({ result: null, exitCode: null, stderr: error.message });
    });
  });
}

async function runJob(job: AtriaLoginJob, repo: ProvidersRepo, lines: string[]): Promise<void> {
  const emit = (message: string) => {
    const stamp = new Date().toISOString().slice(11, 19);
    job.logs.push(`[${stamp}] ${message}`);
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  };

  emit(`Starting Atria auto-login for ${lines.length} account(s)…`);
  const existing = new Set((await repo.listAccounts(job.providerId)).map((account) => account.label.toLowerCase()));

  for (const line of lines) {
    const [email, password] = line.split("|", 2).map((part) => part.trim());
    if (!email || !password) {
      emit(`SKIP: invalid format — ${redact(line.slice(0, 30), password ?? "")}…`);
      job.results.push({ email: email ?? "unknown", success: false, error: "Invalid format" });
      continue;
    }

    if (existing.has(email.toLowerCase())) {
      emit(`SKIP: ${email} — account already exists`);
      job.results.push({ email, success: false, error: "Account already exists" });
      continue;
    }

    emit(`Processing ${email}…`);
    const { result, exitCode, stderr } = await runDriver(job, email, password, emit);

    // The API key is the only credential Mirais needs; the account is created as
    // soon as we have one. The child may exit non-zero for benign reasons, so the
    // key itself — not the exit code — is the source of truth.
    const apiKey = result?.api_key ?? null;
    const gotKey = Boolean(apiKey);
    if (gotKey) {
      const masked = maskKey(apiKey!);
      const account = await repo.addAccount(job.providerId, { label: email, apiKey: apiKey! });
      await repo.updateAccount(account.id, {
        enabled: true,
        lastWarmupStatus: "healthy",
        lastWarmupAt: new Date().toISOString(),
        lastWarmupDetail: "Atria auto-login captured key",
      });
      existing.add(email.toLowerCase());
      emit(`SUCCESS: ${email} — API key captured (${masked})`);
      job.results.push({ email, success: true });
    } else {
      const reason = result?.error ?? (exitCode === 0 ? "no_key_in_output" : `exit ${exitCode}`);
      emit(`FAILED: ${email} — ${reason}`);
      job.results.push({ email, success: false, error: `${reason}${stderr ? `: ${stderr.slice(0, 200)}` : ""}` });
    }
  }

  const ok = job.results.filter((row) => row.success).length;
  emit(`Done: ${ok}/${job.results.length} successful`);
  job.done = true;
}

export function atriaLoginRoutes(db: Database) {
  const repo = new ProvidersRepo(db);
  return new Elysia({ prefix: "/api/providers/atria-login" })
    .post("/", async ({ body }) => {
      const parsed = atriaLoginSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, parsed.error.issues[0]?.message ?? "Invalid payload");
      const provider = await repo.get(parsed.data.providerId);
      if (!provider) throw new AdminError(404, "Provider not found");
      if (!isAtriaProvider(provider)) throw new AdminError(400, "Auto-login is only available for Atria providers");

      const lines = parsed.data.lines.map((line) => line.trim()).filter(Boolean);
      if (!lines.length) throw new AdminError(400, "No accounts provided");

      const jobId = crypto.randomUUID();
      const job: AtriaLoginJob = {
        id: jobId,
        providerId: provider.id,
        startedAt: new Date().toISOString(),
        done: false,
        error: null,
        headed: parsed.data.headed === true,
        results: [],
        logs: [],
      };
      jobs.set(jobId, job);
      latestJob.set(provider.id, jobId);

      log.info("atria auto-login started", { provider: provider.name, accounts: lines.length, headed: job.headed });
      runJob(job, repo, lines).catch((error) => {
        job.done = true;
        job.error = error instanceof Error ? error.message : String(error);
        log.error("atria auto-login crashed", { error: job.error });
      });

      await fs.mkdir(profilesRoot, { recursive: true });
      return { jobId, total: lines.length };
    })
    .get("/latest/:providerId", ({ params }) => {
      const jobId = latestJob.get(params.providerId);
      const job = jobId ? jobs.get(jobId) : undefined;
      return { job: job ?? null };
    })
    .get("/:jobId", ({ params }) => {
      const job = jobs.get(params.jobId);
      if (!job) throw new AdminError(404, "Job not found");
      return { id: job.id, done: job.done, error: job.error, results: job.results, startedAt: job.startedAt };
    })
    .get("/:jobId/logs", ({ params }) => {
      const job = jobs.get(params.jobId);
      if (!job) throw new AdminError(404, "Job not found");
      return { logs: job.logs };
    })
    .delete("/latest/:providerId", ({ params }) => {
      const jobId = latestJob.get(params.providerId);
      if (jobId) {
        jobs.delete(jobId);
        latestJob.delete(params.providerId);
      }
      return { ok: true };
    });
}
