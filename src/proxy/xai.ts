import type { CanonicalRequest, CanonicalResponse, ProviderAccount, Usage } from "../shared/types";
import { GatewayError } from "../shared/errors";
import type { ProvidersRepo } from "../store/repos/providers";
import { XAI_BASE_URL, refreshAccessToken } from "../admin/xai-oauth";
import { aggregateResponsesStream, codexRequestBody, responsesStreamToChat } from "./codex";

const REFRESH_THRESHOLD_MS = 5 * 60_000;

/** The Grok CLI OAuth API implements the Responses dialect. */
export function xaiResponsesUrl(): string {
  return `${XAI_BASE_URL}/responses`;
}

export function xaiRequestBody(req: CanonicalRequest, modelId: string): Record<string, unknown> {
  return codexRequestBody(req, modelId, true);
}

export function xaiHeaders(accessToken: string, stream = false): Record<string, string> {
  return {
    "content-type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "xai-grok-cli",
    "x-grok-client-version": "0.2.103",
    "x-grok-client-identifier": "grok-shell",
    ...(stream ? { accept: "text/event-stream" } : {}),
  };
}

export async function ensureFreshXaiToken(repo: ProvidersRepo, account: ProviderAccount): Promise<string> {
  if (!account.expires_at || account.expires_at - Date.now() > REFRESH_THRESHOLD_MS) return account.api_key;
  if (!account.refresh_token) {
    throw new GatewayError(401, "authentication_error", "Grok login has expired and cannot be refreshed. Reconnect the account.");
  }

  try {
    const tokens = await refreshAccessToken(account.refresh_token);
    const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null;
    repo.updateAccountOAuth(account.id, { refreshToken: tokens.refresh_token ?? account.refresh_token, expiresAt });
    repo.updateAccount(account.id, { apiKey: tokens.access_token });
    account.api_key = tokens.access_token;
    account.refresh_token = tokens.refresh_token ?? account.refresh_token;
    account.expires_at = expiresAt;
    return tokens.access_token;
  } catch (err) {
    throw new GatewayError(401, "authentication_error", `Grok token refresh failed: ${err instanceof Error ? err.message : String(err)}. Reconnect the account.`);
  }
}

export function aggregateXaiResponsesStream(stream: ReadableStream<Uint8Array>, model: string): Promise<CanonicalResponse> {
  return aggregateResponsesStream(stream, model);
}

export function xaiResponsesStreamToChat(stream: ReadableStream<Uint8Array>, model: string): { stream: ReadableStream<Uint8Array>; usagePromise: Promise<Usage | null> } {
  return responsesStreamToChat(stream, model);
}