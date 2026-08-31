/**
 * Direct GitHub Copilot backend proxy.
 *
 * Fetches the ProviderEndpoint (baseUrl + apiKey + headers) from the sidecar's
 * /v1/endpoint endpoint, then makes direct HTTP requests to the Copilot
 * backend — bypassing the sidecar HTTP hop for inference.
 *
 * The sidecar is still used for:
 *   - device-code login flow
 *   - model listing
 *   - quota checks
 *   - endpoint discovery (this module)
 *
 * But inference requests (chat/completions) go directly to the Copilot
 * backend via the endpoint the SDK itself would use.
 */

import { config } from "../config";
import { log } from "../utils/logger";
import { assertSafeUpstreamUrl, fetchNoCrossHostRedirect } from "../utils/upstreamUrl";
import type { CanonicalRequest, CanonicalResponse, Usage } from "../shared/types";
import { GatewayError } from "../shared/errors";
import { SseParser } from "./translator/stream";
import { normalizeUsage } from "./promptCache";

interface CopilotEndpoint {
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
  sessionToken: { token: string; header: string; model?: string; expiresAt?: string } | null;
}

const endpointCache = new Map<string, { ep: CopilotEndpoint; cachedAt: number }>();
const ENDPOINT_CACHE_TTL = 300_000;

// HTTP keep-alive agent for reusing connections to Copilot backend
let keepAliveAgent: { destroy(): void } | null = null;
function getKeepAliveAgent() {
  if (!keepAliveAgent) {
    // Bun's fetch uses undici internally; we rely on Connection: keep-alive default
    keepAliveAgent = { destroy: () => {} };
  }
  return keepAliveAgent;
}

async function fetchEndpoint(sidecarUrl: string, modelId?: string): Promise<CopilotEndpoint> {
  const params = modelId ? `?model=${encodeURIComponent(modelId)}` : "";
  const res = await fetch(`${sidecarUrl.replace(/\/+$/, "")}/endpoint${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GatewayError(502, "server_error", `Sidecar endpoint fetch failed: HTTP ${res.status} ${text}`);
  }
  return await res.json() as CopilotEndpoint;
}

async function getEndpoint(sidecarUrl: string, modelId?: string): Promise<CopilotEndpoint> {
  const cacheKey = `${sidecarUrl}:${modelId ?? ""}`;
  const cached = endpointCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < ENDPOINT_CACHE_TTL) {
    return cached.ep;
  }
  const ep = await fetchEndpoint(sidecarUrl, modelId);
  endpointCache.set(cacheKey, { ep, cachedAt: Date.now() });
  return ep;
}

export function clearEndpointCache(sidecarUrl?: string): void {
  if (sidecarUrl) {
    for (const key of endpointCache.keys()) {
      if (key.startsWith(sidecarUrl)) endpointCache.delete(key);
    }
  } else {
    endpointCache.clear();
  }
}

function buildHeaders(ep: CopilotEndpoint): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...ep.headers as Record<string, string>,
  };
  if (ep.apiKey) headers.authorization = `Bearer ${ep.apiKey}`;
  if (ep.sessionToken) {
    headers[ep.sessionToken.header] = ep.sessionToken.token;
  }
  return headers;
}

export async function directChatCompletions(
  sidecarUrl: string,
  req: CanonicalRequest,
  modelId: string,
): Promise<CanonicalResponse> {
  const ep = await getEndpoint(sidecarUrl, modelId);
  const url = `${ep.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  assertSafeUpstreamUrl(url, { allowPrivate: false });

  const body = { ...req, model: ep.sessionToken?.model ?? modelId, stream: false };

  const res = await fetchNoCrossHostRedirect(url, {
    method: "POST",
    headers: buildHeaders(ep),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    keepalive: true,
  }, 3, { allowPrivate: false });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      clearEndpointCache(sidecarUrl);
    }
    throw new GatewayError(res.status, "server_error", `Copilot direct API error: HTTP ${res.status} ${text}`);
  }

  const data = (await res.json()) as CanonicalResponse;
  const usage = normalizeUsage(data.usage);
  return usage ? { ...data, usage } : data;
}

export async function directChatCompletionsStream(
  sidecarUrl: string,
  req: CanonicalRequest,
  modelId: string,
): Promise<{ stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null> }> {
  const ep = await getEndpoint(sidecarUrl, modelId);
  const url = `${ep.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  assertSafeUpstreamUrl(url, { allowPrivate: false });

  const body = { ...req, model: ep.sessionToken?.model ?? modelId, stream: true };

  const res = await fetchNoCrossHostRedirect(url, {
    method: "POST",
    headers: {
      ...buildHeaders(ep),
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    keepalive: true,
  }, 3, { allowPrivate: false });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      clearEndpointCache(sidecarUrl);
    }
    throw new GatewayError(res.status, "server_error", `Copilot direct API error: HTTP ${res.status} ${text}`);
  }
  if (!res.body) throw new GatewayError(502, "server_error", "Copilot direct API returned no body");

  const parser = new SseParser();
  let usage: Usage | null = null;
  let resolveUsage: (u: Usage | null) => void;
  let rejectUsage: (reason?: unknown) => void;
  const usagePromise = new Promise<Usage | null>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const reader = res.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = dec.decode(value, { stream: true });
          for (const ev of parser.feed(text)) {
            if (!ev.data || ev.data === "[DONE]") {
              controller.enqueue(enc.encode(`data: ${ev.data}\n\n`));
              continue;
            }
            try {
              const parsed = JSON.parse(ev.data);
              if (parsed.usage) usage = normalizeUsage(parsed.usage);
              if (parsed.model) parsed.model = req.model;
              controller.enqueue(enc.encode(`data: ${JSON.stringify(parsed)}\n\n`));
            } catch {
              controller.enqueue(enc.encode(`data: ${ev.data}\n\n`));
            }
          }
        }
      } catch (err) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: "stream error", type: "server_error" } })}\n\n`));
      } finally {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        resolveUsage!(usage);
        controller.close();
      }
    },
    cancel() {
      res.body?.cancel().catch(() => undefined);
    },
  });

  return { stream, usagePromise };
}