import type { Database } from "bun:sqlite";
import type { GatewayKey } from "./shared/types";
import { nowIso } from "./utils/id";

interface Bucket {
  minute: number;
  count: number;
}

const buckets = new Map<string, Bucket>();
const inFlight = new Map<string, number>();

export function checkRateLimit(db: Database, key: GatewayKey): { retryAfterSec?: number } {
  const nowMin = Math.floor(Date.now() / 60_000);

  if (key.rate_limit_rpm) {
    const b = buckets.get(key.id);
    if (!b || b.minute !== nowMin) {
      buckets.set(key.id, { minute: nowMin, count: 1 });
    } else if (b.count >= key.rate_limit_rpm) {
      return { retryAfterSec: 60 - Math.floor((Date.now() % 60_000) / 1000) };
    } else {
      b.count += 1;
    }
  }

  if (key.concurrency) {
    const n = inFlight.get(key.id) ?? 0;
    if (n >= key.concurrency) return { retryAfterSec: 5 };
  }

  if (key.daily_token_budget) {
    const row = db
      .query(
        `SELECT COALESCE(SUM(input_tokens) + SUM(output_tokens), 0) as t
         FROM request_logs WHERE key_id = ? AND ts >= datetime('now', 'start of day')`,
      )
      .get(key.id) as { t: number };
    if (row.t >= key.daily_token_budget) {
      return { retryAfterSec: secondsUntilMidnight() };
    }
  }

  return {};
}

export function acquireSlot(keyId: string): void {
  inFlight.set(keyId, (inFlight.get(keyId) ?? 0) + 1);
}

export function releaseSlot(keyId: string): void {
  const n = (inFlight.get(keyId) ?? 1) - 1;
  if (n <= 0) inFlight.delete(keyId);
  else inFlight.set(keyId, n);
}

function secondsUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
}

export function allowedModels(key: GatewayKey): string[] | null {
  if (!key.allowed_models) return null;
  try {
    return JSON.parse(key.allowed_models) as string[];
  } catch {
    return null;
  }
}

export function isExpired(key: GatewayKey): boolean {
  if (!key.expires_at) return false;
  return key.expires_at <= nowIso();
}
