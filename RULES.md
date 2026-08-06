# RULES.md — Coding Rules (Binding)

Violations of §1 (Hard Rules) block merge. §2 conventions block merge when clearly violated. If a rule conflicts with a requirement, open an issue — don't silently break the rule.

## 1. Hard Rules

### Security
- **R1.1** Never log secrets: upstream API keys, gateway keys, session cookies, `Authorization` headers. Redact in all log paths.
- **R1.2** Gateway keys exist only as SHA-256 hash + display prefix. Plaintext may live only in memory during creation response.
- **R1.3** Every `/api/*` route except `/api/auth/login` requires session middleware. Every `/v1/*` route requires gateway-key middleware. No exceptions.
- **R1.4** All external input (env, request bodies, admin forms) validated with zod before use.
- **R1.5** No telemetry, external beacons, or third-party analytics — frontend and backend.
- **R1.6** Request/response bodies persisted only when `TRACK_PAYLOADS=full`, and purged on the 7-day body retention schedule.

### Correctness / Data
- **R1.7** Schema changes only via new migration file `NNNN_name.sql`; never edit an applied migration. Migrations must be idempotent and run inside a transaction.
- **R1.8** Proxy path never buffers a full SSE stream. Translation is incremental.
- **R1.9** Failover only on the retriable set {429, 500, 502, 503, 504, network, upstream-auth}. Client 4xx passes through untouched.
- **R1.10** All SQL through repo modules in `src/store/repos/`; no ad-hoc queries in route handlers; always parameterized statements — string interpolation into SQL is forbidden.
- **R1.11** Money/token math: integers for tokens; USD as REAL rounded at display time only.

### Cross-platform
- **R1.12** No OS-specific APIs, no hardcoded `\` or `/` in paths — `node:path` / Bun APIs only. No shell-outs that assume bash/cmd.
- **R1.13** No native npm modules. If it needs node-gyp, it's banned.

### Dependencies
- **R1.14** New dependency requires: (a) not covered by Bun built-in, (b) justification in PR description, (c) entry added to doc 02 §1 table if it changes stack facts.

## 2. Code Conventions

### TypeScript
- **R2.1** `strict: true`. No `any` (use `unknown` + narrow), no `// @ts-ignore`, no non-null `!` unless provably safe with a comment.
- **R2.2** Shared domain types in `src/shared/types.ts`; zod schemas in `src/shared/schemas.ts`; derive TS types from zod where possible.
- **R2.3** Files: `kebab-case.ts`; types `PascalCase`; functions/vars `camelCase`; env `SCREAMING_SNAKE`.
- **R2.4** Errors: construct client errors via `src/shared/errors.ts` helpers (OpenAI shape). Never hand-roll error JSON in routes.

### Backend structure
- **R2.5** Routes thin: parse → authorize → call service module → respond. Business logic lives in `src/routing`, `src/translate`, `src/accounts`, `src/usage`.
- **R2.6** Timeouts everywhere: upstream calls use `UPSTREAM_TIMEOUT_MS`; no unawaited promises without a comment.
- **R2.7** Logging: structured JSON via the shared logger; levels debug/info/warn/error; include `requestId` in proxy logs.
- **R2.8** Env access only through `src/config.ts` — never `process.env` scattered in modules.

### Frontend
- **R2.9** Server state via TanStack Query hooks in `api/hooks.ts`; no fetch-in-component. Local state stays local (`useState`), no global store library.
- **R2.10** Use the component inventory (doc 05 §5); don't fork one-off styled buttons/inputs. New primitives go through the design tokens (no hardcoded hex in pages).
- **R2.11** Every list view implements loading skeleton, empty state, error state. Every destructive action uses `ConfirmModal`.
- **R2.12** Accessibility: icon buttons have `aria-label`; interactive elements keyboard-reachable with visible focus ring; contrast AA.

### Tests
- **R2.13** Translators and token saver: golden-fixture unit tests required for every new mapping/rule.
- **R2.14** New/changed endpoints: integration test (ephemeral port + mock upstream).
- **R2.15** `bun run typecheck` and `bun test test/` green before merge — on both CI OSes (windows-latest, ubuntu-latest).

### Git / Docs
- **R2.16** Conventional Commits; one concern per commit; PRs reference the requirement (PRD FR-x) or issue.
- **R2.17** Behavior/API/schema/UI changes update the relevant doc in `docs/` in the same PR.
- **R2.18** Don't commit `data/`, `.env`, or any file containing a real key. `.env.example` stays complete and current.

## 3. Performance Budgets (CI-enforced where possible)

| Budget | Limit |
|---|---|
| Proxy overhead (excluding upstream) | p50 < 15 ms |
| Dashboard JS bundle (gzip) | < 350 KB initial |
| Dashboard first load (local) | < 1 s |
| Migration at boot | < 500 ms |
| Memory @ 500 idle SSE conns | < 512 MB |

## 4. Review Checklist (paste into PR)

- [ ] Hard rules §1 reviewed (esp. R1.1 secrets, R1.3 auth, R1.8 streaming, R1.10 SQL)
- [ ] Types strict; zod on all inputs
- [ ] Tests: fixtures/integration added where required
- [ ] Runs on Windows AND Ubuntu (or explicitly server/FE-only)
- [ ] Docs updated (docs/ + README if user-facing)
- [ ] No new dependency without justification
