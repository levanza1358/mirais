import { describe, expect, test } from "bun:test";
import { parseOpenAiCallbackUrl } from "../src/admin/oauth";

describe("OpenAI OAuth callback URL", () => {
  test("accepts the fixed Codex localhost callback URL", () => {
    const callback = parseOpenAiCallbackUrl("http://localhost:1455/auth/callback?code=abc&state=pending-state");
    expect(callback.searchParams.get("code")).toBe("abc");
    expect(callback.searchParams.get("state")).toBe("pending-state");
  });

  test("rejects callbacks outside the Codex localhost endpoint", () => {
    expect(() => parseOpenAiCallbackUrl("https://ai.miraya.my.id/auth/callback?code=abc&state=pending-state")).toThrow();
    expect(() => parseOpenAiCallbackUrl("http://localhost:1456/auth/callback?code=abc&state=pending-state")).toThrow();
    expect(() => parseOpenAiCallbackUrl("http://localhost:1455/other?code=abc&state=pending-state")).toThrow();
  });

  test("requires an OAuth code or error", () => {
    expect(() => parseOpenAiCallbackUrl("http://localhost:1455/auth/callback?state=pending-state")).toThrow();
  });
});