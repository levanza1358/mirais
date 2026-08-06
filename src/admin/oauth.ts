import crypto from "node:crypto";
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { ProvidersRepo } from "../store/repos/providers";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";

// The OpenAI OAuth client (same public client as the official Codex CLI)
// only whitelists this exact redirect — verified: any other port/path
// returns an "Authentication Error" page before login even starts.
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_PORT = 1455;

// ── OpenAI / ChatGPT (Codex) OAuth constants — same public client as the
// official Codex CLI (see openai/codex codex-rs/login/src/server.rs) ──
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEBUDDY_DEVICE_PLATFORM = "CLI";
const OPENAI_ALLOWED_PROVIDER_TYPES = new Set(["openai"]);

const CODEBUDDY_OAUTH: Record<string, { stateUrl: string; tokenUrl: string; refreshUrl: string }> = {
  "codebuddy-global": {
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
  },
  "codebuddy-cn": {
    stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI",
    tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
    refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
  },
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface PendingLogin {
  providerId: string;
  verifier: string;
  createdAt: number;
  resolve: (result: { ok: boolean; message: string }) => void;
  flow?: "openai" | "codebuddy";
  cleanup?: () => void;
}

// In-memory pending logins (state → pending). Entries expire after 10 min.
const pending = new Map<string, PendingLogin>();

// ── temporary callback listener on port 1455 (only while a login is active) ──
let callbackServer: { stop: (closeConnections?: boolean) => void } | null = null;
let callbackServerRefs = 0;

function ensureCallbackServer(onResult: (q: URLSearchParams) => void): void {
  callbackServerRefs += 1;
  if (callbackServer) return;
  try {
    callbackServer = Bun.serve({
      port: CALLBACK_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/auth/callback") {
          onResult(url.searchParams);
          return new Response(callbackReceivedPage(), {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("Mirais OAuth callback listener", { status: 200 });
      },
    });
    log.debug("oauth callback listener started", { port: CALLBACK_PORT });
  } catch (err) {
    callbackServer = null;
    callbackServerRefs = Math.max(0, callbackServerRefs - 1);
    throw new AdminError(500, `Cannot listen on port ${CALLBACK_PORT} for the OAuth callback — is Codex CLI or another app using it? (${err instanceof Error ? err.message : String(err)})`);
  }
}

function releaseCallbackServer(): void {
  callbackServerRefs = Math.max(0, callbackServerRefs - 1);
  if (callbackServerRefs === 0 && callbackServer) {
    callbackServer.stop();
    callbackServer = null;
    log.debug("oauth callback listener stopped");
  }
}

function sweepPending(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}


function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract the ChatGPT account id + email from the id_token claims. */
function accountInfo(idToken: string | undefined): { accountId: string | null; email: string | null } {
  if (!idToken) return { accountId: null, email: null };
  const claims = decodeJwtPayload(idToken);
  if (!claims) return { accountId: null, email: null };
  const email = typeof claims.email === "string" ? claims.email : null;
  // With id_token_add_organizations=true the account id lives under the
  // organizations claim; fall back to common alternatives.
  let accountId: string | null = null;
  const orgs = claims.organizations ?? claims["https://api.openai.com/auth"] ?? claims.organization;
  if (Array.isArray(orgs) && orgs.length) {
    const first = orgs[0] as Record<string, unknown>;
    accountId = (first.id ?? first.account_id ?? null) as string | null;
  } else if (orgs && typeof orgs === "object") {
    const o = orgs as Record<string, unknown>;
    accountId = (o.account_id ?? o.id ?? null) as string | null;
  }
  accountId ??= (claims.account_id ?? claims.sub ?? null) as string | null;
  return { accountId, email };
}

export function oauthRoutes(db: Database) {
  const repo = new ProvidersRepo(db);

  async function pollCodeBuddyToken(state: string, providerId: string): Promise<void> {
    const p = repo.get(providerId);
    if (!p) return;
    const cfg = CODEBUDDY_OAUTH[p.type];
    if (!cfg) return;

    const entry = pending.get(state);
    if (!entry) return;

    const timer = setInterval(async () => {
      const active = pending.get(state);
      if (!active) {
        clearInterval(timer);
        return;
      }
      try {
        const res = await fetch(`${cfg.tokenUrl}?state=${encodeURIComponent(state)}&platform=${CODEBUDDY_DEVICE_PLATFORM}`, {
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json() as {
          code?: number;
          msg?: string;
          data?: { accessToken?: string; refreshToken?: string; expiresIn?: number };
        };
        if (data.code === 11217) return;
        if (data.code !== 0 || !data.data?.accessToken) {
          pending.delete(state);
          results.set(state, { ok: false, message: data.msg ?? "CodeBuddy login failed", at: Date.now() });
          clearInterval(timer);
          return;
        }

        const label = `${p.type === "codebuddy-cn" ? "CodeBuddy CN" : "CodeBuddy"}-${repo.listAccounts(p.id).length + 1}`;
        repo.addAccount(p.id, { label, apiKey: data.data.accessToken });
        const accounts = repo.listAccounts(p.id);
        const created = accounts[accounts.length - 1];
        if (created) {
          repo.updateAccountOAuth(created.id, {
            authKind: "oauth",
            refreshToken: data.data.refreshToken ?? null,
            expiresAt: data.data.expiresIn ? Date.now() + data.data.expiresIn * 1000 : null,
          });
        }
        pending.delete(state);
        results.set(state, { ok: true, message: `Connected as ${label}`, at: Date.now() });
        clearInterval(timer);
      } catch {
        // keep polling
      }
    }, 2000);
  }

  async function handleCallback(q: URLSearchParams): Promise<void> {
    const code = q.get("code");
    const state = q.get("state");
    const error = q.get("error");
    const entry = state ? pending.get(state) : undefined;
    if (!entry) return;
    pending.delete(state!);
    releaseCallbackServer();

    if (entry.cleanup) entry.cleanup();

    if (error) {
      entry.resolve({ ok: false, message: `Login failed: ${q.get("error_description") ?? error}` });
      return;
    }
    if (!code) {
      entry.resolve({ ok: false, message: "Missing authorization code in callback." });
      return;
    }

    const p = repo.get(entry.providerId);
    if (!p) {
      entry.resolve({ ok: false, message: "Provider no longer exists." });
      return;
    }

    // Exchange the authorization code for tokens.
    let tokens: TokenResponse;
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: entry.verifier,
        redirect_uri: REDIRECT_URI,
      }).toString();

      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      tokens = (await res.json()) as TokenResponse;
      if (!res.ok) {
        log.warn("oauth token exchange failed", { status: res.status, err: tokens.error });
        entry.resolve({ ok: false, message: `Token exchange failed: ${tokens.error_description ?? tokens.error ?? `HTTP ${res.status}`}` });
        return;
      }
    } catch (err) {
      entry.resolve({ ok: false, message: `Token exchange request failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    if (!tokens.access_token) {
      entry.resolve({ ok: false, message: "Token response did not include an access token." });
      return;
    }

    const { accountId, email } = accountInfo(tokens.id_token);
    const label = email ? `ChatGPT (${email})` : `ChatGPT-${repo.listAccounts(p.id).length + 1}`;
    const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null;

    repo.addAccount(p.id, { label, apiKey: tokens.access_token });
    const accounts = repo.listAccounts(p.id);
    const created = accounts[accounts.length - 1];
    if (created) {
      repo.updateAccountOAuth(created.id, {
        authKind: "oauth",
        refreshToken: tokens.refresh_token ?? null,
        idToken: tokens.id_token ?? null,
        accountId,
        expiresAt,
      });
    }
    log.info("oauth account connected", { provider: p.name, label, accountId });
    entry.resolve({ ok: true, message: `Connected as ${label}` });
  }

  // Completed login results, kept briefly so the dashboard can poll them.
  const results = new Map<string, { ok: boolean; message: string; at: number }>();

  return new Elysia()
    .post("/api/oauth/openai/start", ({ body }) => {
      const { providerId } = (body ?? {}) as { providerId?: string };
      if (!providerId) throw new AdminError(400, "providerId is required");
      const p = repo.get(providerId);
      if (!p) throw new AdminError(404, "Provider not found");
      if (p.type === "codebuddy-global" || p.type === "codebuddy-cn") {
        const cfg = CODEBUDDY_OAUTH[p.type];
        if (!cfg) throw new AdminError(400, "CodeBuddy OAuth config not found");
        const stateReq = fetch(cfg.stateUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(20_000),
        });
        return stateReq.then(async (res) => {
          const data = await res.json() as { code?: number; data?: { state?: string; authUrl?: string }; msg?: string };
          if (!res.ok || data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
            throw new AdminError(502, data.msg ?? `CodeBuddy auth start failed: HTTP ${res.status}`);
          }
          const state = data.data.state;
          pending.set(state, {
            providerId,
            verifier: "",
            createdAt: Date.now(),
            flow: "codebuddy",
            resolve: (r) => {
              results.set(state, { ...r, at: Date.now() });
              setTimeout(() => results.delete(state), 2 * 60_000).unref();
            },
          });
          void pollCodeBuddyToken(state, providerId);
          setTimeout(() => {
            if (pending.delete(state)) {
              results.set(state, { ok: false, message: "Login timed out — please try again.", at: Date.now() });
            }
          }, 10 * 60_000).unref();
          log.info("codebuddy oauth login started", { provider: p.name });
          return { url: data.data.authUrl, state };
        });
      }
      if (!OPENAI_ALLOWED_PROVIDER_TYPES.has(p.type)) {
        throw new AdminError(400, "OAuth login is only available for supported OpenAI-compatible providers");
      }

      sweepPending();
      const { verifier, challenge } = pkce();
      const state = b64url(crypto.randomBytes(24));

      let cleanup: (() => void) | undefined;
      pending.set(state, {
        providerId,
        verifier,
        createdAt: Date.now(),
        cleanup: () => cleanup?.(),
        resolve: (r) => {
          results.set(state, { ...r, at: Date.now() });
          // results are fetched once; also expire them after 2 minutes
          setTimeout(() => results.delete(state), 2 * 60_000).unref();
        },
      });
      ensureCallbackServer((q) => { void handleCallback(q); });
      cleanup = () => releaseCallbackServer();

      // Safety: if the user never completes login, clean up after 10 minutes.
      setTimeout(() => {
        const stale = pending.get(state);
        if (pending.delete(state)) {
          stale?.cleanup?.();
          results.set(state, { ok: false, message: "Login timed out — please try again.", at: Date.now() });
        }
      }, 10 * 60_000).unref();

      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state,
        originator: "codex_cli_rs",
      });
      log.info("oauth login started", { provider: p.name });
      return { url: `${AUTHORIZE_URL}?${params.toString()}`, state };
    })
    .get("/api/oauth/openai/redirect", ({ query, set }) => {
      const url = (query as Record<string, string | undefined>).url;
      if (!url) throw new AdminError(400, "url is required");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new AdminError(400, "Invalid redirect url");
      }
      if (!["https:", "http:"].includes(parsed.protocol)) {
        throw new AdminError(400, "Unsupported redirect protocol");
      }
      set.redirect = parsed.toString();
      return;
    })
    .get("/api/oauth/openai/status", ({ query }) => {
      const state = (query as Record<string, string | undefined>).state;
      if (!state) throw new AdminError(400, "state is required");
      const r = results.get(state);
      if (r) {
        results.delete(state);
        return { done: true, ok: r.ok, message: r.message };
      }
      return { done: false };
    });
}

function resultPage(ok: boolean, message: string): string {
  const color = ok ? "#34D399" : "#F87171";
  const title = ok ? "Login successful" : "Login failed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mirais — ${title}</title>
<style>body{background:#0b0e14;color:#e6e9f0;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#12161f;border:1px solid #232a3a;border-radius:16px;padding:32px;max-width:420px;text-align:center}
h1{font-size:18px;margin:0 0 8px;color:${color}}p{font-size:13px;color:#8b94a7;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message.replace(/</g, "&lt;")}</p></div></body></html>`;
}

function callbackReceivedPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mirais — Login callback received</title>
<style>body{background:#0b0e14;color:#e6e9f0;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px;box-sizing:border-box}
.card{background:#12161f;border:1px solid #232a3a;border-radius:16px;padding:32px;max-width:420px;text-align:center;box-shadow:0 16px 48px #0006}h1{font-size:18px;margin:0 0 8px;color:#34D399}p{font-size:13px;line-height:1.6;color:#aab2c2;margin:0}.hint{margin-top:14px;color:#737d91;font-size:12px}</style></head>
<body><div class="card"><h1>Login callback received</h1><p>Mirais is finishing the connection. Return to the Mirais dashboard; this page can be closed.</p><p class="hint">Do not close the dashboard while it is connecting.</p></div></body></html>`;
}
