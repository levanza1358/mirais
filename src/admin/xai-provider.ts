import type { ProviderAccount } from "../shared/types";
import type { ProvidersRepo } from "../store/repos/providers";
import { ensureFreshXaiToken, xaiHeaders, xaiRequestBody, xaiResponsesUrl } from "../proxy/xai";

export interface XaiModelCatalogEntry {
  id: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
  capabilities: string[] | null;
}

/** Fetch the model catalog advertised by the Grok CLI OAuth endpoint. */
export async function fetchXaiModels(
  repo: ProvidersRepo,
  account: ProviderAccount,
): Promise<XaiModelCatalogEntry[]> {
  const accessToken = await ensureFreshXaiToken(repo, account);
  const response = await fetch("https://cli-chat-proxy.grok.com/v1/models", {
    headers: xaiHeaders(accessToken),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Grok model catalog returned HTTP ${response.status}`);

  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return (payload.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === "string" && model.id.length > 0)
    .map((model) => ({ id: model.id, contextLength: null, maxOutputTokens: null, capabilities: null }));
}

/** Send a minimal streaming Grok request and extract the first text delta. */
export async function testXaiModel(
  repo: ProvidersRepo,
  account: ProviderAccount,
  modelId: string,
  prompt: string,
): Promise<{ response: Response; previewText?: string }> {
  const accessToken = await ensureFreshXaiToken(repo, account);
  const response = await fetch(xaiResponsesUrl(), {
    method: "POST",
    headers: xaiHeaders(accessToken, true),
    body: JSON.stringify(xaiRequestBody({
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      max_tokens: 64,
    }, modelId)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) return { response };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let previewText: string | undefined;
  try {
    while (!previewText) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/"delta"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (match?.[1]) previewText = JSON.parse(`"${match[1]}"`) as string;
      if (buffer.length > 32_000) break;
    }
  } finally {
    await reader.cancel();
  }
  return { response, previewText };
}
