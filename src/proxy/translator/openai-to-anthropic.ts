import { ulid } from "../../utils/id";
import type { CanonicalResponse, Usage, ChatMessage, ToolCall } from "../../shared/types";

// ── Anthropic Messages response → Canonical (OpenAI) response ──

export function anthropicToOpenaiResponse(body: Record<string, unknown>, requestedModel: string): CanonicalResponse {
  const blocks = (body.content as Array<Record<string, unknown>>) ?? [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type === "text") textParts.push((b.text as string) ?? "");
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: (b.id as string) ?? `call_${ulid()}`,
        type: "function",
        function: { name: (b.name as string) ?? "", arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }

  const message: ChatMessage = { role: "assistant", content: textParts.join("") };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usageIn = body.usage as Record<string, number> | undefined;
  const usage: Usage | undefined = usageIn
    ? {
        prompt_tokens: usageIn.input_tokens ?? 0,
        completion_tokens: usageIn.output_tokens ?? 0,
        total_tokens: (usageIn.input_tokens ?? 0) + (usageIn.output_tokens ?? 0),
      }
    : undefined;

  const stopReason = body.stop_reason as string | null;
  const finish = stopReason === "end_turn" ? "stop"
    : stopReason === "max_tokens" ? "length"
    : stopReason === "tool_use" ? "tool_calls"
    : stopReason === "stop_sequence" ? "stop"
    : stopReason ?? "stop";

  return {
    id: (body.id as string) ?? `chatcmpl-${ulid()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

// ── Canonical (OpenAI) response → Anthropic Messages response ──

export function openaiToAnthropicResponse(resp: CanonicalResponse): Record<string, unknown> {
  const choice = resp.choices[0];
  const content: Array<Record<string, unknown>> = [];
  if (choice?.message.content && typeof choice.message.content === "string") {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const tc of choice?.message.tool_calls ?? []) {
    let input: unknown = {};
    try { input = JSON.parse(tc.function.arguments); } catch { /* empty */ }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }

  const finish = choice?.finish_reason;
  const stopReason = finish === "length" ? "max_tokens" : finish === "tool_calls" ? "tool_use" : "end_turn";

  return {
    id: `msg_${ulid().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: resp.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}
