import { ulid } from "../../utils/id";
import { SseParser } from "./stream";

type OpenAiChunk = Record<string, unknown>;

const markerBody = String.raw`(?:\|\s*\||｜\s*｜|\|)\s*DSML\s*(?:\|\s*\||｜\s*｜|\|)`;
const marker = String.raw`<\s*${markerBody}\s*>`;
const closingMarker = String.raw`<\s*/\s*${markerBody}\s*>`;
const toolCallsStart = new RegExp(`${marker}\\s*<\\s*tool_calls\\s*>`, "i");
const toolCallsEnd = new RegExp(`${closingMarker}\\s*<\\s*tool_calls\\s*>`, "i");
const compactToolCallsEnd = new RegExp(`<\\s*/\\s*${markerBody}\\s*tool_calls\\s*>`, "i");
const closingTag = new RegExp(`${closingMarker}\\s*<\\s*([a-z_][\\w-]*)\\s*>`, "gi");
const openingTag = new RegExp(`${marker}\\s*<\\s*([a-z_][\\w-]*)([^>]*)>`, "gi");
const compactClosingTag = new RegExp(`<\\s*/\\s*${markerBody}\\s*([a-z_][\\w-]*)\\s*>`, "gi");
const invoke = /<\s*invoke\s+name\s*=\s*(["'])([^"']+)\1\s*>([\s\S]*?)<\s*\/\s*invoke\s*>/gi;
const parameter = /<\s*parameter\s+name\s*=\s*(["'])([^"']+)\1(?:\s+[^>]*)?>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;

function decodeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ?? entity);
}

function parseToolCalls(block: string): Array<{ name: string; arguments: string }> {
  const calls: Array<{ name: string; arguments: string }> = [];
  const normalized = block
    .replace(compactClosingTag, "</$1>")
    .replace(closingTag, "</$1>")
    .replace(openingTag, "<$1$2>");
  for (const match of normalized.matchAll(invoke)) {
    const [, , name, body] = match;
    if (!name || body === undefined) throw new Error("DSML invoke is missing a function name");
    const args: Record<string, string> = {};
    for (const parameterMatch of body.matchAll(parameter)) {
      const [, , parameterName, value] = parameterMatch;
      if (!parameterName || value === undefined || Object.hasOwn(args, parameterName)) {
        throw new Error("DSML invoke has an invalid parameter");
      }
      args[parameterName] = decodeXml(value);
    }
    if (body.replace(parameter, "").trim()) throw new Error("DSML invoke contains unsupported content");
    calls.push({ name, arguments: JSON.stringify(args) });
  }
  if (!calls.length || normalized.replace(invoke, "").trim()) throw new Error("DSML tool_calls contains malformed invoke markup");
  return calls;
}

/** Convert raw DeepSeek DSML text deltas into OpenAI Chat Completions tool calls. */
export function dsmlToOpenAiStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = new SseParser();
  let textBuffer = "";
  let dsmlBuffer: string | null = null;
  let sawToolCalls = false;
  let failed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: string) => controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      const protocolError = (message: string) => {
        if (failed) return;
        failed = true;
        emit(JSON.stringify({ error: { message: `Malformed DSML tool call: ${message}`, type: "server_error", code: "dsml_parse_error" } }));
        emit("[DONE]");
      };
      const emitChunk = (chunk: OpenAiChunk, delta: Record<string, unknown>, finishReason: string | null) => {
        const choices = chunk.choices as Array<Record<string, unknown>>;
        emit(JSON.stringify({ ...chunk, choices: [{ ...choices[0], delta, finish_reason: finishReason }] }));
      };
      const emitText = (chunk: OpenAiChunk, text: string) => {
        if (text) emitChunk(chunk, { content: text }, null);
      };
      const processText = (chunk: OpenAiChunk, content: string) => {
        if (failed) return;
        if (dsmlBuffer !== null) {
          dsmlBuffer += content;
        } else {
          textBuffer += content;
          const start = textBuffer.search(toolCallsStart);
          if (start === -1) {
            const keep = Math.min(textBuffer.length, 48);
            emitText(chunk, textBuffer.slice(0, -keep));
            textBuffer = textBuffer.slice(-keep);
            return;
          }
          emitText(chunk, textBuffer.slice(0, start));
          dsmlBuffer = textBuffer.slice(start);
          textBuffer = "";
        }
        const bufferedDsml = dsmlBuffer;
        const endings = [toolCallsEnd, compactToolCallsEnd]
          .map((expression) => ({ expression, index: bufferedDsml.search(expression) }))
          .filter((entry) => entry.index >= 0)
          .sort((a, b) => a.index - b.index);
        const ending = endings[0];
        if (!ending) return;
        const end = ending.index;
        const match = ending.expression.exec(bufferedDsml);
        if (!match) return;
        const block = bufferedDsml.slice(0, end + match[0].length);
        const tail = bufferedDsml.slice(end + match[0].length);
        dsmlBuffer = null;
        try {
          const body = block.replace(toolCallsStart, "").replace(ending.expression, "");
          for (const [index, call] of parseToolCalls(body).entries()) {
            emitChunk(chunk, {
              tool_calls: [{ index, id: `call_${ulid()}`, type: "function", function: { name: call.name, arguments: "" } }],
            }, null);
            for (let offset = 0; offset < call.arguments.length; offset += 32) {
              emitChunk(chunk, { tool_calls: [{ index, function: { arguments: call.arguments.slice(offset, offset + 32) } }] }, null);
            }
          }
          sawToolCalls = true;
        } catch (error) {
          protocolError(error instanceof Error ? error.message : "invalid markup");
          return;
        }
        if (tail) processText(chunk, tail);
      };
      const processEvent = (data: string) => {
        if (failed || data === "[DONE]") return;
        let chunk: OpenAiChunk;
        try { chunk = JSON.parse(data) as OpenAiChunk; } catch { emit(data); return; }
        const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        const delta = choice?.delta as Record<string, unknown> | undefined;
        if (!choice || !delta) { emit(data); return; }
        if (typeof delta.content !== "string") {
          if (choice.finish_reason && (dsmlBuffer !== null || textBuffer || sawToolCalls)) {
            if (dsmlBuffer !== null) protocolError("missing tool_calls closing tag");
            else {
              emitText(chunk, textBuffer);
              textBuffer = "";
              emitChunk(chunk, delta, sawToolCalls ? "tool_calls" : choice.finish_reason as string | null);
            }
            return;
          }
          emit(data);
          return;
        }
        const { content: _content, ...rest } = delta;
        if (Object.keys(rest).length) emitChunk(chunk, rest, choice.finish_reason as string | null);
        processText(chunk, delta.content);
        if (choice.finish_reason) {
          if (dsmlBuffer !== null) protocolError("missing tool_calls closing tag");
          else {
            emitText(chunk, textBuffer);
            textBuffer = "";
            emitChunk(chunk, {}, sawToolCalls ? "tool_calls" : choice.finish_reason as string | null);
          }
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.feed(decoder.decode(value, { stream: true }))) processEvent(event.data);
        }
        for (const event of parser.feed(decoder.decode())) processEvent(event.data);
        for (const event of parser.finish()) processEvent(event.data);
        if (!failed) {
          if (dsmlBuffer !== null) protocolError("missing tool_calls closing tag");
          else if (textBuffer) protocolError("stream ended before a completion chunk");
          else emit("[DONE]");
        }
      } catch (error) {
        protocolError(error instanceof Error ? error.message : "stream failure");
      } finally {
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}