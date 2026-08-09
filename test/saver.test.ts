import { describe, test, expect } from "bun:test";
import { compressToolOutput, estimateTokens, isCommandTool, type TokenSaverConfig } from "../src/proxy/saver/compress";
import { applyTokenSaver } from "../src/proxy/saver/rules";
import type { CanonicalRequest } from "../src/shared/types";

const cfg = (over: Partial<TokenSaverConfig> = {}): TokenSaverConfig => ({
  enabled: true,
  rules: { gitDiff: true, grep: true, ls: true, longOutputMaxLines: 100 },
  ...over,
});

describe("estimateTokens", () => {
  test("roughly chars/4", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("isCommandTool", () => {
  test("matches command-like names", () => {
    expect(isCommandTool("bash")).toBe(true);
    expect(isCommandTool("run_shell_command")).toBe(true);
    expect(isCommandTool("TerminalExec")).toBe(true);
    expect(isCommandTool("get_weather")).toBe(false);
  });
});

describe("compressToolOutput", () => {
  test("disabled → passthrough", () => {
    const r = compressToolOutput("diff --git a/x b/x", cfg({ enabled: false }));
    expect(r.saved).toBe(0);
    expect(r.text).toBe("diff --git a/x b/x");
  });

  test("git diff: drops long context runs, keeps changes", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "@@ -1,8 +1,8 @@",
      " ctx1",
      " ctx2",
      " ctx3",
      " ctx4",
      " ctx5",
      "-old line",
      "+new line",
      " ctx6",
    ].join("\n");
    const r = compressToolOutput(diff, cfg());
    expect(r.text).toContain("-old line");
    expect(r.text).toContain("+new line");
    expect(r.text).toContain("diff --git");
    expect(r.text.split("\n").length).toBeLessThan(diff.split("\n").length);
    expect(r.saved).toBeGreaterThan(0);
  });

  test("grep: collapses blank runs and duplicate separators", () => {
    const grep = "a.ts:1:foo\n--\n--\n\n\nb.ts:2:bar";
    const r = compressToolOutput(grep, cfg());
    expect(r.text).not.toContain("\n\n\n");
    expect(r.saved).toBeGreaterThan(0);
  });

  test("long output truncation keeps head and tail with marker", () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const r = compressToolOutput(long, cfg({ rules: { gitDiff: false, grep: false, ls: false, longOutputMaxLines: 100 } }));
    expect(r.text).toContain("[...mirais: truncated 200 lines...]");
    expect(r.text).toContain("line 0");
    expect(r.text).toContain("line 299");
    expect(r.text.split("\n").length).toBeLessThan(110);
  });

  test("short non-matching text unchanged", () => {
    const r = compressToolOutput("just a short answer", cfg());
    expect(r.text).toBe("just a short answer");
    expect(r.saved).toBe(0);
  });
});

describe("applyTokenSaver", () => {
  test("only compacts tool-role string messages", () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const req: CanonicalRequest = {
      model: "m",
      messages: [
        { role: "user", content: long },
        { role: "tool", tool_call_id: "c1", content: long },
        { role: "assistant", content: "ok" },
      ],
    };
    const r = applyTokenSaver(req, cfg({ rules: { gitDiff: false, grep: false, ls: false, longOutputMaxLines: 50 } }));
    expect(r.tokensSaved).toBeGreaterThan(0);
    // user message untouched
    expect(r.request.messages[0]!.content).toBe(long);
    // tool message compacted
    expect((r.request.messages[1]!.content as string).length).toBeLessThan(long.length);
    // assistant untouched
    expect(r.request.messages[2]!.content).toBe("ok");
  });

  test("disabled → identity", () => {
    const req: CanonicalRequest = { model: "m", messages: [{ role: "tool", content: "x" }] };
    const r = applyTokenSaver(req, cfg({ enabled: false }));
    expect(r.tokensSaved).toBe(0);
    expect(r.request).toBe(req);
  });

  test("deduplicates repeated tool outputs and compacts stale results", () => {
    const content = "same verbose output ".repeat(200);
    const request = {
      model: "m",
      messages: [
        { role: "tool" as const, content, tool_call_id: "1" },
        { role: "tool" as const, content: "older unique ".repeat(200), tool_call_id: "2" },
        { role: "tool" as const, content, tool_call_id: "3" },
      ],
    };
    const result = applyTokenSaver(request, { enabled: true, rules: { gitDiff: true, grep: true, ls: true, longOutputMaxLines: 200, deduplicateToolOutputs: true, keepRecentToolResults: 1 } });
    expect(String(result.request.messages[0]?.content)).toContain("stale tool output compacted");
    expect(String(result.request.messages[2]?.content)).toContain("duplicate tool output omitted");
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  test("never grows short duplicate or stale outputs", () => {
    const request = { model: "m", messages: [
      { role: "tool" as const, content: "x", tool_call_id: "1" },
      { role: "tool" as const, content: "x", tool_call_id: "2" },
    ] };
    const result = applyTokenSaver(request, { enabled: true, rules: { gitDiff: true, grep: true, ls: true, longOutputMaxLines: 200, deduplicateToolOutputs: true, keepRecentToolResults: 0 } });
    expect(result.request.messages.map((message) => message.content)).toEqual(["x", "x"]);
  });

  test("compacts repetitive build logs", () => {
    const repeated = Array.from({ length: 40 }, (_, index) => `compile module ${index}ms`).join("\n");
    const result = compressToolOutput(repeated, { enabled: true, rules: { gitDiff: true, grep: true, ls: true, longOutputMaxLines: 200, buildLogs: true } });
    expect(result.text).toContain("repeated build lines omitted");
    expect(result.text.length).toBeLessThan(repeated.length);
  });
});
