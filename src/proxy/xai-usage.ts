/**
 * xAI Grok CLI usage/billing handler.
 *
 * Grok CLI exposes two REST endpoints for quota data:
 *   GET /v1/billing?format=credits  — credit balance, usage, reset periods
 *   GET /v1/user?include=subscription — subscription tier + access flags
 *
 * Reference: @xai-official/grok CLI traffic to cli-chat-proxy.grok.com
 */

import type { ProviderAccount } from "../shared/types";
import { GatewayError } from "../shared/errors";

const XAI_BASE = "https://cli-chat-proxy.grok.com/v1";

// ── public types ──

export interface XaiUsageSnapshot {
  plan: string | null;
  /** Normalized quota rows ready for the dashboard. */
  quotas: Record<string, XaiQuotaRow>;
  /** Human-readable message when no numeric quota is available. */
  message?: string;
}

export interface XaiQuotaRow {
  used: number;
  total: number;
  remainingPercentage: number;
  resetAt: string | null;
  unlimited: boolean;
}

// ── helpers ──

function unwrapVal(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "val" in value) {
    const v = (value as Record<string, unknown>).val;
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function parseResetTime(value: unknown): string | null {
  if (typeof value === "string" && value) {
    try {
      return new Date(value).toISOString();
    } catch {
      return null;
    }
  }
  if (typeof value === "number" && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

function makeQuota(used: number, total: number, resetAt: string | null, unlimited = false): XaiQuotaRow {
  const safeTotal = total > 0 ? total : 1;
  const safeUsed = Math.max(0, Math.min(used, safeTotal));
  return {
    used: safeUsed,
    total: safeTotal,
    remainingPercentage: unlimited ? 100 : Math.round((1 - safeUsed / safeTotal) * 100),
    resetAt,
    unlimited,
  };
}

function buildXaiCliHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "grok-shell/0.2.103 (linux; x86_64)",
    "x-grok-client-version": "0.2.103",
    "x-grok-client-identifier": "grok-shell",
    accept: "application/json",
  };
}

function resolvePlan(user: Record<string, unknown> | null, config: Record<string, unknown>): string {
  const tier = (user?.subscriptionTier ?? user?.subscription_tier ?? config?.subscriptionTier ?? config?.subscription_tier);
  if (typeof tier === "string" && tier.trim() && !/^(free|none|null)$/i.test(tier.trim())) {
    return tier.trim().replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (user?.hasGrokCodeAccess === true) return "Grok Code";
  if (config?.isUnifiedBillingUser === true) return "Grok Build";
  return "Grok Build";
}

function planFromAccessToken(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const tier = payload.tier;
    if (typeof tier === "string" && tier.trim()) {
      return tier.trim().replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return null;
  } catch {
    return null;
  }
}

// ── billing parser ──

export function parseXaiBilling(billing: unknown, user: Record<string, unknown> | null = null): XaiUsageSnapshot {
  const root = (billing && typeof billing === "object" ? billing : {}) as Record<string, unknown>;
  const config = (root.config && typeof root.config === "object" ? root.config : root) as Record<string, unknown>;

  const periodEnd =
    parseResetTime(config.billingPeriodEnd) ||
    parseResetTime(config.billing_period_end) ||
    parseResetTime((config.currentPeriod as Record<string, unknown>)?.end) ||
    null;

  const quotas: Record<string, XaiQuotaRow> = {};

  // Monthly included credits (Grok Build / SuperGrok)
  const monthlyLimit = unwrapVal(config.monthlyLimit ?? config.monthly_limit, NaN);
  const includedUsed = unwrapVal(config.includedUsed ?? config.included_used, NaN);
  if (Number.isFinite(monthlyLimit) && monthlyLimit > 0) {
    const used = Number.isFinite(includedUsed) ? includedUsed : 0;
    quotas["Monthly included"] = makeQuota(used, monthlyLimit, periodEnd);
  }

  // On-demand spending window (subscription / promo credits)
  const onDemandCap = unwrapVal(config.onDemandCap, NaN);
  const onDemandUsed = unwrapVal(config.onDemandUsed, NaN);
  if (Number.isFinite(onDemandCap) && onDemandCap > 0) {
    quotas["On-demand"] = makeQuota(Math.max(0, onDemandUsed), onDemandCap, periodEnd);
  } else if (Number.isFinite(onDemandCap) && onDemandCap === 0 && Number.isFinite(onDemandUsed)) {
    // Cap 0 = exhausted free/promo state. Use synthetic 1/1 depleted row.
    quotas["On-demand"] = makeQuota(1, 1, periodEnd);
  }

  // Prepaid top-up balance
  const prepaid = unwrapVal(config.prepaidBalance ?? root.prepaidBalance, NaN);
  if (Number.isFinite(prepaid) && prepaid > 0) {
    quotas["Prepaid"] = makeQuota(0, prepaid, null);
  }

  // SuperGrok weekly shared pool (creditUsagePercent)
  const usedPct = unwrapVal(config.creditUsagePercent ?? config.credit_usage_percent ?? root.creditUsagePercent, NaN);
  if (Number.isFinite(usedPct) && usedPct >= 0) {
    quotas["Weekly SuperGrok"] = makeQuota(Math.max(0, Math.min(100, usedPct)), 100, periodEnd);
  }

  // Generic credit envelopes
  const creditBags = [
    root.credits, root.creditBalance, root.usage,
    config.credits, config.includedCredits, config.subscriptionCredits,
  ].filter((bag) => bag && typeof bag === "object" && !Array.isArray(bag)) as Record<string, unknown>[];

  for (const bag of creditBags) {
    const total = unwrapVal(bag.total ?? bag.limit ?? bag.cap ?? bag.allocation ?? bag.amount, NaN);
    const used = unwrapVal(bag.used ?? bag.spent ?? bag.consumed, NaN);
    const remaining = unwrapVal(bag.remaining ?? bag.balance ?? bag.left, NaN);
    if (Number.isFinite(total) && total > 0) {
      const resolvedUsed = Number.isFinite(used) ? used : Number.isFinite(remaining) ? Math.max(0, total - remaining) : 0;
      if (!quotas["Credits"]) {
        quotas["Credits"] = makeQuota(resolvedUsed, total, parseResetTime(bag.resetAt ?? bag.resetsAt ?? bag.end) || periodEnd);
      }
    } else if (Number.isFinite(remaining) && remaining >= 0 && !quotas["Credits"]) {
      quotas["Credits"] = makeQuota(0, remaining > 0 ? remaining : 1, periodEnd);
    }
  }

  const plan = planFromAccessToken("") || resolvePlan(user, config);

  // Determine if a human-readable message is needed (no numeric quotas)
  const subscriptionAccess = user?.subscriptionTier
    ? !/^(free|none|null)$/i.test(String(user.subscriptionTier))
    : false;

  if (Object.keys(quotas).length === 0) {
    return {
      plan,
      quotas: {},
      message: subscriptionAccess
        ? "Subscription access is active; Grok does not expose a numeric included quota for this tier."
        : "Grok Build connected, but no credit allotment was returned. Free promo may be exhausted.",
    };
  }

  return { plan, quotas };
}

// ── main fetcher ──

const BILLING_URL = `${XAI_BASE}/billing?format=credits`;
const USER_URL = `${XAI_BASE}/user?include=subscription`;
const GRPC_CREDITS_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

// Empty gRPC-web request frame (flag 0 + length 0)
const GRPC_WEB_EMPTY_FRAME = new Uint8Array([0, 0, 0, 0, 0]);

/**
 * Decode the gRPC-web GetGrokCreditsConfig response.
 * Real shape (live capture):
 *   field 1 (length-delimited) — nested credits info
 *     subfield 1 (fixed32 float) — usage ratio 0..1
 *     subfield 5 (Timestamp{seconds,nanos}) — credit-pool reset time
 * Fail-open: returns null on any parse error.
 */
function decodeGrokCreditsFrame(buf: Uint8Array): { percentUsed: number; resetAt: string | null } | null {
  try {
    // Skip gRPC-web trailer (5 bytes: flag + 4-byte length BE)
    let pos = 5;
    if (buf.length < 6) return null;

    while (pos < buf.length - 5) {
      const tag = buf[pos]!;
      pos += 1;
      const fieldNum = tag >>> 3;
      const wireType = tag & 0x07;

      if (wireType === 2) {
        // Length-delimited
        let len = 0;
        let shift = 0;
        while (pos < buf.length) {
          const b = buf[pos]!;
          pos += 1;
          len |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        const inner = buf.slice(pos, pos + len);
        pos += len;

        if (fieldNum === 1) {
          // Nested CreditsInfo
          const credits = decodeCreditsInfo(inner);
          if (credits) return credits;
        }
      } else if (wireType === 5) {
        // Fixed32 — skip
        pos += 4;
      } else if (wireType === 0) {
        // Varint — skip
        while (pos < buf.length && (buf[pos]! & 0x80)) pos += 1;
        pos += 1;
      } else {
        break;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function decodeCreditsInfo(buf: Uint8Array): { percentUsed: number; resetAt: string | null } | null {
  try {
    let pos = 0;
    let percentUsed: number | null = null;
    let resetSeconds: number | null = null;
    let resetNanos = 0;

    while (pos < buf.length) {
      const tag = buf[pos]!;
      pos += 1;
      const fieldNum = tag >>> 3;
      const wireType = tag & 0x07;

      if (wireType === 5 && fieldNum === 1) {
        // Fixed32 float — usage ratio
        const view = new DataView(buf.buffer.slice(buf.byteOffset + pos, buf.byteOffset + pos + 4));
        percentUsed = view.getFloat32(0, true); // little-endian
        pos += 4;
      } else if (wireType === 2 && fieldNum === 5) {
        // Length-delimited — Timestamp
        let len = 0;
        let shift = 0;
        while (pos < buf.length) {
          const b = buf[pos]!;
          pos += 1;
          len |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        const ts = decodeTimestamp(buf.slice(pos, pos + len));
        pos += len;
        if (ts) {
          resetSeconds = ts.seconds;
          resetNanos = ts.nanos;
        }
      } else if (wireType === 5) {
        pos += 4;
      } else if (wireType === 0) {
        while (pos < buf.length && (buf[pos]! & 0x80)) pos += 1;
        pos += 1;
      } else if (wireType === 2) {
        let len = 0;
        let shift = 0;
        while (pos < buf.length) {
          const b = buf[pos]!;
          pos += 1;
          len |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        pos += len;
      } else {
        break;
      }
    }

    if (percentUsed === null) return null;
    const resetAt = resetSeconds !== null
      ? new Date(resetSeconds * 1000 + Math.round(resetNanos / 1_000_000)).toISOString()
      : null;
    return { percentUsed, resetAt };
  } catch {
    return null;
  }
}

function decodeTimestamp(buf: Uint8Array): { seconds: number; nanos: number } | null {
  try {
    let pos = 0;
    let seconds = 0;
    let nanos = 0;
    while (pos < buf.length) {
      const tag = buf[pos]!;
      pos += 1;
      const fieldNum = tag >>> 3;
      const wireType = tag & 0x07;

      if (wireType === 0 && fieldNum === 1) {
        // Varint seconds
        let val = 0;
        let shift = 0;
        while (pos < buf.length) {
          const b = buf[pos]!;
          pos += 1;
          val |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        seconds = val;
      } else if (wireType === 0 && fieldNum === 2) {
        // Varint nanos
        let val = 0;
        let shift = 0;
        while (pos < buf.length) {
          const b = buf[pos]!;
          pos += 1;
          val |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        nanos = val;
      } else if (wireType === 0) {
        while (pos < buf.length && (buf[pos]! & 0x80)) pos += 1;
        pos += 1;
      } else if (wireType === 5) {
        pos += 4;
      } else if (wireType === 2) {
        let len = 0;
        let shift = 0;
        while (pos < buf.length) {
          const b = buf[pos]!;
          pos += 1;
          len |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7;
        }
        pos += len;
      } else {
        break;
      }
    }
    return { seconds, nanos };
  } catch {
    return null;
  }
}

/**
 * Fetch SuperGrok weekly pool via gRPC-web GetGrokCreditsConfig.
 * Fail-open: any network/auth/parse failure returns null.
 */
async function fetchGrokCreditsConfig(accessToken: string): Promise<{ percentUsed: number; resetAt: string | null } | null> {
  try {
    const res = await fetch(GRPC_CREDITS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/grpc-web+proto",
        "X-Grpc-Web": "1",
        Accept: "application/grpc-web+proto",
      },
      body: GRPC_WEB_EMPTY_FRAME,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return decodeGrokCreditsFrame(buf);
  } catch {
    return null;
  }
}

export async function fetchXaiUsage(account: ProviderAccount): Promise<XaiUsageSnapshot> {
  const headers = buildXaiCliHeaders(account.api_key);

  try {
    const [billingRes, userRes] = await Promise.all([
      fetch(BILLING_URL, { method: "GET", headers, signal: AbortSignal.timeout(15_000) }),
      fetch(USER_URL, { method: "GET", headers, signal: AbortSignal.timeout(15_000) }).catch(() => null),
    ]);

    if (billingRes.status === 401 || billingRes.status === 403) {
      return { plan: null, quotas: {}, message: "Grok CLI authentication expired. Please re-authorize." };
    }

    if (!billingRes.ok) {
      const errText = await billingRes.text().catch(() => "");
      return { plan: null, quotas: {}, message: `Grok CLI billing API error (${billingRes.status}): ${errText.slice(0, 200)}` };
    }

    const billing = await billingRes.json().catch(() => null);
    if (!billing || typeof billing !== "object") {
      return { plan: null, quotas: {}, message: "Grok CLI billing response was not JSON." };
    }

    let user: Record<string, unknown> | null = null;
    if (userRes && "ok" in userRes && (userRes as Response).ok) {
      user = await (userRes as Response).json().catch(() => null) as Record<string, unknown> | null;
    }

    const parsed = parseXaiBilling(billing, user);

    // Override plan from access token JWT tier (more accurate than REST user endpoint)
    parsed.plan = planFromAccessToken(account.api_key) || parsed.plan;

    // If REST returned no quotas but user has a paid subscription tier,
    // try the gRPC GetGrokCreditsConfig fallback for SuperGrok weekly pool.
    if (Object.keys(parsed.quotas).length === 0) {
      const tier = user?.subscriptionTier ?? user?.subscription_tier;
      const hasPaidSub = typeof tier === "string" && tier.trim() && !/^(free|none|null)$/i.test(tier.trim());
      if (hasPaidSub) {
        const grpc = await fetchGrokCreditsConfig(account.api_key);
        if (grpc) {
          const used = Math.max(0, Math.min(100, Math.round(grpc.percentUsed * 100)));
          parsed.quotas["Weekly SuperGrok"] = makeQuota(used, 100, grpc.resetAt);
          // Clear the message since we now have quota data
          parsed.message = undefined;
        }
      }
    }

    return parsed;
  } catch (err) {
    return { plan: null, quotas: {}, message: `Grok CLI usage error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
