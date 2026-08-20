import type { Database } from "bun:sqlite";
import { ulid, nowIso } from "../../utils/id";
import type { Provider, ProviderAccount, ProviderModel, ProviderType } from "../../shared/types";

export class ProvidersRepo {
  constructor(private db: Database) {}

  list(): Provider[] {
    return this.db.query("SELECT * FROM providers ORDER BY priority ASC, name ASC").all() as Provider[];
  }

  get(id: string): Provider | null {
    return (this.db.query("SELECT * FROM providers WHERE id = ?").get(id) as Provider) ?? null;
  }

  getByName(name: string): Provider | null {
    return (this.db.query("SELECT * FROM providers WHERE lower(name) = lower(?)").get(name) as Provider) ?? null;
  }

  create(input: { name: string; type: ProviderType; baseUrl?: string | null; enabled?: boolean; priority?: number; accountStrategy?: Provider["account_strategy"] }): Provider {
    const id = ulid();
    this.db
      .query("INSERT INTO providers (id, name, type, base_url, enabled, priority, account_strategy) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.type, input.baseUrl ?? null, input.enabled === false ? 0 : 1, input.priority ?? 100, input.accountStrategy ?? "priority");
    return this.get(id)!;
  }

  update(id: string, patch: Partial<{ name: string; type: ProviderType; baseUrl: string | null; enabled: boolean; priority: number; accountStrategy: Provider["account_strategy"] }>): Provider | null {
    const cur = this.get(id);
    if (!cur) return null;
    this.db
      .query("UPDATE providers SET name=?, type=?, base_url=?, enabled=?, priority=?, account_strategy=?, updated_at=? WHERE id=?")
      .run(
        patch.name ?? cur.name,
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

  remove(id: string) {
    this.db.query("DELETE FROM providers WHERE id = ?").run(id);
  }

  // ── accounts ──

  listAccounts(providerId: string): ProviderAccount[] {
    return this.db
      .query("SELECT * FROM provider_accounts WHERE provider_id = ? ORDER BY priority ASC, created_at ASC")
      .all(providerId) as ProviderAccount[];
  }

  getAccount(accId: string): ProviderAccount | null {
    return (this.db.query("SELECT * FROM provider_accounts WHERE id = ?").get(accId) as ProviderAccount) ?? null;
  }

  addAccount(providerId: string, input: { label: string; apiKey?: string; baseUrl?: string | null; priority?: number }): ProviderAccount {
    const id = ulid();
    this.db
      .query("INSERT INTO provider_accounts (id, provider_id, label, api_key, base_url, priority) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, providerId, input.label, input.apiKey ?? "", input.baseUrl ?? null, input.priority ?? 100);
    return this.getAccount(id)!;
  }

  updateAccount(accId: string, patch: Partial<{ label: string; apiKey: string; baseUrl: string | null; priority: number; enabled: boolean; notes: string | null; tags: string | null; sessionCookie: string | null; planType: string | null; rateLimitedUntil: number | null; lastWarmupAt: string | null; lastWarmupStatus: string | null; lastWarmupLatencyMs: number | null; lastWarmupDetail: string | null }>): ProviderAccount | null {
    const cur = this.getAccount(accId);
    if (!cur) return null;
    this.db
      .query("UPDATE provider_accounts SET label=?, api_key=?, base_url=?, priority=?, enabled=?, notes=?, tags=?, session_cookie=?, plan_type=?, rate_limited_until=?, last_warmup_at=?, last_warmup_status=?, last_warmup_latency_ms=?, last_warmup_detail=?, updated_at=? WHERE id=?")
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
        patch.lastWarmupAt !== undefined ? patch.lastWarmupAt : (cur.last_warmup_at ?? null),
        patch.lastWarmupStatus !== undefined ? patch.lastWarmupStatus : (cur.last_warmup_status ?? null),
        patch.lastWarmupLatencyMs !== undefined ? patch.lastWarmupLatencyMs : (cur.last_warmup_latency_ms ?? null),
        patch.lastWarmupDetail !== undefined ? patch.lastWarmupDetail : (cur.last_warmup_detail ?? null),
        nowIso(),
        accId,
      );
    return this.getAccount(accId);
  }

  removeAccount(accId: string) {
    this.db.query("DELETE FROM provider_accounts WHERE id = ?").run(accId);
  }

  removeAllAccounts(providerId: string): number {
    return this.db.query("DELETE FROM provider_accounts WHERE provider_id = ?").run(providerId).changes;
  }

  /** Store OAuth token metadata for an account (ChatGPT login). */
  updateAccountOAuth(accId: string, patch: { authKind?: string; refreshToken?: string | null; idToken?: string | null; accountId?: string | null; expiresAt?: number | null }): void {
    const cur = this.getAccount(accId) as (ProviderAccount & { auth_kind?: string; refresh_token?: string | null; id_token?: string | null; account_id?: string | null; expires_at?: number | null }) | null;
    if (!cur) return;
    this.db
      .query("UPDATE provider_accounts SET auth_kind=?, refresh_token=?, id_token=?, account_id=?, expires_at=?, updated_at=? WHERE id=?")
      .run(
        patch.authKind ?? cur.auth_kind ?? "api_key",
        (patch.refreshToken !== undefined ? patch.refreshToken : cur.refresh_token) ?? null,
        (patch.idToken !== undefined ? patch.idToken : cur.id_token) ?? null,
        (patch.accountId !== undefined ? patch.accountId : cur.account_id) ?? null,
        (patch.expiresAt !== undefined ? patch.expiresAt : cur.expires_at) ?? null,
        nowIso(),
        accId,
      );
  }

  // ── models ──

  listModels(providerId: string): ProviderModel[] {
    return this.db
      .query("SELECT * FROM provider_models WHERE provider_id = ? ORDER BY model_id ASC")
      .all(providerId) as ProviderModel[];
  }

  listAllModels(): ProviderModel[] {
    return this.db.query("SELECT * FROM provider_models ORDER BY model_id ASC").all() as ProviderModel[];
  }

  findModel(modelId: string): Array<ProviderModel & { provider: Provider }> {
    const rows = this.db
      .query(
        `SELECT pm.*, p.id as p_id, p.name as p_name, p.type as p_type, p.base_url as p_base_url, p.enabled as p_enabled, p.priority as p_priority, p.account_strategy as p_account_strategy
         FROM provider_models pm JOIN providers p ON p.id = pm.provider_id
         WHERE pm.model_id = ? AND pm.enabled = 1 AND p.enabled = 1
         ORDER BY p.priority ASC`,
      )
      .all(modelId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateModel(row));
  }

  findProviderModel(providerId: string, modelId: string): ProviderModel | null {
    return (this.db
      .query("SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ? AND enabled = 1")
      .get(providerId, modelId) as ProviderModel) ?? null;
  }

  getProviderModel(providerId: string, modelId: string): ProviderModel | null {
    return (this.db
      .query("SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?")
      .get(providerId, modelId) as ProviderModel) ?? null;
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

  upsertModel(providerId: string, modelId: string, patch?: Partial<{ displayName: string | null; enabled: boolean; contextLength: number | null; maxOutputTokens: number | null; capabilities: string[] | null; creditRate: number | null; creditUnit: ProviderModel["credit_unit"]; source: "manual" | "sync" }>): void {
    const caps = patch?.capabilities !== undefined ? (patch.capabilities ? JSON.stringify(patch.capabilities) : null) : undefined;
    const existing = this.db
      .query("SELECT id FROM provider_models WHERE provider_id = ? AND model_id = ?")
      .get(providerId, modelId) as { id: string } | null;
    if (existing) {
      const cur = this.db.query("SELECT * FROM provider_models WHERE id = ?").get(existing.id) as ProviderModel;
      this.db
        .query("UPDATE provider_models SET display_name=?, enabled=?, context_length=?, max_output_tokens=?, capabilities=?, credit_rate=?, credit_unit=?, source=? WHERE id=?")
        .run(
          patch?.displayName ?? cur.display_name,
          patch?.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
          patch?.contextLength !== undefined ? patch.contextLength : cur.context_length,
          patch?.maxOutputTokens !== undefined ? patch.maxOutputTokens : cur.max_output_tokens,
          caps !== undefined ? caps : cur.capabilities,
          patch?.creditRate !== undefined ? patch.creditRate : cur.credit_rate,
          patch?.creditUnit !== undefined ? patch.creditUnit : cur.credit_unit,
          cur.source === "manual" ? "manual" : (patch?.source ?? cur.source),
          existing.id,
        );
    } else {
      this.db
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

  replaceSyncedModels(providerId: string, models: Array<{ id: string; contextLength: number | null; maxOutputTokens: number | null; capabilities: string[] | null }>): number {
    const kept = new Set(models.map((model) => model.id));
    return this.db.transaction(() => {
      for (const model of models) {
        this.upsertModel(providerId, model.id, {
          contextLength: model.contextLength,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: model.capabilities,
          source: "sync",
        });
      }
      let pruned = 0;
      for (const existing of this.listModels(providerId)) {
        if (existing.source === "sync" && !kept.has(existing.model_id)) {
          this.removeModel(providerId, existing.model_id);
          pruned++;
        }
      }
      return pruned;
    })();
  }

  removeModel(providerId: string, modelId: string) {
    this.db.query("DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?").run(providerId, modelId);
  }
}
