import { describe, expect, test } from "bun:test";
import { fetchXaiResponses, XaiStreamTranslator, xaiHeaders, xaiRequestBody, xaiRequestContext, xaiResponsesStreamToChat } from "../src/proxy/xai";
import { requireInitialStreamByte } from "../src/proxy/executor";
import type { CanonicalRequest, ProviderAccount } from "../src/shared/types";

const toolRequest: CanonicalRequest = {
  model: "grok-4.5",
  messages: [
    { role: "system", content: "You are precise." },
    { role: "assistant", content: "", tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: "{\"city\": \"Jakarta\"}" } }] },
    { role: "tool", tool_call_id: "call_weather", content: "Sunny" },
    { role: "tool", tool_call_id: "unknown", content: "Must not be sent" },
    { role: "user", content: "Summarize the weather." },
  ],
  tools: [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: {} } } }],
  tool_choice: "auto",
};

describe("xAI stream termination", () => {
  test("translates an unterminated final Responses API event", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"final Grok answer\"}",
        ));
        controller.close();
      },
    });

    const { stream } = xaiResponsesStreamToChat(upstream, "xai/grok-4.5");
    const output = await new Response(stream).text();

    expect(output).toContain("final Grok answer");
    expect(output).toContain("chat.completion.chunk");
  });

  test("reports the upstream error class when a Responses stream fails", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("connection closed", "AbortError"));
      },
    });

    const { stream } = xaiResponsesStreamToChat(upstream, "xai/grok-4.5");
    const output = await new Response(stream).text();

    expect(output).toContain("upstream stream error (AbortError)");
  });

  test("fails before forwarding when an upstream stream aborts without bytes", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("connection closed", "AbortError"));
      },
    });

    await expect(requireInitialStreamByte(upstream, "Grok"))
      .rejects.toThrow("aborted before first byte (AbortError)");
  });
});

describe("xAI Grok CLI adapter", () => {
  test("keeps only tool outputs linked to a prior function call", () => {
    const body = xaiRequestBody(toolRequest, "grok-4.5");
    const input = body.input as Array<Record<string, unknown>>;
    expect(body.instructions).toContain("You are precise.");
    expect(body.instructions).toContain("careful, verified engineering workflow");
    expect(input.some((item) => item.type === "function_call_output" && item.call_id === "call_weather")).toBe(true);
    expect(input.some((item) => item.type === "function_call_output" && item.call_id === "unknown")).toBe(false);
  });

  test("keeps a tool result linked after normalizing a Grok server call ID", () => {
    const request: CanonicalRequest = {
      ...toolRequest,
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "fc_12345678-1234-1234-1234-123456789abc", type: "function", function: { name: "weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "fc_12345678-1234-1234-1234-123456789abc", content: "Sunny" },
      ],
    };

    const input = xaiRequestBody(request, "grok-4.5").input as Array<Record<string, unknown>>;
    const call = input.find((item) => item.type === "function_call");
    const result = input.find((item) => item.type === "function_call_output");
    expect(typeof call?.call_id).toBe("string");
    expect(result?.call_id).toBe(call?.call_id);
  });

  test("increments Grok turn index for a stable client session", () => {
    const first = xaiRequestContext({ sessionId: "test-session" }, toolRequest, "grok-4.5");
    const second = xaiRequestContext({ sessionId: "test-session" }, toolRequest, "grok-4.5");
    expect(second.turn).toBe(first.turn + 1);
    expect(second.sessionId).toBe("test-session");
  });

  test("adds Grok CLI account identity headers to non-chat probes", () => {
    const account: ProviderAccount = {
      id: "01JABCDEFGH1234567890ABCDE",
      provider_id: "provider-1",
      label: "grok@example.test",
      api_key: "access-token",
      enabled: 1,
      priority: 0,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    const headers = xaiHeaders("access-token", false, undefined, account);
    expect(headers["x-email"]).toBe("grok@example.test");
    expect(headers["x-grok-agent-id"]).toBe("mi-01JABCDE-FGH1-2345");
  });

  test("does not retry an xAI request after its combined timeout signal aborts", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response("busy", { status: 503 }));
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort(new Error("request timed out"));

    try {
      const response = await fetchXaiResponses({ method: "POST", signal: controller.signal }, controller.signal);
      expect(response.status).toBe(503);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("emits arguments xAI supplies only in completed parallel function-call items", () => {
    const translator = new XaiStreamTranslator("grok-4.5");
    translator.handleEvent("response.output_item.added", JSON.stringify({ type: "response.output_item.added", output_index: 3, item: { id: "fc_weather", type: "function_call", call_id: "call_weather", name: "weather", arguments: "" } }));
    translator.handleEvent("response.output_item.added", JSON.stringify({ type: "response.output_item.added", output_index: 4, item: { id: "fc_time", type: "function_call", call_id: "call_time", name: "time", arguments: "" } }));

    const weather = translator.handleEvent("response.output_item.done", JSON.stringify({ type: "response.output_item.done", output_index: 3, item: { id: "fc_weather", type: "function_call", call_id: "call_weather", name: "weather", arguments: '{"city":"Jakarta"}' } })).join("");
    const time = translator.handleEvent("response.output_item.done", JSON.stringify({ type: "response.output_item.done", output_index: 4, item: { id: "fc_time", type: "function_call", call_id: "call_time", name: "time", arguments: '{"zone":"Asia/Jakarta"}' } })).join("");

    expect(weather).toContain('"index":0');
    expect(weather).toContain('"arguments":"{\\"city\\":\\"Jakarta\\"}"');
    expect(time).toContain('"index":1');
    expect(time).toContain('"arguments":"{\\"zone\\":\\"Asia/Jakarta\\"}"');
  });

  test("emits xAI reasoning summaries in the dedicated reasoning channel", () => {
    const translator = new XaiStreamTranslator("grok-4.5");
    const output = translator.handleEvent("response.reasoning_summary_text.delta", JSON.stringify({
      type: "response.reasoning_summary_text.delta",
      delta: "Checking the existing file first.",
    })).join("");

    expect(output).toContain("reasoning_content");
    expect(output).toContain("Checking the existing file first.");
    expect(output).not.toContain("【Reasoning】");
  });

  test("uses maximum effective reasoning effort for Grok-4.5", () => {
    const body = xaiRequestBody({ ...toolRequest, reasoning: { effort: "low" } }, "grok-4.5");

    expect(body.reasoning).toEqual({ summary: "concise", effort: "high" });
  });
});