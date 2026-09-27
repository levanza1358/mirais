import { describe, expect, test } from "bun:test";
import { anthropicToOpenaiRequest, openaiToAnthropicRequest } from "../src/proxy/translator/anthropic-to-openai";
import { AnthropicToOpenAIStreamTranslator, OpenAIToAnthropicStreamTranslator } from "../src/proxy/translator/stream";
import { normalizeUsage } from "../src/proxy/promptCache";
import { clampReasoningTokens } from "../src/proxy/executor";
import { xaiChatCompletionsBody, xaiRequestBody, normalizeEffort } from "../src/proxy/xai";
import type { CanonicalRequest } from "../src/shared/types";
import type { RouteCandidate } from "../src/shared/types";

function candidate(name: string, modelId: string): RouteCandidate {
  return {
    provider: { id: `p_${name}`, name, display_name: name, type: name as never, base_url: null, enabled: 1, priority: 0, account_strategy: "priority", created_at: "", updated_at: "" },
    modelId,
    accounts: [],
  };
}

describe("Anthropic Messages → canonical reasoning", () => {
  test("thinking:enabled maps to canonical reasoning with budget", () => {
    const out = anthropicToOpenaiRequest({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      messages: [{ role: "user", content: "ping" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
    expect(out.reasoning?.enabled).toBe(true);
    expect(out.reasoning?.budget_tokens).toBe(4096);
    expect(out.reasoning?.thinking?.type).toBe("enabled");
  });

  test("thinking:adaptive maps to canonical reasoning with type adaptive", () => {
    const out = anthropicToOpenaiRequest({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      messages: [{ role: "user", content: "ping" }],
      thinking: { type: "adaptive" },
    });
    expect(out.reasoning?.enabled).toBe(true);
    expect(out.reasoning?.thinking?.type).toBe("adaptive");
  });
});

describe("canonical reasoning → Anthropic request", () => {
  test("enabled=false strips thinking but keeps temperature", () => {
    const out = openaiToAnthropicRequest({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1024,
      temperature: 0.4,
      reasoning: { enabled: false },
    } as CanonicalRequest, "claude-opus-4-7");
    expect((out as { thinking?: unknown }).thinking).toBeUndefined();
    expect((out as { temperature?: number }).temperature).toBe(0.4);
  });

  test("type:adaptive emits thinking without budget_tokens", () => {
    const out = openaiToAnthropicRequest({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 4096,
      reasoning: { thinking: { type: "adaptive" } },
    } as CanonicalRequest, "claude-opus-4-7");
    expect((out as { thinking?: { type: string; budget_tokens?: number } }).thinking).toEqual({ type: "adaptive" });
  });

  test("explicit budget wins over default", () => {
    const out = openaiToAnthropicRequest({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 4096,
      reasoning: { budget_tokens: 12000 },
    } as CanonicalRequest, "claude-opus-4-7");
    expect((out as { thinking?: { type: string; budget_tokens: number } }).thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
  });
});

describe("xAI reasoning effort mapping", () => {
  test("minimal collapses to low", () => {
    expect(normalizeEffort("minimal")).toBe("low");
  });
  test("max collapses to xhigh", () => {
    expect(normalizeEffort("max")).toBe("xhigh");
  });
  test("unknown falls back to high", () => {
    expect(normalizeEffort("gibberish")).toBe("high");
  });
  test("grok-4.5 honours client effort", () => {
    const body = xaiChatCompletionsBody({
      model: "grok-4.5",
      messages: [{ role: "user", content: "ping" }],
      reasoning: { effort: "low" },
    } as CanonicalRequest, "grok-4.5");
    expect((body as { reasoning_effort?: string }).reasoning_effort).toBe("low");
  });
  test("non-Grok-4.5 models skip reasoning_effort", () => {
    const body = xaiChatCompletionsBody({
      model: "grok-build",
      messages: [{ role: "user", content: "ping" }],
      reasoning: { effort: "high" },
    } as CanonicalRequest, "grok-build");
    expect((body as { reasoning_effort?: string }).reasoning_effort).toBeUndefined();
  });
  test("Responses body uses client's effort for grok-4.5", () => {
    const body = xaiRequestBody({
      model: "grok-4.5",
      messages: [{ role: "user", content: "ping" }],
      reasoning: { effort: "medium" },
    } as CanonicalRequest, "grok-4.5");
    const reasoning = (body as { reasoning?: { effort?: string; summary?: string } }).reasoning;
    expect(reasoning?.summary).toBe("concise");
    expect(reasoning?.effort).toBe("medium");
    expect((body as { include?: string[] }).include).toContain("reasoning.encrypted_content");
  });
  test("enabled=false omits reasoning and include", () => {
    const body = xaiRequestBody({
      model: "grok-4.5",
      messages: [{ role: "user", content: "ping" }],
      reasoning: { enabled: false },
    } as CanonicalRequest, "grok-4.5");
    expect((body as { reasoning?: unknown }).reasoning).toBeUndefined();
    expect((body as { include?: unknown }).include).toBeUndefined();
  });
});

describe("normalizeUsage reasoning_tokens", () => {
  test("Responses output_tokens_details.reasoning_tokens", () => {
    const u = normalizeUsage({
      input_tokens: 100,
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 23 },
    });
    expect(u?.reasoning_tokens).toBe(23);
  });
  test("absent reasoning_tokens leaves field undefined", () => {
    const u = normalizeUsage({ prompt_tokens: 1, completion_tokens: 1 });
    expect(u?.reasoning_tokens).toBeUndefined();
  });
});

describe("clampReasoningTokens", () => {
  const cand = candidate("anthropic", "claude-opus-4-7");
  test("clamps against global ceiling", async () => {
    const req: CanonicalRequest = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "ping" }],
      reasoning: { budget_tokens: 1_000_000 },
    };
    const out = await clampReasoningTokens(req, cand, 8192);
    expect(out.reasoning?.budget_tokens).toBe(8192);
  });
  test("enabled=false leaves request untouched", async () => {
    const req: CanonicalRequest = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "ping" }],
      reasoning: { enabled: false, budget_tokens: 1_000_000 },
    };
    const out = await clampReasoningTokens(req, cand, 8192);
    expect(out.reasoning?.budget_tokens).toBe(1_000_000);
  });
});

describe("Anthropic → OpenAI stream reasoning", () => {
  test("thinking_delta translates to delta.reasoning_content", () => {
    const t = new AnthropicToOpenAIStreamTranslator("claude-opus-4-7");
    const startChunk = JSON.stringify({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-4-7", content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
    const blockStart = JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
    const thinkingDelta = JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "plan:" } });
    t.handleEvent("message_start", startChunk);
    t.handleEvent("content_block_start", blockStart);
    const out = t.handleEvent("content_block_delta", thinkingDelta);
    expect(out.join("")).toContain('"reasoning_content":"plan:"');
  });
});

describe("OpenAI → Anthropic stream reasoning", () => {
  test("reasoning_content emits a thinking block", () => {
    const t = new OpenAIToAnthropicStreamTranslator("gpt-5.2");
    const chunk = JSON.stringify({
      choices: [{ delta: { reasoning_content: "let's see" } }],
    });
    const out = t.handleData(chunk);
    expect(out.join("")).toContain('"type":"content_block_start"');
    expect(out.join("")).toContain('"type":"thinking"');
    expect(out.join("")).toContain('"type":"thinking_delta"');
  });
});