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

## ADR-007: In-memory cooldowns & round-robin cursors
**Context:** Persisting health state buys little; restart-reset is acceptable for a single-node gateway.
**Decision:** Cooldown registry and account cursors live in process memory. Backoff 1m→5m→15m; honor `Retry-After`.
**Consequences:** + simple, fast; − a restart clears learned health (self-heals within one request cycle).

## ADR-008: Token saver = rules pipeline, not ML
**Context:** RTK-style compression proves deterministic rules (git diff/grep/ls) capture most savings.
**Decision:** Ordered rule set with per-rule toggles; count `tokens_saved`; optional terse system-prompt injection; per-request bypass header.
**Consequences:** + transparent, testable, debuggable; − misses savings ML could catch (backlog: pluggable compressor).

## ADR-009: Gateway keys hashed, shown once
**Context:** Keys are bearer secrets; DB theft shouldn't leak usable keys.
**Decision:** SHA-256 hash stored; prefix kept for display; constant-time compare; plaintext revealed only at creation.
**Consequences:** + leak-resistant; − lost key = re-issue (documented in UI).

## ADR-010: Dashboard auth = single password + signed cookie
**Context:** Single-user/team tool; multi-user auth is a non-goal.
**Decision:** scrypt password hash in settings; HMAC-signed `HttpOnly SameSite=Lax` cookie; 12h TTL; login rate-limited 5/5min/IP; first-run setup screen if no password configured.
**Consequences:** + zero-friction yet safe; − shared-password model (acceptable per PRD personas).

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
