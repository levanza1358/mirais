import type { CanonicalRequest, ChatMessage, MessageContent } from "../../shared/types";

// ── Canonical (OpenAI) → Anthropic Messages request ──

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<Record<string, unknown>>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
}

function contentToAnthropic(content: MessageContent): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: (part as { text: string }).text });
    } else if (part.type === "image_url") {
      const url = (part as { image_url: { url: string } }).image_url.url;
      // data:image/png;base64,xxx
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (m) {
        blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    } else if (part.type === "tool_result") {
      const p = part as unknown as { tool_use_id: string; content: string };
      blocks.push({ type: "tool_result", tool_use_id: p.tool_use_id, content: p.content });
    } else {
      blocks.push(part as Record<string, unknown>);
    }
  }
  return blocks;
}

function messageToAnthropic(msg: ChatMessage): AnthropicMessage {
  const role = msg.role === "assistant" ? "assistant" : "user";
  if (msg.role === "tool") {
    // OpenAI tool message → user message with tool_result block
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: msg.tool_call_id ?? "", content: typeof msg.content === "string" ? msg.content : "" }],
    };
  }
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    const blocks: Array<Record<string, unknown>> = [];
    if (typeof msg.content === "string" && msg.content) blocks.push({ type: "text", text: msg.content });
    for (const tc of msg.tool_calls) {
      let input: unknown = {};
      try { input = JSON.parse(tc.function.arguments); } catch { /* keep empty */ }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
    return { role: "assistant", content: blocks };
  }
  return { role, content: contentToAnthropic(msg.content ?? "") };
}

export function openaiToAnthropicRequest(req: CanonicalRequest, modelId: string): AnthropicRequest {
  const system: Array<Record<string, unknown>> = [];
  const messages: AnthropicMessage[] = [];

  for (const msg of req.messages) {
    if (msg.role === "system" || (msg.role as string) === "developer") {
      if (typeof msg.content === "string") {
        system.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") system.push({ type: "text", text: (part as { text: string }).text });
        }
      }
      continue;
    }
    messages.push(messageToAnthropic(msg));
  }

  const out: AnthropicRequest = {
    model: modelId,
    max_tokens: req.max_tokens ?? 4096,
    messages,
  };
  if (system.length) out.system = system;
  if (req.stream !== undefined) out.stream = req.stream;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
  }
  if (req.tool_choice !== undefined) {
    const tc = req.tool_choice;
    if (typeof tc === "string") {
      out.tool_choice = tc === "required" ? { type: "any" } : tc === "auto" ? { type: "auto" } : { type: tc };
    } else if (tc && typeof tc === "object" && "function" in (tc as Record<string, unknown>)) {
      const name = ((tc as { function: { name: string } }).function.name);
      out.tool_choice = { type: "tool", name };
    } else {
      out.tool_choice = tc;
    }
  }
  return out;
}

// ── Anthropic Messages request → Canonical (OpenAI) ──

export function anthropicToOpenaiRequest(body: Record<string, unknown>): CanonicalRequest {
  const messages: ChatMessage[] = [];

  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = (body.system as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  for (const m of body.messages as Array<{ role: string; content: unknown }>) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role as "user" | "assistant", content: m.content });
      continue;
    }
    const blocks = m.content as Array<Record<string, unknown>>;
    if (m.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
      for (const b of blocks) {
        if (b.type === "text") textParts.push(b.text as string);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id as string,
            type: "function",
            function: { name: b.name as string, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg: ChatMessage = { role: "assistant", content: textParts.join("") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    // user message
    const parts: Array<Record<string, unknown>> = [];
    const toolResults: ChatMessage[] = [];
    for (const b of blocks) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") {
        const src = b.source as Record<string, unknown>;
        if (src?.type === "base64") {
          parts.push({ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } });
        } else if (src?.type === "url") {
          parts.push({ type: "image_url", image_url: { url: src.url } });
        }
      } else if (b.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: b.tool_use_id as string,
          content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
        });
      } else {
        parts.push(b);
      }
    }
    if (parts.length) {
      messages.push({ role: "user", content: parts as MessageContent });
    }
    messages.push(...toolResults);
  }

  const out: CanonicalRequest = {
    model: body.model as string,
    messages,
  };
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens as number;
  if (body.stream !== undefined) out.stream = body.stream as boolean;
  if (body.temperature !== undefined) out.temperature = body.temperature as number;
  if (body.top_p !== undefined) out.top_p = body.top_p as number;
  if (body.stop_sequences !== undefined) out.stop = body.stop_sequences as string[];
  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as Array<Record<string, unknown>>).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name as string,
        description: t.description as string | undefined,
        parameters: t.input_schema as Record<string, unknown> | undefined,
      },
    }));
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice as Record<string, unknown>;
    if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
    else out.tool_choice = tc.type as string;
  }
  return out;
}
