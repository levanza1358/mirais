import type { Database } from "bun:sqlite";
import type { GatewayKey } from "./shared/types";
import { GatewayError } from "./shared/errors";
import { KeysRepo } from "./store/repos/keys";
import { ProvidersRepo } from "./store/repos/providers";
import { isExpired, allowedModels } from "./ratelimit";
import { log } from "./utils/logger";

export function authenticateGatewayKey(db: Database, authHeader: string | null): GatewayKey {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new GatewayError(401, "authentication_error", "Missing Authorization: Bearer <key> header");
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    throw new GatewayError(401, "authentication_error", "Empty API key");
  }
  const repo = new KeysRepo(db);
  const key = repo.getByPlaintextKey(token);
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
  repo.touchLastUsed(key.id);
  return key;
}

export function authorizeModel(key: GatewayKey, model: string, _db?: Database): void {
  const allowed = allowedModels(key);
  if (allowed === null) return;
  if (allowed.includes("*") || allowed.includes(model)) return;
  throw new GatewayError(403, "invalid_request_error", `Key is not permitted to use model '${model}'`);
}
