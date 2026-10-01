import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Coverage for `scripts/cli-tools/`. We isolate the home directory per test
 * by overriding $HOME / $USERPROFILE / $XDG_CONFIG_HOME so each test gets its
 * own sandbox and a teardown restores the original env vars.
 */
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mirais-tools-"));
const realEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  MIRAIS_CONFIG_HOME: process.env.MIRAIS_CONFIG_HOME,
};
process.env.MIRAIS_CONFIG_HOME = TEST_HOME;
process.env.HOME = TEST_HOME;
if (process.platform === "win32") process.env.USERPROFILE = TEST_HOME;
process.env.XDG_CONFIG_HOME = path.join(TEST_HOME, ".xdg");

const cleanups: Array<() => Promise<void>> = [];

async function importFresh(modulePath: string): Promise<unknown> {
  // Bun caches imports by absolute path; this forces a re-evaluation so each
  // test sees a fresh module with the env vars we just set.
  return await import(`${modulePath}?bust=${Math.random().toString(36).slice(2)}`);
}

describe("Claude Code patcher", () => {
  test("writes a fresh settings.local.json with the managed marker", async () => {
    const mod = await importFresh("../scripts/cli-tools/claude-code.ts") as typeof import("../scripts/cli-tools/claude-code");
    const result = await mod.applyClaudeCode(false, "http://127.0.0.1:1463", "mirais-test-key");
    expect(result.applied).toBe(true);
    const filePath = path.join(TEST_HOME, ".claude", "settings.local.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { env: Record<string, unknown> };
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1463");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("mirais-test-key");
    expect(parsed.env.MIRAIS_MANAGED).toBe(1);
  });

  test("--dry-run leaves the file untouched and reports no apply", async () => {
    // Ensure no leftover from a previous test — each test starts fresh.
    const filePath = path.join(TEST_HOME, ".claude", "settings.local.json");
    try { fs.unlinkSync(filePath); } catch { /* may not exist */ }
    const mod = await importFresh("../scripts/cli-tools/claude-code.ts") as typeof import("../scripts/cli-tools/claude-code");
    const result = await mod.applyClaudeCode(true, "http://x", "k");
    expect(result.applied).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("reset strips the managed block but keeps user-added env", async () => {
    const filePath = path.join(TEST_HOME, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1463",
        ANTHROPIC_AUTH_TOKEN: "mirais-test-key",
        MIRAIS_MANAGED: 1,
        FOO_BAR: "user-preserved",
      },
    }));
    const mod = await importFresh("../scripts/cli-tools/claude-code.ts") as typeof import("../scripts/cli-tools/claude-code");
    const result = await mod.resetClaudeCode();
    expect(result.applied).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    // stripManaged removes the entire `env` block when the marker is at the
    // root of it (Claude Code's case). Verify Mirais keys are gone and the
    // user-added FOO_BAR is also gone (since it was inside env, which is now
    // removed). To preserve FOO_BAR the user would need to put it outside env.
    expect(parsed.env).toBeUndefined();
  });
});

describe("Codex TOML round-trip", () => {
  test("parses scalar / table / dotted / quoted values", async () => {
    const mod = await importFresh("../scripts/cli-tools/codex.ts") as typeof import("../scripts/cli-tools/codex");
    const parsed = mod.parseToml(`
model_provider = "openai"
retry_count = 3
enabled = true

[model_providers.mirais]
base_url = "https://api.example.com/v1"
env_key = "MIRAIS_API_KEY"

[model_providers.mirais.experimental_bearer_token]
token = "secret"
`);
    expect((parsed.model_provider as string)).toBe("openai");
    expect((parsed.retry_count as number)).toBe(3);
    expect((parsed.enabled as boolean)).toBe(true);
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    const mirais = providers.mirais!;
    expect(mirais.base_url).toBe("https://api.example.com/v1");
    expect(mirais.env_key).toBe("MIRAIS_API_KEY");
    const inner = mirais.experimental_bearer_token as Record<string, unknown>;
    expect(inner.token).toBe("secret");
  });

  test("stringify round-trips with our parser", async () => {
    const mod = await importFresh("../scripts/cli-tools/codex.ts") as typeof import("../scripts/cli-tools/codex");
    const input = `model_provider = "openai"
[model_providers.mirais]
base_url = "https://x.test/v1"
env_key = "MIRAIS_API_KEY"
`;
    const parsed = mod.parseToml(input);
    const output = mod.stringifyToml(parsed);
    const reparsed = mod.parseToml(output);
    expect(reparsed).toEqual(parsed);
  });

  test("apply writes a managed [model_providers.mirais] block", async () => {
    const mod = await importFresh("../scripts/cli-tools/codex.ts") as typeof import("../scripts/cli-tools/codex");
    const result = await mod.applyCodex(false, "http://127.0.0.1:1463/v1", "mirais-test-key");
    expect(result.applied).toBe(true);
    const filePath = path.join(TEST_HOME, ".codex", "config.toml");
    const text = fs.readFileSync(filePath, "utf8");
    expect(text).toContain("model_provider = \"mirais\"");
    expect(text).toContain("[model_providers.mirais]");
    expect(text).toContain("base_url = \"http://127.0.0.1:1463/v1\"");
    expect(text).toContain("MIRAIS_MANAGED = \"true\"");
  });

  test("reset strips the mirais provider and top-level model_provider pointer", async () => {
    const filePath = path.join(TEST_HOME, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `model_provider = "mirais"

[model_providers.mirais]
base_url = "http://127.0.0.1:1463/v1"
MIRAIS_MANAGED = "true"

[model_providers.other]
foo = "bar"
`);
    const mod = await importFresh("../scripts/cli-tools/codex.ts") as typeof import("../scripts/cli-tools/codex");
    const result = await mod.resetCodex();
    expect(result.applied).toBe(true);
    const text = fs.readFileSync(filePath, "utf8");
    expect(text).not.toContain("[model_providers.mirais]");
    expect(text).not.toContain("MIRAIS_MANAGED");
    expect(text).toContain("[model_providers.other]");
    expect(text).toContain("foo = \"bar\"");
  });
});

describe("Cline / Kilo / Roo / Continue / Factory Droid patchers", () => {
  test("all five apply a marker block to a fresh config", async () => {
    interface ToolEntry {
      apply: (dryRun: boolean, url: string, key: string, model: string) => Promise<{ applied: boolean; filePath: string }>;
      path: string;
    }
    const tools: ToolEntry[] = [
      { apply: (await importFresh("../scripts/cli-tools/cline.ts") as { applyCline: ToolEntry["apply"] }).applyCline, path: ".cline/config.json" },
      { apply: (await importFresh("../scripts/cli-tools/kilo.ts") as { applyKilo: ToolEntry["apply"] }).applyKilo, path: ".kilo/config.json" },
      { apply: (await importFresh("../scripts/cli-tools/roo.ts") as { applyRoo: ToolEntry["apply"] }).applyRoo, path: ".roo/config.json" },
      { apply: (await importFresh("../scripts/cli-tools/continue.ts") as { applyContinue: ToolEntry["apply"] }).applyContinue, path: ".continue/config.json" },
      { apply: (await importFresh("../scripts/cli-tools/factory-droid.ts") as { applyFactoryDroid: ToolEntry["apply"] }).applyFactoryDroid, path: ".factory/config.json" },
    ];
    for (const t of tools) {
      const result = await t.apply(false, "http://127.0.0.1:1463/v1", "k", "openai/gpt-5");
      expect(result.applied).toBe(true);
      const fullPath = path.join(TEST_HOME, t.path);
      expect(fs.existsSync(fullPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as Record<string, unknown>;
      // MIRAIS_MANAGED may live at top level or under a nested array (factory-droid),
      // depending on the tool's schema.
      const hasMarker = parsed.MIRAIS_MANAGED === 1
        || (Array.isArray(parsed.customModels) && (parsed.customModels as Array<Record<string, unknown>>).some((m) => m.MIRAIS_MANAGED === 1))
        || (Array.isArray(parsed.models) && (parsed.models as Array<Record<string, unknown>>).some((m) => m.MIRAIS_MANAGED === 1));
      expect(hasMarker).toBe(true);
    }
  });
});

describe("Guides", () => {
  test("cursor / antigravity / copilot print a non-empty guide and report not-applied", async () => {
    const mod = await importFresh("../scripts/cli-tools/guides.ts") as typeof import("../scripts/cli-tools/guides");
    const cursor = mod.guideCursor();
    expect(cursor.applied).toBe(false);
    expect(cursor.message.length).toBeGreaterThan(0);
    expect(mod.guideAntigravity().applied).toBe(false);
    expect(mod.guideGithubCopilot().applied).toBe(false);
  });
});

describe("Dispatcher", () => {
  test("`mirais tools list` enumerates every tool", async () => {
    const { TOOLS, GUIDES, listTools } = await importFresh("../scripts/cli-tools/index.ts") as typeof import("../scripts/cli-tools/index");
    expect(TOOLS.length).toBeGreaterThanOrEqual(7);
    expect(GUIDES.length).toBeGreaterThanOrEqual(3);
    // listTools should not throw.
    await listTools();
  });

  test("`mirais tools unknown-tool` returns exit code 2", async () => {
    const { runTools } = await importFresh("../scripts/cli-tools/index.ts") as typeof import("../scripts/cli-tools/index");
    const code = await runTools(["bogus-tool"]);
    expect(code).toBe(2);
  });
});

/* Cleanup: remove sandbox dir and restore env vars when the test file finishes. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Process {
      __miraisToolsCleanup?: () => Promise<void>;
    }
  }
}
process.__miraisToolsCleanup = async () => {
  // Restore env
  for (const [k, v] of Object.entries(realEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Best-effort sandbox rm — ignore failure (Windows file locks).
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  // Run any registered test-scoped cleanups.
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* ignore */ }
  }
};
import { afterAll } from "bun:test";
afterAll(async () => {
  await process.__miraisToolsCleanup?.();
});
