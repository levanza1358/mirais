import type { Database } from "../sql";
import { ulid, sha256Hex, randomApiKey, nowIso } from "../../utils/id";
import type { GatewayKey } from "../../shared/types";

export class KeysRepo {
  constructor(private db: Database) {}

  list(): Promise<Array<Omit<GatewayKey, "key_hash">>> {
    return this.db
      .query(
        `SELECT id, label, key_prefix, key_plain, enabled, allowed_models, rate_limit_rpm, concurrency,
                daily_token_budget, token_budget, expires_at, created_at, last_used_at
         FROM gateway_keys ORDER BY created_at DESC`,
      )
      .all<Omit<GatewayKey, "key_hash">>();
  }

  get(id: string): Promise<GatewayKey | null> {
    return this.db.query("SELECT * FROM gateway_keys WHERE id = ?").get<GatewayKey>(id);
  }

  async getByPlaintextKey(key: string): Promise<GatewayKey | null> {
    // Primary lookup: plaintext column. Legacy fallback: sha256 hash for
    // databases that predate the 0021 migration.
    const byPlain = await this.db.query("SELECT * FROM gateway_keys WHERE key_plain = ?").get<GatewayKey>(key);
    if (byPlain) return byPlain;
    const hash = sha256Hex(key);
    return this.db.query("SELECT * FROM gateway_keys WHERE key_hash = ?").get<GatewayKey>(hash);
  }

  create(input: {
    label: string;
    allowedModels?: string[] | null;
    rateLimitRpm?: number | null;
    concurrency?: number | null;
    dailyTokenBudget?: number | null;
    tokenBudget?: number | null;
    expiresAt?: string | null;
  }): Promise<{ record: GatewayKey; plaintext: string }> {
    const plaintext = randomApiKey();
    const id = ulid();
    return this.db
      .query(
        `INSERT INTO gateway_keys (id, label, key_hash, key_plain, key_prefix, allowed_models, rate_limit_rpm, concurrency, daily_token_budget, token_budget, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.label,
        sha256Hex(plaintext),
        plaintext,
        plaintext.slice(0, 12),
        input.allowedModels ? JSON.stringify(input.allowedModels) : null,
        input.rateLimitRpm ?? null,
        input.concurrency ?? null,
        input.dailyTokenBudget ?? null,
        input.tokenBudget ?? null,
        input.expiresAt ?? null,
        nowIso(),
      ).then(async () => {
        const record = await this.get(id);
        if (!record) throw new Error("Created gateway key could not be loaded");
        return { record, plaintext };
      });
  }

  async rotate(id: string): Promise<{ record: GatewayKey; plaintext: string } | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    const plaintext = randomApiKey();
    await this.db
      .query("UPDATE gateway_keys SET key_hash = ?, key_plain = ?, key_prefix = ? WHERE id = ?")
      .run(sha256Hex(plaintext), plaintext, plaintext.slice(0, 12), id);
    const record = await this.get(id);
    if (!record) throw new Error("Rotated gateway key could not be loaded");
    return { record, plaintext };
  }

  update(id: string, patch: Partial<{
    label: string;
    allowedModels: string[] | null;
    rateLimitRpm: number | null;
    concurrency: number | null;
    dailyTokenBudget: number | null;
    tokenBudget: number | null;
    expiresAt: string | null;
    enabled: boolean;
  }>): Promise<GatewayKey | null> {
    return this.get(id).then(async (cur) => {
    if (!cur) return null;
    await this.db
      .query(
        `UPDATE gateway_keys SET label=?, allowed_models=?, rate_limit_rpm=?, concurrency=?, daily_token_budget=?, token_budget=?, expires_at=?, enabled=? WHERE id=?`,
      )
      .run(
        patch.label ?? cur.label,
        patch.allowedModels !== undefined ? (patch.allowedModels ? JSON.stringify(patch.allowedModels) : null) : cur.allowed_models,
        patch.rateLimitRpm !== undefined ? patch.rateLimitRpm : cur.rate_limit_rpm,
        patch.concurrency !== undefined ? patch.concurrency : cur.concurrency,
        patch.dailyTokenBudget !== undefined ? patch.dailyTokenBudget : cur.daily_token_budget,
        patch.tokenBudget !== undefined ? patch.tokenBudget : cur.token_budget,
        patch.expiresAt !== undefined ? patch.expiresAt : cur.expires_at,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
        id,
      );
    return this.get(id);
    });
  }

  async remove(id: string): Promise<void> {
    await this.db.query("DELETE FROM gateway_keys WHERE id = ?").run(id);
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.db.query("UPDATE gateway_keys SET last_used_at = ? WHERE id = ?").run(nowIso(), id);
  }
}
