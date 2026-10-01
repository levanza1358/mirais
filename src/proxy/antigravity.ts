import crypto from "node:crypto";
import type { CanonicalRequest, CanonicalResponse, ProviderAccount, Usage } from "../shared/types";
import type { ProvidersRepo } from "../store/repos/providers";
import { GatewayError } from "../shared/errors";
import { config } from "../config";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "../admin/oauth";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPSTREAM = "https://daily-cloudcode-pa.googleapis.com";
const USER_AGENT = "antigravity/hub/2.9.1 windows/x64";
const projects = new Map<string, string>();
const tokens = new Map<string, { accessToken: string; expiresAt: number }>();

export const ANTIGRAVITY_MODELS = [
  { id: "gemini-3-pro-high", context: 1_048_576, output: 65_536 },
  { id: "claude-sonnet-4-5", context: 200_000, output: 64_000 },
  { id: "claude-opus-4-5-thinking", context: 200_000, output: 64_000 },
];

export function antigravityModelCatalog(): Array<{ id: string; contextLength: number; maxOutputTokens: number; capabilities: string[] }> {
  return ANTIGRAVITY_MODELS.map((model) => ({
    id: model.id,
    contextLength: model.context,
    maxOutputTokens: model.output,
    capabilities: ["reasoning", "tools", "vision"],
  }));
}

function sessionId(): string {
  return `-${(BigInt(Math.floor(Math.random() * 8_000_000_000_000_000_000)) + 1_000_000_000_000_000_000n).toString()}`;
}

async function accessToken(repo: ProvidersRepo, account: ProviderAccount): Promise<string> {
  const cached = tokens.get(account.id);
  if (cached && cached.expiresAt > Date.now() + 300_000) return cached.accessToken;
  if (!account.refresh_token) {
    if (account.api_key) return account.api_key;
    throw new GatewayError(401, "authentication_error", "Antigravity account has no refresh token");
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  const json = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !json.access_token) {
    throw new GatewayError(401, "authentication_error", `Antigravity OAuth refresh failed: ${json.error ?? response.status}`);
  }
  const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  tokens.set(account.id, { accessToken: json.access_token, expiresAt });
  account.api_key = json.access_token;
  await repo.updateAccountOAuth(account.id, { authKind: "oauth", accountKind: "oauth-browser", refreshToken: json.refresh_token ?? account.refresh_token, expiresAt });
  return json.access_token;
}

async function request(repo: ProvidersRepo, account: ProviderAccount, path: string, body: Record<string, unknown>, accept = "application/json"): Promise<Response> {
  const token = await accessToken(repo, account);
  return fetch(`${UPSTREAM}/v1internal${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept, "user-agent": USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
}

function upstreamErrorDetail(status: number, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return `HTTP ${status}`;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const root = parsed as Record<string, unknown>;
      const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
      const message = typeof error.message === "string" ? error.message : null;
      const code = typeof error.status === "string" ? error.status : null;
      if (message && code) return `${code}: ${message}`.slice(0, 600);
      if (message) return message.slice(0, 600);
    }
  } catch {
    // Some gateway errors are plain text; retain a short, sanitized excerpt.
  }
  return trimmed.replace(/\s+/g, " ").slice(0, 600);
}

async function projectId(repo: ProvidersRepo, account: ProviderAccount): Promise<string> {
  const cached = projects.get(account.id);
  if (cached) return cached;
  const response = await request(repo, account, ":loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } });
  if (!response.ok) {
    const detail = upstreamErrorDetail(response.status, await response.text().catch(() => ""));
    throw new GatewayError(
      response.status >= 500 ? 502 : response.status,
      response.status === 401 ? "authentication_error" : response.status === 429 ? "rate_limit_error" : "server_error",
      `Antigravity project lookup failed (${response.status}): ${detail}`,
    );
  }
  const json = await response.json() as { cloudaicompanionProject?: string | { id?: string }; projectId?: string; project?: string | { id?: string } };
  const rawProject = json.cloudaicompanionProject ?? json.project ?? json.projectId;
  const project = typeof rawProject === "string" ? rawProject : rawProject?.id;
  if (!project) throw new GatewayError(502, "server_error", "Antigravity did not return a Cloud AI Companion project");
  projects.set(account.id, project);
  return project;
}

function contentParts(content: CanonicalRequest["messages"][number]["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [{ text: JSON.stringify(content) }];
  return content.flatMap<Record<string, unknown>>((part) => {
    if (typeof part === "string") return [{ text: part }];
    if (typeof part !== "object" || part === null) return [];
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") return [{ text: item.text }];
    const image = item.image_url;
    if (item.type === "image_url" && image && typeof image === "object" && typeof (image as { url?: unknown }).url === "string") {
      const match = /^data:([^;]+);base64,(.*)$/s.exec((image as { url: string }).url);
      return match ? [{ inlineData: { mimeType: match[1], data: match[2] } }] : [];
    }
    return [];
  });
}

function bodyFor(req: CanonicalRequest, model: string, project: string): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [];
  for (const message of req.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      contents.push({ role: "user", parts: [{ functionResponse: { name: message.name ?? message.tool_call_id ?? "tool", ...(message.tool_call_id ? { id: message.tool_call_id } : {}), response: { result: typeof message.content === "string" ? message.content : JSON.stringify(message.content) } } }] });
      continue;
    }
    const parts = contentParts(message.content);
    for (const call of message.tool_calls ?? []) {
      let args: unknown = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* upstream receives an empty object for malformed tool arguments */ }
      parts.push({ functionCall: { name: call.function.name, args, id: call.id }, thoughtSignature: "skip_thought_signature_validator" });
    }
    if (!parts.length && message.role === "assistant") parts.push({ text: "" });
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  const system = req.messages.filter((message) => message.role === "system").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n\n");
  const generationConfig: Record<string, unknown> = {};
  if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  if (req.stop !== undefined) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.reasoning) {
    const effortBudget = { minimal: 0, low: 1000, medium: 4000, high: -1, xhigh: -1 }[req.reasoning.effort ?? "high"];
    generationConfig.thinkingConfig = { includeThoughts: req.reasoning.enabled !== false && effortBudget !== 0, thinkingBudget: req.reasoning.budget_tokens ?? effortBudget };
  }
  if (req.response_format && typeof req.response_format === "object") {
    const format = req.response_format as { type?: string; json_schema?: { schema?: Record<string, unknown> } };
    if (format.type === "json_object" || format.type === "json") generationConfig.responseMimeType = "application/json";
    if (format.type === "json_schema" && format.json_schema?.schema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = format.json_schema.schema;
    }
  }
  const tools = req.tools?.filter((tool) => tool.type === "function" && tool.function.name).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
  }));
  return {
    model,
    userAgent: "antigravity",
    requestType: "agent",
    project,
    requestId: `agent-${crypto.randomUUID()}`,
    request: { contents, generationConfig, ...(tools?.length ? { tools: [{ functionDeclarations: tools }] } : {}), sessionId: sessionId(), ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) },
  };
}

function translate(json: unknown, model: string): CanonicalResponse {
  const wrapper = (json as { response?: Record<string, unknown> })?.response ?? json as Record<string, unknown>;
  const candidate = (wrapper?.candidates as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const parts = candidate.content && typeof candidate.content === "object" ? (candidate.content as { parts?: Array<Record<string, unknown>> }).parts ?? [] : [];
  const content = parts.filter((part) => typeof part.text === "string" && part.thought !== true).map((part) => part.text as string).join("");
  const reasoning = parts.filter((part) => typeof part.text === "string" && part.thought === true).map((part) => part.text as string).join("");
  const toolCalls = parts.flatMap((part) => {
    const call = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
    return call?.name ? [{ id: call.id ?? `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] : [];
  });
  const usage = wrapper?.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number } | undefined;
  const normalizedUsage: Usage | undefined = usage ? { prompt_tokens: usage.promptTokenCount ?? 0, completion_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0), total_tokens: usage.totalTokenCount ?? 0 } : undefined;
  const message = { role: "assistant" as const, content: content || "", ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  return { id: `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : candidate.finishReason === "MAX_TOKENS" ? "length" : "stop" }], ...(normalizedUsage ? { usage: normalizedUsage } : {}) };
}

export async function callAntigravity(repo: ProvidersRepo, req: CanonicalRequest, account: ProviderAccount, model: string): Promise<CanonicalResponse> {
  const response = await request(repo, account, ":generateContent", bodyFor(req, model, await projectId(repo, account)));
  if (!response.ok) throw new GatewayError(response.status, response.status === 401 ? "authentication_error" : response.status === 429 ? "rate_limit_error" : "server_error", `Antigravity upstream error (${response.status}): ${(await response.text()).slice(0, 240)}`);
  return translate(await response.json(), req.model);
}

export async function streamAntigravity(repo: ProvidersRepo, req: CanonicalRequest, account: ProviderAccount, model: string): Promise<{ stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null>; ready: Promise<void> }> {
  const response = await request(repo, account, ":streamGenerateContent?alt=sse", bodyFor(req, model, await projectId(repo, account)), "text/event-stream");
  if (!response.ok || !response.body) throw new GatewayError(response.status || 502, response.status === 401 ? "authentication_error" : response.status === 429 ? "rate_limit_error" : "server_error", `Antigravity stream error (${response.status})`);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let resolveUsage!: (usage: Usage | null) => void;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const usagePromise = new Promise<Usage | null>((resolve) => { resolveUsage = resolve; });
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body!.getReader();
      const buffer = { text: "" };
      let usage: Usage | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer.text += decoder.decode(value, { stream: true });
          const frames = buffer.text.split(/\n\s*\n/);
          buffer.text = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              const chunk = translate(parsed, req.model);
              const delta = chunk.choices[0]?.message;
              if (delta?.content || delta?.reasoning_content || delta?.tool_calls?.length || chunk.choices[0]?.finish_reason) {
                started = true;
                resolveReady();
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...chunk, object: "chat.completion.chunk", choices: [{ index: 0, delta: { ...(delta?.content ? { content: delta.content } : {}), ...(delta?.reasoning_content ? { reasoning_content: delta.reasoning_content } : {}), ...(delta?.tool_calls ? { tool_calls: delta.tool_calls } : {}) }, finish_reason: chunk.choices[0]?.finish_reason ?? null }] })}\n\n`));
              }
              usage = chunk.usage ?? usage;
            } catch { /* ignore keepalive/non-JSON frames */ }
          }
        }
        if (!started) rejectReady(new GatewayError(502, "server_error", "Antigravity stream ended before producing output"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        resolveUsage(usage);
        controller.close();
      } catch (error) {
        if (!started) rejectReady(error);
        resolveUsage(usage);
        controller.error(error);
      }
    },
    cancel() { response.body?.cancel().catch(() => undefined); },
  });
  return { stream, usagePromise, ready };
}