import type { ProviderAccount } from "../shared/types";
import type { ProvidersRepo } from "../store/repos/providers";
import { GatewayError } from "../shared/errors";
import { log } from "../utils/logger";

/**
 * Shared OAuth refresh coordination.
 *
 * Two problems this solves:
 *
 * 1. **Refresh races.** Every provider had its own `ensureFresh*` function that
 *    checked expiry, POSTed the refresh token, then persisted the result. With
 *    concurrent requests on one account (the executor fans out per attempt, and
 *    the warmup timer runs every 60s) several callers could POST the *same*
 *    refresh token. Providers that rotate refresh tokens invalidate the old one,
 *    so the loser of the race ends up holding a dead token and the account
 *    breaks permanently. `withRefreshLock` collapses concurrent refreshes for an
 *    account into a single in-flight promise.
 *
 * 2. **Blind retry of revoked grants.** A permanently failed refresh threw a
 *    401 and persisted nothing, so the account stayed "healthy" in the DB and
 *    was retried on every subsequent request. `markReauthRequired` records the
 *    terminal state so the router skips the account until it is reconnected.
 */

const inFlight = new Map<string, Promise<string>>();

/**
 * Run `refresh` under a per-account lock. Concurrent callers for the same
 * account await the same promise instead of issuing their own refresh.
 */
export function withRefreshLock(accountId: string, refresh: () => Promise<string>): Promise<string> {
  const existing = inFlight.get(accountId);
  if (existing) return existing;
  const pending = refresh().finally(() => {
    inFlight.delete(accountId);
  });
  inFlight.set(accountId, pending);
  return pending;
}

/**
 * OAuth error codes that mean the grant is gone for good. Retrying these
 * cannot succeed — only the operator reconnecting the account can.
 */
const PERMANENT_ERROR_CODES = [
  "invalid_grant",
  "invalid_request",
  "invalid_client",
  "unauthorized_client",
  "access_denied",
];

/**
 * True when a refresh failure is terminal rather than transient. HTTP 400/401
 * from a token endpoint means the grant was rejected; 5xx and network errors
 * are retriable and must not park the account.
 */
export function isPermanentRefreshFailure(status: number, body?: string | null): boolean {
  if (status === 400 || status === 401 || status === 403) return true;
  const lower = (body ?? "").toLowerCase();
  if (PERMANENT_ERROR_CODES.some((code) => lower.includes(code))) return true;
  return /revoked|expired|not found|no longer valid/.test(lower);
}

/**
 * Persist the terminal auth state and return the error to throw. The account is
 * skipped by `Router.pickAccounts` until `reauth_required` is cleared, which
 * `ProvidersRepo.updateAccountOAuth` does whenever fresh tokens are stored.
 */
export function markReauthRequired(
  repo: ProvidersRepo,
  account: ProviderAccount,
  reason: string,
): GatewayError {
  try {
    repo.updateAccount(account.id, {
      reauthRequired: true,
      reauthReason: reason.slice(0, 300),
      lastWarmupStatus: "failing",
      lastWarmupDetail: reason.slice(0, 300),
      lastWarmupAt: new Date().toISOString(),
    });
  } catch { /* best-effort — DB may be mid-restart */ }
  log.warn("account requires reauth", { account: account.label, reason });
  return new GatewayError(401, "authentication_error", `${reason} Reconnect the account from the dashboard.`);
}
