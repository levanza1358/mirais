# PRD — Product Requirements Document

| | |
|---|---|
| **Product** | Mirais |
| **Version** | 1.0 (initial release) |
| **Status** | Approved for build |
| **Date** | 2026-08-05 |
| **Owner** | Project maintainer |

## 1. Problem Statement

Developers using AI coding tools (Claude Code, Cursor, Cline, Codex, Continue) face:

- **P1 — Interrupted work:** provider rate limits (429) and outages stop coding mid-task with no automatic recovery.
- **P2 — Protocol fragmentation:** tools speak OpenAI or Anthropic shapes; providers support only one — mixing providers requires per-tool reconfiguration.
- **P3 — Token waste:** agentic tool outputs (`git diff`, `grep`, `ls`) burn 20–40% of input tokens on noise.
- **P4 — Zero visibility:** no idea which model/provider consumed what, what it cost, or why a request failed.
- **P5 — Key sprawl & risk:** sharing access means sharing raw provider keys with no ACLs, budgets, or revocation.
- **P6 — Clunky ops:** existing solutions are either heavy (Node monoliths), cloud-coupled, or Windows-hostile.

## 2. Goals & Non-Goals

### Goals (v1)
- **G1:** Single local endpoint (`localhost:1463`) accepting OpenAI Chat Completions + Anthropic Messages, routed to any configured provider, with streaming.
- **G2:** Automatic failover across providers/accounts with cooldowns; multi-account round-robin.
- **G3:** On-the-fly OpenAI ↔ Anthropic translation (requests, responses, streams, tools, images).
- **G4:** Token saver compressing tool outputs; measurable savings shown in UI.
- **G5:** Dashboard (passwordless; network-bound) for providers, accounts, models, aliases, combos, gateway API keys, logs, analytics, settings. External access must be gated by a reverse proxy, firewall, VPN, or private network — the dashboard itself has no application login.
- **G6:** Usage analytics: tokens, estimated cost, latency, success rate — per model/provider/key.
- **G7:** First-class on Windows 10/11 **and** Ubuntu/Server; deploy via source, systemd/NSSM, or Docker.

### Non-Goals (v1)
- Multi-user auth / teams, cloud sync, hosted offering
- Parallel/"fusion" combo strategies (race + judge)
- OAuth login flows to providers (API-key auth only)
- Embeddings, images, audio, fine-tuning endpoints
- Clustering / multi-node / Postgres
- Mobile-native app (dashboard is responsive web)

## 3. Users & Personas

| Persona | Needs |
|---|---|
| **Solo dev (primary)** | Point all tools at one endpoint; never hit a wall; spend less; see what happened |
| **Small team lead** | Issue scoped gateway keys with budgets/ACLs instead of sharing provider keys |
| **Self-hoster** | Runs it on an Ubuntu home server for LAN devices; wants systemd + Docker + backups |

## 4. Functional Requirements

Priority: **P0** must-have v1 · **P1** should-have v1 · **P2** v1.x stretch

### FR-1 Proxy Core — P0
- FR-1.1 `POST /v1/chat/completions` (OpenAI shape, stream + non-stream)
- FR-1.2 `POST /v1/messages` (Anthropic shape, stream + non-stream)
- FR-1.3 `GET /v1/models` unified catalog; `GET /health`
- FR-1.4 OpenAI-shaped error responses; correct HTTP status mapping (doc 03)
- FR-1.5 Request validation via zod; body limit configurable (default 25 MB)

### FR-2 Routing & Failover — P0
- FR-2.1 Model resolution: direct, `provider/model`, alias, `combo:name`
- FR-2.2 Failover on retriable errors only (429, 5xx, network, upstream auth) — max 3 attempts default
- FR-2.3 Per-account cooldown with exponential backoff (1m→5m→15m); honor `Retry-After`
- FR-2.4 Multi-account round-robin per provider; per-provider priority
- FR-2.5 `X-Mirais-No-Fallback: 1` opt-out header

### FR-3 Translation — P0
- FR-3.1 OpenAI ↔ Anthropic: messages, system prompt, `tool_calls`↔`tool_use`, `tool`↔`tool_result`, images, `max_tokens` defaulting (4096)
- FR-3.2 Streaming event translation both directions, incremental (no buffering)
- FR-3.3 Golden-fixture test coverage for every mapping

### FR-4 Token Saver — P1
- FR-4.1 Compression rules: git diff, grep/rg, ls/tree, long-output head+tail truncation
- FR-4.2 Global toggle + per-rule toggles + per-request bypass header
- FR-4.3 Report `tokens_saved` per request; aggregate savings on dashboard
- FR-4.4 Terse mode (optional system-prompt injection)

### FR-5 Gateway API Keys — P0
- FR-5.1 Issue/revoke/enable keys; SHA-256 hashed storage; one-time plaintext reveal
- FR-5.2 Per-key limits: model ACL, requests/min, concurrency, daily token budget, expiry
- FR-5.3 Per-key usage stats

### FR-6 Providers & Accounts — P0
- FR-6.1 Built-in provider types: openai, anthropic, gemini, openrouter, deepseek, groq, xai, glm + custom OpenAI-compatible base URL
- FR-6.2 CRUD providers/accounts; live connection test; model list refresh where upstream supports it
- FR-6.3 Per-model enable + pricing override

### FR-7 Combos — P1
- FR-7.1 Named sequential fallback chains; drag-and-drop editor; dry-run "test resolution"
- FR-7.2 Usable as `combo:name` in any client request

### FR-8 Dashboard — P0
- FR-8.1 Failed-over retries only count retriable upstream errors (429, 5xx, network, upstream-auth); client errors pass through untouched.
- FR-8.2 Pages: Overview, Providers, Models, Combos, API Keys, Logs, Settings (spec: doc 05)
- FR-8.3 Dark/light theme, responsive ≥1280px desktop-first, accessible (focus/aria/contrast AA)

### FR-9 Analytics & Logs — P0
- FR-9.1 Request log with attempts timeline, tokens, cost, latency, status
- FR-9.2 Aggregations: summary cards, timeseries, by-model, by-provider (24h/7d/30d)
- FR-9.3 Payload capture only when `TRACK_PAYLOADS=full`; retention auto-purge (default 30d; bodies 7d)

### FR-10 Settings & Ops — P1
- FR-10.1 Token saver config, pricing table editor, retention, backup now, config export/import, factory reset (typed confirm)
- FR-10.2 Surface operational health (uptime, DB size, configured providers/accounts) on the Settings page; export diagnostic bundles for support tickets.

## 5. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Performance** | p50 proxy overhead < 15 ms (excluding upstream); ≥ 500 concurrent SSE streams on 2 vCPU/2 GB; dashboard first load < 1 s local |
| **Reliability** | No request data loss on crash mid-stream (log row written on abort); SQLite WAL; restart-safe |
| **Security** | Gateway keys hashed (SHA-256) with display prefix only; `DASHBOARD_PASSWORD` field removed (dashboard is intentionally passwordless per `RULES.md` R1.3); constant-time compare; `DATA_DIR` 0700 on Linux; no telemetry. External dashboard access is a network concern, not an app concern. |
| **Compatibility** | Windows 10/11 x64, Ubuntu 22.04/24.04 x64 (+arm64 via Docker); Bun ≥ 1.1; Chrome/Edge/Firefox latest |
| **Observability** | Structured JSON logs to stdout; `/health` for monitors; in-app logs page |
| **Maintainability** | 100% TypeScript strict; typecheck + tests green in CI on both OSes |

## 6. Success Metrics

| Metric | Target |
|---|---|
| Successful failover recovery | ≥ 95% of retriable failures recovered without client error |
| Token saver | ≥ 20% input-token reduction on agentic coding traces (measured on fixture corpus) |
| Translation fidelity | 100% golden fixtures pass; zero semantic-loss bugs in beta |
| Dashboard task time | Add provider + key + first request < 3 minutes for a new user |
| Crash rate | < 0.1% of requests cause process error |

## 7. Release Plan

| Milestone | Content | Gate |
|---|---|---|
| **M1 — Core proxy** | FR-1, FR-2, FR-3 | curl-driven smoke vs 2 real providers |
| **M2 — Managed gateway** | FR-5, FR-6, FR-9 | integration tests green |
| **M3 — Dashboard** | FR-8, FR-10 | UI checklist (doc 05 §4) on both OSes |
| **M4 — v1.0** | FR-4, FR-7, packaging (Docker/systemd/NSSM), docs | fresh-machine install test, Windows + Ubuntu Server |

Build sequencing detail lives in [docs/06-implementation-phases.md](docs/06-implementation-phases.md).

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Streaming translation edge cases (tool calls mid-stream) | Wrong output to client | Golden fixtures incl. partial JSON; fallback: pass-through untranslated when provider+client protocols match |
| Provider API drift | Breakage | Upstream clients isolated per provider; version-pinned fixtures; error surfacing in logs UI |
| SQLite write contention under heavy logging | Latency | WAL + batched inserts; async log queue |
| Windows path/service quirks | OS parity failure | CI on `windows-latest`; NSSM guide tested on clean VM |
| Scope creep toward "platform" | Missed v1 | PRD non-goals are binding; backlog parked in doc 06 §Post-v1 |

## 9. Open Questions

1. Ship `bun build --compile` single binaries in v1.0 or v1.1? (Leaning v1.1.)
2. Default pricing table refresh mechanism — manual edit only, or optional community JSON feed (offline-first says manual)?
3. Should `/v1/responses` land in v1 or is Chat Completions + Messages sufficient for launch?
