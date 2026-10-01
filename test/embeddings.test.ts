import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearAllCooldowns, executeEmbedding } from "../src/proxy/executor";
import { embeddingsCreateSchema } from "../src/shared/schemas";
import type { EmbeddingRequest, RouteCandidate, ProviderAccount, Provider } from "../src/shared/types";
import { GatewayError } from "../src/shared/errors";

/**
 * Coverage for `POST /v1/embeddings`. The executor:
 *   - validates the upstream route (openai / custom / codex-oauth)
 *   - forwards the body verbatim with `model` rewritten to the upstream id
 *   - decodes base64 → Float32 and verifies float arrays round-trip
 *   - cools down the account on 429/5xx and fails over
 *   - logs attempts via AttemptsRecord[]
 */

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "prov-1",
    name: "openai",
    display_name: "OpenAI",
    type: "openai",
    base_url: "https://api.example.com/v1",
    enabled: 1,
    priority: 100,
    account_strategy: "priority",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "acc-1",
    provider_id: "prov-1",
    label: "primary",
    api_key: "sk-test",
    enabled: 1,
    priority: 100,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    auth_kind: "api_key",
    account_kind: "api-key",
    refresh_token: null,
    id_token: null,
    account_id: null,
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

function makeCandidate(provider: Provider, account: ProviderAccount, modelId = "text-embedding-3-small"): RouteCandidate {
  return { provider, modelId, accounts: [account] };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = globalThis.fetch; clearAllCooldowns(); });
afterEach(() => { globalThis.fetch = originalFetch; mock.restore(); });

describe("embeddingsCreateSchema", () => {
  test("accepts a single string input", () => {
    const parsed = embeddingsCreateSchema.parse({ model: "openai/text-embedding-3-small", input: "hello" });
    expect(parsed.input).toBe("hello");
  });

  test("accepts an array of strings", () => {
    const parsed = embeddingsCreateSchema.parse({ model: "openai/text-embedding-3-small", input: ["a", "b", "c"] });
    expect(parsed.input).toEqual(["a", "b", "c"]);
  });

  test("accepts an array of number arrays (pre-tokenized)", () => {
    const parsed = embeddingsCreateSchema.parse({ model: "openai/text-embedding-3-small", input: [[1, 2, 3], [4, 5, 6]] as number[][] });
    expect(parsed.input).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  test("accepts encoding_format + dimensions + user", () => {
    const parsed = embeddingsCreateSchema.parse({
      model: "openai/text-embedding-3-small",
      input: "x",
      encoding_format: "base64",
      dimensions: 512,
      user: "user-1",
    });
    expect(parsed.encoding_format).toBe("base64");
    expect(parsed.dimensions).toBe(512);
    expect(parsed.user).toBe("user-1");
  });

  test("rejects an empty input array", () => {
    expect(() => embeddingsCreateSchema.parse({ model: "x", input: [] })).toThrow();
  });

  test("rejects missing model", () => {
    expect(() => embeddingsCreateSchema.parse({ input: "x" })).toThrow();
  });
});

describe("executeEmbedding — happy path", () => {
  test("forwards the body, rewrites model, returns the OpenAI-shaped response", async () => {
    const provider = makeProvider();
    const account = makeAccount();
    const candidate = makeCandidate(provider, account, "text-embedding-3-small");
    const req: EmbeddingRequest = { model: "openai/text-embedding-3-small", input: "hello" };

    let captured: { url: string; init: RequestInit | undefined } | null = null;
    globalThis.fetch = mock(async (input: Request | URL, init?: RequestInit) => {
      captured = { url: typeof input === "string" ? input : input.toString(), init };
      return jsonResponse({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const result = await executeEmbedding(req, [candidate]);
    expect(result.response.data[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.response.usage.total_tokens).toBe(1);
    expect(result.candidate.modelId).toBe("text-embedding-3-small");
    expect(result.accountLabel).toBe("primary");
    expect(result.encodingMismatch).toBe(false);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://api.example.com/v1/embeddings");
    const body = JSON.parse(String(captured!.init?.body)) as { model: string; input: string };
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toBe("hello");
    const headers = captured!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  test("detects base64 encoding when the client asked for float", async () => {
    const provider = makeProvider();
    const account = makeAccount();
    const candidate = makeCandidate(provider, account);
    const req: EmbeddingRequest = { model: "openai/text-embedding-3-small", input: "x", encoding_format: "float" };
    globalThis.fetch = mock(async () => jsonResponse({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: "AAAA" /* base64 placeholder */ }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })) as unknown as typeof fetch;
    const result = await executeEmbedding(req, [candidate]);
    expect(result.encodingMismatch).toBe(true);
  });

  test("array input → upstream gets array input, multi-vector response", async () => {
    const provider = makeProvider();
    const account = makeAccount();
    const candidate = makeCandidate(provider, account);
    const req: EmbeddingRequest = { model: "openai/text-embedding-3-small", input: ["a", "b", "c"] };
    globalThis.fetch = mock(async () => jsonResponse({
      object: "list",
      data: [
        { object: "embedding", index: 0, embedding: [0.1] },
        { object: "embedding", index: 1, embedding: [0.2] },
        { object: "embedding", index: 2, embedding: [0.3] },
      ],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 3, total_tokens: 3 },
    })) as unknown as typeof fetch;
    const result = await executeEmbedding(req, [candidate]);
    expect(result.response.data).toHaveLength(3);
    expect(result.response.usage.total_tokens).toBe(3);
  });

  test("routes Codex OAuth accounts to chatgpt.com/backend-api/wham/embeddings", async () => {
    const provider = makeProvider({ name: "codex", type: "codex", base_url: null });
    const account = makeAccount({ auth_kind: "oauth", account_kind: "oauth-cli", account_id: "acct-1" });
    const candidate = makeCandidate(provider, account, "text-embedding-3-small");
    const req: EmbeddingRequest = { model: "codex/text-embedding-3-small", input: "x" };
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: Request | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.5] }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }) as unknown as typeof fetch;
    await executeEmbedding(req, [candidate]);
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/wham/embeddings");
  });
});

describe("executeEmbedding — failure modes", () => {
  test("rejects when no candidates resolve", async () => {
    await expect(executeEmbedding({ model: "openai/text-embedding-3-small", input: "x" }, []))
      .rejects.toThrow(/did not resolve to any embedding-capable provider/i);
  });

  test("rejects non-OpenAI-compatible providers", async () => {
    const provider = makeProvider({ name: "anthropic", type: "anthropic" });
    const account = makeAccount();
    const candidate = makeCandidate(provider, account);
    await expect(executeEmbedding({ model: "anthropic/claude-3-5-sonnet", input: "x" }, [candidate]))
      .rejects.toThrow(/does not support embeddings/i);
  });

  test("429 from upstream → account cooled down + fails over", async () => {
    const provider = makeProvider();
    const account1 = makeAccount({ id: "acc-1", label: "first" });
    const account2 = makeAccount({ id: "acc-2", label: "second" });
    const candidates: RouteCandidate[] = [
      { provider, modelId: "text-embedding-3-small", accounts: [account1] },
      { provider, modelId: "text-embedding-3-small", accounts: [account2] },
    ];
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;
    await expect(executeEmbedding({ model: "openai/text-embedding-3-small", input: "x" }, candidates))
      .rejects.toBeInstanceOf(GatewayError);
    expect(calls).toBe(2);
  });

  test("5xx → fails over", async () => {
    const provider = makeProvider();
    const account1 = makeAccount({ id: "acc-1", label: "first" });
    const account2 = makeAccount({ id: "acc-2", label: "second" });
    const candidates: RouteCandidate[] = [
      { provider, modelId: "text-embedding-3-small", accounts: [account1] },
      { provider, modelId: "text-embedding-3-small", accounts: [account2] },
    ];
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) return new Response("upstream down", { status: 502 });
      return jsonResponse({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1] }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }) as unknown as typeof fetch;
    const result = await executeEmbedding({ model: "openai/text-embedding-3-small", input: "x" }, candidates);
    expect(result.accountLabel).toBe("second");
    expect(calls).toBe(2);
  });

  test("non-OpenAI-shape response → GatewayError 502", async () => {
    const provider = makeProvider();
    const account = makeAccount();
    const candidate = makeCandidate(provider, account);
    globalThis.fetch = mock(async () => jsonResponse({
      // `embedding` field is missing entirely
      data: [{ object: "embedding", index: 0 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })) as unknown as typeof fetch;
    await expect(executeEmbedding({ model: "openai/text-embedding-3-small", input: "x" }, [candidate]))
      .rejects.toThrow(/unsupported encoding/i);
  });

  test("404 → throws GatewayError 404 not_found_error", async () => {
    const provider = makeProvider();
    const account = makeAccount();
    const candidate = makeCandidate(provider, account);
    globalThis.fetch = mock(async () => jsonResponse({ error: { message: "model not found" } }, 404)) as unknown as typeof fetch;
    await expect(executeEmbedding({ model: "openai/text-embedding-3-small", input: "x" }, [candidate]))
      .rejects.toThrow(/Embeddings failed: HTTP 404/i);
  });

  test("401 → throws GatewayError 401 authentication_error", async () => {
    const provider = makeProvider();
    const account = makeAccount();
    const candidate = makeCandidate(provider, account);
    globalThis.fetch = mock(async () => jsonResponse({ error: { message: "bad key" } }, 401)) as unknown as typeof fetch;
    await expect(executeEmbedding({ model: "openai/text-embedding-3-small", input: "x" }, [candidate]))
      .rejects.toThrow(/HTTP 401/i);
  });

  test("only Codex OAuth accounts qualify for codex-type provider; api-key accounts get filtered out", async () => {
    const provider = makeProvider({ name: "codex", type: "codex" });
    const account = makeAccount({ auth_kind: "api_key", account_kind: "api-key" });
    const candidate = makeCandidate(provider, account);
    await expect(executeEmbedding({ model: "codex/text-embedding-3-small", input: "x" }, [candidate]))
      .rejects.toThrow(/does not support embeddings/i);
  });
});

describe("executeEmbedding — provider override (custom base_url)", () => {
  test("uses the provider's base_url when type=custom", async () => {
    const provider = makeProvider({ name: "local-llm", type: "custom", base_url: "https://local.test/v1" });
    const account = makeAccount();
    const candidate = makeCandidate(provider, account, "nomic-embed-text-v1.5");
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: Request | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.42] }],
        model: "nomic-embed-text-v1.5",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }) as unknown as typeof fetch;
    await executeEmbedding({ model: "local-llm/nomic-embed-text-v1.5", input: "x" }, [candidate]);
    expect(capturedUrl).toBe("https://local.test/v1/embeddings");
  });
});
