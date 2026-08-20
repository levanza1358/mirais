# 02 — Tech Stack & Project Structure

## 1. Stack Choices

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | **Bun ≥ 1.1** | Fast startup, native TypeScript, built-in SQLite (`bun:sqlite`), test runner, bundler. Single toolchain. Runs on Windows & Linux. |
| HTTP framework | **Elysia** | Bun-native, tiny, type-safe, plugin model, first-class SSE/stream support. |
| Validation | **zod** | Env + request body validation with TS inference. |
| DB | **SQLite** via `bun:sqlite` | Zero-dependency embedded DB, WAL mode, perfect for single-instance gateway. Works identically on Windows/Ubuntu. |
| Dashboard | **React 18 + Vite + Tailwind CSS v4** | Fast SPA, huge ecosystem, utility-first styling, dark mode out of the box. |
| Dashboard components | Custom + **lucide-react** icons + **recharts** (analytics charts) | No heavy UI kit; clean bespoke design, small bundle. |
| State/data (dashboard) | **TanStack Query** | Server-state caching for admin REST API. |
| Token counting | `js-tiktoken` (OpenAI) + heuristic estimator (Anthropic) | Good-enough usage stats without native deps. |
| Logging | tiny structured JSON logger (pino-style, hand-rolled) | No native deps; write to stdout + optional file. |
| xAI Farm | Python 3 `.venv` + Camoufox | Optional automation dependencies remain isolated under the Mirais install root. |
| Packaging | Bun build → static dashboard embedded; optional Docker | `bun build --compile` produces a single binary per OS (win-x64, linux-x64) for v2; v1 ships source + Docker. |
| Copilot adapter | Isolated Node 20+ sidecar using `@github/copilot-sdk` | Required by GitHub's official Copilot SDK. It is local-only and separate from the Bun gateway. |

**Explicitly avoided:** Next.js (too heavy for a localhost gateway), native npm modules like `better-sqlite3` (cross-compiling pain on Windows), Redis (in-memory state is enough), ORMs (raw SQL + thin repos are simpler and auditable).

## 2. Monorepo Layout

```
mirais/
├── package.json               # workspace root: scripts, backend deps
├── bunfig.toml
├── tsconfig.json              # backend TS config
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml         # optional convenience
├── README.md
├── docs/                      # ← this documentation set
│   ├── 01-architecture.md
│   ├── 02-tech-stack-and-project-structure.md
│   ├── 03-api-specification.md
│   ├── 04-database-schema.md
│   ├── 05-uiux-design.md
│   ├── 06-implementation-phases.md
│   └── 07-deployment-windows-ubuntu.md
├── src/                       # ── BACKEND ──
│   ├── server.ts              # entrypoint
│   ├── config.ts              # env loading + zod schema
│   ├── app.ts                 # Elysia app assembly (routes + plugins)
│   ├── http/
│   │   ├── clientRoutes.ts    # /v1/chat/completions, /v1/responses, /v1/messages, /v1/models
│   │   ├── adminRoutes.ts     # /api/* (dashboard data CRUD)
│   │   ├── authRoutes.ts      # /api/auth/login|logout|me
│   │   └── static.ts          # serve dashboard build + landing redirect
│   ├── auth/
│   │   ├── gatewayKeys.ts     # verify client API keys (plaintext/hash lookup, ACL, budgets, rate limit)
│   │   └── session.ts         # admin password login, signed cookie
│   ├── translate/
│   │   ├── canonical.ts       # canonical request/response types (OpenAI-based)
│   │   ├── fromAnthropic.ts   # anthropic request → canonical
│   │   ├── toAnthropic.ts     # canonical → anthropic request
│   │   ├── streamFromAnthropic.ts
│   │   ├── streamToAnthropic.ts
│   │   └── images.ts          # data-uri helpers
│   ├── routing/
│   │   ├── resolve.ts         # model string → candidate list (direct/alias/combo)
│   │   ├── cooldown.ts        # in-memory cooldown registry w/ backoff
│   │   ├── failover.ts        # attempt loop, retriable-error classification
│   │   └── combos.ts          # combo expansion & validation
│   ├── accounts/
│   │   └── pool.ts            # per-provider account round-robin + health
│   ├── upstream/
│   │   ├── client.ts          # shared fetch wrapper: timeout, retry-none, SSE decode
│   │   ├── openai.ts          # OpenAI-compatible upstream (also covers OpenRouter, Groq, DeepSeek, custom)
│   │   ├── anthropic.ts       # Anthropic Messages upstream
│   │   └── gemini.ts          # Gemini → translated through canonical
│   ├── tokensaver/
│   │   ├── index.ts           # pipeline entry
│   │   ├── rules.ts           # git-diff/grep/ls truncation rules
│   │   └── terse.ts           # terse system prompt injection
│   ├── store/
│   │   ├── db.ts              # open DB, WAL, migrate()
│   │   ├── migrations/        # 0001_init.sql, 0002_*.sql …
│   │   └── repos/             # providers.ts, accounts.ts, keys.ts, combos.ts, usage.ts, logs.ts, settings.ts
│   ├── usage/
│   │   ├── tokens.ts          # token counting
│   │   └── aggregate.ts       # dashboard stat queries
│   └── shared/
│       ├── types.ts           # shared TS types
│       ├── errors.ts          # error helpers (OpenAI-shaped errors)
│       └── schemas.ts         # zod schemas for OpenAI/Anthropic payloads
├── dashboard/                 # ── FRONTEND (React SPA) ──
│   ├── package.json
│   ├── vite.config.ts         # dev proxy → http://localhost:1463/api
│   ├── index.html
│   ├── tailwind.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx            # router + auth gate
│       ├── api/client.ts      # fetch wrapper (cookie session, error handling)
│       ├── api/hooks.ts       # TanStack Query hooks
│       ├── components/        # ui primitives: Button, Card, Input, Modal, Table, Badge, Switch, Tabs, Toast…
│       ├── layouts/AppShell.tsx  # sidebar + topbar
│       └── pages/
│           ├── Login.tsx
│           ├── Overview.tsx      # dashboard home: stat cards + charts
│           ├── Providers.tsx     # provider + account management
│           ├── Models.tsx        # model catalog, aliases, test playground
│           ├── Combos.tsx        # fallback chain editor (drag & drop)
│           ├── ApiKeys.tsx       # gateway keys, limits, share info
│           ├── Logs.tsx          # request history & detail drawer
│           └── Settings.tsx      # password, token saver, security, data dir, about
├── test/                      # backend tests (bun test)
│   ├── translate.test.ts
│   ├── routing.test.ts
│   ├── tokensaver.test.ts
│   └── api.integration.test.ts
└── scripts/
    ├── dev.ts                 # run backend + dashboard dev servers together
    ├── build-dashboard.ts
    └── smoke.ts               # post-deploy health + sample request
```

## 3. Root Scripts (`package.json`)

```json
{
  "scripts": {
    "dev": "bun run scripts/dev.ts",
    "dev:server": "bun --watch src/server.ts",
    "dev:dashboard": "bun --cwd dashboard run dev",
    "build": "bun run scripts/build-dashboard.ts",
    "start": "bun src/server.ts",
    "typecheck": "bunx tsc --noEmit -p . && bunx tsc --noEmit -p dashboard",
    "test": "bun test test/",
    "smoke": "bun run scripts/smoke.ts"
  }
}
```

## 4. Environment Variables (`.env.example`)

```bash
# ── Server ──
PORT=1463
HOST=127.0.0.1                 # use 0.0.0.0 to expose on LAN/Tailscale; requires DASHBOARD_PASSWORD
DATA_DIR=./data                # SQLite + logs live here

# ── Dashboard auth ──
DASHBOARD_PASSWORD=change-me    # required for any non-loopback HOST
SESSION_SECRET=replace-with-64-random-hex
SESSION_TTL_HOURS=12

# ── Behaviour ──
TOKEN_SAVER=on                 # on | off
TRACK_PAYLOADS=meta            # none | meta | full   (full stores req/resp bodies)
REQUEST_BODY_LIMIT_MB=25
UPSTREAM_TIMEOUT_MS=120000
# Match this with `codex --version` after updating the official Codex CLI.
# Codex uses it to decide which ChatGPT-authenticated models to return.
CODEX_CLIENT_VERSION=0.145.0
LOG_LEVEL=info                 # debug | info | warn | error

# ── Proxy (corp machines) ──
# HTTPS_PROXY=http://proxy:8080
```

## 5. Cross-Platform Notes (Windows & Ubuntu)

| Concern | Approach |
|---------|----------|
| Paths | Always `node:path`/`Bun.file` APIs — never hardcode `/` or `\`. |
| Line endings | `.gitattributes` with `* text=auto eol=lf` (Bun fine either way). |
| SQLite | `bun:sqlite` ships with Bun on both OS — no native build step. |
| Service | Windows → `nssm` or Task Scheduler; Ubuntu → systemd unit (see doc 07). |
| Firewall | Windows prompts on first listen; Ubuntu Server needs `ufw allow 1463/tcp` only if `HOST=0.0.0.0`. |
| Dev parity | Same commands (`bun run dev`) on both. No WSL required on Windows. |

## 6. Testing Strategy

- **Unit**: translators (golden fixture pairs OpenAI↔Anthropic incl. streaming event sequences), token saver rules, combo resolution, cooldown logic.
- **Integration**: spin the app on an ephemeral port with a mock upstream (Bun HTTP server returning canned SSE), run real client requests through failover paths.
- **Smoke**: `scripts/smoke.ts` hits `/health`, logs in, lists models, and does one completion against a configured provider.
- Dashboard: typecheck + build in CI; manual UI pass per the checklist in doc 06.
