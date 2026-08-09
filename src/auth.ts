import type { Database } from "bun:sqlite";
import type { GatewayKey } from "./shared/types";
import { GatewayError } from "./shared/errors";
import { KeysRepo } from "./store/repos/keys";
import { ProvidersRepo } from "./store/repos/providers";
import { isExpired, allowedModels } from "./ratelimit";
import { config } from "./config";
import { log } from "./utils/logger";

/**
 * Anonymous "key" used when authentication is disabled and the request
 * arrives without a `Authorization: Bearer` header. We never persist this
 * object — it only exists for the lifetime of the request and is never
 * written to `request_logs.key_id` (which is left null).
 */
const ANONYMOUS_KEY: GatewayKey = {
  id: "anonymous",
  label: "anonymous",
  key_prefix: "anonymous",
  key_hash: "",
  enabled: 1,
  allowed_models: null,
  rate_limit_rpm: null,
  concurrency: null,
  daily_token_budget: null,
  expires_at: null,
  created_at: "",
  last_used_at: null,
};

function loadKey(db: Database, plaintext: string): GatewayKey | null {
  return new KeysRepo(db).getByPlaintextKey(plaintext);
}

function enabledKeyExists(db: Database): boolean {
  // Cheap "any enabled key?" probe used by the optional-auth path.
  const row = db.query("SELECT 1 AS x FROM gateway_keys WHERE enabled = 1 LIMIT 1").get() as { x: number } | null;
  return row !== null;
}

export function authenticateGatewayKey(db: Database, authHeader: string | null): GatewayKey {
  // No header: when auth is opt-out (env MIRAIS_AUTH_REQUIRED=off) OR no
  // enabled key is configured at all, fall back to the anonymous identity so
  // a self-hosted loopback listener can still serve traffic. Any provided
  // header is still validated below — you can't bypass auth by simply
  // omitting the header when auth is required.
  if (!authHeader) {
    if (!config.authRequired || !enabledKeyExists(db)) {
      return ANONYMOUS_KEY;
    }
    throw new GatewayError(401, "authentication_error", "Missing Authorization: Bearer <key> header");
  }
  if (!authHeader.startsWith("Bearer ")) {
    throw new GatewayError(401, "authentication_error", "Authorization header must use the Bearer scheme");
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    throw new GatewayError(401, "authentication_error", "Empty API key");
  }
  // Anonymous escape hatch for tooling: a request with the literal
  // placeholder "anonymous" only succeeds when auth is opt-out.
  if (!config.authRequired && token === "anonymous") {
    return ANONYMOUS_KEY;
  }
  const key = loadKey(db, token);
  if (!key) {
    log.warn("invalid gateway key used");
    throw new GatewayError(401, "authentication_error", "Invalid API key");
  }
  if (!key.enabled) {
    throw new GatewayError(401, "authentication_error", "API key is disabled");
  }
  if (isExpired(key)) {
    throw new GatewayError(401, "authentication_error", "API key has expired");
  }
  new KeysRepo(db).touchLastUsed(key.id);
  return key;
}

export function authorizeModel(key: GatewayKey, model: string): void {
  const allowed = allowedModels(key);
  if (allowed === null) return;
  if (allowed.includes("*") || allowed.includes(model)) return;
  throw new GatewayError(403, "invalid_request_error", `Key is not permitted to use model '${model}'`);
}
