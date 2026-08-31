import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { config } from "../config";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";
import { copilotLoginSchema, copilotBulkSchema, copilotQuotaSchema } from "../shared/schemas";
import { ProvidersRepo } from "../store/repos/providers";

const sidecarDir = path.resolve("scripts", "copilot-sidecar");
const sidecarScript = path.join(sidecarDir, "server.mjs");
const cliScript = path.join(sidecarDir, "node_modules", "@github", "copilot", "npm-loader.js");
const homesDir = path.join(config.dataDir, "copilot");
const children = new Map<string, ChildProcess>();
interface LoginFlow {
  proc: ChildProcess;
  reconnect: boolean;
  output: string;
  code: string | null;
  done: boolean;
  exitCode: number | null;
  error: string | null;
  doneAt?: number;
  dupeLogin: string | null;
  credentialTargets: Set<string>;
}
const loginFlows = new Map<string, LoginFlow>();
const bulkDir = path.resolve("scripts", "copilot-bulk-login");
const venvDir = path.resolve(".venv");
const venvPython = path.join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

// ── Bulk login jobs (in-memory, survives until process restart) ──
interface BulkJob {
  id: string;
  providerId: string;
  startedAt: string;
  done: boolean;
  error: string | null;
  results: Array<{ email: string; success: boolean; error?: string | null }>;
  logs: string[];
}
const bulkJobs = new Map<string, BulkJob>();
const latestBulkJob = new Map<string, string>(); // providerId -> jobId

type CopilotQuota = ReturnType<typeof copilotQuotaSchema.parse>;
type CopilotQuotaSnapshot = NonNullable<CopilotQuota["quotaSnapshots"][string]>;

function hasCopilotEntitlement(snapshot: CopilotQuotaSnapshot | undefined): snapshot is CopilotQuotaSnapshot {
  return !!snapshot && (snapshot.isUnlimitedEntitlement || snapshot.entitlementRequests > 0);
}

export function effectiveCopilotQuota(quota: CopilotQuota): CopilotQuotaSnapshot | undefined {
  const { premium_interactions: premium, chat, completions } = quota.quotaSnapshots;
  return [premium, chat, completions].find(hasCopilotEntitlement) ?? premium ?? chat ?? completions;
}

export function isCopilotQuotaExhausted(quota: CopilotQuota): boolean {
  const snapshot = effectiveCopilotQuota(quota);
  return !!snapshot && !snapshot.isUnlimitedEntitlement && snapshot.remainingPercentage <= 0 && !snapshot.usageAllowedWithExhaustedQuota;
}

export async function checkCopilotQuota(accountId: string): Promise<{ exhausted: boolean; detail?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${portFor(accountId)}/v1/quota`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { exhausted: false, detail: `Copilot usage check HTTP ${res.status}` };
    const parsed = copilotQuotaSchema.safeParse(await res.json());
    if (!parsed.success) return { exhausted: false, detail: "invalid Copilot usage response" };
    const exhausted = isCopilotQuotaExhausted(parsed.data);
    return { exhausted, detail: exhausted ? "quota exhausted (0%)" : undefined };
  } catch (err) {
    return { exhausted: false, detail: `Copilot usage check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function copilotEntitlementError(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const error = (body as { error?: unknown }).error;
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : null;
  return message && /not authorized to use this Copilot feature/i.test(message)
    ? "GitHub login succeeded, but this account does not have an active Copilot entitlement"
    : null;
}

function portFor(accountId: string): number {
  let hash = 0;
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 20_000 + (hash % 20_000);
}

function homeFor(accountId: string): string {
  return path.join(homesDir, accountId);
}

export function copilotLoginFromConfig(content: string): string | null {
  try {
    const parsed = JSON.parse(content.replace(/^\s*\/\/.*$/gm, "")) as { lastLoggedInUser?: { login?: unknown } };
    return typeof parsed.lastLoggedInUser?.login === "string" ? parsed.lastLoggedInUser.login : null;
  } catch {
    return null;
  }
}

export function copilotLoginForAccount(accountId: string): string | null {
  try {
    return copilotLoginFromConfig(fs.readFileSync(path.join(homeFor(accountId), "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

export function copilotResolvedLabel(current: string, login: string | null, existing: string[]): string {
  return login && (current.startsWith("pending-") || /^github-copilot-\d+$/.test(current)) && !existing.includes(login) ? login : current;
}

function urlFor(accountId: string): string {
  return `http://127.0.0.1:${portFor(accountId)}/v1`;
}

function envFor(accountId: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return { ...env, COPILOT_HOME: homeFor(accountId), GH_CONFIG_DIR: path.join(homeFor(accountId), "gh"), PORT: String(portFor(accountId)) };
}

function listCopilotCredentialTargets(): Set<string> {
  const targets = new Set<string>();
  if (process.platform !== "win32") return targets;
  try {
    const out = require("node:child_process").execSync("cmdkey /list", { encoding: "utf-8", timeout: 10_000 });
    for (const match of out.matchAll(/LegacyGeneric:target=([^\r\n]*copilot-cli[^\r\n]*)/g)) targets.add(match[1].trim());
  } catch { /* ignore */ }
  return targets;
}

export function copilotCredentialCandidates(current: string[], previous: Set<string>, login: string | null): string[] {
  const expected = login?.toLowerCase();
  return [...current].sort((a, b) => {
    const aMatch = expected && a.toLowerCase().endsWith(`:${expected}.copilot-cli`) ? 1 : 0;
    const bMatch = expected && b.toLowerCase().endsWith(`:${expected}.copilot-cli`) ? 1 : 0;
    return bMatch - aMatch || Number(previous.has(a)) - Number(previous.has(b));
  });
}

// Read the copilot-cli token from the Windows Credential Manager via CredRead (PowerShell P/Invoke).
// Used after device login completes: the token is moved to COPILOT_HOME/token.txt so the
// sidecar does not depend on the credential store (which the SDK fails to read back).
const readCredScript = String.raw`
$sig = @'
using System;
using System.Runtime.InteropServices;
public class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
'@
Add-Type -TypeDefinition $sig
$t = $env:MIRAIS_COPILOT_CREDENTIAL_TARGET
if ($t) {
  $ptr = [IntPtr]::Zero
  if ([CredMan]::CredRead($t, 1, 0, [ref]$ptr)) {
    $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][CredMan+CREDENTIAL])
    if ($c.CredentialBlobSize -gt 0) {
      $blob = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, [int]($c.CredentialBlobSize / 2))
      [Console]::Out.Write("$t|$blob")
      [CredMan]::CredFree($ptr)
      exit 0
    }
    [CredMan]::CredFree($ptr)
  }
}
exit 1
`;

function readCredScriptPath(): string {
  const p = path.join(config.dataDir, "read-copilot-cred.ps1");
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf-8") !== readCredScript) fs.writeFileSync(p, readCredScript, "utf-8");
  return p;
}

function readCopilotCredential(target: string): { target: string; token: string } | null {
  if (process.platform !== "win32") return null;
  try {
    const out = require("node:child_process").execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${readCredScriptPath()}"`,
      { encoding: "utf-8", timeout: 15_000, env: { ...process.env, MIRAIS_COPILOT_CREDENTIAL_TARGET: target } },
    ).trim();
    const idx = out.indexOf("|");
    if (idx < 0) return null;
    return { target: out.slice(0, idx).trim(), token: out.slice(idx + 1).trim() };
  } catch { return null; }
}

async function githubLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "Mirais" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json() as { login?: unknown };
    return res.ok && typeof body.login === "string" ? body.login : null;
  } catch {
    return null;
  }
}

function beginLogin(accountId: string, reconnect = false): void {
  fs.mkdirSync(homeFor(accountId), { recursive: true });
  const login = spawn("node", [cliScript, "login", "--device-code"], {
    cwd: sidecarDir,
    env: { ...envFor(accountId), BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  loginFlows.set(accountId, {
    proc: login,
    reconnect,
    output: "",
    code: null,
    done: false,
    exitCode: null,
    error: null,
    dupeLogin: null,
    credentialTargets: listCopilotCredentialTargets(),
  });
  const onData = (d: Buffer) => {
    const s = d.toString();
    const flow = loginFlows.get(accountId);
    if (!flow) return;
    flow.output += s;
    const m = /(?:one-time code|enter code)[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(s);
    if (m) flow.code = m[1] ?? null;
  };
  login.stdout.on("data", onData);
  login.stderr.on("data", onData);
  login.once("error", (error) => {
    const flow = loginFlows.get(accountId);
    if (flow) flow.error = error.message;
  });
  login.once("close", (code, signal) => {
    const flow = loginFlows.get(accountId);
    if (!flow) return;
    flow.done = true;
    flow.exitCode = code;
    flow.doneAt = Date.now();
    if (code !== 0) {
      const detail = flow.output.trim().split(/\r?\n/).filter(Boolean).at(-1);
      flow.error = detail ?? (signal ? `Login terminated by ${signal}` : `Login exited with code ${code ?? "unknown"}`);
    }
  });
}

function start(accountId: string): void {
  if (children.has(accountId)) return;
  fs.mkdirSync(homeFor(accountId), { recursive: true });
  const child = spawn("node", [sidecarScript], { cwd: sidecarDir, env: envFor(accountId), stdio: "ignore", windowsHide: true });
  children.set(accountId, child);
  child.once("exit", (code) => { children.delete(accountId); if (code !== 0) log.warn("copilot sidecar exited", { accountId, code }); });
}

async function waitReady(accountId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${portFor(accountId)}/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.ok || res.status === 503) return; // server is listening (503 = not authenticated yet)
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function health(accountId: string): Promise<{ ok: boolean; login: string | null; message: string | null }> {
  start(accountId);
  await waitReady(accountId);
  try {
    const res = await fetch(`http://127.0.0.1:${portFor(accountId)}/health`, { signal: AbortSignal.timeout(15_000) });
    const body = await res.json() as { ok?: boolean; login?: string | null; message?: string | null };
    return { ok: res.ok && body.ok === true, login: body.login ?? copilotLoginForAccount(accountId), message: body.message ?? null };
  } catch {
    return { ok: false, login: null, message: "Starting Copilot adapter..." };
  }
}

export function startCopilotSidecars(db: Database): void {
  const repo = new ProvidersRepo(db);
  const tasks: Array<() => void> = [];
  for (const provider of repo.list()) {
    if (provider.type !== "github-copilot") continue;
    const accounts = repo.listAccounts(provider.id);
    for (const account of accounts) {
      const label = copilotResolvedLabel(account.label, copilotLoginForAccount(account.id), accounts.filter((other) => other.id !== account.id).map((other) => other.label));
      if (label !== account.label) repo.updateAccount(account.id, { label });
      if (account.enabled) tasks.push(() => start(account.id));
    }
  }
  // Start all sidecars in parallel
  tasks.forEach((fn) => fn());
}

export async function waitCopilotSidecar(accountId: string): Promise<void> {
  start(accountId);
  await waitReady(accountId);
}

export function copilotRoutes(db: Database) {
  const repo = new ProvidersRepo(db);
  return new Elysia({ prefix: "/api/copilot" })
    .post("/start", ({ body }) => {
      const parsed = copilotLoginSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, "A valid provider and account label are required");
      const { providerId, label } = parsed.data;
      const trimmedLabel = label.trim();
      const provider = repo.get(providerId);
      if (!provider || provider.type !== "github-copilot") throw new AdminError(404, "GitHub Copilot provider not found");
      if ([...loginFlows.values()].some((flow) => !flow.done)) {
        throw new AdminError(409, "Another GitHub Copilot login is still in progress");
      }
      // The label may be empty → it is filled in automatically from the GitHub username after a successful login.
      const finalLabel = trimmedLabel || `pending-${crypto.randomUUID().slice(0, 8)}`;
      if (repo.listAccounts(provider.id).some((a) => a.label.toLowerCase() === finalLabel.toLowerCase()))
        throw new AdminError(409, `Account "${finalLabel}" already exists`);
      const account = repo.addAccount(provider.id, { label: finalLabel, baseUrl: null });
      repo.updateAccount(account.id, { baseUrl: urlFor(account.id), enabled: false });
      beginLogin(account.id);
      return { accountId: account.id, url: urlFor(account.id) };
    })
    .post("/:accountId/reconnect", ({ params }) => {
      const account = repo.getAccount(params.accountId);
      if (!account) throw new AdminError(404, "Account not found");
      const provider = repo.get(account.provider_id);
      if (!provider || provider.type !== "github-copilot") throw new AdminError(400, "Account is not a GitHub Copilot account");
      if ([...loginFlows.values()].some((flow) => !flow.done)) throw new AdminError(409, "Another GitHub Copilot login is still in progress");
      beginLogin(account.id, true);
      return { accountId: account.id, url: urlFor(account.id) };
    })
    .get("/:accountId/login-info", ({ params }) => {
      const flow = loginFlows.get(params.accountId);
      if (!flow) throw new AdminError(404, "No login flow for this account");
      return { code: flow.code, done: flow.done, ok: flow.done ? flow.exitCode === 0 : undefined, error: flow.error, url: "https://github.com/login/device" };
    })
    .delete("/:accountId/login", async ({ params }) => {
      const account = repo.getAccount(params.accountId);
      if (!account) return { ok: true };
      const flow = loginFlows.get(account.id);
      if (account.enabled && !flow?.reconnect) throw new AdminError(409, "Connected accounts cannot be cancelled");
      flow?.proc.kill();
      loginFlows.delete(account.id);
      if (flow?.reconnect) return { ok: true };
      children.get(account.id)?.kill();
      children.delete(account.id);
      repo.removeAccount(account.id);
      await fsp.rm(homeFor(account.id), { recursive: true, force: true });
      return { ok: true };
    })
    .get("/:accountId/status", async ({ params }) => {
      const account = repo.getAccount(params.accountId);
      if (!account) throw new AdminError(404, "Account not found");
      const flow = loginFlows.get(account.id);
      if (flow && !flow.done) return { done: false, ok: false, message: "Waiting for GitHub device authorization…" };
      if (flow?.done && flow.exitCode !== 0) return { done: true, ok: false, message: flow.error ?? "GitHub Copilot login failed" };
      let status = await health(account.id);
      // If the login flow finished but the sidecar still reports "Not authenticated",
      // the new token is in the credential manager but the SDK failed to read it back.
      // Fetch the token via CredRead, save it to token.txt, and restart the sidecar.
      if (!status.ok && /not authenticated/i.test(status.message ?? "")) {
        const tokenPath = path.join(homeFor(account.id), "token.txt");
        if (flow?.done && flow.exitCode === 0 && (flow.reconnect || !fs.existsSync(tokenPath))) {
          const expectedLogin = copilotLoginForAccount(account.id);
          let cred: ReturnType<typeof readCopilotCredential> = null;
          for (const target of copilotCredentialCandidates([...listCopilotCredentialTargets()], flow.credentialTargets, expectedLogin)) {
            const candidate = readCopilotCredential(target);
            if (candidate && (!expectedLogin || (await githubLogin(candidate.token))?.toLowerCase() === expectedLogin.toLowerCase())) {
              cred = candidate;
              break;
            }
          }
          if (cred) {
            fs.writeFileSync(tokenPath, cred.token, "utf-8");
            try { require("node:child_process").execSync(`cmdkey /delete:"${cred.target}"`, { timeout: 5_000 }); } catch { /* ignore */ }
            children.get(account.id)?.kill();
            children.delete(account.id);
            status = await health(account.id);
          }
        }
      }
      if (!status.ok) return { done: false, ok: false, message: status.message };
      const baseUrl = account.base_url ?? urlFor(account.id);
      try {
        const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(15_000) });
        const body = await res.json() as { data?: Array<{ id?: unknown }>; error?: { message?: string } };
        const entitlementError = copilotEntitlementError(body);
        if (entitlementError) return { done: true, ok: false, message: entitlementError };
        if (!res.ok || !Array.isArray(body.data)) throw new Error(`HTTP ${res.status}`);
        const models = body.data
          .map((model) => typeof model.id === "string" ? model.id : null)
          .filter((id): id is string => Boolean(id))
          .map((id) => ({ id, contextLength: null, maxOutputTokens: null, capabilities: null }));
        repo.replaceSyncedModels(account.provider_id, models);
        // Duplicate: this GitHub username already has another account → overwrite confirmation is required.
        // An account already labelled with the login but with a running login flow means a re-login → overwrite the token in the same home.
        const other = status.login
          ? repo.listAccounts(account.provider_id).find((a) => a.id !== account.id && a.label === status.login)
          : undefined;
        if (other && !other.enabled) {
          repo.removeAccount(other.id);
        } else if (other && !loginFlows.has(other.id)) {
          const flow = loginFlows.get(account.id);
          // Grace period: if the authorization just completed (<60s), the token in the old home may
          // not have refreshed yet → poll again instead of immediately offering an overwrite.
          if (flow?.done && flow.doneAt && Date.now() - flow.doneAt < 60_000) {
            return { done: false, ok: false, message: "Finishing sign-in…" };
          }
          if (flow) flow.dupeLogin = status.login;
          return { done: false, ok: false, duplicate: true, login: status.login, existingAccountId: other.id, message: `Account "${status.login}" already exists` };
        }
        // Auto-rename the label from the GitHub username (email-derived) if the label is still a pending/placeholder value
        const patch: Parameters<typeof repo.updateAccount>[1] = { enabled: true, lastWarmupStatus: "healthy", lastWarmupAt: new Date().toISOString(), lastWarmupDetail: `GitHub Copilot login active - ${models.length} models synced` };
        if (status.login && (account.label.startsWith("pending-") || /^github-copilot-\d+$/.test(account.label))) {
          patch.label = status.login;
        }
        repo.updateAccount(account.id, patch);
        return { done: true, ok: true, message: `Connected as ${status.login ?? account.label} - ${models.length} models synced` };
      } catch (error) {
        return { done: false, ok: false, message: `Connected, but model sync failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    })
    .post("/:accountId/overwrite", ({ params }) => {
      const account = repo.getAccount(params.accountId);
      if (!account) throw new AdminError(404, "Account not found");
      const flow = loginFlows.get(account.id);
      const dupes = repo.listAccounts(account.provider_id).filter((a) => a.id !== account.id && flow?.dupeLogin && a.label === flow.dupeLogin);
      for (const d of dupes) {
        children.get(d.id)?.kill();
        loginFlows.delete(d.id);
        repo.removeAccount(d.id);
      }
      return { ok: true };
    })
    .post("/bulk", async ({ body }) => {
      const parsed = copilotBulkSchema.safeParse(body);
      if (!parsed.success) throw new AdminError(400, "providerId and accounts are required");
      const { providerId, accounts } = parsed.data;
      const provider = repo.get(providerId);
      if (!provider || provider.type !== "github-copilot") throw new AdminError(404, "GitHub Copilot provider not found");

      const lines = accounts.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      if (lines.length === 0) throw new AdminError(400, "No valid accounts found");

      const force = (body as { force?: boolean }).force === true;

      const jobId = crypto.randomUUID();
      const job: BulkJob = {
        id: jobId,
        providerId,
        startedAt: new Date().toISOString(),
        done: false,
        error: null,
        results: [],
        logs: [],
      };
      bulkJobs.set(jobId, job);
      latestBulkJob.set(providerId, jobId);

      // Run in the background — do not await
      runBulkJob(job, repo, lines, force).catch((err) => {
        job.error = err instanceof Error ? err.message : String(err);
        job.done = true;
        job.logs.push(`[ERROR] ${job.error}`);
      });

      return { jobId, total: lines.length };
    })
    .get("/bulk/latest/:providerId", ({ params }) => {
      const jobId = latestBulkJob.get(params.providerId);
      const job = jobId ? bulkJobs.get(jobId) : undefined;
      if (!job) return { job: null };
      return { job: { id: job.id, done: job.done, error: job.error, results: job.results, logs: job.logs } };
    })
    .delete("/bulk/latest/:providerId", ({ params }) => {
      const jobId = latestBulkJob.get(params.providerId);
      if (jobId) {
        const job = bulkJobs.get(jobId);
        if (job && !job.done) throw new AdminError(409, "Job is still running");
        bulkJobs.delete(jobId);
        latestBulkJob.delete(params.providerId);
      }
      return { ok: true };
    })
    .get("/bulk/:jobId", ({ params }) => {
      const job = bulkJobs.get(params.jobId);
      if (!job) throw new AdminError(404, "Job not found");
      return job;
    })
    .get("/bulk/:jobId/logs", ({ params }) => {
      const job = bulkJobs.get(params.jobId);
      if (!job) throw new AdminError(404, "Job not found");
      return { logs: job.logs, done: job.done, results: job.results, error: job.error };
    });
}

async function runBulkJob(job: BulkJob, repo: ProvidersRepo, lines: string[], force: boolean): Promise<void> {
  const log = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    job.logs.push(`[${ts}] ${msg}`);
  };

  log(`Starting bulk login for ${lines.length} account(s)...`);

  const existing = new Set(repo.listAccounts(job.providerId).map((a) => a.label.toLowerCase()));

  for (const line of lines) {
    const [email, password] = line.split("|", 2).map((s) => s.trim());
    if (!email || !password) {
      log(`SKIP: Invalid format — ${line.slice(0, 30)}...`);
      job.results.push({ email: email ?? "unknown", success: false, error: "Invalid format" });
      continue;
    }

    if (existing.has(email.toLowerCase())) {
      if (!force) {
        log(`SKIP: ${email} — account already exists`);
        job.results.push({ email, success: false, error: "Account already exists" });
        continue;
      }
      const dup = repo.listAccounts(job.providerId).find((a) => a.label.toLowerCase() === email.toLowerCase());
      if (dup) {
        log(`FORCE: removing existing account ${email}...`);
        repo.removeAccount(dup.id);
      }
      existing.delete(email.toLowerCase());
    }

    log(`Processing: ${email}`);

    // Create the account in the DB first
    const account = repo.addAccount(job.providerId, { label: email, baseUrl: null });
    repo.updateAccount(account.id, { baseUrl: urlFor(account.id), enabled: false });
    existing.add(email.toLowerCase());
    fs.mkdirSync(homeFor(account.id), { recursive: true });

    const accountsFile = path.join(homeFor(account.id), "bulk_account.txt");
    const outputFile = path.join(homeFor(account.id), "bulk_result.json");
    await fsp.writeFile(accountsFile, line, "utf-8");

    log(`Spawning bot for ${email}...`);
    const proc = spawn(venvPython, [
      path.join(bulkDir, "copilot-bulk-login.py"),
      "--accounts", accountsFile,
      "--output", outputFile,
      "--copilot-home", homeFor(account.id),
      "--cli-script", cliScript,
    ], { cwd: bulkDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CAMOUFOX_HOME: path.resolve(".camoufox"), PYTHONUTF8: "1" }, timeout: 600_000, windowsHide: true });

    let stderr = "";
    proc.stdout.on("data", (d) => {
      const text = d.toString().trim();
      log(`[BOT] ${text}`);
    });
    proc.stderr.on("data", (d) => {
      const text = d.toString().trim();
      stderr += text;
      log(`[BOT-ERR] ${text}`);
    });

    const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));
    await fsp.unlink(accountsFile).catch(() => {});

    let result: Array<{ email: string; success: boolean; error?: string | null }> = [];
    try { result = JSON.parse(await fsp.readFile(outputFile, "utf-8")); } catch { result = []; }
    await fsp.unlink(outputFile).catch(() => {});

    const first = result[0];
    if (first && first.success) {
      log(`SUCCESS: ${email}`);
      repo.updateAccount(account.id, { enabled: true, lastWarmupStatus: "healthy", lastWarmupAt: new Date().toISOString(), lastWarmupDetail: "Bulk login successful" });
      job.results.push({ email, success: true });
    } else {
      const errMsg = first?.error ?? `Exit ${exitCode}`;
      log(`FAILED: ${email} — ${errMsg} (removing from database)`);
      // Failure = do not keep it in the database. Remove the account and its folder.
      repo.removeAccount(account.id);
      await fsp.rm(homeFor(account.id), { recursive: true, force: true }).catch(() => {});
      job.results.push({ email, success: false, error: `${errMsg}${stderr ? `: ${stderr.slice(0, 200)}` : ""}` });
    }
  }

  const successCount = job.results.filter((r) => r.success).length;
  log(`Done: ${successCount}/${job.results.length} successful`);
  job.done = true;
}