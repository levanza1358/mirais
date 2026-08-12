import type { RouteCandidate, ResolvedRoute, Provider, ProviderAccount, RoutingPolicy } from "../shared/types";
import type { ProvidersRepo } from "../store/repos/providers";
import type { AliasesRepo, CombosRepo } from "../store/repos/routing";
import { GatewayError } from "../shared/errors";

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://cli-chat-proxy.grok.com/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  blackbox: "https://api.blackbox.ai/v1",
  "codebuddy-global": "https://www.codebuddy.ai/v2",
  "codebuddy-cn": "https://copilot.tencent.com/v2",
};

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  mode: "balanced",
  preferProviders: [],
  denyProviders: [],
  denyModels: [],
  maxAttempts: 3,
  respectPriority: true,
};

export function normalizeRoutingPolicy(policy?: Partial<RoutingPolicy> | null): RoutingPolicy {
  return {
    ...DEFAULT_ROUTING_POLICY,
    ...policy,
    preferProviders: policy?.preferProviders ?? [],
    denyProviders: policy?.denyProviders ?? [],
    denyModels: policy?.denyModels ?? [],
  };
}

export function baseUrlFor(provider: Provider): string {
  return provider.base_url ?? DEFAULT_BASE_URLS[provider.type] ?? "https://api.openai.com/v1";
}

export function upstreamFormat(provider: Provider): "openai" | "anthropic" {
  return provider.type === "anthropic" ? "anthropic" : "openai";
}

export class Router {
  constructor(
    private providers: ProvidersRepo,
    private aliases: AliasesRepo,
    private combos: CombosRepo,
  ) {}

  resolve(model: string, forbidden: Set<string> = new Set()): ResolvedRoute {
    return this.resolveWithPolicy(model, DEFAULT_ROUTING_POLICY, forbidden);
  }

  resolveWithPolicy(model: string, policy: RoutingPolicy, forbidden: Set<string> = new Set()): ResolvedRoute {
    policy = normalizeRoutingPolicy(policy);
    // 1. qualified provider/model
    if (model.includes("/")) {
      const [providerName, ...rest] = model.split("/");
      const modelId = rest.join("/");
      const provider = providerName ? this.providers.getByName(providerName) : undefined;
      if (provider && provider.enabled) {
        if (policy.denyProviders.includes(provider.name) || policy.denyModels.includes(modelId)) {
          throw new GatewayError(403, "invalid_request_error", `Model '${model}' is blocked by routing policy`);
        }
        if (!this.providers.findProviderModel(provider.id, modelId)) {
          throw new GatewayError(404, "not_found_error", `Model '${modelId}' not found or disabled for provider '${provider.name}'`);
        }
        const accounts = this.pickAccounts(provider);
        return { kind: "qualified", requested: model, candidates: [{ provider, modelId, accounts }] };
      }
      // Fallback: the first segment isn't a known provider — the whole string
      // may itself be a registered model id (e.g. BlackBoxAI ids look like
      // "blackboxai/meta/llama-3.1-70b"). Try direct model resolution below
      // before giving up with a provider-not-found error.
      const direct = this.providers.findModel(model);
      if (direct.length) {
        const raw = direct.map((m) => ({
          provider: m.provider,
          modelId: m.model_id,
          accounts: this.pickAccounts(m.provider),
        }));
        const candidates = this.sortCandidates(this.filterCandidates(raw, policy), policy);
        return { kind: "direct", requested: model, candidates };
      }
      throw new GatewayError(404, "not_found_error", `Provider '${providerName}' not found or disabled`);
    }

    // 2. alias
    const alias = this.aliases.getByAlias(model);
    if (alias) {
      if (forbidden.has(`alias:${alias.alias}`)) {
        throw new GatewayError(400, "invalid_request_error", `Alias '${model}' resolves into a cycle`);
      }
      forbidden.add(`alias:${alias.alias}`);
      const inner = this.resolveWithPolicy(alias.target, policy, forbidden);
      return { kind: "alias", requested: model, candidates: inner.candidates };
    }

    // 3. combo
    const comboName = model.startsWith("combo:") ? model.slice("combo:".length) : model;
    const combo = this.combos.getByName(comboName);
    if (combo) {
      const marker = `combo:${combo.name}`;
      if (forbidden.has(marker)) {
        throw new GatewayError(400, "invalid_request_error", `Combo '${model}' resolves into a cycle`);
      }
      const candidates: RouteCandidate[] = [];
      const seen = new Set(forbidden);
      seen.add(marker);
      for (const entry of combo.entries) {
        try {
          const r = this.resolveWithPolicy(entry.target, policy, new Set(seen));
          candidates.push(...r.candidates);
        } catch (error) {
          if (!(error instanceof GatewayError) || error.status === 400 || error.status === 403) throw error;
          // Skip unavailable entries so the next combo target can be tried.
        }
      }
      if (!candidates.length) {
        throw new GatewayError(503, "server_error", `Combo '${model}' has no usable entries`);
      }
      return { kind: "combo", requested: model, candidates };
    }

    // 4. direct model id across providers
    const matches = this.providers.findModel(model);
    if (!matches.length) {
      throw new GatewayError(
        404,
        "not_found_error",
        `Model '${model}' not found. Add it under a provider, or create an alias.`,
      );
    }
    const raw = matches.map((m) => ({
      provider: m.provider,
      modelId: m.model_id,
      accounts: this.pickAccounts(m.provider),
    }));
    const candidates = this.sortCandidates(this.filterCandidates(raw, policy), policy);
    if (!candidates.length) {
      throw new GatewayError(404, "not_found_error", `Model '${model}' is unavailable under current routing policy.`);
    }
    return { kind: "direct", requested: model, candidates };
  }

  private filterCandidates(candidates: RouteCandidate[], policy: RoutingPolicy): RouteCandidate[] {
    return candidates.filter((candidate) => !policy.denyProviders.includes(candidate.provider.name) && !policy.denyModels.includes(candidate.modelId));
  }

  private sortCandidates(candidates: RouteCandidate[], policy: RoutingPolicy): RouteCandidate[] {
    const preferred = new Map(policy.preferProviders.map((name, index) => [name, index]));
    return [...candidates].sort((a, b) => {
      const ap = preferred.has(a.provider.name) ? preferred.get(a.provider.name)! : Number.MAX_SAFE_INTEGER;
      const bp = preferred.has(b.provider.name) ? preferred.get(b.provider.name)! : Number.MAX_SAFE_INTEGER;
      if (ap !== bp) return ap - bp;
      if (policy.respectPriority && a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
      if (policy.mode === "priority") return a.provider.priority - b.provider.priority;
      return a.provider.name.localeCompare(b.provider.name) || a.modelId.localeCompare(b.modelId);
    });
  }

  private pickAccounts(provider: Provider): ProviderAccount[] {
    const healthy: ProviderAccount[] = [];
    const unknown: ProviderAccount[] = [];
    const degraded: ProviderAccount[] = [];

    const accounts = this.providers
      .listAccounts(provider.id)
      .filter((a) => a.enabled)
      .sort((a, b) => a.priority - b.priority);
    if (!accounts.length) {
      throw new GatewayError(503, "server_error", `Provider '${provider.name}' has no enabled accounts`);
    }

    for (const account of accounts) {
      const until = account.rate_limited_until;
      if (until != null && until > Date.now()) {
        // Still inside the persisted rate-limit window — keep it out of
        // rotation entirely so only healthy accounts get traffic.
        continue;
      }
      if (until != null && until <= Date.now()) {
        // Window passed — recover automatically without a warmup ping.
        this.providers.updateAccount(account.id, {
          rateLimitedUntil: null,
          lastWarmupStatus: "healthy",
          lastWarmupDetail: null,
        });
      }
      if (account.last_warmup_status === "healthy") healthy.push(account);
      else if (!account.last_warmup_status) unknown.push(account);
      else degraded.push(account);
    }

    return [...healthy, ...unknown, ...degraded];
  }
}
