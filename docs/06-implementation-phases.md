# 06 — Implementation Phases

Build order is dependency-driven: proxy core first (it delivers value alone), then admin surface, then polish. Each phase ends in a **runnable** state.

Legend: ✅ exit criteria = all boxes checked and manual smoke passed on **both Windows and Ubuntu**.

---

## Phase 0 — Scaffold (½ day) — DONE
- [x] `bun init` root + `dashboard/` (Vite React-TS template, Tailwind v4)
- [x] tsconfig paths, eslint, `.gitattributes`, `.env.example`, `scripts/dev.ts`
- [x] CI (GitHub Actions): typecheck + `bun test` + `bun run build` on `windows-latest` & `ubuntu-latest` (`.github/workflows/ci.yml`); Ubuntu post-deploy smoke runs against `/health` + `/api/health`
- ✅ `bun run dev` starts empty Elysia on `:1463` + Vite dev server; `/health` returns ok

## Phase 1 — Storage & Config (1 day) — DONE
- [x] `config.ts` with zod env validation
- [x] `store/db.ts`: open SQLite, WAL, migration runner
- [x] `0001_init.sql` (full schema from doc 04) + repos for providers/accounts/keys/combos/settings
- ✅ unit tests: migration idempotent, repos CRUD round-trip

## Phase 2 — Proxy Core (3 days) ← heart of the product — DONE
- [x] Canonical types + zod schemas for OpenAI & Anthropic payloads
- [x] Translators: request `fromAnthropic`, `toAnthropic`; streaming event translators both ways (golden fixtures)
- [x] Upstream clients: `openai` (covers openrouter/groq/deepseek/custom), `anthropic`; SSE decode/encode
- [x] `routing/resolve.ts`: model string → candidates (qualified, direct, alias)
- [x] `accounts/pool.ts`: round-robin + enabled filter
- [x] `routing/cooldown.ts` + `failover.ts`: retriable classification, backoff, attempt loop
- [x] `http/clientRoutes.ts`: `/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/health`
- [x] Gateway-key auth middleware (plaintext/hash lookup, enabled, expiry)
- ✅ tests: translation fixtures pass; failover test with mock upstreams (429 → next account → success); curl smoke against a real provider via env key

## Phase 3 — Token Saver & Usage (1½ days) — DONE
- [x] `tokensaver/rules.ts`: git-diff/grep/ls/long-output compression + unit tests on sample outputs
- [x] Terse-mode injection; `X-Mirais-Token-Saver: off` bypass
- [x] `usage/tokens.ts` + insert into `request_logs` on completion/abort
- [x] Key limits enforcement: rpm, concurrency, daily budget, model ACL (403/429 paths)
- ✅ integration test: agentic-style conversation with tool results shows ≥20% input-token reduction; limits return correct errors

## Phase 4 — Admin Auth & API (1½ days) — DONE
- [x] `session.ts`: bcrypt password hash, HMAC-signed cookie, login rate-limit
- [x] First-run flow: if no password set → forced setup screen (`/api/auth/setup` bootstrap; `/api/auth/check` always 200 so SPA can branch)
- [x] All admin routes from doc 03 (providers, accounts, aliases, combos, keys, logs, stats, settings)
- [x] Config export/import
- [x] **Global session guard**: every `/api/*` route (except `/api/auth/*`, `/api/health`) requires a valid session — enforced at root app level
- ✅ API integration tests (unauthenticated 401s, CRUD happy paths, combo validation)

## Phase 5 — Dashboard UI (4 days) — DONE
- [x] App shell (sidebar/topbar/theme) + component inventory from doc 05
- [x] Login + auth gate + ⌘K palette
- [x] Overview (stat cards, charts, live activity)
- [x] Providers (cards, add/edit modals, account test, drag priority)
- [x] Models (table, aliases, playground drawer with streaming)
- [x] Combos (drag-and-drop editor, test resolution)
- [x] API Keys (create → one-time reveal, limits UI)
- [x] Logs (virtualized table, filters, detail drawer)
- [x] Settings (gateway, token saver, change password, about)

## Phase 8 — Pricing Removal Cleanup (done)
- [x] Remove pricing/cost logic from backend routes, repos, and shared types
- [x] Remove pricing/cost surfaces from dashboard API and UI helpers
- [x] Add migration `0008_remove_pricing.sql` to clean existing databases
- ✅ UI verified in browser against live server (login → all pages render, CRUD works)

## Phase 6 — Combos & Polish (1 day) — DONE
- [x] Combo routing end-to-end (`combo:name` in client API) + attempt timeline in log detail
- [x] Empty/error states everywhere; skeletons; toasts
- [x] `scripts/smoke.ts` + README quick-start verified
- ✅ E2E pass: live server + fake upstream — login, provider CRUD, alias (`provider/model` form), combo fallback, gateway key → `/v1/chat/completions` 200, unauthenticated admin → 401

## Phase 7 — Packaging & Deploy (1 day) — DONE (Windows verified)
- [x] Dashboard build embedded into Elysia static serving (`bun run build` → `dashboard/dist` served at `/` with SPA fallback)
- [x] Dockerfile (oven/bun base, `DATA_DIR` volume, non-root user) + docker-compose
- [x] Windows: `nssm` service guide + start script; Ubuntu: systemd unit + ufw notes (doc 07)
- [x] `scripts/backup.ts` (VACUUM INTO) + nightly retention task
- ✅ fresh-machine test: Windows 11 (bun install → dev) verified; Ubuntu Server 24.04 (docker compose up → curl completion) — pending manual run

## Post-v1 Backlog (not in initial build)
- OpenAI-hosted platform resources beyond the implemented stateless Responses gateway (persistent response/conversation resources and hosted tools), Gemini native translation
- Parallel combo strategy ("fusion": race + judge)
- OAuth providers (Claude Code/Codex-style token import + refresh)
- SSE realtime dashboard (replace polling)
- `bun build --compile` single binaries for win-x64/linux-x64
- Request body encryption at rest, per-key IP allowlists
- MCP server exposure of admin operations

## Effort Summary
| Phase | Estimate |
|-------|----------|
| 0–1 | 1.5 d |
| 2 | 3 d |
| 3–4 | 3 d |
| 5 | 4 d |
| 6–7 | 2 d |
| **Total** | **~13–14 working days** for one developer |
