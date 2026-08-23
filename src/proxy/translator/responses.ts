import type { z } from "zod";
import type { CanonicalRequest, CanonicalResponse, ChatMessage, Usage } from "../../shared/types";
import type { responsesCreateSchema } from "../../shared/schemas";
import { SseParser } from "./stream";
import { normalizeUsage } from "../promptCache";
import { ulid } from "../../utils/id";

export type ResponsesCreateRequest = z.infer<typeof responsesCreateSchema>;

export function responsesRequestToCanonical(input: ResponsesCreateRequest): CanonicalRequest {
  const messages: ChatMessage[] = [];
  if (input.instructions) messages.push({ role: "system", content: input.instructions });
  if (typeof input.input === "string") {
    messages.push({ role: "user", content: input.input });
  } else {
    for (const item of input.input) {
      if (item.type === "function_call") {
        messages.push({ role: "assistant", content: "", tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }] });
      } else if (item.type === "function_call_output") {
        messages.push({ role: "tool", content: item.output, tool_call_id: item.call_id });
      } else {
        const role = item.role === "developer" ? "system" : item.role;
        const content = typeof item.content === "string" ? item.content : item.content.map((part) => part.type === "input_image"
          ? { type: "image_url" as const, image_url: { url: part.image_url } }
          : { type: "text" as const, text: part.text });
        messages.push({ role, content });
      }
    }
  }
  return {
    model: input.model,
    messages,
    stream: input.stream,
    max_tokens: input.max_output_tokens,
    temperature: input.temperature,
    top_p: input.top_p,
    tools: input.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict } })),
    tool_choice: input.tool_choice,
    reasoning: input.reasoning,
    parallel_tool_calls: input.parallel_tool_calls,
    service_tier: input.service_tier,
    stream_options: input.stream ? { include_usage: true } : undefined,
    response_format: input.text?.format?.type === "json_object" ? { type: "json_object" }
      : input.text?.format?.type === "json_schema" ? { type: "json_schema", json_schema: { name: input.text.format.name, schema: input.text.format.schema, strict: input.text.format.strict } }
      : undefined,
  };
}

function usageToResponses(usage?: Usage | null) {
  return usage ? {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.completion_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.total_tokens,
  } : undefined;
}

export function canonicalResponseToResponses(response: CanonicalResponse, requestedModel: string) {
  const message = response.choices[0]?.message;
  const text = typeof message?.content === "string" ? message.content : "";
  const output: Array<Record<string, unknown>> = [];
  if (text || !message?.tool_calls?.length) {
    output.push({ id: `msg_${ulid()}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
  }
  for (const tool of message?.tool_calls ?? []) {
    output.push({ id: `fc_${ulid()}`, type: "function_call", status: "completed", call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments });
  }
  return {
    id: response.id.startsWith("resp_") ? response.id : `resp_${ulid()}`,
    object: "response",
    created_at: response.created,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: requestedModel,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    usage: usageToResponses(response.usage),
  };
}

export function chatSseToResponses(source: ReadableStream<Uint8Array>, requestedModel: string): { stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null> } {
  let resolveUsage: (usage: Usage | null) => void;
  const usagePromise = new Promise<Usage | null>((resolve) => { resolveUsage = resolve; });
  const responseId = `resp_${ulid()}`;
  let text = "";
  let usage: Usage | null = null;
  let reader: ReturnType<typeof source.getReader> | null = null;
  let sequence = 0;
  let message: { id: string; outputIndex: number } | null = null;
  const tools = new Map<number, { id: string; callId: string; name: string; arguments: string; outputIndex: number }>();
  const output: Array<Record<string, unknown>> = [];
  const encoder = new TextEncoder();
  const encodeEvent = (type: string, payload: Record<string, unknown>) =>
    encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const activeReader = source.getReader();
      reader = activeReader;
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const base = { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: requestedModel, output: [] };
      controller.enqueue(encodeEvent("response.created", { response: { ...base, status: "in_progress" } }));
      controller.enqueue(encodeEvent("response.in_progress", { response: { ...base, status: "in_progress" } }));
      const ensureMessage = () => {
        if (message) return message;
        message = { id: `msg_${ulid()}`, outputIndex: output.length };
        controller.enqueue(encodeEvent("response.output_item.added", { output_index: message.outputIndex, item: { id: message.id, type: "message", status: "in_progress", role: "assistant", content: [] } }));
        controller.enqueue(encodeEvent("response.content_part.added", { item_id: message.id, output_index: message.outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
        return message;
      };
      const consume = (parsed: { data: string }) => {
        if (parsed.data === "[DONE]") return;
        let chunk: Record<string, unknown>;
        try { chunk = JSON.parse(parsed.data) as Record<string, unknown>; } catch { return; }
        const u = normalizeUsage(chunk.usage);
        if (u) usage = u;
        const choices = chunk.choices as Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined;
        const delta = choices?.[0]?.delta;
        if (delta?.content) {
          const item = ensureMessage();
          text += delta.content;
          controller.enqueue(encodeEvent("response.output_text.delta", { item_id: item.id, output_index: item.outputIndex, content_index: 0, delta: delta.content }));
        }
        for (const call of delta?.tool_calls ?? []) {
          let tool = tools.get(call.index);
          if (!tool) {
            tool = { id: `fc_${ulid()}`, callId: call.id ?? `call_${ulid()}`, name: call.function?.name ?? "", arguments: "", outputIndex: output.length + (message ? 1 : 0) + tools.size };
            tools.set(call.index, tool);
            controller.enqueue(encodeEvent("response.output_item.added", { output_index: tool.outputIndex, item: { id: tool.id, type: "function_call", status: "in_progress", call_id: tool.callId, name: tool.name, arguments: "" } }));
          }
          if (call.id) tool.callId = call.id;
          if (call.function?.name) tool.name += call.function.name;
          if (call.function?.arguments) {
            tool.arguments += call.function.arguments;
            controller.enqueue(encodeEvent("response.function_call_arguments.delta", { item_id: tool.id, output_index: tool.outputIndex, delta: call.function.arguments }));
          }
        }
      };
      try {
        for (;;) {
          const { done, value } = await activeReader.read();
          if (done) break;
          for (const parsed of parser.feed(decoder.decode(value, { stream: true }))) consume(parsed);
        }
        for (const parsed of parser.feed(decoder.decode())) consume(parsed);
        for (const parsed of parser.finish()) consume(parsed);
        if (message) {
          const part = { type: "output_text", text, annotations: [] };
          const item = { id: message.id, type: "message", status: "completed", role: "assistant", content: [part] };
          output[message.outputIndex] = item;
          controller.enqueue(encodeEvent("response.output_text.done", { item_id: message.id, output_index: message.outputIndex, content_index: 0, text }));
          controller.enqueue(encodeEvent("response.content_part.done", { item_id: message.id, output_index: message.outputIndex, content_index: 0, part }));
          controller.enqueue(encodeEvent("response.output_item.done", { output_index: message.outputIndex, item }));
        }
        for (const tool of [...tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
          const item = { id: tool.id, type: "function_call", status: "completed", call_id: tool.callId, name: tool.name, arguments: tool.arguments };
          output[tool.outputIndex] = item;
          controller.enqueue(encodeEvent("response.function_call_arguments.done", { item_id: tool.id, output_index: tool.outputIndex, arguments: tool.arguments }));
          controller.enqueue(encodeEvent("response.output_item.done", { output_index: tool.outputIndex, item }));
        }
        controller.enqueue(encodeEvent("response.completed", { response: { ...base, status: "completed", output: output.filter(Boolean), usage: usageToResponses(usage) } }));
      } catch (error) {
        controller.error(error);
      } finally {
        resolveUsage!(usage);
        activeReader.releaseLock();
        reader = null;
        try { controller.close(); } catch { /* already errored */ }
      }
    },
    async cancel(reason) {
      resolveUsage!(usage);
      await reader?.cancel(reason);
    },
  });
  return { stream, usagePromise };
}
