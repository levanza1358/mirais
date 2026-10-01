import { describe, expect, test } from "bun:test";
import { isCodexAccount } from "../src/proxy/codex";
import type { ProviderAccount } from "../src/shared/types";

/**
 * Account resolution after the OpenAI / Codex soft-merge.
 *
 * The same provider type ("openai") now hosts accounts that should hit two
 * different upstreams:
 *   - oauth-browser  → api.openai.com/v1 (standard Chat Completions)
 *   - oauth-cli      → chatgpt.com/backend-api/wham (Codex CLI JSON tokens)
 *   - api-key        → api.openai.com/v1 (plain Bearer)
 *
 * isCodexAccount() decides which upstream the runtime should route to. The
 * resolver reads `account.account_kind` first (authoritative), then falls
 * back to JWT inspection for rows that pre-date migration 0043 (NULL), then
 * finally falls back to the provider type as a last resort.
 */
function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "acc",
    provider_id: "prov",
    label: "label",
    api_key: "sk-test",
    enabled: 1,
    priority: 100,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    auth_kind: "oauth",
    account_kind: null,
    account_id: null,
    refresh_token: null,
    id_token: null,
    plan_type: null,
    expires_at: null,
    notes: null,
    tags: null,
    session_cookie: null,
    rate_limited_until: null,
    reauth_required: 0,
    reauth_reason: null,
    last_warmup_at: null,
    last_warmup_status: null,
    last_warmup_latency_ms: null,
    last_warmup_detail: null,
    base_url: null,
    ...overrides,
  };
}

describe("isCodexAccount — account_kind explicit", () => {
  test("oauth-cli on openai → Codex backend", () => {
    expect(isCodexAccount("openai", account({ account_kind: "oauth-cli" }))).toBe(true);
  });

  test("oauth-cli on codex → Codex backend", () => {
    expect(isCodexAccount("codex", account({ account_kind: "oauth-cli" }))).toBe(true);
  });

  test("oauth-browser on openai → public OpenAI API", () => {
    expect(isCodexAccount("openai", account({ account_kind: "oauth-browser" }))).toBe(false);
  });

  test("api-key on openai → public OpenAI API", () => {
    expect(isCodexAccount("openai", account({ auth_kind: "api_key", account_kind: "api-key" }))).toBe(false);
  });

  test("api-key on codex → Codex backend (hand-rolled Codex provider)", () => {
    expect(isCodexAccount("codex", account({ auth_kind: "api_key", account_kind: "api-key" }))).toBe(true);
  });
});

describe("isCodexAccount — JWT fallback for NULL account_kind", () => {
  test("detects Codex CLI JWT via https://api.openai.com/auth namespace", () => {
    // A real Codex CLI access token has the chatgpt-account-id claim and the
    // `https://api.openai.com/auth` payload object. We build the JWT
    // manually here so the test doesn't depend on a live token.
    const payload = { "https://api.openai.com/auth": { user_id: "u", team_id: "t" }, sub: "u" };
    const header = { alg: "none", typ: "JWT" };
    const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const token = `${encode(header)}.${encode(payload)}.signature`;
    expect(isCodexAccount("openai", account({ api_key: token, account_kind: null }))).toBe(true);
  });

  test("detects Codex CLI JWT via https://chatgpt.com/ audience", () => {
    const payload = { aud: "https://chatgpt.com/api" };
    const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const token = `header.${encode(payload)}.sig`;
    expect(isCodexAccount("openai", account({ api_key: token, account_kind: null }))).toBe(true);
  });

  test("falls through to provider type when JWT has no Codex markers", () => {
    const payload = { aud: "https://api.openai.com/v1", sub: "u" };
    const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const token = `header.${encode(payload)}.sig`;
    expect(isCodexAccount("openai", account({ api_key: token, account_kind: null }))).toBe(true);
    expect(isCodexAccount("anthropic", account({ api_key: token, account_kind: null }))).toBe(false);
  });

  test("ignores malformed JWTs and falls through to provider type", () => {
    expect(isCodexAccount("openai", account({ api_key: "not.a.jwt-base64!!!", account_kind: null }))).toBe(true);
    expect(isCodexAccount("anthropic", account({ api_key: "garbage", account_kind: null }))).toBe(false);
  });

  test("opaque (non-JWT) tokens use provider type as the final hint", () => {
    expect(isCodexAccount("openai", account({ api_key: "opaque-key", account_kind: null }))).toBe(true);
    expect(isCodexAccount("anthropic", account({ api_key: "opaque-key", account_kind: null }))).toBe(false);
  });
});

describe("isCodexAccount — non-OAuth short-circuits", () => {
  test("api-key on codex still routes through Codex", () => {
    expect(isCodexAccount("codex", account({ auth_kind: "api_key", account_kind: "api-key" }))).toBe(true);
  });

  test("api-key on openai does NOT route through Codex", () => {
    expect(isCodexAccount("openai", account({ auth_kind: "api_key", account_kind: "api-key" }))).toBe(false);
  });
});
