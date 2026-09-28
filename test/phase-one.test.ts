import { describe, expect, test } from "bun:test";
import { AuditRepo } from "../src/store/repos/audit";
import { LogsRepo } from "../src/store/repos/logs";
import { freshDb } from "./helpers";

describe("phase-one observability", () => {
  test("audit entries are paginated and preserve safe metadata", async () => {
    const db = await freshDb();
    const audit = new AuditRepo(db);
    await audit.record("updated", "settings", null, { fields: ["token_saver"] });
    await audit.record("created", "provider", "provider-1", { name: "openai", type: "openai" });

    const page = await audit.list(1, 1);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    const first = page.items[0];
    expect(first).toBeTruthy();
    expect(["provider", "settings"]).toContain(first?.resource ?? "");
    expect(first?.detail).toBeTruthy();
  });

  test("log list excludes payloads while detail keeps them", async () => {
    const db = await freshDb();
    const logs = new LogsRepo(db);
    const marker = "it's C:\\\\temp\\\\file ? x' OR 1=1 --";
    await logs.insert({
      keyId: null,
      endpoint: "/v1/chat/completions",
      requestedModel: marker,
      provider: "provider'\\name",
      model: marker,
      attempts: 1,
      status: "success",
      httpStatus: 200,
      error: marker,
      inputTokens: 1,
      outputTokens: 2,
      latencyMs: 3,
      tokensSaved: 0,
      requestBody: JSON.stringify({ content: marker }),
      responseBody: marker,
    });
    const listed = await logs.list({ page: 1, limit: 10, model: marker });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.requested_model).toBe(marker);
    expect(listed.items[0]?.has_payload).toBeTruthy();
    expect("request_body" in (listed.items[0] ?? {})).toBe(false);
    expect("response_body" in (listed.items[0] ?? {})).toBe(false);
    const detail = await logs.getById(listed.items[0]?.id ?? "");
    expect(detail?.request_body).toBe(JSON.stringify({ content: marker }));
    expect(detail?.response_body).toBe(marker);
    expect(detail?.provider).toBe("provider'\\name");
  });

  test("legacy payload cleanup moves recent bodies and clears old columns", async () => {
    const db = await freshDb();
    const logs = new LogsRepo(db);
    await logs.insert({ keyId: null, endpoint: "/v1/chat/completions", requestedModel: "legacy", provider: "p", model: "legacy", attempts: 1, status: "success", httpStatus: 200, error: null, inputTokens: 1, outputTokens: 1, latencyMs: 1, tokensSaved: 0, requestBody: "legacy-request", responseBody: "legacy-response" });
    const row = (await logs.list({ page: 1, limit: 1 })).items[0];
    await db.query("UPDATE request_logs SET request_body = ?, response_body = ? WHERE id = ?").run("legacy-request", "legacy-response", row?.id ?? "");
    await logs.cleanupLegacyPayloads();
    const raw = await db.query("SELECT request_body, response_body FROM request_logs WHERE id = ?").get<{ request_body: string | null; response_body: string | null }>(row?.id ?? "");
    expect(raw).toEqual({ request_body: null, response_body: null });
    expect((await logs.getById(row?.id ?? ""))?.request_body).toBe("legacy-request");
    expect((await logs.getById(row?.id ?? ""))?.response_body).toBe("legacy-response");
  });

  test("payload retention does not remove metadata", async () => {
    const db = await freshDb();
    const logs = new LogsRepo(db);
    await logs.insert({ keyId: null, endpoint: "/v1/chat/completions", requestedModel: "old", provider: "p", model: "old", attempts: 1, status: "success", httpStatus: 200, error: null, inputTokens: 1, outputTokens: 1, latencyMs: 1, tokensSaved: 0, requestBody: "old-body" });
    const row = (await logs.list({ page: 1, limit: 1 })).items[0];
    await db.query("UPDATE request_log_payloads SET created_at = ? WHERE request_log_id = ?").run("2000-01-01T00:00:00.000Z", row?.id ?? "");
    expect((await db.query("SELECT created_at FROM request_log_payloads WHERE request_log_id = ?").get<{ created_at: string }>(row?.id ?? ""))?.created_at).toContain("2000");
    await logs.purgePayloadsOlderThan(7);
    expect((await db.query("SELECT request_log_id FROM request_log_payloads WHERE request_log_id = ?").get<{ request_log_id: string }>(row?.id ?? ""))).toBeNull();
    expect((await logs.list({ page: 1, limit: 1 })).total).toBe(1);
    expect((await logs.getById(row?.id ?? ""))?.request_body).toBeNull();
  });

  test("provider health aggregates request outcomes", async () => {
    const db = await freshDb();
    const logs = new LogsRepo(db);
    const base = {
      keyId: null,
      endpoint: "/v1/chat/completions",
      requestedModel: "m",
      provider: "openai",
      model: "m",
      attempts: 1,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      tokensSaved: 0,
    };
    await logs.insert({ ...base, status: "success", httpStatus: 200, error: null });
    await logs.insert({ ...base, status: "error", httpStatus: 500, error: "upstream" });

    const health = await logs.providerHealth(7);
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ provider: "openai", requests: 2, errors: 1, error_rate: 0.5, avg_latency_ms: 100 });
  });

  test("key usage reports totals and top models", async () => {
    const db = await freshDb();
    await db.query("INSERT INTO gateway_keys (id, label, key_hash, key_prefix) VALUES (?, ?, ?, ?)")
      .run("key-1", "test key", "hash-key-1", "test-");
    const logs = new LogsRepo(db);
    const entry = { keyId: "key-1", endpoint: "/v1/chat/completions", requestedModel: "m", provider: "openai", model: "m", attempts: 1, status: "success" as const, httpStatus: 200, error: null, inputTokens: 10, outputTokens: 5, latencyMs: 10, tokensSaved: 0 };
    await logs.insert(entry);
    const usage = await logs.keyUsage("key-1");
    expect(usage).toMatchObject({ requests_total: 1, input_tokens_total: 10, output_tokens_total: 5, tokens_total: 15 });
    expect(usage.top_models[0]).toMatchObject({ model: "m", requests: 1, tokens: 15 });
  });

  test("key usage sums partial token fields", async () => {
    const db = await freshDb();
    await db.query("INSERT INTO gateway_keys (id, label, key_hash, key_prefix) VALUES (?, ?, ?, ?)").run("key-partial", "partial", "hash-partial", "part-");
    const logs = new LogsRepo(db);
    await logs.insert({ keyId: "key-partial", endpoint: "/v1/chat/completions", requestedModel: "m", provider: "p", model: "m", attempts: 1, status: "success", httpStatus: 200, error: null, inputTokens: 100, outputTokens: null, latencyMs: 1, tokensSaved: 0 });
    expect((await logs.keyUsage("key-partial")).tokens_total).toBe(100);
  });

  test("replay preserves original endpoint", async () => {
    const db = await freshDb();
    const logs = new LogsRepo(db);
    await logs.insert({ keyId: null, endpoint: "/v1/messages", requestedModel: "m", provider: "anthropic", model: "m", attempts: 1, status: "success", httpStatus: 200, error: null, inputTokens: 1, outputTokens: 1, latencyMs: 1, tokensSaved: 0, requestBody: JSON.stringify({ model: "m", messages: [] }), kind: "request" });
    const row = (await logs.list({ page: 1, limit: 1 })).items[0];
    expect(await logs.getReplayBody(row?.id ?? "")).toEqual({ endpoint: "/v1/messages", body: { model: "m", messages: [], stream: false } });
  });

  test("replay payload is available only for captured request JSON", async () => {
    const db = await freshDb();
    const logs = new LogsRepo(db);
    await logs.insert({ keyId: null, endpoint: "/v1/chat/completions", requestedModel: "m", provider: "openai", model: "m", attempts: 1, status: "success", httpStatus: 200, error: null, inputTokens: 1, outputTokens: 1, latencyMs: 10, tokensSaved: 0, requestBody: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] }), kind: "request" });
    const row = (await logs.list({ page: 1, limit: 1 })).items[0];
    expect(row).toBeTruthy();
    expect(await logs.getReplayBody(row?.id ?? "")).toEqual({ endpoint: "/v1/chat/completions", body: { model: "m", messages: [{ role: "user", content: "hello" }], stream: false } });
  });
});
