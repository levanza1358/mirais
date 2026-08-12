import { describe, expect, test } from "bun:test";
import { xaiRequestBody, xaiRequestContext } from "../src/proxy/xai";
import type { CanonicalRequest } from "../src/shared/types";

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

describe("xAI Grok CLI adapter", () => {
  test("keeps only tool outputs linked to a prior function call", () => {
    const body = xaiRequestBody(toolRequest, "grok-4.5");
    const input = body.input as Array<Record<string, unknown>>;
    expect(body.instructions).toBe("You are precise.");
    expect(input.some((item) => item.type === "function_call_output" && item.call_id === "call_weather")).toBe(true);
    expect(input.some((item) => item.type === "function_call_output" && item.call_id === "unknown")).toBe(false);
  });

  test("increments Grok turn index for a stable client session", () => {
    const first = xaiRequestContext({ sessionId: "test-session" }, toolRequest, "grok-4.5");
    const second = xaiRequestContext({ sessionId: "test-session" }, toolRequest, "grok-4.5");
    expect(second.turn).toBe(first.turn + 1);
    expect(second.sessionId).toBe("test-session");
  });
});