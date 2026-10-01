import type { Database } from "../sql";
import { ulid, nowIso } from "../../utils/id";
import type { Provider, ProviderAccount, ProviderModel, ProviderType } from "../../shared/types";

export class ProvidersRepo {
  constructor(private db: Database) {}

  list(): Promise<Provider[]> {
    return this.db.query("SELECT * FROM providers ORDER BY priority ASC, name ASC").all<Provider>();
  }

  get(id: string): Promise<Provider | null> {
    return this.db.query("SELECT * FROM providers WHERE id = ?").get<Provider>(id);
  }

  getByName(name: string): Promise<Provider | null> {
    return this.db.query("SELECT * FROM providers WHERE lower(name) = lower(?)").get<Provider>(name);
  }

  async create(input: { name: string; displayName?: string | null; type: ProviderType; baseUrl?: string | null; enabled?: boolean; priority?: number; accountStrategy?: Provider["account_strategy"] }): Promise<Provider> {
    const id = ulid();
    await this.db
      .query("INSERT INTO providers (id, name, display_name, type, base_url, enabled, priority, account_strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.displayName ?? null, input.type, input.baseUrl ?? null, input.enabled === false ? 0 : 1, input.priority ?? 100, input.accountStrategy ?? "priority", nowIso(), nowIso());
    const provider = await this.get(id);
    if (!provider) throw new Error("Created provider could not be loaded");
    return provider;
  }

  async update(id: string, patch: Partial<{ name: string; displayName: string | null; type: ProviderType; baseUrl: string | null; enabled: boolean; priority: number; accountStrategy: Provider["account_strategy"] }>): Promise<Provider | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    await this.db
      .query("UPDATE providers SET name=?, display_name=?, type=?, base_url=?, enabled=?, priority=?, account_strategy=?, updated_at=? WHERE id=?")
      .run(
        patch.name ?? cur.name,
        patch.displayName !== undefined ? patch.displayName : cur.display_name,
        patch.type ?? cur.type,
        patch.baseUrl !== undefined ? patch.baseUrl : cur.base_url,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
        patch.priority ?? cur.priority,
        patch.accountStrategy ?? cur.account_strategy,
        nowIso(),
        id,
      );
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.db.query("DELETE FROM providers WHERE id = ?").run(id);
  }

  // ── accounts ──

  listAccounts(providerId: string): Promise<ProviderAccount[]> {
    return this.db
      .query("SELECT * FROM provider_accounts WHERE provider_id = ? ORDER BY priority ASC, created_at ASC")
      .all<ProviderAccount>(providerId);
  }

  getAccount(accId: string): Promise<ProviderAccount | null> {
    return this.db.query("SELECT * FROM provider_accounts WHERE id = ?").get<ProviderAccount>(accId);
  }

  async addAccount(providerId: string, input: { label: string; apiKey?: string; baseUrl?: string | null; priority?: number; authKind?: string; accountKind?: "oauth-browser" | "oauth-cli" | "api-key" | null; refreshToken?: string | null; accountId?: string | null }): Promise<ProviderAccount> {
    const id = ulid();
    await this.db
      .query("INSERT INTO provider_accounts (id, provider_id, label, api_key, base_url, priority, auth_kind, account_kind, refresh_token, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, providerId, input.label, input.apiKey ?? "", input.baseUrl ?? null, input.priority ?? 100, input.authKind ?? "api_key", input.accountKind ?? null, input.refreshToken ?? null, input.accountId ?? null, nowIso(), nowIso());
    const account = await this.getAccount(id);
    if (!account) throw new Error("Created provider account could not be loaded");
    return account;
  }

  async updateAccount(accId: string, patch: Partial<{ label: string; apiKey: string; baseUrl: string | null; priority: number; enabled: boolean; notes: string | null; tags: string | null; sessionCookie: string | null; planType: string | null; rateLimitedUntil: number | null; reauthRequired: boolean; reauthReason: string | null; lastWarmupAt: string | null; lastWarmupStatus: string | null; lastWarmupLatencyMs: number | null; lastWarmupDetail: string | null }>): Promise<ProviderAccount | null> {
    const cur = await this.getAccount(accId);
    if (!cur) return null;
    await this.db
      .query("UPDATE provider_accounts SET label=?, api_key=?, base_url=?, priority=?, enabled=?, notes=?, tags=?, session_cookie=?, plan_type=?, rate_limited_until=?, reauth_required=?, reauth_reason=?, last_warmup_at=?, last_warmup_status=?, last_warmup_latency_ms=?, last_warmup_detail=?, updated_at=? WHERE id=?")
      .run(
        patch.label ?? cur.label,
        patch.apiKey ?? cur.api_key,
        patch.baseUrl !== undefined ? patch.baseUrl : (cur.base_url ?? null),
        patch.priority ?? cur.priority,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
        patch.notes !== undefined ? patch.notes : (cur.notes ?? null),
        patch.tags !== undefined ? patch.tags : (cur.tags ?? null),
        patch.sessionCookie !== undefined ? patch.sessionCookie : (cur.session_cookie ?? null),
        patch.planType !== undefined ? patch.planType : (cur.plan_type ?? null),
        patch.rateLimitedUntil !== undefined ? patch.rateLimitedUntil : (cur.rate_limited_until ?? null),
        patch.reauthRequired !== undefined ? (patch.reauthRequired ? 1 : 0) : (cur.reauth_required ?? 0),
        patch.reauthReason !== undefined ? patch.reauthReason : (cur.reauth_reason ?? null),
        patch.lastWarmupAt !== undefined ? patch.lastWarmupAt : (cur.last_warmup_at ?? null),
        patch.lastWarmupStatus !== undefined ? patch.lastWarmupStatus : (cur.last_warmup_status ?? null),
        patch.lastWarmupLatencyMs !== undefined ? patch.lastWarmupLatencyMs : (cur.last_warmup_latency_ms ?? null),
        patch.lastWarmupDetail !== undefined ? patch.lastWarmupDetail : (cur.last_warmup_detail ?? null),
        nowIso(),
        accId,
      );
    return this.getAccount(accId);
  }

  // ── per-(account, model) cooldowns ──

  /** Model ids still cooling down for an account. Expired rows are pruned lazily. */
  listModelCooldowns(accountId: string): Promise<Array<{ model_id: string; until: number }>> {
    return this.db
      .query("SELECT model_id, until FROM account_model_cooldowns WHERE account_id = ? AND until > ?")
      .all<{ model_id: string; until: number }>(accountId, Date.now());
  }

  async isModelCoolingDown(accountId: string, modelId: string): Promise<boolean> {
    const row = await this.db
      .query("SELECT until FROM account_model_cooldowns WHERE account_id = ? AND model_id = ?")
      .get<{ until: number }>(accountId, modelId);
    if (!row) return false;
    if (row.until <= Date.now()) {
      await this.clearModelCooldown(accountId, modelId);
      return false;
    }
    return true;
  }

  async setModelCooldown(accountId: string, modelId: string, until: number, reason?: string | null): Promise<void> {
    const existing = await this.db.query("SELECT account_id FROM account_model_cooldowns WHERE account_id = ? AND model_id = ?").get<{ account_id: string }>(accountId, modelId);
    await this.db
      .query(
        existing
          ? "UPDATE account_model_cooldowns SET until = ?, reason = ?, updated_at = ? WHERE account_id = ? AND model_id = ?"
          : "INSERT INTO account_model_cooldowns (account_id, model_id, until, reason, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(...(existing
        ? [until, reason ?? null, nowIso(), accountId, modelId]
        : [accountId, modelId, until, reason ?? null, nowIso()]));
  }

  async clearModelCooldown(accountId: string, modelId: string): Promise<void> {
    await this.db.query("DELETE FROM account_model_cooldowns WHERE account_id = ? AND model_id = ?").run(accountId, modelId);
  }

  /** Drop every expired cooldown row. Returns how many were removed. */
  async purgeExpiredModelCooldowns(): Promise<number> {
    return (await this.db.query("DELETE FROM account_model_cooldowns WHERE until <= ?").run(Date.now())).changes;
  }

  async removeAccount(accId: string): Promise<void> {
    await this.db.query("DELETE FROM provider_accounts WHERE id = ?").run(accId);
  }

  async removeAllAccounts(providerId: string): Promise<number> {
    return (await this.db.query("DELETE FROM provider_accounts WHERE provider_id = ?").run(providerId)).changes;
  }

  /** Store OAuth token metadata for an account (ChatGPT login). */
  async updateAccountOAuth(accId: string, patch: { authKind?: string; accountKind?: "oauth-browser" | "oauth-cli" | "api-key" | null; refreshToken?: string | null; idToken?: string | null; accountId?: string | null; expiresAt?: number | null }): Promise<void> {
    const cur = await this.getAccount(accId) as (ProviderAccount & { auth_kind?: string; account_kind?: string | null; refresh_token?: string | null; id_token?: string | null; account_id?: string | null; expires_at?: number | null }) | null;
    if (!cur) return;
    await this.db
      .query("UPDATE provider_accounts SET auth_kind=?, account_kind=?, refresh_token=?, id_token=?, account_id=?, expires_at=?, reauth_required=0, reauth_reason=NULL, updated_at=? WHERE id=?")
      .run(
        patch.authKind ?? cur.auth_kind ?? "api_key",
        (patch.accountKind !== undefined ? patch.accountKind : (cur.account_kind ?? null)) ?? null,
        (patch.refreshToken !== undefined ? patch.refreshToken : cur.refresh_token) ?? null,
        (patch.idToken !== undefined ? patch.idToken : cur.id_token) ?? null,
        (patch.accountId !== undefined ? patch.accountId : cur.account_id) ?? null,
        (patch.expiresAt !== undefined ? patch.expiresAt : cur.expires_at) ?? null,
        nowIso(),
        accId,
      );
  }

  // ── models ──

  listModels(providerId: string): Promise<ProviderModel[]> {
    return this.db
      .query("SELECT * FROM provider_models WHERE provider_id = ? ORDER BY model_id ASC")
      .all<ProviderModel>(providerId);
  }

  listAllModels(): Promise<ProviderModel[]> {
    return this.db.query("SELECT * FROM provider_models ORDER BY model_id ASC").all<ProviderModel>();
  }

  async findModel(modelId: string): Promise<Array<ProviderModel & { provider: Provider }>> {
    const rows = await this.db
      .query(
        `SELECT pm.*, p.id as p_id, p.name as p_name, p.type as p_type, p.base_url as p_base_url, p.enabled as p_enabled, p.priority as p_priority, p.account_strategy as p_account_strategy
         FROM provider_models pm JOIN providers p ON p.id = pm.provider_id
         WHERE pm.model_id = ? AND pm.enabled = 1 AND p.enabled = 1
         ORDER BY p.priority ASC`,
      )
      .all<Record<string, unknown>>(modelId);
    return rows.map((row) => this.hydrateModel(row));
  }

  findProviderModel(providerId: string, modelId: string): Promise<ProviderModel | null> {
    return this.db
      .query("SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ? AND enabled = 1")
      .get<ProviderModel>(providerId, modelId);
  }

  getProviderModel(providerId: string, modelId: string): Promise<ProviderModel | null> {
    return this.db
      .query("SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?")
      .get<ProviderModel>(providerId, modelId);
  }

  private hydrateModel(row: Record<string, unknown>): ProviderModel & { provider: Provider } {
    return {
      id: row.id,
      provider_id: row.provider_id,
      model_id: row.model_id,
      display_name: row.display_name,
      enabled: row.enabled,
      context_length: row.context_length,
      max_output_tokens: row.max_output_tokens,
      capabilities: row.capabilities,
      credit_rate: row.credit_rate,
      credit_unit: row.credit_unit,
      provider: {
        id: row.p_id,
        name: row.p_name,
        type: row.p_type,
        base_url: row.p_base_url,
        enabled: row.p_enabled,
        priority: row.p_priority,
        account_strategy: row.p_account_strategy,
        created_at: "",
        updated_at: "",
      },
    } as ProviderModel & { provider: Provider };
  }

  async upsertModel(providerId: string, modelId: string, patch?: Partial<{ displayName: string | null; enabled: boolean; contextLength: number | null; maxOutputTokens: number | null; capabilities: string[] | null; creditRate: number | null; creditUnit: ProviderModel["credit_unit"]; source: "manual" | "sync" }>): Promise<void> {
    const caps = patch?.capabilities !== undefined ? (patch.capabilities ? JSON.stringify(patch.capabilities) : null) : undefined;
    const existing = await this.db
      .query("SELECT id FROM provider_models WHERE provider_id = ? AND model_id = ?")
      .get<{ id: string }>(providerId, modelId);
    if (existing) {
      const cur = await this.db.query("SELECT * FROM provider_models WHERE id = ?").get<ProviderModel>(existing.id);
      if (!cur) throw new Error("Provider model disappeared during update");
      const isSync = patch?.source === "sync";
      await this.db
        .query("UPDATE provider_models SET display_name=?, enabled=?, context_length=?, max_output_tokens=?, capabilities=?, credit_rate=?, credit_unit=?, source=? WHERE id=?")
        .run(
          patch?.displayName ?? cur.display_name,
          patch?.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
          patch?.contextLength !== undefined && !(isSync && patch.contextLength === null) ? patch.contextLength : cur.context_length,
          patch?.maxOutputTokens !== undefined && !(isSync && patch.maxOutputTokens === null) ? patch.maxOutputTokens : cur.max_output_tokens,
          caps !== undefined && !(isSync && !patch?.capabilities?.length) ? caps : cur.capabilities,
          patch?.creditRate !== undefined ? patch.creditRate : cur.credit_rate,
          patch?.creditUnit !== undefined ? patch.creditUnit : cur.credit_unit,
          cur.source === "manual" ? "manual" : (patch?.source ?? cur.source),
          existing.id,
        );
    } else {
      await this.db
        .query("INSERT INTO provider_models (id, provider_id, model_id, display_name, enabled, context_length, max_output_tokens, capabilities, credit_rate, credit_unit, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          ulid(),
          providerId,
          modelId,
          patch?.displayName ?? null,
          patch?.enabled === false ? 0 : 1,
          patch?.contextLength ?? null,
          patch?.maxOutputTokens ?? null,
          caps !== undefined ? caps : null,
          patch?.creditRate ?? null,
          patch?.creditUnit ?? null,
          patch?.source ?? "manual",
        );
    }
  }

  replaceSyncedModels(providerId: string, models: Array<{ id: string; contextLength: number | null; maxOutputTokens: number | null; capabilities: string[] | null }>, prune = false): Promise<number> {
    const kept = new Set(models.map((model) => model.id));
    return this.db.transaction(async (tx) => {
      const repo = new ProvidersRepo(tx);
      for (const model of models) {
        await repo.upsertModel(providerId, model.id, {
          contextLength: model.contextLength,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: model.capabilities,
          source: "sync",
        });
      }
      if (!prune) return 0;
      let pruned = 0;
      for (const existing of await repo.listModels(providerId)) {
        if (existing.source === "sync" && !kept.has(existing.model_id)) {
          await repo.removeModel(providerId, existing.model_id);
          pruned++;
        }
      }
      return pruned;
    })();
  }

  async removeModel(providerId: string, modelId: string): Promise<void> {
    await this.db.query("DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?").run(providerId, modelId);
  }
}
