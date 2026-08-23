# DESIGN.md — Design Decisions & ADRs

Technical and product design decisions for Mirais, each with context and consequences. Docs 01–05 hold the detail; this file explains the **why**. Numbered as ADRs — once accepted, they change only via a new ADR.

---

## ADR-001: Bun + Elysia, not Node/Next.js
**Context:** 9Router (Next.js monolith) is heavy for a localhost gateway: slow startup, big memory, bundler complexity. Cartethyia shows Bun + Elysia is fast and clean.
**Decision:** Backend = Bun + Elysia; dashboard = separate React+Vite SPA served as static files by the same process.
**Consequences:** + ms-level startup, native TS, built-in SQLite & test runner; − smaller ecosystem than Express (acceptable — our surface is small).

## ADR-002: One process, one port (1463)
**Context:** Users run this on laptops and home servers; extra processes/ports = support burden.
**Decision:** Client API (`/v1`), admin API (`/api`), static dashboard (`/`) all on `:1463`.
**Consequences:** + trivial to run/secure/document; − one process is a blast-radius (mitigated by process supervisor restart + crash-rate NFR).

## ADR-003: SQLite via `bun:sqlite`, no ORM
**Context:** Single-instance gateway; native modules (better-sqlite3) break cross-platform installs; ORMs hide SQL we *want* to see.
**Decision:** Raw SQL in thin repo modules; WAL mode; ULID ids; migration files applied in order.
**Consequences:** + zero-dep, auditable, identical on Win/Ubuntu; − hand-written queries (fine at ~8 tables).

## ADR-004: Canonical format = OpenAI Chat Completions
**Context:** Two client protocols (OpenAI, Anthropic), N upstreams.
**Decision:** Everything normalizes to OpenAI shape internally; translate in/out at the edges.
**Consequences:** + one routing/token-saver pipeline, M+N translators instead of M×N; − Responses API parity deferred (open question #3 in PRD).

## ADR-005: Streaming-first translation, never buffer
**Context:** Agentic coding streams are long; buffering kills TTFB and memory.
**Decision:** SSE events translated incrementally, including partial tool-call JSON assembly per content block.
**Consequences:** + constant memory, real-time UX; − harder code (owned by `translate/stream*.ts` with golden fixtures).

## ADR-006: Failover only on retriable errors
**Context:** Failing over on a 400 would amplify client bugs and double-spend tokens.
**Decision:** Retry set = {429, 500, 502, 503, 504, network, upstream-auth}; everything else returns as-is. Max 3 attempts (configurable later).
**Consequences:** + predictable, honest errors; − some "soft" provider errors may need rule additions over time.

## ADR-007: Hybrid cooldown persistence & in-memory round-robin cursors
**Context:** Routing cursors are disposable, but a restart must not immediately reuse an exhausted account/model pair.
**Decision:** Round-robin cursors and short-lived attempt backoff remain in memory. Model-scoped account cooldown windows are persisted and expired state is swept every minute.
**Consequences:** + restart-safe quota protection without persisting routing cursors; − one small state table and periodic cleanup.

## ADR-008: Token saver = rules pipeline, not ML
**Context:** RTK-style compression proves deterministic rules (git diff/grep/ls) capture most savings.
**Decision:** Ordered rule set with per-rule toggles; count `tokens_saved`; optional terse system-prompt injection; per-request bypass header.
**Consequences:** + transparent, testable, debuggable; − misses savings ML could catch (backlog: pluggable compressor).

## ADR-009: Gateway keys hashed, shown once
**Context:** Keys are bearer secrets; DB theft shouldn't leak usable keys.
**Decision:** SHA-256 hash stored; prefix kept for display; constant-time compare; plaintext revealed only at creation.
**Consequences:** + leak-resistant; − lost key = re-issue (documented in UI).

## ADR-010: Dashboard auth = single password + signed cookie (SUPERSEDED by ADR-016)
**Context:** Single-user/team tool; multi-user auth is a non-goal.
**Decision:** scrypt password hash in settings; HMAC-signed `HttpOnly SameSite=Lax` cookie; 12h TTL; login rate-limited 5/5min/IP; first-run setup screen if no password configured.
**Consequences:** + zero-friction yet safe; − shared-password model (acceptable per PRD personas).
**Status:** Superseded — the password + cookie flow was removed in `b550db4`; see ADR-016.

## ADR-016: Dashboard has no application-level login (SUPERSEDED by ADR-018)
**Context:** Initial design (ADR-010) added a per-install password + HMAC cookie. Real deployments showed this created a second secret to manage (the dashboard password) and was repeatedly mistaken for a network authentication layer — operators left it default or shared it with clients. Multi-user auth is explicitly a non-goal (ADR-010 itself stated so).
**Decision:** Dashboard routes under `/api/*` are intentionally public to anyone who can reach the listener. Access control is delegated to the network boundary (loopback bind, reverse proxy, firewall, VPN, or private network — see `docs/07-deployment-windows-ubuntu.md`). The `/api/auth/login|logout|setup|session` routes are removed entirely. `AGENTS.md` §7 and `RULES.md` R1.3 are the source of truth.
**Consequences:** + one fewer secret to rotate; + zero auth surface area in the dashboard bundle; + trivially auditable; − operators MUST be told to bind to 127.0.0.1 (or put it behind a proxy) — `config.ts` aborts startup if `HOST=0.0.0.0` and no dashboard password is set, and a startup warning is logged if `DATA_DIR` is writable by group/other on Linux.
**Status:** Superseded — the dashboard password is back, on by default; see ADR-018.

## ADR-018: Dashboard-only password, on by default, session-based
**Context:** Removing the login entirely (ADR-016) left exposed installs with no in-app protection, and Mirais defaults to `HOST=0.0.0.0`. The counter-lesson from ADR-016 was that a mandatory second secret and a re-prompt on every page load are what actually pushed operators into unsafe workarounds.
**Decision:** A dashboard password protects `/api/*` (except `/api/auth/*` and `/api/health`) and nothing else — `/v1/*` keeps authenticating with gateway keys, so proxy clients are never affected. It is enabled on first start with the default `12345678`, stored only as a `Bun.password` hash in `settings`; `DASHBOARD_PASSWORD` overrides the initial value. Sessions are HMAC-signed `HttpOnly SameSite=Lax` cookies signed with a random `session_secret` combined with the password hash, so changing or removing the password revokes every session. Lifetime is operator-configurable (`dashboard_session_hours`, default `SESSION_TTL_HOURS`; "remember this browser" = 30 days), so refreshes never re-prompt inside the window. Settings → General can change the password, change the lifetime, or turn the password off entirely (an empty stored hash means disabled and is never re-seeded). Login is rate-limited to 5 failures per IP per 5 minutes. Network controls remain the outer boundary.
**Consequences:** + exposed installs are protected out of the box; + no re-prompt per page load; + proxy traffic and `/api/health` monitoring untouched; + no session table or migration needed; − the shipped default password is weak and must be changed; − a forgotten password requires clearing the `dashboard_password_hash` settings row; − single shared password (multi-user auth remains a non-goal).
**Status:** Active.

## ADR-011: Dark-first bespoke UI, no component library
**Context:** Heavy kits (MUI/AntD) fight the aesthetic and bloat the bundle.
**Decision:** Tailwind v4 + ~25 hand-built components (inventory in doc 05 §5); lucide icons; recharts.
**Consequences:** + exact look, small bundle; − components must be built once, well (Phase 5 owns this).

## ADR-012: UI copy voice = calm, direct, honest
**Context:** SOUL.md §Personality. Cost numbers are *estimates* and must say so.
**Decision:** No hype words, no emoji in UI (status icons excepted); errors state cause + next action; savings labeled "vs list price".
**Consequences:** Trust. Enforced in UI review checklist.

## ADR-013: Packaging tiers — source first, Docker second, binaries later
**Context:** v1 must run identically on Windows & Ubuntu Server.
**Decision:** v1: `bun run start` + systemd/NSSM guides + Dockerfile. v1.1: evaluate `bun build --compile` single binaries.
**Consequences:** + fewer build pipelines now; − requires Bun installed for source path (documented).

## ADR-014: No telemetry, ever
**Context:** SOUL.md. The app handles people's prompts and keys.
**Decision:** No analytics, no update-check beacons, no crash reporting. Version check = user visits repo.
**Consequences:** + trust, compliance-free; − we learn usage only from user feedback. Final.

## ADR-015: Config via env + settings table, clearly split
**Context:** Two config kinds: deployment-time (port, data dir, secrets) vs runtime-tunable (token saver, pricing, retention).
**Decision:** Env = deployment (zod-validated at boot, read-only in UI); `settings` table = runtime (editable in Settings page). Export/import covers settings, secrets redacted.
**Consequences:** + 12-factor-clean, safe UI editing; − two places to look (documented in doc 02 §4).

---

## UI Design Snapshot (canonical tokens — full spec in doc 05)

- Dark-first (`#0B0E14` base), glass surfaces, accent `#7C5CFF` (user-configurable)
- Inter UI / JetBrains Mono code · 12px card radius · 150–200ms transitions
- Shell: 240px collapsible sidebar + topbar with ⌘K palette and health dot
- Pages: Login · Overview · Providers · Models · Combos · API Keys · Logs · Settings
- Every list: skeleton / empty / error states; every destructive action: typed confirm

## Architecture Snapshot (full spec in doc 01)

```
client → auth → token saver → translate → router → account pool → upstream
                                              └──── cooldown · failover · combo ────┘
```

Single Bun process; modules per doc 01 §3; request lifecycle per doc 01 §2.
