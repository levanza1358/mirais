# Mirais

**Mirais** is a self-hosted AI gateway & router: one local endpoint that routes LLM requests across multiple providers, translates between OpenAI and Anthropic API shapes on the fly, saves tokens, and never lets you hit a dead end — with a beautiful password-protected dashboard.

- **Default address:** `http://localhost:1463`
- **Dashboard:** `http://localhost:1463/` (password protected)
- **API base:** `http://localhost:1463/v1`
- **Platforms:** Windows 10/11, Ubuntu 22.04+ / Ubuntu Server
- **Stack:** Bun + Elysia (backend) · React + Vite + Tailwind (dashboard) · SQLite (storage)

Inspired by [9Router](https://github.com/decolua/9router) (token saving, tiered fallback) and [Cartethyia](https://github.com/risunCode/Cartethyia) (protocol translation, clean modular architecture).

---

## Feature Highlights

| # | Feature | Description |
|---|---------|-------------|
| 1 | **Multi-provider routing + failover** | Route by model name across providers with priority, cooldowns, and automatic fallback on error/rate-limit |
| 2 | **Multi-account + API key management** | Multiple accounts per provider (round-robin), issue gateway API keys with model ACLs, budgets & rate limits |
| 3 | **OpenAI ↔ Anthropic translation** | Accept/return both API shapes; translated on the fly with tool-calling, streaming & image handling |
| 4 | **Token saver / compression** | Compress verbose `tool_result` content (git diff, grep, ls…) and optional terse-reply prompt injection |
| 5 | **Usage tracking & analytics** | Tokens, estimated cost, requests per model/provider, latency, charts on dashboard |
| 6 | **Combos / fallback chains** | Named model chains, e.g. `combo:never-stop` = claude → gpt → glm → free provider |

## Documentation

| Doc | Content |
|-----|---------|
| [docs/01-architecture.md](docs/01-architecture.md) | System design, request flow, module map |
| [docs/02-tech-stack-and-project-structure.md](docs/02-tech-stack-and-project-structure.md) | Stack rationale + full folder layout |
| [docs/03-api-specification.md](docs/03-api-specification.md) | Client-facing & admin API reference |
| [docs/04-database-schema.md](docs/04-database-schema.md) | SQLite schema, migrations, data retention |
| [docs/05-uiux-design.md](docs/05-uiux-design.md) | Dashboard pages, design system, wireflows |
| [docs/06-implementation-phases.md](docs/06-implementation-phases.md) | Phase-by-phase build plan with checklists |
| [docs/07-deployment-windows-ubuntu.md](docs/07-deployment-windows-ubuntu.md) | Windows & Ubuntu Server setup, service, hardening |

## Quick Start (dev)

```bash
# Requires Bun >= 1.1 (https://bun.sh)
git clone <your-repo> mirais && cd mirais
bun install
cd dashboard && bun install && cd ..
cp .env.example .env      # set DASHBOARD_PASSWORD
bun run dev
```

Open `http://localhost:1463` → login with your `DASHBOARD_PASSWORD`.

## Run as a background service

```bash
# Windows (cmd/PowerShell) — from the project root
mirais start      # start in background (detached, logs to data/mirais.log)
mirais status     # running? healthy? (exit 0 = healthy, 3 = not running)
mirais restart
mirais stop

# Linux/macOS
./mirais start|status|restart|stop

# Or via bun from anywhere in the project
bun run mirais start
bun run svc:status   # svc:start / svc:stop / svc:restart also available
```

State is tracked via `data/mirais.pid`; server output goes to `data/mirais.log`.
For a real always-on service (auto-start on boot), see [docs/07-deployment-windows-ubuntu.md](docs/07-deployment-windows-ubuntu.md) (NSSM / systemd).

## Quick Start (client usage)

```bash
curl http://localhost:1463/v1/chat/completions \
  -H "Authorization: Bearer <gateway-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"combo:never-stop","messages":[{"role":"user","content":"hello"}]}'
```

Point any OpenAI/Anthropic-compatible tool (Claude Code, Cursor, Cline, Codex, Continue…) at `http://localhost:1463/v1`.

## License

MIT
