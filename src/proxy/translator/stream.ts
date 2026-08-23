import { ulid } from "../../utils/id";
import type { Usage } from "../../shared/types";
import { cacheTokensFrom } from "../promptCache";

// ── Anthropic SSE stream → OpenAI chat.completion.chunk SSE lines ──
// State machine over Anthropic event types: message_start, content_block_start,
// content_block_delta, content_block_stop, message_delta, message_stop, ping.

export interface StreamResult {
  usage: Usage | null;
  finishReason: string | null;
}

export class AnthropicToOpenAIStreamTranslator {
  private id = `chatcmpl-${ulid()}`;
  private created = Math.floor(Date.now() / 1000);
  private model: string;
  private started = false;
  private toolIndex = -1;
  private toolBlocks: Array<{ id: string; name: string }> = [];
  private usage: Usage | null = null;
  private finishReason: string | null = null;

  constructor(requestedModel: string) {
    this.model = requestedModel;
  }

  /** Returns array of SSE data lines to emit (each already `data: ...\n\n`). */
  handleEvent(event: string, data: string): string[] {
    const out: string[] = [];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return out;
    }

    switch (event) {
      case "message_start": {
        const msg = parsed.message as Record<string, unknown> | undefined;
        const usageIn = msg?.usage as Record<string, number> | undefined;
        if (usageIn) {
          this.usage = {
            prompt_tokens: usageIn.input_tokens ?? 0,
            completion_tokens: usageIn.output_tokens ?? 0,
            total_tokens: (usageIn.input_tokens ?? 0) + (usageIn.output_tokens ?? 0),
            ...cacheTokensFrom(usageIn),
          };
        }
        if (msg?.id) this.id = `chatcmpl-${msg.id as string}`;
        out.push(this.chunk({ role: "assistant", content: "" }, null));
        this.started = true;
        break;
      }
      case "content_block_start": {
        const block = parsed.content_block as Record<string, unknown>;
        if (block.type === "tool_use") {
          this.toolIndex += 1;
          this.toolBlocks.push({ id: block.id as string, name: block.name as string });
          out.push(
            this.chunk({
              tool_calls: [{
                index: this.toolIndex,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: "" },
              }],
            }, null),
          );
        }
        break;
      }
      case "content_block_delta": {
        const delta = parsed.delta as Record<string, unknown>;
        if (delta.type === "text_delta") {
          out.push(this.chunk({ content: delta.text as string }, null));
        } else if (delta.type === "input_json_delta") {
          out.push(
            this.chunk({
              tool_calls: [{ index: Math.max(this.toolIndex, 0), function: { arguments: delta.partial_json as string } }],
            }, null),
          );
        }
        break;
      }
      case "message_delta": {
        const delta = parsed.delta as Record<string, unknown>;
        const stopReason = delta.stop_reason as string | null;
        if (stopReason) {
          this.finishReason =
            stopReason === "end_turn" ? "stop"
            : stopReason === "max_tokens" ? "length"
            : stopReason === "tool_use" ? "tool_calls"
            : "stop";
        }
        const usageIn = parsed.usage as Record<string, number> | undefined;
        if (usageIn && this.usage) {
          this.usage.completion_tokens = usageIn.output_tokens ?? this.usage.completion_tokens;
          this.usage.total_tokens = this.usage.prompt_tokens + this.usage.completion_tokens;
        }
        break;
      }
      case "message_stop": {
        const finalDelta: Record<string, unknown> = {};
        out.push(this.chunk(finalDelta, this.finishReason ?? "stop", this.usage ?? undefined));
        out.push("data: [DONE]\n\n");
        break;
      }
      default:
        // content_block_stop, ping → ignore
        break;
    }
    return out;
  }

  result(): StreamResult {
    return { usage: this.usage, finishReason: this.finishReason };
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null, usage?: Usage): string {
    const obj: Record<string, unknown> = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) obj.usage = usage;
    return `data: ${JSON.stringify(obj)}\n\n`;
  }
}

// ── OpenAI SSE stream → Anthropic SSE lines ──

export class OpenAIToAnthropicStreamTranslator {
  private messageId = `msg_${ulid().replace(/-/g, "")}`;
  private model: string;
  private sentStart = false;
  private textBlockIndex = 0;
  private textBlockOpen = false;
  private toolBlockIndex = 0;
  private openToolBlocks = new Map<number, { id: string; started: boolean }>();
  private usage: Usage | null = null;
  private stopReason = "end_turn";

  constructor(requestedModel: string) {
    this.model = requestedModel;
  }

  handleData(data: string): string[] {
    const out: string[] = [];
    if (data === "[DONE]") {
      out.push(...this.finish());
      return out;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return out;
    }

    if (!this.sentStart) {
      out.push(this.sse("message_start", {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
      this.sentStart = true;
    }

    const usageIn = chunk.usage as Record<string, number> | undefined;
    if (usageIn) {
      this.usage = {
        prompt_tokens: usageIn.prompt_tokens ?? 0,
        completion_tokens: usageIn.completion_tokens ?? 0,
        total_tokens: (usageIn.prompt_tokens ?? 0) + (usageIn.completion_tokens ?? 0),
        ...cacheTokensFrom(usageIn),
      };
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return out;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const finish = choice.finish_reason as string | null;
    if (finish) {
      this.stopReason = finish === "length" ? "max_tokens" : finish === "tool_calls" ? "tool_use" : "end_turn";
    }

    const content = delta.content as string | undefined;
    if (content) {
      if (!this.textBlockOpen) {
        out.push(this.sse("content_block_start", {
          type: "content_block_start",
          index: this.textBlockIndex,
          content_block: { type: "text", text: "" },
        }));
        this.textBlockOpen = true;
      }
      out.push(this.sse("content_block_delta", {
        type: "content_block_delta",
        index: this.textBlockIndex,
        delta: { type: "text_delta", text: content },
      }));
    }

    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    for (const tc of toolCalls ?? []) {
      const index = (tc.index as number) ?? 0;
      let state = this.openToolBlocks.get(index);
      if (!state) {
        state = { id: (tc.id as string) ?? `toolu_${ulid().replace(/-/g, "")}`, started: false };
        this.openToolBlocks.set(index, state);
        this.toolBlockIndex += 1;
      }
      const anthropicIndex = this.textBlockOpen ? this.textBlockIndex + 1 + index : index;
      if (!state.started) {
        if (this.textBlockOpen) {
          out.push(this.sse("content_block_stop", { type: "content_block_stop", index: this.textBlockIndex }));
          this.textBlockOpen = false;
        }
        const fn = tc.function as Record<string, unknown> | undefined;
        out.push(this.sse("content_block_start", {
          type: "content_block_start",
          index: anthropicIndex,
          content_block: { type: "tool_use", id: state.id, name: fn?.name ?? "" },
        }));
        state.started = true;
      }
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn?.arguments) {
        out.push(this.sse("content_block_delta", {
          type: "content_block_delta",
          index: anthropicIndex,
          delta: { type: "input_json_delta", partial_json: fn.arguments },
        }));
      }
    }

    if (finish) {
      out.push(...this.finish());
    }
    return out;
  }

  private finish(): string[] {
    const out: string[] = [];
    if (!this.sentStart) {
      out.push(this.sse("message_start", {
        type: "message_start",
        message: {
          id: this.messageId, type: "message", role: "assistant", model: this.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
      this.sentStart = true;
    }
    if (this.textBlockOpen) {
      out.push(this.sse("content_block_stop", { type: "content_block_stop", index: this.textBlockIndex }));
      this.textBlockOpen = false;
    }
    let i = 0;
    for (const [idx, state] of this.openToolBlocks) {
      if (state.started) {
        const anthropicIndex = 1 + idx + i * 0; // already emitted; just stop blocks
        out.push(this.sse("content_block_stop", { type: "content_block_stop", index: anthropicIndex }));
      }
      i += 1;
    }
    out.push(this.sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage?.completion_tokens ?? 0 },
    }));
    if (this.usage) {
      // Anthropic message_start already sent usage 0; final usage comes via message_delta output_tokens.
    }
    out.push(this.sse("message_stop", { type: "message_stop" }));
    return out;
  }

  result(): StreamResult {
    return { usage: this.usage, finishReason: this.stopReason };
  }

  private sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

// ── SSE line parser (incremental) ──
export class SseParser {
  private buffer = "";

  feed(chunk: string): Array<{ event: string; data: string }> {
    this.buffer += chunk;
    const events: Array<{ event: string; data: string }> = [];
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(this.buffer)) !== null) {
      const raw = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) events.push({ event, data: dataLines.join("\n") });
    }
    return events;
  }

  finish(): Array<{ event: string; data: string }> {
    if (!this.buffer.trim()) { this.buffer = ""; return []; }
    return this.feed("\n\n");
  }
}
