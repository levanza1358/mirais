import type { Provider, ProviderAccount } from "../shared/types";
import { baseUrlFor } from "../proxy/router";
import { SseParser } from "../proxy/translator/stream";

export const CODEBUDDY_MODELS: Record<string, string[]> = {
  "codebuddy-global": [
    "claude-opus-4.7-1m", "claude-opus-4.6", "claude-sonnet-4.6", "claude-haiku-4.5",
    "glm-5.2", "glm-5.1", "glm-5.0", "glm-5.0-turbo", "glm-5v-turbo", "glm-4.7",
    "minimax-m3", "minimax-m2.7", "kimi-k2.7", "kimi-k2.6", "kimi-k2.5", "hy3-preview",
    "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2", "deepseek-v3-2-volc",
  ],
  "codebuddy-cn": [
    "kimi-k3", "glm-5.2", "glm-5.1", "glm-5.0", "glm-5.0-turbo", "glm-5v-turbo",
    "minimax-m3", "minimax-m2.7", "kimi-k2.7", "kimi-k2.6", "kimi-k2.5", "hy3-preview",
    "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2", "deepseek-v3-2-volc",
  ],
};

export function isCodeBuddyProviderType(type: string): boolean {
  return type === "codebuddy-global" || type === "codebuddy-cn";
}

export function codeBuddyChatUrl(provider: Provider): string {
  const base = baseUrlFor(provider);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function codeBuddyHeaders(account: ProviderAccount): Record<string, string> {
  return {
    "content-type": "application/json",
    Authorization: `Bearer ${account.api_key}`,
    "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    accept: "text/event-stream",
  };
}

export async function requestCodeBuddyChat(
  provider: Provider,
  account: ProviderAccount,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<Response> {
  return fetch(codeBuddyChatUrl(provider), {
    method: "POST",
    headers: codeBuddyHeaders(account),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [
        { role: "system", content: "You are a helpful AI assistant." },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
}

export async function readCodeBuddyPreviewFromSse(body: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
        if (!event.data || event.data === "[DONE]") continue;
        try {
          const payload = JSON.parse(event.data) as { choices?: Array<{ delta?: { content?: string | Array<{ type?: string; text?: string }>; reasoning_content?: string }; message?: { content?: string } }> };
          const delta = payload.choices?.[0]?.delta?.content;
          const reasoning = payload.choices?.[0]?.delta?.reasoning_content;
          if (typeof reasoning === "string") text += reasoning;
          if (typeof delta === "string") text += delta;
          else if (Array.isArray(delta)) text += delta.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text ?? "").join("");
          else if (typeof payload.choices?.[0]?.message?.content === "string") text += payload.choices[0].message.content;
          if (text.trim().length >= 32) break;
        } catch {
          // Ignore malformed chunks.
        }
      }
      if (text.trim().length >= 32) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 220) : undefined;
}
