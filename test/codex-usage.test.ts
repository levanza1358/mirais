import { describe, expect, test } from "bun:test";
import { aggregateResponsesStream, codexPlanAllowsModel, codexQuotaDetail, isCodexQuotaExhausted, responsesStreamToChat, type CodexUsageSnapshot } from "../src/proxy/codex";

function usage(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
  return {
    plan_type: null,
    email: null,
    limit_reached: false,
    primary: null,
    secondary: null,
    banked_resets: null,
    credits: null,
    ...overrides,
  };
}

describe("Codex quota exhaustion", () => {
  test("treats explicit limit_reached as exhausted", () => {
    expect(isCodexQuotaExhausted(usage({ limit_reached: true }))).toBe(true);
  });

  test("treats a full primary window as exhausted even without limit_reached", () => {
    const snapshot = usage({
      primary: { used_percent: 100, remaining_percent: 0, window_seconds: null, resets_in_seconds: null, reset_at: null },
    });
    expect(isCodexQuotaExhausted(snapshot)).toBe(true);
    expect(codexQuotaDetail(snapshot)).toContain("primary window at 100%");
  });

  test("treats a full secondary window as exhausted", () => {
    const snapshot = usage({
      secondary: { used_percent: 100, remaining_percent: 0, window_seconds: null, resets_in_seconds: null, reset_at: null },
    });
    expect(isCodexQuotaExhausted(snapshot)).toBe(true);
  });

  test("keeps a partially used quota healthy", () => {
    expect(isCodexQuotaExhausted(usage({
      primary: { used_percent: 99.9, remaining_percent: 0.1, window_seconds: null, resets_in_seconds: null, reset_at: null },
    }))).toBe(false);
  });
});

describe("Codex paid model plans", () => {
  test("never permits free or unknown accounts for Plus/Pro-gated models", () => {
    expect(codexPlanAllowsModel(null, "gpt-5.6-sol")).toBe(false);
    expect(codexPlanAllowsModel("free", "gpt-5.6-sol")).toBe(false);
    expect(codexPlanAllowsModel("free", "gpt-5.3-codex-spark")).toBe(false);
  });

  test("allows Plus for Sol but requires Pro for Codex Spark", () => {
    expect(codexPlanAllowsModel("plus", "gpt-5.6-sol")).toBe(true);
    expect(codexPlanAllowsModel("plus", "gpt-5.3-codex-spark")).toBe(false);
    expect(codexPlanAllowsModel("pro", "gpt-5.3-codex-spark")).toBe(true);
  });
});

function upstream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
}

describe("Responses stream readiness", () => {
  test("rejects when the upstream errors before any content", async () => {
    const { ready } = responsesStreamToChat(upstream([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
      "data: {\"error\":{\"message\":\"Our servers are currently overloaded. Please try again later.\",\"type\":\"server_error\"}}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
    ]), "openai/gpt-5.6-terra");

    await expect(ready).rejects.toThrow("Our servers are currently overloaded");
  });

  test("rejects when the upstream closes without content", async () => {
    const { ready } = responsesStreamToChat(upstream([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
    ]), "openai/gpt-5.6-terra");

    await expect(ready).rejects.toThrow("ended before any content");
  });

  test("forwards buffered chunks once content arrives", async () => {
    const { stream, ready } = responsesStreamToChat(upstream([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
    ]), "openai/gpt-5.6-terra");

    await ready;
    const out = await new Response(stream).text();
    expect(out).toContain("\"role\":\"assistant\"");
    expect(out).toContain("hello");
    expect(out).toContain("[DONE]");
  });

  test("streams reasoning deltas on the reasoning channel", async () => {
    const { stream, ready } = responsesStreamToChat(upstream([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
      "data: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"thinking\"}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
    ]), "openai/gpt-5.6-sol");

    await ready;
    const out = await new Response(stream).text();
    expect(out).toContain("\"reasoning_content\":\"thinking\"");
    expect(out).not.toContain("\"content\":\"thinking\"");
  });

  test("emits final response text when no text delta arrived", async () => {
    const { stream, ready } = responsesStreamToChat(upstream([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"final answer\"}]}]}}\n\n",
    ]), "openai/gpt-5.6-sol");

    await ready;
    const out = await new Response(stream).text();
    expect(out).toContain("\"content\":\"final answer\"");
    expect(out).toContain("\"finish_reason\":\"stop\"");
  });

  test("maps response.incomplete to finish_reason length", async () => {
    const { stream, ready } = responsesStreamToChat(upstream([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
      "data: {\"type\":\"response.incomplete\",\"response\":{}}\n\n",
    ]), "openai/gpt-5.6-sol");

    await ready;
    const out = await new Response(stream).text();
    expect(out).toContain("\"finish_reason\":\"length\"");
  });
});

describe("Responses stream aggregation", () => {
  test("falls back to final output text and reasoning", async () => {
    const withFinalText = await aggregateResponsesStream(upstream([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"final answer\"}]}]}}\n\n",
    ]), "openai/gpt-5.6-sol");
    expect(withFinalText.choices[0]?.message.content).toBe("final answer");

    const reasoningOnly = await aggregateResponsesStream(upstream([
      "data: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"thinking\"}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
    ]), "openai/gpt-5.6-sol");
    expect(reasoningOnly.choices[0]?.message.content).toBe("thinking");
  });
});