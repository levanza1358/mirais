/**
 * Combo presets — curated fallback templates inspired by 9router's combo
 * library ("maximize-subscription", "always-on", "free-forever", …). Each
 * preset is a named, ordered list of model-target slots. Some slots are
 * literal `provider/model` strings; others are tags like
 * `{subscription-gpt}` that the resolver expands at apply-time by walking
 * the operators' providers list.
 *
 * The resolver is deterministic — same providers list, same output. Tags
 * that no enabled provider matches stay as `null` and the apply endpoint
 * returns 422 so the operator can fix the chain (either enable a matching
 * provider or pass `overrides`).
 */
import type { Provider, ProviderModel, ProviderAccount } from "../shared/types";

export type ComboSlot =
  | { kind: "literal"; model: string }
  | { kind: "tag"; tag: ComboSlotTag; fallback?: string[] };

export type ComboSlotTag =
  | "subscription-gpt" | "subscription-claude"
  | "cheap-claude" | "cheap-gpt"
  | "free-claude-or-gpt" | "free-claude" | "free-gpt" | "free-emergency"
  | "oauth-cli-codex" | "oauth-browser-gpt"
  | "primary" | "secondary" | "tertiary";

export interface ComboPreset {
  id: string;
  label: string;
  description: string;
  strategy: "sequential" | "round_robin";
  targets: ComboSlot[];
}

/** Curated preset catalogue — keep this small and high-quality. */
export const COMBO_PRESETS: ComboPreset[] = [
  {
    id: "maximize-subscription",
    label: "Maximize subscription",
    description: "Use your ChatGPT/Claude subscription first, cheap API backup, free tier last.",
    strategy: "sequential",
    targets: [
      { kind: "tag", tag: "subscription-gpt", fallback: ["openai/gpt-5"] },
      { kind: "tag", tag: "cheap-claude", fallback: ["anthropic/claude-haiku-4-5"] },
      { kind: "tag", tag: "free-emergency", fallback: [] },
    ],
  },
  {
    id: "zero-cost",
    label: "Zero cost (free tiers only)",
    description: "No-paid fallback chain. Requires at least one free provider.",
    strategy: "sequential",
    targets: [
      { kind: "tag", tag: "free-claude-or-gpt", fallback: ["openai/gpt-5-mini"] },
      { kind: "tag", tag: "free-gpt", fallback: ["openai/gpt-5-mini"] },
      { kind: "tag", tag: "free-emergency", fallback: [] },
    ],
  },
  {
    id: "always-on",
    label: "Always on (5-tier)",
    description: "Maximum uptime — 5 layers of fallback. Cost scales with how often later tiers fire.",
    strategy: "sequential",
    targets: [
      { kind: "tag", tag: "subscription-gpt", fallback: ["openai/gpt-5"] },
      { kind: "tag", tag: "subscription-claude", fallback: ["anthropic/claude-sonnet-4-5"] },
      { kind: "tag", tag: "cheap-claude", fallback: ["anthropic/claude-haiku-4-5"] },
      { kind: "tag", tag: "cheap-gpt", fallback: ["openai/gpt-5-mini"] },
      { kind: "tag", tag: "free-emergency", fallback: [] },
    ],
  },
  {
    id: "round-robin-spread",
    label: "Spread load (round-robin)",
    description: "Distribute traffic evenly across your best three providers.",
    strategy: "round_robin",
    targets: [
      { kind: "tag", tag: "primary", fallback: ["openai/gpt-5"] },
      { kind: "tag", tag: "secondary", fallback: ["anthropic/claude-sonnet-4-5"] },
      { kind: "tag", tag: "tertiary", fallback: ["deepseek/deepseek-v3"] },
    ],
  },
  {
    id: "codex-first",
    label: "Codex + everything else",
    description: "Prefer the Codex CLI OAuth account, fall back to a paid API.",
    strategy: "sequential",
    targets: [
      { kind: "tag", tag: "oauth-cli-codex", fallback: ["openai/gpt-5.6-codex"] },
      { kind: "tag", tag: "oauth-browser-gpt", fallback: ["openai/gpt-5"] },
      { kind: "tag", tag: "cheap-gpt", fallback: ["openai/gpt-5-mini"] },
    ],
  },
  {
    id: "claude-only-fallback",
    label: "Claude with deep fallback",
    description: "Use Claude across the quality spectrum before falling back to anything else.",
    strategy: "sequential",
    targets: [
      { kind: "literal", model: "anthropic/claude-opus-4-7" },
      { kind: "literal", model: "anthropic/claude-sonnet-4-5" },
      { kind: "literal", model: "anthropic/claude-haiku-4-5" },
      { kind: "tag", tag: "cheap-claude", fallback: ["anthropic/claude-haiku-4-5"] },
      { kind: "tag", tag: "free-claude", fallback: [] },
    ],
  },
];

export interface ResolvedTarget {
  /** Slot name as it appears in the preset — literal model id or `{tag}`. */
  slot: string;
  /** Concrete `provider/model` string, or null when no enabled provider matched. */
  resolved: string | null;
  /** Display label of the account Mirais would route to, or null. */
  account: string | null;
}

/**
 * Resolve each slot in a preset to a concrete `provider/model` + account.
 *
 * Inputs come from the provider/model/account tables; we walk them in
 * three steps:
 *   1. For each enabled provider, collect its enabled models.
 *   2. For each slot, find the best match: literals pass through, tags run
 *      through `resolveTag` which prefers curated models in `preferredIds`
 *      and falls back to a model on any provider of the right type.
 *   3. Pick the first healthy enabled account on the chosen provider.
 */
export function resolveComboPreset(
  preset: ComboPreset,
  providers: Provider[],
  models: ProviderModel[],
  accounts: ProviderAccount[],
  overrides: Record<string, string> = {},
): { resolved: ResolvedTarget[]; unresolved: string[] } {
  const byProviderName = new Map(providers.filter((p) => p.enabled).map((p) => [p.name, p]));
  const enabledHealthyAccounts = (providerId: string): ProviderAccount[] => {
    return accounts.filter((a) => a.provider_id === providerId && a.enabled === 1 && a.last_warmup_status === "healthy");
  };

  const resolved: ResolvedTarget[] = [];
  const unresolved: string[] = [];

  for (const slot of preset.targets) {
    let model: string | null = null;
    if (slot.kind === "literal") {
      model = slot.model;
    } else if (overrides[slot.tag]) {
      model = overrides[slot.tag] as string;
    } else {
      const resolvedModel = resolveTag(slot.tag, byProviderName, models, slot.fallback);
      if (resolvedModel) {
        model = resolvedModel;
      } else {
        unresolved.push(slot.tag);
      }
    }

    let chosenAccount: ProviderAccount | null = null;
    if (model) {
      const slash = model.indexOf("/");
      const providerName = slash > 0 ? model.slice(0, slash) : model;
      const provider = byProviderName.get(providerName);
      if (provider) {
        const pool = enabledHealthyAccounts(provider.id);
        chosenAccount = pool[0]
          ?? accounts.find((a) => a.provider_id === provider.id && a.enabled === 1)
          ?? null;
      }
    }
    resolved.push({
      slot: slot.kind === "literal" ? slot.model : `{${slot.tag}}`,
      resolved: model,
      account: chosenAccount?.label ?? null,
    });
  }
  return { resolved, unresolved };
}

function resolveTag(
  tag: ComboSlotTag,
  byProviderName: Map<string, Provider>,
  models: ProviderModel[],
  fallback: string[] | undefined,
): string | null {
  let result: string | null;
  switch (tag) {
    case "subscription-gpt":
      result = pickModelByType(["openai"], models, byProviderName, ["gpt-6", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5", "gpt-5"]);
      break;
    case "subscription-claude":
      result = pickModelByType(["anthropic"], models, byProviderName, ["claude-opus-4-7", "claude-sonnet-4-5", "claude-haiku-4-5"]);
      break;
    case "cheap-claude":
      result = pickModelByType(["anthropic"], models, byProviderName, ["claude-haiku-4-5", "claude-sonnet-4-5"]);
      break;
    case "cheap-gpt":
      result = pickModelByType(["openai"], models, byProviderName, ["gpt-5-mini", "gpt-4.1-mini"]);
      break;
    case "free-claude-or-gpt":
      result = pickModelByType(["anthropic", "openai"], models, byProviderName, [], true)
        ?? pickModelByType(["openai", "anthropic"], models, byProviderName, [], false);
      break;
    case "free-gpt":
      result = pickModelByType(["openai"], models, byProviderName, [], true);
      break;
    case "free-claude":
      result = pickModelByType(["anthropic"], models, byProviderName, [], true);
      break;
    case "free-emergency":
      // Last-resort tier: pick the cheapest enabled provider, not the most
      // expensive. We prefer models whose id contains "free" / "mini" / "haiku"
      // to bias toward the budget tier. If none match, fall back to the
      // cheapest available across all enabled providers.
      result = pickModelByType(
        ["openai", "anthropic", "deepseek", "xai", "glm", "blackbox"],
        models,
        byProviderName,
        ["gpt-5-mini", "gpt-4.1-mini", "claude-haiku-4-5", "deepseek-v3"],
        false,
      );
      break;
    case "oauth-cli-codex":
      result = pickModelByType(["codex"], models, byProviderName, [], false);
      break;
    case "oauth-browser-gpt":
      result = pickModelByType(["openai"], models, byProviderName, [], false);
      break;
    case "primary":
      result = pickModelByType(["openai"], models, byProviderName, ["gpt-5"], true);
      break;
    case "secondary":
      result = pickModelByType(["anthropic"], models, byProviderName, ["claude-sonnet-4-5", "claude-haiku-4-5"]);
      break;
    case "tertiary":
      result = pickModelByType(["deepseek"], models, byProviderName, []);
      break;
    default:
      return null;
  }
  if (result) return result;
  // Fallback: only honor `fallback` if its provider is actually enabled.
  // Without an enabled provider, the literal model string is useless — we'd
  // route to a non-existent upstream and the gateway would 404.
  if (fallback) {
    for (const model of fallback) {
      const slash = model.indexOf("/");
      const providerName = slash > 0 ? model.slice(0, slash) : model;
      if (byProviderName.has(providerName)) return model;
    }
  }
  return null;
}

interface RankedModel {
  providerName: string;
  modelId: string;
  rank: number;
}

/**
 * Pick the best model from any enabled provider matching `providerTypes`,
 * ranked by `preferredIds` (curated list) and optional `preferFree` (favours
 * names with "free"/"trial" hints). Returns `providerName/modelId` or null.
 */
function pickModelByType(
  providerTypes: string[],
  models: ProviderModel[],
  byProviderName: Map<string, Provider>,
  preferredIds: string[],
  preferFree = false,
): string | null {
  // Build providerId → ProviderModel[] map so we can find a provider's models.
  const candidates: RankedModel[] = [];
  for (const m of models) {
    if (m.enabled !== 1) continue;
    const providerByRow = providerForModel(m, byProviderName);
    if (!providerByRow) continue;
    if (!providerTypes.includes(providerByRow.type)) continue;

    let rank = 100;
    // preferredIds match the short model id (e.g. "gpt-5"); the row carries
    // the full id ("openai/gpt-5") — match by suffix.
    const shortId = m.model_id.includes("/") ? m.model_id.slice(m.model_id.indexOf("/") + 1) : m.model_id;
    const id = preferredIds.indexOf(shortId);
    if (id !== -1) rank = id;
    else if (preferFree && /free|trial/i.test(m.model_id)) rank = 50;
    // Strip the provider/ prefix from `model_id` so we don't double-prefix
    // when assembling the final string below. Models stored with prefix
    // (e.g. "openai/gpt-5") and bare (e.g. "gpt-5") are both supported.
    const bare = m.model_id.includes("/") ? m.model_id.slice(m.model_id.indexOf("/") + 1) : m.model_id;
    candidates.push({ providerName: providerByRow.name, modelId: bare, rank });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.rank - b.rank);
  const top = candidates[0]!;
  return `${top.providerName}/${top.modelId}`;
}

/**
 * Resolve the provider row for a model. We use `model.provider_id` when
 * available; otherwise fall back to the `provider/model_id` prefix split.
 */
function providerForModel(model: ProviderModel, byProviderName: Map<string, Provider>): Provider | undefined {
  if (model.provider_id) {
    // We don't have providerId → Provider map here; walk byName.values() and
    // match by id. ProviderModel.provider_id is a string; we look it up.
    for (const p of byProviderName.values()) {
      if (p.id === model.provider_id) return p;
    }
  }
  // Fallback: split model_id on "/".
  const slash = model.model_id.indexOf("/");
  if (slash > 0) {
    const providerName = model.model_id.slice(0, slash);
    const p = byProviderName.get(providerName);
    if (p) return p;
  }
  return undefined;
}
