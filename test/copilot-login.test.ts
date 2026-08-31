import { describe, expect, test } from "bun:test";
import { copilotCredentialCandidates, copilotEntitlementError, copilotLoginFromConfig, copilotResolvedLabel, isCopilotQuotaExhausted } from "../src/admin/copilot";
import { copilotWarmupError } from "../src/admin/providers";

const quotaSnapshot = (remainingPercentage: number, entitlementRequests: number) => ({
  isUnlimitedEntitlement: false,
  entitlementRequests,
  usedRequests: entitlementRequests * (1 - remainingPercentage / 100),
  usageAllowedWithExhaustedQuota: false,
  remainingPercentage,
  overage: 0,
  overageAllowedWithExhaustedQuota: false,
});

describe("GitHub Copilot login", () => {
  test("reads the GitHub login from Copilot config", () => {
    expect(copilotLoginFromConfig(`// managed\n{"lastLoggedInUser":{"host":"https://github.com","login":"miraya000z"}}`)).toBe("miraya000z");
    expect(copilotLoginFromConfig("{}")).toBeNull();
  });

  test("prefers the authorized login credential when several targets appear", () => {
    const previous = new Set(["https://github.com:existing.copilot-cli"]);
    expect(copilotCredentialCandidates([
      "https://github.com:existing.copilot-cli",
      "https://github.com:other.copilot-cli",
      "https://github.com:Piprosi.copilot-cli",
    ], previous, "piprosi")[0]).toBe("https://github.com:Piprosi.copilot-cli");
  });

  test("finds a reused credential target for the authorized login", () => {
    const target = "https://github.com:Piprosi.copilot-cli";
    expect(copilotCredentialCandidates([target], new Set([target]), "Piprosi")).toEqual([target]);
  });

  test("resolves placeholder labels without duplicating existing accounts", () => {
    expect(copilotResolvedLabel("pending-12345678", "octocat", [])).toBe("octocat");
    expect(copilotResolvedLabel("github-copilot-2", "octocat", [])).toBe("octocat");
    expect(copilotResolvedLabel("custom", "octocat", [])).toBe("custom");
    expect(copilotResolvedLabel("pending-12345678", "octocat", ["octocat"])).toBe("pending-12345678");
  });

  test("treats a missing Copilot entitlement as a terminal login error", () => {
    expect(copilotEntitlementError({ error: { message: 'Request models.list failed with message: 403 "unauthorized: not authorized to use this Copilot feature"' } }))
      .toBe("GitHub login succeeded, but this account does not have an active Copilot entitlement");
  });

  test("keeps unrelated model failures retryable", () => {
    expect(copilotEntitlementError({ error: { message: "upstream unavailable" } })).toBeNull();
  });

  test("treats exhausted chat quota as exhausted even when completions remain", () => {
    expect(isCopilotQuotaExhausted({ quotaSnapshots: {
      chat: quotaSnapshot(0, 200),
      completions: quotaSnapshot(98.6, 2_000),
      premium_interactions: quotaSnapshot(0, 0),
    } })).toBe(true);
  });

  test("uses premium interactions when the account has that entitlement", () => {
    expect(isCopilotQuotaExhausted({ quotaSnapshots: {
      chat: quotaSnapshot(100, 200),
      premium_interactions: quotaSnapshot(0, 300),
    } })).toBe(true);
  });

  test("keeps an account healthy when its effective chat quota remains", () => {
    expect(isCopilotQuotaExhausted({ quotaSnapshots: {
      chat: quotaSnapshot(40, 200),
      premium_interactions: quotaSnapshot(0, 0),
    } })).toBe(false);
  });

  test("falls back from a zero-entitlement chat snapshot to completions", () => {
    expect(isCopilotQuotaExhausted({ quotaSnapshots: {
      chat: quotaSnapshot(0, 0),
      completions: quotaSnapshot(80, 2_000),
      premium_interactions: quotaSnapshot(0, 0),
    } })).toBe(false);
  });

  test("preserves useful Copilot warmup errors", () => {
    expect(copilotWarmupError({ error: { message: "SDK authentication failed" } }, 502)).toBe("SDK authentication failed");
    expect(copilotWarmupError(null, 503)).toBe("HTTP 503");
  });

  test("requires re-login when account authentication is unavailable", () => {
    expect(copilotWarmupError({ error: { message: "Request models.list failed with message: Not authenticated. Please login." } }, 502))
      .toBe("GitHub Copilot authentication is missing or expired — re-login required");
  });

  test("explains missing entitlement during warmup", () => {
    expect(copilotWarmupError({ error: { message: "403 unauthorized: not authorized to use this Copilot feature" } }, 502))
      .toBe("GitHub login succeeded, but this account does not have an active Copilot entitlement");
  });
});