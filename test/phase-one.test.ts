import { describe, expect, test } from "bun:test";
import { AuditRepo } from "../src/store/repos/audit";
import { LogsRepo } from "../src/store/repos/logs";
import { freshDb } from "./helpers";

describe("phase-one observability", () => {
  test("audit entries are paginated and preserve safe metadata", () => {
    const db = freshDb();
    const audit = new AuditRepo(db);
    audit.record("updated", "settings", null, { fields: ["token_saver"] });
    audit.record("created", "provider", "provider-1", { name: "openai", type: "openai" });

    const page = audit.list(1, 1);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    const first = page.items[0];
    expect(first).toBeTruthy();
    expect(["provider", "settings"]).toContain(first?.resource ?? "");
    expect(first?.detail).toBeTruthy();
  });

  test("provider health aggregates request outcomes", () => {
    const db = freshDb();
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
    logs.insert({ ...base, status: "success", httpStatus: 200, error: null });
    logs.insert({ ...base, status: "error", httpStatus: 500, error: "upstream" });

    const health = logs.providerHealth(7);
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ provider: "openai", requests: 2, errors: 1, error_rate: 0.5, avg_latency_ms: 100 });
  });

  test("key usage reports totals and top models", () => {
    const db = freshDb();
    const logs = new LogsRepo(db);
    const entry = { keyId: "key-1", endpoint: "/v1/chat/completions", requestedModel: "m", provider: "openai", model: "m", attempts: 1, status: "success" as const, httpStatus: 200, error: null, inputTokens: 10, outputTokens: 5, latencyMs: 10, tokensSaved: 0 };
    logs.insert(entry);
    const usage = logs.keyUsage("key-1");
    expect(usage).toMatchObject({ requests_total: 1, input_tokens_total: 10, output_tokens_total: 5, tokens_total: 15 });
    expect(usage.top_models[0]).toMatchObject({ model: "m", requests: 1, tokens: 15 });
  });

  test("replay payload is available only for captured request JSON", () => {
    const db = freshDb();
    const logs = new LogsRepo(db);
    logs.insert({ keyId: null, endpoint: "/v1/chat/completions", requestedModel: "m", provider: "openai", model: "m", attempts: 1, status: "success", httpStatus: 200, error: null, inputTokens: 1, outputTokens: 1, latencyMs: 10, tokensSaved: 0, requestBody: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] }), kind: "request" });
    const row = logs.list({ page: 1, limit: 1 }).items[0];
    expect(row).toBeTruthy();
    expect(logs.getReplayBody(row?.id ?? "")).toEqual({ endpoint: "/v1/chat/completions", body: { model: "m", messages: [{ role: "user", content: "hello" }], stream: false } });
  });
});
