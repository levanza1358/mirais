import { describe, expect, test } from "bun:test";
import { dsmlToOpenAiStream } from "../src/proxy/translator/dsml";

function upstream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(typeof event === "string" ? event : `data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
}

async function readEvents(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown> | "[DONE]">> {
  const text = await new Response(stream).text();
  return text.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
    return !data ? [] : [data === "[DONE]" ? data : JSON.parse(data) as Record<string, unknown>];
  });
}

function chunk(content: string, finishReason: string | null = null) {
  return { id: "chatcmpl_upstream", object: "chat.completion.chunk", created: 1, model: "upstream", choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] };
}

function finish() {
  return { id: "chatcmpl_upstream", object: "chat.completion.chunk", created: 1, model: "upstream", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}

function toolCalls(events: Array<Record<string, unknown> | "[DONE]">): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    if (event === "[DONE]") return [];
    const choices = event.choices as Array<{ delta?: { tool_calls?: Array<Record<string, unknown>> } }> | undefined;
    return choices?.[0]?.delta?.tool_calls ?? [];
  });
}

describe("OpenAI chat DSML tool-call compatibility", () => {
  test("converts one DSML tool call to OpenAI SSE", async () => {
    const events = await readEvents(dsmlToOpenAiStream(upstream([chunk('<|DSML|><tool_calls><|DSML|><invoke name="run_command"><|DSML|><parameter name="command" string="true">go build ./...</|DSML|><parameter></|DSML|><invoke></|DSML|><tool_calls>'), finish(), "data: [DONE]\n\n"])));
    const calls = toolCalls(events);
    expect(calls[0]).toMatchObject({ index: 0, id: expect.stringMatching(/^call_/), type: "function", function: { name: "run_command", arguments: "" } });
    expect(calls.map((call) => (call.function as { arguments?: string }).arguments ?? "").join("")).toBe('{"command":"go build ./..."}');
    expect((events.at(-2) as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason).toBe("tool_calls");
    expect(events.at(-1)).toBe("[DONE]");
  });

  test("handles DSML and arguments fragmented across SSE chunks", async () => {
    const events = await readEvents(dsmlToOpenAiStream(upstream([chunk("<|DSML|><tool_calls><|DSML|><invoke name=\"run_command\"><|DSML|><parameter name=\"command\" string=\"true\">go "), chunk("build ./... with a deliberately long argument</|DSML|><parameter></|DSML|><invoke></|DSML|><tool_calls>"), finish(), "data: [DONE]\n\n"])));
    const calls = toolCalls(events);
    const argumentDeltas = calls.map((call) => (call.function as { arguments?: string }).arguments ?? "").filter(Boolean);
    expect(argumentDeltas.length).toBeGreaterThan(1);
    expect(JSON.parse(argumentDeltas.join(""))).toEqual({ command: "go build ./... with a deliberately long argument" });
  });

  test("converts multiple tool calls and preserves preceding assistant text", async () => {
    const events = await readEvents(dsmlToOpenAiStream(upstream([chunk('I will inspect first. <|DSML|><tool_calls><|DSML|><invoke name="list"><|DSML|><parameter name="path" string="true">.</|DSML|><parameter></|DSML|><invoke><|DSML|><invoke name="read"><|DSML|><parameter name="path" string="true">README.md</|DSML|><parameter></|DSML|><invoke></|DSML|><tool_calls>'), finish(), "data: [DONE]\n\n"])));
    const content = events.flatMap((event) => {
      if (event === "[DONE]") return [];
      const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
      return [choices?.[0]?.delta?.content ?? ""];
    }).join("");
    expect(content).toBe("I will inspect first. ");
    expect(toolCalls(events).filter((call) => "id" in call)).toHaveLength(2);
  });

  test("accepts a matching assistant tool call and tool result continuation", async () => {
    const request = {
      model: "test", stream: true, tools: [{ type: "function", function: { name: "run_command" } }], messages: [
        { role: "user", content: "build" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"go build ./..."}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    };
    const response = await readEvents(dsmlToOpenAiStream(upstream([chunk("Build passed."), finish(), "data: [DONE]\n\n"])));
    expect(request.messages[1]?.tool_calls?.[0]?.id).toBe(request.messages[2]?.tool_call_id);
    expect(response.some((event) => event !== "[DONE]" && (event.choices as Array<{ delta: { content?: string } }>)[0]?.delta.content === "Build passed.")).toBe(true);
  });

  test("returns protocol error for malformed DSML without a successful tool call", async () => {
    const events = await readEvents(dsmlToOpenAiStream(upstream([chunk('<|DSML|><tool_calls><|DSML|><invoke name="run_command">'), finish(), "data: [DONE]\n\n"])));
    expect(toolCalls(events)).toHaveLength(0);
    expect(events.some((event) => event !== "[DONE]" && (event.error as { code?: string } | undefined)?.code === "dsml_parse_error")).toBe(true);
    expect(events.at(-1)).toBe("[DONE]");
  });
});