import { describe, expect, test } from "bun:test";
import {
  COMBO_PRESETS,
  resolveComboPreset,
  type ComboSlot,
} from "../src/proxy/comboPresets";
import type { Provider, ProviderAccount, ProviderModel } from "../src/shared/types";

/** Coverage for `resolveComboPreset`. We build small provider/model/account
 *  fixtures and assert that each tag picks the right model from the right
 *  provider, that literals pass through verbatim, and that unresolved tags
 *  end up in the `unresolved` list rather than crashing.
 */

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: overrides.id ?? `prov-${Math.random()}`,
    name: overrides.name ?? "openai",
    display_name: null,
    type: overrides.type ?? "openai",
    base_url: overrides.base_url ?? "https://api.example.com/v1",
    enabled: overrides.enabled ?? 1,
    priority: overrides.priority ?? 100,
    account_strategy: "priority",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function account(overrides: Partial<ProviderAccount>): ProviderAccount {
  return {
    id: overrides.id ?? `acc-${Math.random()}`,
    provider_id: overrides.provider_id ?? "prov-1",
    label: overrides.label ?? "primary",
    api_key: "sk-test",
    enabled: 1,
    priority: 100,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    auth_kind: "api_key",
    account_kind: "api-key",
    refresh_token: null,
    id_token: null,
    account_id: null,
    plan_type: null,
    expires_at: null,
    notes: null,
    tags: null,
    session_cookie: null,
    rate_limited_until: null,
    reauth_required: 0,
    reauth_reason: null,
    last_warmup_at: null,
    last_warmup_status: null,
    last_warmup_latency_ms: null,
    last_warmup_detail: null,
    base_url: null,
    ...overrides,
  };
}

function model(overrides: Partial<ProviderModel>): ProviderModel {
  return {
    id: overrides.id ?? `model-${Math.random()}`,
    provider_id: overrides.provider_id ?? "prov-1",
    model_id: overrides.model_id ?? "gpt-5",
    display_name: null,
    enabled: overrides.enabled ?? 1,
    context_length: null,
    max_output_tokens: null,
    capabilities: null,
    credit_rate: null,
    credit_unit: null,
    source: "manual",
    ...overrides,
  };
}

describe("COMBO_PRESETS catalogue", () => {
  test("has 6 curated presets with stable ids", () => {
    const ids = COMBO_PRESETS.map((p) => p.id);
    expect(ids).toContain("maximize-subscription");
    expect(ids).toContain("zero-cost");
    expect(ids).toContain("always-on");
    expect(ids).toContain("round-robin-spread");
    expect(ids).toContain("codex-first");
    expect(ids).toContain("claude-only-fallback");
    // All have unique ids.
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every preset has a non-empty targets list", () => {
    for (const preset of COMBO_PRESETS) {
      expect(preset.targets.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveComboPreset", () => {
  test("literal targets pass through verbatim with provider resolution", () => {
    const presets = COMBO_PRESETS.find((p) => p.id === "claude-only-fallback")!;
    const anthropic = provider({ id: "p-anthropic", name: "anthropic", type: "anthropic" });
    const models = [
      model({ provider_id: "p-oai", model_id: "gpt-5" }),
      model({ provider_id: "p-anthropic", model_id: "claude-opus-4-7" }),
      model({ provider_id: "p-anthropic", model_id: "claude-sonnet-4-5" }),
      model({ provider_id: "p-anthropic", model_id: "claude-haiku-4-5" }),
    ];
    const accounts = [account({ provider_id: "p-anthropic", label: "anthropic-main" })];
    const { resolved, unresolved } = resolveComboPreset(presets, [anthropic], models, accounts);
    expect(unresolved).toEqual([]);
    expect(resolved.length).toBe(presets.targets.length);
    expect(resolved[0]?.resolved).toBe("anthropic/claude-opus-4-7");
    expect(resolved[0]?.account).toBe("anthropic-main");
    expect(resolved[1]?.resolved).toBe("anthropic/claude-sonnet-4-5");
    expect(resolved[2]?.resolved).toBe("anthropic/claude-haiku-4-5");
  });

  test("subscription-gpt tag picks the highest-ranked GPT model", () => {
    const openai = provider({ id: "p-oai", name: "openai", type: "openai" });
    const anthropic = provider({ id: "p-anthropic", name: "anthropic", type: "anthropic" });
    const models = [
      model({ provider_id: "p-oai", model_id: "gpt-5" }),
      model({ provider_id: "p-oai", model_id: "gpt-5.6-sol" }),
      model({ provider_id: "p-oai", model_id: "gpt-6" }),
      model({ provider_id: "p-oai", model_id: "gpt-5-mini" }),
      model({ provider_id: "p-anthropic", model_id: "claude-haiku-4-5" }),
    ];
    const { resolved, unresolved } = resolveComboPreset(
      COMBO_PRESETS.find((p) => p.id === "maximize-subscription")!,
      [openai, anthropic],
      models,
      [account({ provider_id: "p-oai" }), account({ provider_id: "p-anthropic" })],
    );
    // gpt-6 ranks first; cheap-claude falls back to claude-haiku-4-5 (anthropic).
    // free-emergency resolves to gpt-5-mini because openai is enabled.
    expect(resolved[0]?.resolved).toBe("openai/gpt-6");
    expect(resolved[1]?.resolved).toBe("anthropic/claude-haiku-4-5");
    expect(resolved[2]?.resolved).toBe("openai/gpt-5-mini");
    expect(unresolved).toEqual([]);
  });

  test("overrides win over tag resolution", () => {
    const openai = provider({ id: "p-oai", name: "openai", type: "openai" });
    const models = [model({ provider_id: "p-oai", model_id: "openai/gpt-5" })];
    const { resolved } = resolveComboPreset(
      COMBO_PRESETS.find((p) => p.id === "maximize-subscription")!,
      [openai],
      models,
      [account({ provider_id: "p-oai" })],
      { "subscription-gpt": "openai/gpt-5" },
    );
    expect(resolved[0]?.resolved).toBe("openai/gpt-5");
  });

  test("tags with no enabled provider end up in `unresolved`", () => {
    const presets = COMBO_PRESETS.find((p) => p.id === "always-on")!;
    const { resolved, unresolved } = resolveComboPreset(presets, [], [], []);
    expect(resolved.every((r) => r.resolved === null)).toBe(true);
    expect(unresolved.length).toBeGreaterThan(0);
  });

  test("round-robin-spread picks different providers for primary/secondary/tertiary", () => {
    const openai = provider({ id: "p-oai", name: "openai", type: "openai" });
    const anthropic = provider({ id: "p-anthropic", name: "anthropic", type: "anthropic" });
    const deepseek = provider({ id: "p-deepseek", name: "deepseek", type: "deepseek" });
    const models = [
      model({ provider_id: "p-oai", model_id: "gpt-5" }),
      model({ provider_id: "p-anthropic", model_id: "claude-sonnet-4-5" }),
      model({ provider_id: "p-deepseek", model_id: "deepseek-v3" }),
    ];
    const { resolved } = resolveComboPreset(
      COMBO_PRESETS.find((p) => p.id === "round-robin-spread")!,
      [openai, anthropic, deepseek],
      models,
      [
        account({ provider_id: "p-oai" }),
        account({ provider_id: "p-anthropic" }),
        account({ provider_id: "p-deepseek" }),
      ],
    );
    expect(resolved.map((r) => r.resolved)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-5",
      "deepseek/deepseek-v3",
    ]);
  });

  test("literal slots coexist with tag slots", () => {
    const openai = provider({ id: "p-oai", name: "openai", type: "openai" });
    const anthropic = provider({ id: "p-anthropic", name: "anthropic", type: "anthropic" });
    const models = [
      model({ provider_id: "p-oai", model_id: "gpt-5" }),
      model({ provider_id: "p-anthropic", model_id: "claude-haiku-4-5" }),
    ];
    const slots: ComboSlot[] = [
      { kind: "literal", model: "openai/gpt-5" },
      { kind: "tag", tag: "cheap-claude" },
    ];
    const custom: typeof COMBO_PRESETS[number] = {
      id: "test",
      label: "test",
      description: "test",
      strategy: "sequential",
      targets: slots,
    };
    const { resolved } = resolveComboPreset(custom, [openai, anthropic], models, []);
    expect(resolved[0]?.resolved).toBe("openai/gpt-5");
    expect(resolved[1]?.resolved).toBe("anthropic/claude-haiku-4-5");
  });

  test("disabled provider with healthy model is excluded from ranking", () => {
    const openai = provider({ id: "p-oai", name: "openai", type: "openai", enabled: 0 });
    const models = [model({ provider_id: "p-oai", model_id: "openai/gpt-5" })];
    const { resolved, unresolved } = resolveComboPreset(
      COMBO_PRESETS.find((p) => p.id === "zero-cost")!,
      [openai],
      models,
      [account({ provider_id: "p-oai" })],
    );
    expect(resolved.some((r) => r.resolved === null)).toBe(true);
    expect(unresolved.length).toBeGreaterThan(0);
  });
});
