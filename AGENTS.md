# AGENTS.md — Instructions for AI Coding Agents

> Read this file **first** before touching any code in this repository. Then read the doc(s) relevant to your task in `docs/`.

## What this project is

**Mirais** — a self-hosted AI gateway & router. One local endpoint (`http://localhost:1463`) that routes LLM requests across multiple providers, translates OpenAI ↔ Anthropic API shapes on the fly, compresses tokens, tracks usage, and is managed through a passwordless dashboard.

The single source of truth is the documentation set:

| File | Use it when |
|------|-------------|
| [docs/01-architecture.md](docs/01-architecture.md) | Changing request flow, routing, translation, token saver |
| [docs/02-tech-stack-and-project-structure.md](docs/02-tech-stack-and-project-structure.md) | Adding files/dependencies, env vars |
| [docs/03-api-specification.md](docs/03-api-specification.md) | Adding/changing any endpoint |
| [docs/04-database-schema.md](docs/04-database-schema.md) | Changing schema → new migration file required |
| [docs/05-uiux-design.md](docs/05-uiux-design.md) | Any dashboard work |
| [docs/06-implementation-phases.md](docs/06-implementation-phases.md) | Knowing what to build next |
| [docs/07-deployment-windows-ubuntu.md](docs/07-deployment-windows-ubuntu.md) | Deployment/service/Docker work |
| [PRD.md](PRD.md) | Understanding *what* and *why* |
| [DESIGN.md](DESIGN.md) | Technical & UI design decisions (ADRs) |
| [RULES.md](RULES.md) | Coding rules — **binding, not optional** |
| [SOUL.md](SOUL.md) | Project principles — the spirit behind decisions |

## Stack (fixed — do not substitute)

- **Backend:** Bun ≥ 1.1 + Elysia + zod, SQLite via `bun:sqlite` (WAL)
- **Dashboard:** React 18 + Vite + Tailwind CSS v4 + TanStack Query + lucide-react + recharts
- **No** Next.js, **no** ORMs, **no** native npm modules, **no** Redis

## Commands

```bash
bun run dev            # backend (:1463) + dashboard dev server
bun run typecheck      # MUST pass before considering work done
bun test test/         # MUST pass
bun run build          # builds dashboard into dashboard/dist
bun run smoke          # post-deploy verification
```

## How to work

1. **Small, focused changes.** One concern per commit. Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
2. **Match existing structure.** New backend module → follow `src/` module map (doc 01 §3). New dashboard page → `dashboard/src/pages/` + sidebar entry.
3. **Types first.** Shared shapes live in `src/shared/types.ts`; validate all external input with zod schemas from `src/shared/schemas.ts`.
4. **Every DB change = new migration** in `src/store/migrations/` (never edit applied migrations).
5. **Errors follow the spec.** Client API → OpenAI-shaped errors (doc 03). Admin API → `{ "error": "…" }`.
6. **Streaming is first-class.** Never buffer full SSE responses in the proxy path.
7. **Security invariants (never break):** the gateway key is a plaintext credential stored in the local DB (single-user install, recoverable — see RULES.md R1.2). The Mirais dashboard has no application-level password or login; control external access with a reverse proxy, firewall, VPN, or private network.
8. **Cross-platform always.** No hardcoded path separators, no OS-specific APIs; if it can't run on both Windows and Ubuntu, it doesn't merge.
9. **Tests:** translators and token saver require golden-fixture unit tests; new endpoints require integration tests. See doc 02 §6.
10. **Update docs in the same PR** when behavior, API, schema, or UI changes.
11. **Only commit and push after verification and user confirmation.** First run the relevant tests and checks, then report the results and wait for the user to confirm that the fix is correct. Do not commit or push before that confirmation. After confirmation, commit and push the verified fix to GitHub.
12. **Respect exposure safety rules.** The dashboard is passwordless. When Mirais is exposed beyond a trusted network, restrict access with a reverse proxy, firewall, VPN, or private network. Never rely on an application-level dashboard login.

## Do NOT

- Do not add a dependency without checking doc 02 §1 first (most needs are covered by Bun built-ins).
- Do not log request/response bodies unless `TRACK_PAYLOADS=full` is set.
- Do not introduce `any` types, `// @ts-ignore`, or console.log debugging in committed code.
- Do not break the exit criteria of the current phase (doc 06) — work phase by phase.
- **Never rotate, regenerate, revoke, or disable the global gateway API key, run a one-off key creation, or touch `gateway_keys` rows in any way, without explicit confirmation from the user.** The user owns the key and rotates it manually from the dashboard's "Generate new key" button (or the `mirais rotate` CLI command). If a task seems to require touching the key — pause and ask. This rule is independent of any other permission; it overrides general workflow guidance.

## Current status

Phases 0–7 complete (Windows verified; Ubuntu docker run pending). See the checklist in [docs/06-implementation-phases.md](docs/06-implementation-phases.md).
