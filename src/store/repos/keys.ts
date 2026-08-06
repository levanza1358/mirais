import type { Database } from "bun:sqlite";
import { ulid, sha256Hex, randomApiKey, nowIso } from "../../utils/id";
import type { GatewayKey } from "../../shared/types";

export class KeysRepo {
  constructor(private db: Database) {}

  list(): Array<Omit<GatewayKey, "key_hash">> {
    return this.db
      .query(
        `SELECT id, label, key_prefix, enabled, allowed_models, rate_limit_rpm, concurrency,
                daily_token_budget, expires_at, created_at, last_used_at
         FROM gateway_keys ORDER BY created_at DESC`,
      )
      .all() as Array<Omit<GatewayKey, "key_hash">>;
  }

  get(id: string): GatewayKey | null {
    return (this.db.query("SELECT * FROM gateway_keys WHERE id = ?").get(id) as GatewayKey) ?? null;
  }

  getByPlaintextKey(key: string): GatewayKey | null {
    const hash = sha256Hex(key);
    return (this.db.query("SELECT * FROM gateway_keys WHERE key_hash = ?").get(hash) as GatewayKey) ?? null;
  }

  create(input: {
    label: string;
    allowedModels?: string[] | null;
    rateLimitRpm?: number | null;
    concurrency?: number | null;
    dailyTokenBudget?: number | null;
    expiresAt?: string | null;
  }): { record: GatewayKey; plaintext: string } {
    const existing = this.db.query("SELECT id FROM gateway_keys LIMIT 1").get() as { id: string } | null;
    if (existing) {
      throw new Error("Only one global API key is allowed");
    }
    const plaintext = randomApiKey();
    const id = ulid();
    this.db
      .query(
        `INSERT INTO gateway_keys (id, label, key_hash, key_prefix, allowed_models, rate_limit_rpm, concurrency, daily_token_budget, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.label,
        sha256Hex(plaintext),
        plaintext.slice(0, 12),
        input.allowedModels ? JSON.stringify(input.allowedModels) : null,
        input.rateLimitRpm ?? null,
        input.concurrency ?? null,
        input.dailyTokenBudget ?? null,
        input.expiresAt ?? null,
      );
    return { record: this.get(id)!, plaintext };
  }

  rotate(id: string): { record: GatewayKey; plaintext: string } | null {
    const cur = this.get(id);
    if (!cur) return null;
    const plaintext = randomApiKey();
    this.db
      .query("UPDATE gateway_keys SET key_hash = ?, key_prefix = ? WHERE id = ?")
      .run(sha256Hex(plaintext), plaintext.slice(0, 12), id);
    return { record: this.get(id)!, plaintext };
  }

  update(id: string, patch: Partial<{
    label: string;
    allowedModels: string[] | null;
    rateLimitRpm: number | null;
    concurrency: number | null;
    dailyTokenBudget: number | null;
    expiresAt: string | null;
    enabled: boolean;
  }>): GatewayKey | null {
    const cur = this.get(id);
    if (!cur) return null;
    this.db
      .query(
        `UPDATE gateway_keys SET label=?, allowed_models=?, rate_limit_rpm=?, concurrency=?, daily_token_budget=?, expires_at=?, enabled=? WHERE id=?`,
      )
      .run(
        patch.label ?? cur.label,
        patch.allowedModels !== undefined ? (patch.allowedModels ? JSON.stringify(patch.allowedModels) : null) : cur.allowed_models,
        patch.rateLimitRpm !== undefined ? patch.rateLimitRpm : cur.rate_limit_rpm,
        patch.concurrency !== undefined ? patch.concurrency : cur.concurrency,
        patch.dailyTokenBudget !== undefined ? patch.dailyTokenBudget : cur.daily_token_budget,
        patch.expiresAt !== undefined ? patch.expiresAt : cur.expires_at,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
        id,
      );
    return this.get(id);
  }

  remove(id: string) {
    this.db.query("DELETE FROM gateway_keys WHERE id = ?").run(id);
  }

  touchLastUsed(id: string) {
    this.db.query("UPDATE gateway_keys SET last_used_at = ? WHERE id = ?").run(nowIso(), id);
  }
}
