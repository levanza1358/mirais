/**
 * xAI (Grok) OAuth Device Code Flow
 * Uses Grok CLI's public OAuth client to authenticate without API credits.
 */

import crypto from "node:crypto";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";

export const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
export const XAI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const XAI_MODELS = ["grok-build", "grok-4.5", "grok-4.5-high", "grok-4.5-medium", "grok-4.5-low"];

export interface XaiDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface XaiTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

export interface XaiImapSettings {
  enabled: boolean;
  gmail_username: string;
  gmail_app_password: string;
  email_domain: string;
  account_password?: string;
  headless: boolean;
  otp_check_interval: number;
  otp_max_retries: number;
}

export function generateFarmEmail(domain = "levanza.my.id"): string {
  const adjectives = ["swift", "brave", "clever", "mighty", "silent", "golden", "crimson", "azure", "shadow", "storm"];
  const nouns = ["fox", "wolf", "eagle", "hawk", "bear", "tiger", "lion", "dragon", "phoenix", "raven"];
  const adj = adjectives[crypto.randomInt(adjectives.length)];
  const noun = nouns[crypto.randomInt(nouns.length)];
  const num = crypto.randomInt(100, 9999);
  return `${adj}${noun}${num}@${domain}`;
}

export async function requestDeviceCode(): Promise<XaiDeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: XAI_CLIENT_ID,
    scope: XAI_SCOPE,
  });

  const res = await fetch(XAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AdminError(res.status, `xAI device code request failed: ${text}`);
  }

  return res.json() as Promise<XaiDeviceCodeResponse>;
}

export async function pollForToken(deviceCode: string): Promise<XaiTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: XAI_CLIENT_ID,
  });

  const res = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json() as Record<string, unknown>;

  if (data.error === "authorization_pending") {
    throw new AdminError(428, "Authorization pending — user has not yet authorized");
  }

  if (data.error === "slow_down") {
    throw new AdminError(429, "Polling too fast — slow down");
  }

  if (data.error === "expired_token") {
    throw new AdminError(410, "Device code expired — please restart the flow");
  }

  if (data.error === "access_denied") {
    throw new AdminError(403, "User denied the authorization request");
  }

  if (!res.ok || data.error) {
    throw new AdminError(res.status, `xAI token poll failed: ${String(data.error_description ?? data.error ?? res.statusText)}`);
  }

  return data as unknown as XaiTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<XaiTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: XAI_CLIENT_ID,
  });

  const res = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AdminError(res.status, `xAI token refresh failed: ${text}`);
  }

  return res.json() as Promise<XaiTokenResponse>;
}

export function extractEmailFromAccessToken(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    const payloadBase64 = parts[1];
    if (!payloadBase64) return null;
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8")) as Record<string, unknown>;
    return (payload.email as string) ?? (payload.sub as string) ?? null;
  } catch {
    return null;
  }
}

export async function validateAccessToken(accessToken: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const res = await fetch(`${XAI_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Token validation failed (${res.status}): ${text.slice(0, 200)}` };
    }

    const email = extractEmailFromAccessToken(accessToken);
    return { ok: true, email: email ?? undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface FarmResult {
  success: boolean;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  error?: string;
}

export async function farmXaiAccount(imapSettings: XaiImapSettings): Promise<FarmResult> {
  const email = generateFarmEmail(imapSettings.email_domain);
  log.info("xAI farm started", { email });

  try {
    const { runXaiFarm, checkXaiFarmDependencies } = await import("../../scripts/xfarm/index");

    const deps = await checkXaiFarmDependencies(true);
    if (!deps.ok) {
      const missing = deps.checks.filter((check) => !check.ok).map((check) => check.label);
      return {
        success: false,
        email,
        error: `Missing dependencies: ${missing.join(", ")}. Run: pip install -r scripts/xfarm/requirements.txt`,
      };
    }

    const result = await runXaiFarm({
      email,
      headless: imapSettings.headless,
      timeout: 300_000,
      debug: process.env.XAI_FARM_DEBUG === "1",
      config: {
        enabled: imapSettings.enabled,
        gmail_username: imapSettings.gmail_username,
        gmail_app_password: imapSettings.gmail_app_password,
        email_domain: imapSettings.email_domain,
        headless: imapSettings.headless,
        otp_check_interval: imapSettings.otp_check_interval,
        otp_max_retries: imapSettings.otp_max_retries,
      },
    });

    if (!result.success) {
      return {
        success: false,
        email: result.email ?? email,
        error: result.error ?? "Farm failed",
      };
    }

    return {
      success: true,
      email: result.email ?? email,
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresIn: 3600,
    };
  } catch (err) {
    log.error("xAI farm failed", { error: err instanceof Error ? err.message : String(err) });
    return {
      success: false,
      email,
      error: `Farm error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function startDeviceFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}> {
  const device = await requestDeviceCode();
  return {
    deviceCode: device.device_code,
    userCode: device.user_code,
    verificationUrl: device.verification_uri_complete,
    expiresIn: device.expires_in,
    interval: device.interval,
  };
}
