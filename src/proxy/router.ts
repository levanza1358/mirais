import type { RouteCandidate, ResolvedRoute, Provider, ProviderAccount, RoutingPolicy } from "../shared/types";
import type { ProvidersRepo } from "../store/repos/providers";
import type { AliasesRepo, CombosRepo } from "../store/repos/routing";
import { GatewayError } from "../shared/errors";

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  blackbox: "https://api.blackbox.ai/v1",
  "codebuddy-global": "https://www.codebuddy.ai/v2",
  "codebuddy-cn": "https://copilot.tencent.com/v2",
};

const PROVIDER_SHORT_ALIASES: Record<string, string> = {
  cbc: "codebuddy-cn",
  cbg: "codebuddy-global",
};

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
    return this.resolveWithPolicy(model, {
      mode: "balanced",
      preferProviders: [],
      denyProviders: [],
      denyModels: [],
      maxAttempts: 3,
      respectPriority: true,
    }, forbidden);
  }

  resolveWithPolicy(model: string, policy: RoutingPolicy, forbidden: Set<string> = new Set()): ResolvedRoute {
    // 1. qualified provider/model
    if (model.includes("/")) {
      const [providerName, ...rest] = model.split("/");
      const modelId = rest.join("/");
      const resolvedProviderName = providerName ? (PROVIDER_SHORT_ALIASES[providerName] ?? providerName) : undefined;
      const provider = resolvedProviderName ? this.providers.getByName(resolvedProviderName) : undefined;
      if (provider && provider.enabled) {
        if (policy.denyProviders.includes(provider.name) || policy.denyModels.includes(modelId)) {
          throw new GatewayError(403, "invalid_request_error", `Model '${model}' is blocked by routing policy`);
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
      // Try short-id resolution (e.g. "bb/gpt-5.4" → "blackboxai/openai/gpt-5.4")
      if (providerName && modelId) {
        const shortMatch = this.providers.findModelByShortId(providerName, modelId);
        if (shortMatch.length) {
          const raw = shortMatch.map((m) => ({
            provider: m.provider,
            modelId: m.model_id,
            accounts: this.pickAccounts(m.provider),
          }));
          const candidates = this.sortCandidates(this.filterCandidates(raw, policy), policy);
          return { kind: "direct", requested: model, candidates };
        }
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
    const combo = this.combos.getByName(model);
    if (combo) {
      const candidates: RouteCandidate[] = [];
      const seen = new Set(forbidden);
      seen.add(`combo:${combo.name}`);
      for (const entry of combo.entries) {
        try {
          const r = this.resolveWithPolicy(entry.target, policy, new Set(seen));
          candidates.push(...r.candidates);
        } catch {
          // skip unresolvable entry
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
      if (account.last_warmup_status === "healthy") healthy.push(account);
      else if (!account.last_warmup_status) unknown.push(account);
      else degraded.push(account);
    }

    return [...healthy, ...unknown, ...degraded];
  }
}
