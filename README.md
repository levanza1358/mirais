# Mirais

<img src="assets/icon.png" alt="Mirais icon" width="96" align="right" />

**Mirais** is a self-hosted AI gateway: one endpoint for all your LLM providers. It routes requests across providers, translates between OpenAI and Anthropic API shapes on the fly, saves tokens, and never lets you hit a dead end — managed through a clean dashboard.

- **API base:** `http://localhost:1463/v1`
- **Dashboard:** `http://localhost:1463/`
- **Platforms:** Windows 10/11, Ubuntu 22.04+
- **Stack:** Bun + Elysia · React + Vite + Tailwind · SQLite

## What it does

| Feature | Description |
|---------|-------------|
| **Multi-provider routing** | Route by model name across providers with priority, cooldowns, and automatic failover on errors and rate limits |
| **Multi-account** | Many accounts per provider, rotated round-robin or by priority |
| **OpenAI ↔ Anthropic** | Both API shapes accepted and translated on the fly — tools, streaming, images |
| **Token saver** | Compresses verbose tool output (git diff, grep, ls…) before it reaches the model |
| **Combos** | Named fallback chains: `combo:never-stop` = claude → gpt → glm → free provider |
| **Gateway keys** | Issue API keys with model ACLs, rate limits, budgets, expiry |
| **Usage analytics** | Tokens, latency, success rate per model/provider with charts |
| **Account backup** | One-click JSON export/import of all provider accounts |

## Install

### Ubuntu / Ubuntu Server

```bash
curl -fsSL https://raw.githubusercontent.com/levanza1358/mirais/main/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/levanza1358/mirais/main/install.ps1 | iex
```

Then:

```bash
mirais start
mirais autostart on
mirais status
```

The global `mirais` command remembers the install location — no `cd` needed.

## First run

1. Open `http://localhost:1463/`.
2. Log in with the default password `12345678` — change it in Settings → General.
3. Add a provider, add accounts, and sync models.
4. Create a gateway key, then point any OpenAI-compatible tool at `http://localhost:1463/v1`.

A login lasts 12 hours by default ("remember this browser" = 30 days). The password can be turned off entirely; it guards the dashboard only — `/v1/*` clients always use gateway keys.

## Using the API

```bash
curl http://localhost:1463/v1/chat/completions \
  -H "Authorization: Bearer <gateway-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"combo:never-stop","messages":[{"role":"user","content":"hello"}]}'
```

Point Claude Code, Cursor, Cline, Codex, Continue, or anything OpenAI/Anthropic-compatible at `http://localhost:1463/v1`.

## CLI

```bash
mirais start            # start in background (logs to data/mirais.log)
mirais stop | restart
mirais status           # exit 0 = healthy
mirais expose on|off    # 0.0.0.0 or 127.0.0.1
mirais autostart on|off # start at boot (systemd / Windows Startup)
mirais update           # update + rebuild + restart
mirais doctor --fix     # diagnose and repair
bun run backup          # export all provider accounts to data/backups/*.json
```

## Security notes

- Default bind is `0.0.0.0` (exposed). Use `mirais expose off` for localhost-only.
- When exposed without a dashboard password, Mirais logs a warning at startup.
- The dashboard password is not a network boundary — use a firewall, VPN, or reverse proxy for internet-facing installs.
- Account backups contain credentials in plaintext JSON. Keep them private.

## Development

```bash
git clone <your-repo> mirais && cd mirais
bun install
cd dashboard && bun install && cd ..
bun run dev        # backend :1463 + dashboard dev server
bun test test/
bun run typecheck
bun run build      # build dashboard into dashboard/dist
```

Detailed docs live in [`docs/`](docs/): architecture, API reference, database schema, UI design, and deployment guides.

## License

MIT
