import { describe, expect, test } from "bun:test";
import { codexQuotaDetail, isCodexQuotaExhausted, type CodexUsageSnapshot } from "../src/proxy/codex";

function usage(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
  return {
    plan_type: null,
    email: null,
    limit_reached: false,
    primary: null,
    secondary: null,
    banked_resets: null,
    credits: null,
    ...overrides,
  };
}

describe("Codex quota exhaustion", () => {
  test("treats explicit limit_reached as exhausted", () => {
    expect(isCodexQuotaExhausted(usage({ limit_reached: true }))).toBe(true);
  });

  test("treats a full primary window as exhausted even without limit_reached", () => {
    const snapshot = usage({
      primary: { used_percent: 100, remaining_percent: 0, window_seconds: null, resets_in_seconds: null, reset_at: null },
    });
    expect(isCodexQuotaExhausted(snapshot)).toBe(true);
    expect(codexQuotaDetail(snapshot)).toContain("primary window at 100%");
  });

  test("treats a full secondary window as exhausted", () => {
    const snapshot = usage({
      secondary: { used_percent: 100, remaining_percent: 0, window_seconds: null, resets_in_seconds: null, reset_at: null },
    });
    expect(isCodexQuotaExhausted(snapshot)).toBe(true);
  });

  test("keeps a partially used quota healthy", () => {
    expect(isCodexQuotaExhausted(usage({
      primary: { used_percent: 99.9, remaining_percent: 0.1, window_seconds: null, resets_in_seconds: null, reset_at: null },
    }))).toBe(false);
  });
});