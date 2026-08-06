import { describe, test, expect } from "bun:test";
import {
  openaiToAnthropicRequest,
  anthropicToOpenaiRequest,
} from "../src/proxy/translator/anthropic-to-openai";
import {
  anthropicToOpenaiResponse,
  openaiToAnthropicResponse,
} from "../src/proxy/translator/openai-to-anthropic";
import type { CanonicalRequest, CanonicalResponse } from "../src/shared/types";

// ── OpenAI → Anthropic request ──

describe("openaiToAnthropicRequest", () => {
  test("basic system + user messages", () => {
    const req: CanonicalRequest = {
      model: "claude",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 100,
    };
    const out = openaiToAnthropicRequest(req, "claude-sonnet-4-5");
    expect(out.model).toBe("claude-sonnet-4-5");
    expect(out.max_tokens).toBe(100);
    expect(out.system).toEqual([{ type: "text", text: "You are helpful." }]);
    expect(out.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  test("defaults max_tokens to 4096", () => {
    const out = openaiToAnthropicRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }, "m");
    expect(out.max_tokens).toBe(4096);
  });

  test("assistant tool_calls → tool_use blocks", () => {
    const req: CanonicalRequest = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } },
          ],
        },
      ],
    };
    const out = openaiToAnthropicRequest(req, "m");
    const msg = out.messages[0]!;
    expect(msg.role).toBe("assistant");
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "Let me check." });
    expect(blocks[1]).toEqual({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Jakarta" } });
  });

  test("tool role message → user tool_result block", () => {
    const req: CanonicalRequest = {
      model: "m",
      messages: [{ role: "tool", tool_call_id: "call_1", content: "sunny, 32C" }],
    };
    const out = openaiToAnthropicRequest(req, "m");
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny, 32C" }],
    });
  });

  test("image data-url → base64 image block", () => {
    const req: CanonicalRequest = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ],
    };
    const out = openaiToAnthropicRequest(req, "m");
    const blocks = out.messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  test("tools + tool_choice mapping", () => {
    const req: CanonicalRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "Search the web",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
      tool_choice: "required",
    };
    const out = openaiToAnthropicRequest(req, "m");
    expect(out.tools).toEqual([
      {
        name: "search",
        description: "Search the web",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    expect(out.tool_choice).toEqual({ type: "any" });
  });

  test("stop sequences + temperature passthrough", () => {
    const req: CanonicalRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stop: ["END"],
      temperature: 0.5,
      top_p: 0.9,
      stream: true,
    };
    const out = openaiToAnthropicRequest(req, "m");
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.stream).toBe(true);
  });
});

// ── Anthropic → OpenAI request ──

describe("anthropicToOpenaiRequest", () => {
  test("string system + plain messages", () => {
    const out = anthropicToOpenaiRequest({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      system: "Be terse.",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
    });
    expect(out.model).toBe("claude-sonnet-4-5");
    expect(out.max_tokens).toBe(512);
    expect(out.messages[0]).toEqual({ role: "system", content: "Be terse." });
    expect(out.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(out.messages[2]).toEqual({ role: "assistant", content: "Hi there" });
  });

  test("assistant tool_use blocks → tool_calls", () => {
    const out = anthropicToOpenaiRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_1", name: "search", input: { q: "bun" } },
          ],
        },
      ],
    });
    const msg = out.messages[0]!;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Checking.");
    expect(msg.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "search", arguments: '{"q":"bun"}' } },
    ]);
  });

  test("user tool_result block → tool message", () => {
    const out = anthropicToOpenaiRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result text" }],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "result text" },
    ]);
  });

  test("base64 image → data-url image_url part", () => {
    const out = anthropicToOpenaiRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          ],
        },
      ],
    });
    const content = out.messages[0]!.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } });
  });

  test("anthropic tools → openai function tools", () => {
    const out = anthropicToOpenaiRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "calc", description: "Calculator", input_schema: { type: "object", properties: {} } }],
    });
    expect(out.tools).toEqual([
      {
        type: "function",
        function: { name: "calc", description: "Calculator", parameters: { type: "object", properties: {} } },
      },
    ]);
  });
});

// ── Anthropic → OpenAI response ──

describe("anthropicToOpenaiResponse", () => {
  test("text response with usage", () => {
    const out = anthropicToOpenaiResponse(
      {
        id: "msg_123",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude",
    );
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("claude");
    expect(out.choices[0]!.message.content).toBe("Hello!");
    expect(out.choices[0]!.finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test("tool_use response → tool_calls + finish tool_calls", () => {
    const out = anthropicToOpenaiResponse(
      {
        id: "msg_1",
        content: [{ type: "tool_use", id: "toolu_9", name: "search", input: { q: "x" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 7 },
      },
      "m",
    );
    expect(out.choices[0]!.finish_reason).toBe("tool_calls");
    expect(out.choices[0]!.message.tool_calls).toEqual([
      { id: "toolu_9", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
    ]);
  });

  test("max_tokens stop → length", () => {
    const out = anthropicToOpenaiResponse(
      { id: "msg_2", content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" },
      "m",
    );
    expect(out.choices[0]!.finish_reason).toBe("length");
  });
});

// ── OpenAI → Anthropic response ──

describe("openaiToAnthropicResponse", () => {
  test("text response", () => {
    const resp: CanonicalResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-x",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    };
    const out = openaiToAnthropicResponse(resp) as Record<string, unknown>;
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.stop_reason).toBe("end_turn");
    expect(out.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(out.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
  });

  test("tool_calls response → tool_use blocks", () => {
    const resp: CanonicalResponse = {
      id: "chatcmpl-2",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-x",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const out = openaiToAnthropicResponse(resp) as Record<string, unknown>;
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "f", input: { a: 1 } }]);
  });
});

// ── Round-trip ──

describe("round-trip", () => {
  test("openai → anthropic → openai preserves semantics", () => {
    const original: CanonicalRequest = {
      model: "m",
      max_tokens: 256,
      temperature: 0.7,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ],
    };
    const anth = openaiToAnthropicRequest(original, "m");
    const back = anthropicToOpenaiRequest(anth as unknown as Record<string, unknown>);
    expect(back.max_tokens).toBe(256);
    expect(back.temperature).toBe(0.7);
    expect(back.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(back.messages[1]).toEqual({ role: "user", content: "hello" });
    expect(back.messages[2]).toEqual({ role: "assistant", content: "hi" });
    expect(back.messages[3]).toEqual({ role: "user", content: "bye" });
  });
});
