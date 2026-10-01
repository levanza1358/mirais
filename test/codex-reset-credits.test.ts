import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  fetchCodexUsage,
  type CodexUsageSnapshot,
} from "../src/proxy/codex";
import type { ProviderAccount } from "../src/shared/types";

/**
 * Reset-credit coverage for the ChatGPT/Codex backend.
 *
 * The Codex backend exposes reset credits (one-shot tokens that immediately
 * refill the 5h / weekly rate-limit windows) under a dedicated endpoint.
 * Earlier revisions of this code only knew about the legacy `banked_resets`
 * object, which the upstream removed — every call returned 0.
 *
 * The actual field is `rate_limit_reset_credits.available_count` in the
 * `/usage` payload, and per-credit details live at
 * `/rate-limit-reset-credits`. Spending a credit is a POST against
 * `/rate-limit-reset-credits/consume` with a server-generated
 * `redeem_request_id` for idempotency.
 */

function makeAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "acc-1",
    provider_id: "prov-1",
    label: "acc",
    api_key: "token",
    enabled: 1,
    priority: 100,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    auth_kind: "oauth",
    account_kind: "oauth-cli",
    account_id: "acct-123",
    refresh_token: "refresh",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("fetchCodexUsage — rate_limit_reset_credits parsing", () => {
  test("reads available_count from the modern field name", async () => {
    const fetchMock = mock(async () => jsonResponse({
      plan_type: "pro",
      rate_limit: { limit_reached: false, primary_window: { used_percent: 30 }, secondary_window: { used_percent: 0 } },
      rate_limit_reset_credits: { available_count: 4 },
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const usage = await fetchCodexUsage(makeAccount(), "token");
    expect(usage.banked_resets).toEqual({ remaining: 4, total: null });
  });

  test("falls back to legacy banked_resets when modern field absent", async () => {
    const fetchMock = mock(async () => jsonResponse({
      plan_type: "pro",
      rate_limit: { limit_reached: false },
      banked_resets: { remaining: 2, total: 5 },
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const usage = await fetchCodexUsage(makeAccount(), "token");
    expect(usage.banked_resets).toEqual({ remaining: 2, total: 5 });
  });

  test("prefers modern count over legacy count when both present", async () => {
    const fetchMock = mock(async () => jsonResponse({
      plan_type: "pro",
      rate_limit: { limit_reached: false },
      rate_limit_reset_credits: { available_count: 7 },
      banked_resets: { remaining: 1, total: 9 },
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const usage = await fetchCodexUsage(makeAccount(), "token");
    expect(usage.banked_resets).toEqual({ remaining: 7, total: null });
  });

  test("returns null banked_resets when no credit field is present", async () => {
    const fetchMock = mock(async () => jsonResponse({
      plan_type: "free",
      rate_limit: { limit_reached: false },
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const usage: CodexUsageSnapshot = await fetchCodexUsage(makeAccount(), "token");
    expect(usage.banked_resets).toBeNull();
  });
});

describe("fetchCodexResetCredits — per-credit detail endpoint", () => {
  test("returns available_count and normalizes credit entries", async () => {
    const fetchMock = mock(async (input: Request | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/backend-api/wham/rate-limit-reset-credits");
      return jsonResponse({
        available_count: 2,
        credits: [
          { status: "available", granted_at: "2026-06-18T00:25:18Z", expires_at: "2026-07-18T00:25:18Z" },
          { status: "redeemed", granted_at: "bad-date", expires_at: null },
        ],
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const bundle = await fetchCodexResetCredits(makeAccount(), "token");
    expect(bundle.available_count).toBe(2);
    expect(bundle.credits).toHaveLength(2);
    expect(bundle.credits[0]).toMatchObject({
      status: "available",
      granted_at: "2026-06-18T00:25:18.000Z",
      expires_at: "2026-07-18T00:25:18.000Z",
    });
    expect(bundle.credits[1]?.status).toBe("redeemed");
    expect(bundle.credits[1]?.granted_at).toBeNull();
  });

  test("sends the OpenAI-Beta: codex-1 header the backend requires", async () => {
    let captured: RequestInit | undefined;
    const fetchMock = mock(async (_input: Request | URL, init?: RequestInit) => {
      captured = init;
      return jsonResponse({ available_count: 0, credits: [] });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await fetchCodexResetCredits(makeAccount(), "token");
    const headers = captured?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer token");
    expect(headers["OpenAI-Beta"]).toBe("codex-1");
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["content-type"]).toBeUndefined();
  });

  test("sends the ChatGPT-Account-ID header when account_id is known", async () => {
    let captured: RequestInit | undefined;
    const fetchMock = mock(async (_input: Request | URL, init?: RequestInit) => {
      captured = init;
      return jsonResponse({ available_count: 0, credits: [] });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await fetchCodexResetCredits(makeAccount({ account_id: "ws-42" }), "token");
    const headers = captured?.headers as Record<string, string>;
    expect(headers["chatgpt-account-id"]).toBe("ws-42");
  });

  test("returns an empty inventory for free accounts (HTTP 4xx)", async () => {
    const fetchMock = mock(async () => jsonResponse({ detail: "Reset credits are unavailable for this account" }, 403)) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const bundle = await fetchCodexResetCredits(makeAccount(), "token");
    expect(bundle).toEqual({ available_count: 0, credits: [] });
  });

  test("throws on 5xx upstream errors so callers can surface them", async () => {
    const fetchMock = mock(async () => new Response("upstream down", { status: 502 })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    expect(fetchCodexResetCredits(makeAccount(), "token")).rejects.toThrow(/502/);
  });
});

describe("consumeCodexResetCredit — spend a credit", () => {
  test("posts a redeem_request_id and surfaces a success result", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchMock = mock(async (input: Request | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ code: "reset", windows_reset: 2 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await consumeCodexResetCredit(makeAccount(), "token", "redeem-123");
    expect(capturedUrl).toContain("/backend-api/wham/rate-limit-reset-credits/consume");
    const parsed = JSON.parse(capturedBody) as { redeem_request_id: string };
    expect(parsed.redeem_request_id).toBe("redeem-123");
    expect(result.ok).toBe(true);
    expect(result.windows_reset).toBe(2);
    expect(result.code).toBe("reset");
    expect(result.noCredit).toBe(false);
  });

  test("flags no_credit responses without throwing", async () => {
    const fetchMock = mock(async () => jsonResponse({ code: "no_credit", message: "No Codex reset credits available." })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await consumeCodexResetCredit(makeAccount(), "token", "redeem-xyz");
    expect(result.ok).toBe(false);
    expect(result.noCredit).toBe(true);
    expect(result.code).toBe("no_credit");
  });

  test("surfaces an auth failure for HTTP 401", async () => {
    const fetchMock = mock(async () => jsonResponse({ message: "Unauthorized" }, 401)) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await consumeCodexResetCredit(makeAccount(), "token", "redeem-1");
    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
    expect(result.noCredit).toBe(false);
  });
});
