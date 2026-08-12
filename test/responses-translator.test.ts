import { describe, expect, test } from "bun:test";
import { canonicalResponseToResponses, chatSseToResponses, responsesRequestToCanonical } from "../src/proxy/translator/responses";
import { responsesCreateSchema } from "../src/shared/schemas";
import { ResponsesToChatStreamTranslator } from "../src/proxy/codex";

const encoder = new TextEncoder();

describe("Responses compatibility translator", () => {
  test("keeps distinct indexes for parallel Responses function calls", () => {
    const translator = new ResponsesToChatStreamTranslator("grok-4.5");
    const first = translator.handleEvent("response.output_item.added", JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "item_a", call_id: "call_a", name: "one" } })).join("");
    const second = translator.handleEvent("response.output_item.added", JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "item_b", call_id: "call_b", name: "two" } })).join("");
    const args = translator.handleEvent("response.function_call_arguments.delta", JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "item_b", delta: "{}" })).join("");
    expect(first).toContain('"index":0');
    expect(second).toContain('"index":1');
    expect(args).toContain('"index":1');
  });

  test("maps string input, instructions, limits and function tools", () => {
    const req = responsesRequestToCanonical({
      model: "combo:smart",
      instructions: "Be concise",
      input: "Hello",
      max_output_tokens: 42,
      tools: [{ type: "function", name: "weather", parameters: { type: "object" } }],
    });
    expect(req.model).toBe("combo:smart");
    expect(req.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(req.max_tokens).toBe(42);
    expect(req.tools?.[0]?.function.name).toBe("weather");
  });

  test("accepts easy messages and stateless SDK fields while mapping structured output", () => {
    const parsed = responsesCreateSchema.parse({
      model: "m", input: [{ role: "user", content: "hi" }], store: false, background: false,
      text: { format: { type: "json_schema", name: "result", schema: { type: "object" }, strict: true } },
      tools: [{ type: "function", name: "lookup", parameters: {}, strict: true }],
    });
    const req = responsesRequestToCanonical(parsed);
    expect(req.messages[0]?.role).toBe("user");
    expect(req.tools?.[0]?.function.strict).toBe(true);
    expect(req.response_format).toEqual({ type: "json_schema", json_schema: { name: "result", schema: { type: "object" }, strict: true } });
    expect(responsesCreateSchema.safeParse({ model: "m", input: "hi", store: true }).success).toBe(false);
  });

  test("maps canonical text and tool calls to Responses output", () => {
    const result = canonicalResponseToResponses({
      id: "chat_1", object: "chat.completion", created: 123, model: "upstream", usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "hello", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }],
    }, "alias");
    expect(result.object).toBe("response");
    expect(result.model).toBe("alias");
    expect(result.output.map((item) => item.type)).toEqual(["message", "function_call"]);
    expect(result.usage?.input_tokens).toBe(2);
  });

  test("streams incremental Responses SSE without buffering", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const translated = chatSseToResponses(source, "model");
    const text = await new Response(translated.stream).text();
    expect(text).toContain("response.created");
    expect(text).toContain('"delta":"hel"');
    expect(text).toContain('"delta":"lo"');
    expect(text).toContain("response.completed");
    expect((await translated.usagePromise)?.total_tokens).toBe(2);
  });

  test("streams parallel tool calls across fragmented CRLF boundaries", async () => {
    const pieces = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"one","arguments":"{\\"a\\":"}},{"index":1,"id":"call_b","function":{"name":"two","arguments":"{\\"b\\":"}}]}}]}\r',
      '\n\r\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}},{"index":1,"function":{"arguments":"2}"}}]}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ];
    const source = new ReadableStream<Uint8Array>({ start(controller) { for (const piece of pieces) controller.enqueue(encoder.encode(piece)); controller.close(); } });
    const text = await new Response(chatSseToResponses(source, "m").stream).text();
    expect(text).toContain("response.function_call_arguments.delta");
    expect(text).toContain('"call_id":"call_a"');
    expect(text).toContain('"call_id":"call_b"');
    expect(text).toContain('"arguments":"{\\"a\\":1}"');
    expect(text).toContain('"arguments":"{\\"b\\":2}"');
    expect(text).not.toContain('"type":"message","status":"completed"');
    expect(text).toContain('"sequence_number":0');
  });
});
