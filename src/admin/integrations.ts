import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { ProvidersRepo } from "../store/repos/providers";
import { AdminError } from "../shared/errors";
import { log } from "../utils/logger";
import { shortProviderName } from "../shared/providerShort";

const CLI_IDS = ["opencode", "codex", "claude-code", "aider"] as const;
type CliId = typeof CLI_IDS[number];

const CLI_COMMANDS: Record<CliId, string[]> = {
  opencode: ["opencode"],
  codex: ["codex"],
  "claude-code": ["claude", "claude-code"],
  aider: ["aider"],
};

interface ApplyBody {
  cli?: string;
  model?: string;
  apiKey?: string;
}

function configHome(): string {
  return process.platform === "win32"
    ? path.join(os.homedir(), ".config")
    : path.join(os.homedir(), ".config");
}

function cliPath(cli: CliId): string {
  const home = os.homedir();
  switch (cli) {
    case "opencode": return path.join(configHome(), "opencode", "opencode.json");
    case "codex": return path.join(home, ".codex", "config.toml");
    case "claude-code": return path.join(home, ".claude", "settings.json");
    case "aider": return path.join(home, ".aider.conf.yml");
  }
}

function cliName(cli: CliId): string {
  return ({
    opencode: "OpenCode",
    codex: "ChatGPT / Codex (CLI + Desktop)",
    "claude-code": "Claude Code",
    aider: "Aider",
  } satisfies Record<CliId, string>)[cli];
}

function detectedCommand(cli: CliId): string | null {
  for (const command of CLI_COMMANDS[cli]) {
    if (Bun.which(command)) return command;
  }
  return null;
}

function codexDetected(): boolean {
  // Codex CLI or ChatGPT Desktop — check PATH + .codex directory
  if (Bun.which("codex")) return true;
  const codexDir = path.join(os.homedir(), ".codex");
  return fs.existsSync(codexDir);
}

function renderConfig(cli: CliId, model: string, baseUrl: string, apiKey: string): string {
  switch (cli) {
    case "opencode":
      return JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          mirais: {
            npm: "@ai-sdk/openai-compatible",
            name: "Mirais Gateway",
            options: { baseURL: `${baseUrl}/v1`, apiKey },
            models: { [model]: { name: model } },
          },
        },
      }, null, 2);
    case "codex":
      return `# Mirais Gateway — ChatGPT / Codex (CLI + Desktop)\n# After applying, restart ChatGPT Desktop for changes to take effect.\n\nmodel_provider = "mirais"\nmodel = "${model}"\n\n[model_providers.mirais]\nname = "Mirais Gateway"\nbase_url = "${baseUrl}/v1"\nenv_key = "MIRAIS_API_KEY"\n\n# ChatGPT Desktop override\nopenai_base_url = "${baseUrl}/v1"\nforced_login_method = "api"\n`;
    case "claude-code":
      return JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: apiKey,
          ANTHROPIC_MODEL: model,
        },
      }, null, 2);
    case "aider":
      return `model: openai/${model}\nopenai-api-base: ${baseUrl}/v1\nopenai-api-key: ${apiKey}\n`;
  }
}

function mergeJsonConfig(file: string, content: string): string {
  if (!fs.existsSync(file)) return content;
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const next = JSON.parse(content) as Record<string, unknown>;
    return JSON.stringify({ ...current, ...next }, null, 2);
  } catch {
    return content;
  }
}

function mergeTomlConfig(file: string, content: string): string {
  if (!fs.existsSync(file)) return content;
  const existing = fs.readFileSync(file, "utf-8");
  // Remove previous Mirais Gateway blocks
  let cleaned = existing.split(/# --- Mirais Gateway/)[0]?.trim() ?? existing.trim();
  // Remove old Mirais-related keys to avoid duplicate keys
  const lines = cleaned.split("\n");
  const filtered: string[] = [];
  let skipBlock = false;
  for (const line of lines) {
    // Skip [model_providers.mirais] block header
    if (/^\[model_providers\.mirais\]/.test(line.trim())) { skipBlock = true; continue; }
    // Stop skipping when we hit another section header
    if (skipBlock && /^\[/.test(line.trim())) { skipBlock = false; }
    if (skipBlock) continue;
    // Skip top-level mirais keys
    const trimmed = line.trim();
    if (/^model_provider\s*=\s*"mirais"/.test(trimmed)) continue;
    if (/^model\s*=/.test(trimmed) && !trimmed.startsWith("#")) continue;
    if (/^openai_base_url\s*=/.test(trimmed)) continue;
    if (/^forced_login_method\s*=/.test(trimmed)) continue;
    if (/^env_key\s*=\s*"MIRAIS_API_KEY"/.test(trimmed)) continue;
    filtered.push(line);
  }
  const header = "# --- Mirais Gateway (auto-generated) ---";
  return `${filtered.join("\n").trim()}\n\n${header}\n${content.trim()}\n`;
}

function backupAndWrite(file: string, content: string): string | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    backup = `${file}.mirais-${Date.now()}.bak`;
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, content, "utf8");
  return backup;
}

export function integrationRoutes(db: Database) {
  const providers = new ProvidersRepo(db);

  return new Elysia({ prefix: "/api/integrations" })
    .get("/catalog", () => {
      const models = providers.list()
        .filter((provider) => provider.enabled)
        .flatMap((provider) => providers.listModels(provider.id)
          .filter((model) => model.enabled)
          .map((model) => {
            const prefix = shortProviderName(provider.type);
            // Upstream ids often carry vendor segments (e.g. `openai/gpt-5.4`,
            // `moonshotai/kimi-k3`); keep only the tail so the dashboard
            // shows compact labels like `bb/gpt-5.4` instead of
            // `bb/openai/gpt-5.4`.
            const tail = model.model_id.split("/").filter(Boolean).pop() ?? model.model_id;
            return { id: `${prefix}/${tail}`, provider: provider.name, providerType: provider.type };
          }));
      return {
        baseUrl: "http://127.0.0.1:1463",
        clis: CLI_IDS.map((id) => ({
          id,
          name: cliName(id),
          configPath: cliPath(id),
          detected: id === "codex" ? codexDetected() : detectedCommand(id) !== null,
          command: detectedCommand(id),
          configExists: fs.existsSync(cliPath(id)),
          supportsApply: true,
          note: (id === "codex" ? codexDetected() : detectedCommand(id) !== null)
            ? (fs.existsSync(cliPath(id)) ? "CLI detected. Existing config will be backed up before Apply." : "CLI detected. Config will be created on Apply.")
            : "CLI/TUI not detected on PATH. Install it first, then refresh this page.",
        })),
        models,
      };
    })
    .post("/apply", ({ body }) => {
      const input = (body ?? {}) as ApplyBody;
      if (!CLI_IDS.includes(input.cli as CliId)) throw new AdminError(400, "Unsupported CLI");
      const cli = input.cli as CliId;
      if (!input.model?.trim()) throw new AdminError(400, "model is required");
      if (!input.apiKey?.trim()) throw new AdminError(400, "apiKey is required");
      const detected = cli === "codex" ? codexDetected() : detectedCommand(cli) !== null;
      if (!detected) throw new AdminError(400, `${cliName(cli)} is not installed or is not available on PATH`);
      const command = detectedCommand(cli);
      const file = cliPath(cli);
      const model = input.model.trim();
      let content = renderConfig(cli, model, "http://127.0.0.1:1463", input.apiKey.trim());
      if (cli === "opencode" || cli === "claude-code") content = mergeJsonConfig(file, content);
      else if (cli === "codex") content = mergeTomlConfig(file, content);
      const backup = backupAndWrite(file, content);
      log.info("cli integration applied", { cli, command, path: file, backup: !!backup, model });
      return { ok: true, cli: cliName(cli), command, path: file, backup };
    });
}
