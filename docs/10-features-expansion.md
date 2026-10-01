# 10 — Features Expansion: Tier 1 + Tier 2 + Tier 3 Roadmap

> **Status:** Tier 1 design + implementation shipped (2026-10-01). Tier 2 + 3 still pending — design sections below are ready for pickup.
> **Scope:** New client-facing features modeled after 9router and other reference gateways. Each section has its own API surface, schema, persistence impact, and test plan.

## Table of contents

1. **Tier 1 — Quick wins** (1–3 hours each) — **✅ SHIPPED (backend)**
   - 1.1 `/v1/embeddings` endpoint — **✅ shipped**
   - 1.2 CLI integration scripts — **✅ shipped**
   - 1.3 Combo presets — **✅ shipped**

2. **Tier 2 — High impact** (½–1 day each) — **⏳ pending**
   - 2.1 Quota auto-ping scheduler — **⏳ pending**
   - 2.2 Cloudflare Tunnel integration — **⏳ pending**

3. **Tier 3 — Strategic** (1–3 days each) — **⏳ pending**
   - 3.1 Fusion (parallel) combo strategy — **⏳ pending**
   - 3.2 Semantic cache (prompt embedding lookup) — **⏳ pending**

## Status snapshot (2026-10-01)

| Feature | Backend | Dashboard UI | Tests | Migration | Status |
|---|---|---|---|---|---|
| 1.1 `/v1/embeddings` | ✅ | ⏳ (overview tile + logs kind filter) | 19/19 ✅ | — | **shipped** |
| 1.2 CLI setup scripts | ✅ (`scripts/cli-tools/`) | ⏳ (Settings page tab) | 11/11 ✅ | — | **shipped** |
| 1.3 Combo presets | ✅ (`src/proxy/comboPresets.ts` + 3 endpoints) | ⏳ (Combos page dropdown) | 9/9 ✅ | — | **shipped** |
| 2.1 Quota auto-ping | ⏳ | ⏳ | — | `0044_quota_ping_log.sql` | **pending** |
| 2.2 Cloudflare Tunnel | ⏳ | ⏳ | — | — (cert.pem in `dataDir/cloudflared/`) | **pending** |
| 3.1 Fusion strategy | ⏳ | ⏳ | — | `0045_combo_fusion_columns.sql` | **pending** |
| 3.2 Semantic cache | ⏳ | ⏳ | — | `0046_semantic_cache.sql` | **pending** |

**Test count:** 324 pass / 0 fail (up from 285; +39 new for Tier 1).

**Docs follow-ups** (per § "Documentation follow-ups" below): partial — `docs/03-api-specification.md` and `docs/05-uiux-design.md` not yet updated for Tier 1 routes.

## Conventions

- All new client endpoints live under `/v1/*` and require `Authorization: Bearer mirais-…` (gateway key). They honour `x-mirais-warmup` (no-op for embeddings) and the standard rate-limit / token-budget checks already in `src/ratelimit.ts`.
- All new admin endpoints live under `/api/*` and require a dashboard session.
- Each feature gets its own migration, schema entry, log kind where applicable, dashboard UI surface, and test coverage. Tests run on `bun test test/`.
- Each feature is gated behind a settings key (default = off) so the operator can opt in.
- All streaming responses use SSE with `text/event-stream; charset=utf-8` and a `[DONE]` sentinel (no streaming for embeddings, image, etc. — those return JSON).
- Each tier is independently shippable. Tier 2 can land without Tier 1's `x-mirais-*` headers breaking.

---

# Tier 1 — Quick wins

## 1.1 `/v1/embeddings` endpoint

### Motivation

9router supports embeddings across 10+ providers (Voyage, Jina, OpenAI, Cohere, Mistral, NVIDIA, Together, Fireworks, OpenAI-compatible custom). Mirais currently has only chat-style endpoints; RAG and similarity search workloads can't run through the gateway. Adding embeddings unlocks vector-store-backed use cases (semantic cache, agent retrieval, memory layers).

### API surface

```
POST /v1/embeddings
Authorization: Bearer mirais-…
Content-Type: application/json

{
  "model": "openai/text-embedding-3-small",   // provider/model, alias, combo:…; routing rules same as chat
  "input": "string" | ["string", …] | number[] | number[][],   // union per OpenAI spec
  "encoding_format": "float" | "base64",      // optional, default "float"
  "dimensions": 384,                          // optional, provider-dependent (text-embedding-3-* supports it)
  "user": "string"                            // optional, opaque end-user id forwarded to upstream
}
```

Response (default `encoding_format: "float"`):

```json
{
  "object": "list",
  "data": [
    {"object": "embedding", "index": 0, "embedding": [0.0123, -0.0456, …]}
  ],
  "model": "text-embedding-3-small",
  "usage": {"prompt_tokens": 12, "total_tokens": 12}
}
```

Errors are OpenAI-shaped (`{"error": {"message", "type", "code", "param"}}`) with the existing `GatewayError` mapping.

### Routing

Reuse `router.resolveWithPolicy(model, policy)` unchanged. Embeddings routes skip:
- `applyReasoningDefaults` (no reasoning param applies)
- Token-saver (`compressInputTokens` is a no-op on embedding input — empty array of strings, no tool outputs)
- `clampMaxTokens` / `clampReasoningTokens` (not relevant)

The resolved `RouteCandidate` flows to a new `executeEmbedding(req, candidates, providersRepo)` function that:

1. Picks the first candidate whose account isn't cooling down.
2. Forwards the body as-is to `{base}/v1/embeddings` with the account's `Authorization: Bearer <key>` header.
3. Streams input strings as JSON (`{"model", "input", …}`); some providers accept `input` as a single string OR array, we pass whatever the client sent.
4. Returns the response body unchanged (already OpenAI-shaped).

### Provider support

| Provider type | Endpoint | Auth |
|---|---|---|
| `openai` | `POST {base}/v1/embeddings` | `Authorization: Bearer …` |
| `azure-openai` | `POST {base}/openai/deployments/{deployment}/embeddings→api-version=…` (deferred — Azure support lives behind a later flag) | `api-key` header |
| `cohere` (new provider type) | `POST https://api.cohere.ai/v1/embed` with `{texts, model, input_type}` | `Authorization: Bearer …`; response shape **not** OpenAI → server-side translator to OpenAI shape |
| `voyage` (new provider type) | `POST https://api.voyageai.com/v1/embeddings` | `Authorization: Bearer …`; already OpenAI-shaped |
| `custom` | `POST {base}/v1/embeddings` | `Authorization: Bearer …` |

For v1 we ship only `openai` and `custom`. `cohere` and `voyage` follow in a follow-up — the design accommodates them by isolating the per-provider translation in `executeEmbedding` so adding a new upstream is a one-file change.

### Type/contract additions

- `src/shared/types.ts`: new `EmbeddingRequest` and `EmbeddingResponse` interfaces (OpenAI spec verbatim).
- `src/shared/schemas.ts`: `embeddingsCreateSchema = z.object({ model, input, encoding_format→, dimensions→, user→ }).passthrough()`. `input` accepts `string | string[] | number[] | number[][]` via a `z.union([...])`.
- `src/shared/types.ts` `RequestLog.kind`: extend the union with `"embedding"`.

### Persistence

- New `request_logs` kind = `"embedding"`. Existing columns carry:
  - `requested_model` = `model`
  - `model` = resolved upstream id
  - `provider` = provider name
  - `input_tokens` = `usage.prompt_tokens` (text tokenisation is a fair proxy for embedding tokenisation across all v1 providers)
  - `output_tokens` = 0
  - `latency_ms` = wall-clock
  - `status`, `http_status`, `error` as usual
  - `attempts_detail` = `{provider, model, accountId, accountLabel, outcome, latencyMs}` JSON
  - `request_body` and `response_body` honour `TRACK_PAYLOADS` mode (default `meta` → request_body **summarised** to `{model, input_count, dimensions→}` so we don't fill the DB with full embedding vectors; response_body skipped entirely under `meta`, included under `full`)

No new tables. No migration needed.

### Account cooldown integration

Use the same `markCooldown` / `markSuccess` plumbing as chat. A 429 from the upstream (model not loaded, deployment not ready, quota exhausted) cools the account down for the standard exponential backoff window. A 5xx retriable as usual.

### Permissions / rate limits

- `key.allowed_models` filter: an embedding-only key (`["openai/text-embedding-3-small"]`) works; same `authorizeModel(key, req.model)` call.
- `key.rate_limit_rpm`, `key.concurrency`, `key.daily_token_budget`, `key.token_budget`: all apply unchanged.

### Settings flag

`features.embeddings: boolean = true` — operators who only want chat can disable the route entirely. Disabled → 404.

### Test plan

- Unit tests for `embeddingsCreateSchema` (parses valid/invalid payloads, accepts both `string` and `string[]` inputs).
- Mocked upstream round-trip:
  - Single string input
  - Array of 16 strings (multi-vector response)
  - `encoding_format: "base64"` round-trip (verify decoder)
  - 429 from upstream → account cooled down
  - 5xx → failover to next candidate
  - `encoding_format` mismatch (provider returns float but client asked base64) → GatewayError 502
- Provider registry test: `openai` and `custom` route types resolve `/v1/embeddings`; `anthropic` etc. reject with 400 ("Provider does not support embeddings").
- `x-mirais-warmup: 1` is treated as a no-op for embeddings (no warmup semantics for embedding models).
- `x-mirais-no-fallback: 1` honored.

### UI surface

- Overview page: "Embedding requests" tile next to chat requests, shows last 24h count + total tokens.
- Logs page: kind filter adds `embedding`.
- Models page (`/v1/models` listing): includes embedding-capable models with `type: "embedding"` tag.

### Effort

~150 lines of new code (1 schema, 1 executor fn, 1 route handler, 1 type update, 1 dashboard tile, 6–8 tests). Estimated 1 hour.

## 1.2 CLI integration scripts

### Motivation

9router ships with per-tool setup guides for 10+ CLI tools (Claude Code, Codex, Cursor, Cline, Kilo, Roo, Continue, Factory Droid, Hermes Agent, plus IDE subscription intercepts). Mirais currently has no equivalent — new users have to hand-edit `~/.claude/settings.json` or `~/.codex/config.toml` themselves, copy the gateway key out of the dashboard, and paste it. This is the single biggest friction in onboarding.

### Command surface

```
mirais tools                       # interactive menu — pick a tool, pick a key, apply
mirais tools <tool>                # apply <tool> (one of: claude-code, codex, cline, continue, kilo, roo, factory-droid)
mirais tools <tool> --dry-run      # print the diff that would be applied, no writes
mirais tools <tool> --reset        # remove any Mirais-applied config (idempotent)
mirais tools list                  # list supported tools and their status (applied / not applied / unknown)
```

Each `<tool>` resolves a default config path (`~/.claude/settings.json` on Linux/macOS, `%USERPROFILE%\.claude\settings.json` on Windows) and patches it in-place. The script never overwrites a file that has user content unrelated to Mirais — it scopes writes under a `// mirais-managed` block or a separate key.

### Per-tool plan

#### claude-code

Claude Code reads `~/.claude/settings.json` (legacy) **or** `~/.claude/settings.local.json` (preferred). Mirais writes/updates only the `env` block:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:1463",
    "ANTHROPIC_AUTH_TOKEN": "mirais-<key>",
    "MIRAIS_MANAGED": "1"
  }
}
```

`MIRAIS_MANAGED: "1"` is the marker that lets `--reset` strip exactly what Mirais added without nuking user-added env vars.

#### codex

Codex reads `~/.codex/config.toml` (TOML). Mirais writes/updates only the `model_provider` + `provider` block:

```toml
model_provider = "mirais"

[model_providers.mirais]
base_url = "http://127.0.0.1:1463/v1"
env_key = "MIRAIS_API_KEY"

[model_providers.mirais.experimental_bearer_token]
# fall back to this when env_key is unset
token = "mirais-<key>"

MIRAIS_MANAGED = true
```

Detection: parse existing TOML with `@iarna/toml` (or hand-rolled mini-parser for our specific keys — TOML is small enough we can do without a dep). Use `bun-toml` if a dep is OK; the parser only handles sections we touch, ~80 LoC.

#### cline

Cline reads `~/.cline/config.json` (Cline v3+) or `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (MCP server config). Mirais prefers the simpler route:

```json
{
  "apiProvider": "OpenAI",
  "openAiBaseUrl": "http://127.0.0.1:1463/v1",
  "openAiApiKey": "mirais-<key>",
  "openAiModelId": "<model from /v1/models>",
  "MIRAIS_MANAGED": true
}
```

#### continue

Continue reads `~/.continue/config.json`. Mirais writes a `models` array entry:

```json
{
  "models": [
    {
      "title": "Mirais",
      "provider": "openai",
      "model": "<model from /v1/models>",
      "apiBase": "http://127.0.0.1:1463/v1",
      "apiKey": "mirais-<key>"
    }
  ],
  "MIRAIS_MANAGED": true
}
```

#### kilo

Kilo reads `~/.kilo/config.json`. Same shape as Cline's `openAi*` block. Provider name `"openai"` for compatibility.

#### roo

Roo reads `~/.roo/config.json`. Same shape as Cline's `openAi*` block. Adds a sidebar model id if missing.

#### factory-droid

Factory Droid reads `~/.factory/config.json`. Mirais writes:

```json
{
  "customModels": [
    {
      "modelString": "<model>",
      "baseUrl": "http://127.0.0.1:1463/v1",
      "apiKey": "mirais-<key>",
      "provider": "openai"
    }
  ],
  "MIRAIS_MANAGED": true
}
```

#### cursor / antigravity / github-copilot

These tools don't support a global override (Cursor's API base is set per-feature via the UI; Antigravity / Copilot intercept live IDE traffic). For these we **print a setup guide** instead of patching files: a markdown block listing the exact menu paths the operator must click, and the exact values to paste (URL + key + a recommended model id from `/v1/models`).

### File layout

```
scripts/
  cli-tools/
    index.ts            # menu + dispatcher
    shared.ts           # path resolution, marker comment, dry-run + atomic-write helpers
    claude-code.ts      # JSON settings
    codex.ts            # TOML config (mini-parser)
    cline.ts
    continue.ts
    kilo.ts
    roo.ts
    factory-droid.ts
    guides.ts           # cursor / antigravity / copilot markdown guides
```

### Settings flag

`features.cli_setup: boolean = true` — operators can disable the whole menu if they prefer manual setup.

### Test plan

- Path resolution: `$HOME` override, Windows `%USERPROFILE%`, missing dir → create it.
- JSON read/write: round-trip preserves unrelated keys (`MIRAIS_MANAGED` marker scopes the patch).
- TOML parser: handles comments, mixed scalar types, re-emits the same shape.
- Dry-run mode: stdout shows the diff, no file touches.
- `--reset`: removes only Mirais-managed keys, leaves user content intact.
- Edge cases: file is symlink, file is read-only, file is missing (created), file has BOM (stripped on read).

### UI surface

Settings page → **CLI tools** tab — a button per supported tool with status pill (`applied` / `not applied` / `unknown`). Clicking opens a modal that shows the resolved path, the key being applied, and a "Run setup" / "Reset" button. Setup runs `mirais tools <tool> --dry-run` first and only writes after operator clicks Confirm.

### Effort

~600 LoC across 9 small files (50–80 LoC each) + 30 LoC dispatcher + 50 LoC tests. Estimated 2–3 hours.

## 1.3 Combo presets

### Motivation

9router ships curated combo templates ("maximize-claude", "free-forever", "always-on", "openclaw-free") that map to common user goals. New Mirais users currently stare at an empty Combos page and have to invent a fallback chain themselves. Presets collapse that to one click: pick a goal, get a sensible default. Once they're on screen the user can edit freely.

### Preset catalogue

Each preset declares:
- A goal label ("Zero cost", "Maximize subscription")
- An ordered list of model-target slots (each slot is either a literal `provider/model` or a tag like `{best-subscription-gpt}`, `{best-cheap-claude}`, etc.)
- A default strategy (`sequential` or `round_robin`)
- A 1-line description that renders in the dropdown

| Preset id | Label | Targets | Strategy |
|---|---|---|---|
| `maximize-subscription` | Maximize subscription | `[{subscription-gpt}, {cheap-claude}, {free-fallback}]` | sequential |
| `zero-cost` | Zero cost (free tiers only) | `[{free-claude-or-gpt}, {free-second}, {free-emergency}]` | sequential |
| `always-on` | Always on (5-tier) | `[{subscription-opus}, {subscription-gpt}, {cheap-claude}, {cheap-gpt}, {free-emergency}]` | sequential |
| `round-robin-spread` | Spread load | `[{primary}, {secondary}, {tertiary}]` | round_robin |
| `codex-first` | Codex + everything else | `[{oauth-cli-codex}, {oauth-browser-gpt}, {cheap-gpt}]` | sequential |
| `claude-only-fallback` | Claude with deep fallback | `[{claude-opus}, {claude-sonnet}, {claude-haiku}, {cheap-claude}, {free-claude}]` | sequential |

### Slot resolution

Tags like `{subscription-gpt}` are resolved at apply-time by walking the providers list and selecting the best enabled model that matches the slot's criteria. The resolver is deterministic — same providers list, same output.

Slot schema:

```ts
type ComboSlot =
  | { kind: "literal"; model: string }                       // "openai/gpt-5.5"
  | { kind: "tag"; tag: ComboSlotTag; fallback→: string[] };  // {kind:"tag", tag:"subscription-gpt", fallback:["openai/gpt-5.5","…"]}

type ComboSlotTag =
  | "subscription-gpt" | "subscription-claude"
  | "cheap-claude" | "cheap-gpt"
  | "free-claude-or-gpt" | "free-claude" | "free-gpt" | "free-emergency"
  | "oauth-cli-codex" | "oauth-browser-gpt"
  | "primary" | "secondary" | "tertiary";
```

The resolver runs in the dashboard (operator sees the resolved list before saving). For every tag it tries every provider of the right `type`, ranked by:
- enabled + has healthy accounts → top
- last warmup status `healthy` > `unknown` > `rate_limited` > `failing`
- model id matches a `curated` set per tag (e.g. "subscription-gpt" prefers `gpt-5.5`, `gpt-5.6-sol`, `gpt-6-sol`; "free-emergency" prefers anything with `free` / `trial` in the name)

If no enabled provider matches a tag, the slot stays as `{kind:"missing", tag}` and the operator sees a warning "No GPT subscription model is enabled — drop in `openai/gpt-5.5` manually or enable a subscription provider."

### Backend surface

New admin endpoint:

```
POST /api/combos/presets/preview
Content-Type: application/json
{ "preset_id": "maximize-subscription" }

→ { name: "maximize-subscription", strategy: "sequential",
    targets: [{slot:"subscription-gpt", resolved:"openai/gpt-5.5", account:"main"}, …],
    unresolved: ["cheap-claude"],
    description: "…" }
```

```
POST /api/combos/presets/apply
Content-Type: application/json
{ "preset_id": "maximize-subscription", overrides→: { cheap-claude: "openai/gpt-5.5" } }

→ { id, name, strategy, chain: ["openai/gpt-5.5", "openai/gpt-5.5", …] }
```

`apply` writes through the existing `combos` table (no migration). Audit row "created" + "combo" recorded. `unresolved` slots block the apply and return 422 with the operator's choice to either (a) drop them via `overrides` or (b) cancel.

### Frontend surface

`Combos` page (`/dashboard/combos`):
- A new dropdown "Insert preset" → renders all 6 presets with their 1-line description.
- Selecting one opens a modal: shows the slot-by-slot resolution (each row: slot name + resolved target + account or "missing"), the operator can override any missing slot from a free-text input, then clicks "Create combo".
- Combo is created via `/api/combos/presets/apply` and the operator lands on the regular edit view.

### Settings flag

`features.combo_presets: boolean = true`.

### Test plan

- Unit: `resolveComboSlot("subscription-gpt", providers)` returns the highest-ranked enabled subscription GPT model, falls back through the `fallback` list if no curated match.
- Integration: `POST /api/combos/presets/preview` returns the resolved chain for each preset with a stub providers list.
- Integration: `POST /api/combos/presets/apply` creates the combo, lists it via `GET /api/combos`, then deletes it.
- Negative: apply with `unresolved` slot and no override → 422.
- UI: render the modal, click "Create combo", verify it shows up in the list.

### Effort

~250 LoC backend (1 resolver fn, 2 endpoints, 1 audit log entry) + 150 LoC dashboard (1 dropdown, 1 modal, 1 override editor) + 8 tests. Estimated 1 hour.





---

# Tier 2 — High impact

## 2.1 Quota auto-ping scheduler

### Motivation

Subscription providers (ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot) reset their quota windows on a fixed cadence � usually a 5-hour rolling window plus a weekly window. Once you exhaust a window, the account sits idle until the next reset. 9router ships a `quotaAutoPing` scheduler that fires a tiny ping request right when the reset hits so the next call lands on a fresh window immediately. Mirais currently only cools accounts down after a 429 � operators have to wait until the next user request hits an exhausted window.

### Behaviour

When `quota_auto_ping.enabled = true`, Mirais schedules a ping request per OAuth account that has a known `reset_at` timestamp:

1. Scheduler ticks every 30 seconds (`runQuotaAutoPingTick`).
2. For each `(provider, account)` pair, look at the **primary** window's `reset_at` (from the last `codex-quota` / `claude-quota` fetch).
3. If `now >= reset_at - 5s && now <= reset_at + 60s` and we haven't pinged for this reset window yet, fire one tiny request:
   - For ChatGPT/Codex: `POST {base}/v1/responses` with `model: <smallest model on the account>`, `max_output_tokens: 1`, `input: "ping"` � costs ~1 token and refreshes the rolling window.
   - For Claude: `POST {base}/v1/messages` with `model: "claude-haiku-4-5"`, `max_tokens: 1`, `messages: [{role:"user", content:"ping"}]`.
   - For GitHub Copilot: hit `/models` (the existing warmup probe).
4. After a successful ping, mark the reset window as "pinged" (key = `reset_at_epoch_ms`); skip until the next window opens.
5. If the ping fails, log it; the next tick will retry the same window until either it succeeds or the window's been open for >5 min (then give up).

### State persistence

In-memory `Map<accountId, Set<resetEpochMs>>` survives process restart via a single new table:

```sql
-- Migration 0044_quota_auto_ping.sql
CREATE TABLE IF NOT EXISTS quota_ping_log (
  account_id    TEXT NOT NULL,
  reset_at      INTEGER NOT NULL,  -- epoch ms of the reset window we pinged
  pinged_at     TEXT NOT NULL DEFAULT (datetime('now')),
  ok            INTEGER NOT NULL,  -- 1 = success, 0 = failure
  detail        TEXT,
  PRIMARY KEY (account_id, reset_at)
);
```

The scheduler loads the last 50 entries at startup to seed its in-memory set. Each successful/failed ping inserts a row, so a restart doesn't re-ping windows we've already covered.

### Settings schema

```ts
interface QuotaAutoPingConfig {
  enabled: boolean;                  // default false
  /** Skip pinging if the account's last warmup_status is "failing" or "rate_limited". */
  skipWhenFailing: boolean;          // default true
  /** Account kinds this applies to. */
  kinds: ("codex" | "claude" | "github-copilot")[];   // default ["codex","claude"]
  /** Per-account override (advanced). */
  overrides→: { [accountId: string]: { enabled→: boolean; pingModel→: string } };
}
```

Lives in the existing `Settings` type, alongside `warmup_config`.

### Type/skill additions

- New shared types: `QuotaAutoPingConfig`, `QuotaPingEntry`.
- New repo `src/store/repos/quotaPings.ts` with `record(accountId, resetAt, ok, detail)` and `recent(accountId, sinceMs)`.

### Scheduler lifecycle

Lives in `src/admin/autoPing.ts` and starts in `src/server.ts` next to `runAutoWarmups`:

```ts
setInterval(() => { void runQuotaAutoPing(); }, 30_000).unref();
```

On shutdown the scheduler stops naturally (the interval is `.unref()`'d). The in-memory map is rebuilt from `quota_ping_log` on the next start.

### Test plan

- Unit: `resolvePingModel(account)` picks the smallest enabled model for the account (curated list per provider type).
- Unit: `shouldPing(account, lastResetAt, pingLog)` returns true exactly once per `resetAt` value per account.
- Integration: mock `fetchCodexUsage` to return `reset_at = Date.now() + 50ms`, run the tick, expect a `POST /responses` call, second tick should skip (already pinged in DB).
- Integration: `quota_ping_log` row written on success + failure, scheduler re-reads on restart.
- Negative: account with `last_warmup_status = "failing"` is skipped.

### UI surface

- **Accounts card** row for OAuth accounts: small "Ping on reset: ON" / "OFF" toggle.
- **Settings** → new "Quota auto-ping" card with the global toggle + per-kind selectors.
- **Provider detail / Quota modal**: shows the last 5 ping log entries (timestamp, status, detail).

### Effort

~300 LoC backend (settings, repo, scheduler, integration) + 120 LoC dashboard (toggle, log view) + 8 tests. Estimated � day.

## 2.2 Cloudflare Tunnel integration

### Motivation

Mirais currently binds to `127.0.0.1:1463` by default (loopback). Operators who want LAN or internet access have to reverse-proxy manually (caddy, nginx, cloudflared). 9router ships a one-click "Cloudflare Tunnel" feature that uses a Cloudflare Quick Tunnel (no account required) or a named tunnel (account required). This is one of 9router's most-loved features for VPS operators.

### Two modes

#### Quick Tunnel (`mirais tunnel quick`)

Uses `cloudflared tunnel --url http://127.0.0.1:1463` to spin up an ephemeral `*.trycloudflare.com` URL. The URL is printed to the operator's terminal and the dashboard settings page. **No Cloudflare account needed.** Session expires when `cloudflared` exits.

#### Named Tunnel (`mirais tunnel login` + `mirais tunnel run`)

Two-step: `mirais tunnel login` opens a browser to https://dash.cloudflare.com/argotunnel→callback=�&token=� to capture a cert.pem; `mirais tunnel run <name>` starts a long-lived tunnel bound to that account. Operator's hostname (e.g. `mirais.example.com`) is set up in Cloudflare dashboard beforehand.

### CLI command surface

```
mirais tunnel                       # show current status (URL if active, "off" otherwise)
mirais tunnel quick [--background]  # spawn cloudflared quick tunnel, capture URL, print it
mirais tunnel login                 # open browser, capture cert.pem, save to ~/.mirais/cloudflared/
mirais tunnel run <name>            # start named tunnel using saved cert.pem + DNS route
mirais tunnel stop                  # kill the cloudflared process
mirais tunnel url                   # print the live URL of the active tunnel
```

The cloudflared child process is tracked in `data/mirais.pid` adjacent file `data/cloudflared.pid` so `mirais restart` can shut it down cleanly.

### Settings schema

```ts
interface TunnelConfig {
  mode: "off" | "quick" | "named";
  named→: {
    name: string;
    certPath: string;             // default $DATA_DIR/cloudflared/cert.pem
    hostname→: string;            // optional, for the dashboard settings display
  };
  /** Auto-start a quick tunnel on `mirais start` when running outside loopback. */
  autoQuickOnNonLoopback: boolean;  // default false
}
```

Lives in `Settings`. The Settings card also shows the live URL (refreshed every 10s via `/api/tunnel/status`).

### Admin API

```
GET    /api/tunnel/status                  → { mode, url, startedAt, uptimeSec }
POST   /api/tunnel/quick   { background→ }  → starts quick tunnel, returns { url } (poll until populated, ~3s)
POST   /api/tunnel/login                    → { url: "https://�", pollToken: "�" } � opens browser
GET    /api/tunnel/login/callback→token=�   → browser redirects back; server stores cert.pem
POST   /api/tunnel/run     { name }          → starts named tunnel
POST   /api/tunnel/stop                     → kills process
```

### Persistence

No new tables. The cert.pem is stored under `dataDir/cloudflared/` with 0600 perms. PID lives in `data/cloudflared.pid`.

### Dependency

We don't add `cloudflared` itself as a node dep � we shell out to the system `cloudflared` binary. Operator installs it separately (documented in `docs/07-deployment-windows-ubuntu.md`). This keeps Mirais's bundle small and lets the operator upgrade cloudflared independently.

The CLI subcommand `mirais tunnel` checks for `cloudflared` in `$PATH` and errors clearly if missing:

```
$ mirais tunnel quick
Error: cloudflared binary not found in PATH. Install from
       https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

### Process management

`scripts/cli.ts` gains a `tunnel` subcommand that:
- Spawns `cloudflared` with detached stdio (logs to `data/cloudflared.log`)
- Captures stdout for the URL (cloudflared prints `Your quick tunnel has been created! Visit it at https://�`)
- Persists the PID; on `mirais restart`/`mirais stop`, sends SIGTERM first

### Test plan

- Unit: `parseCloudflaredUrl(stdout)` extracts the `https://*.trycloudflare.com` URL from cloudflared's banner output.
- Unit: `pidAlive(pid)` returns true/false via `process.kill(pid, 0)`.
- Integration (mocked cloudflared): `mirais tunnel quick` writes the captured URL to the settings file; `mirais tunnel stop` sends SIGTERM.
- Negative: cloudflared missing from PATH → 404 with clear message.

### UI surface

Settings page → **Tunnel** card showing:
- Current mode + URL (auto-refreshed every 10s)
- "Start quick tunnel" button (instant, ~3s for URL to appear)
- "Login to Cloudflare" button (opens browser)
- "Run named tunnel" input + button
- "Stop" button

### Effort

~400 LoC backend (subcommand, URL parser, process manager, 4 endpoints, settings) + 100 LoC dashboard (status card with auto-refresh) + 6 tests. Estimated � day.


---

# Tier 3 — Strategic

## 3.1 Fusion (parallel) combo strategy

### Motivation

9router ships a "Fusion" combo strategy: instead of `sequential` (try A, then B on failure) or `round_robin` (rotate between A and B per request), Fusion fires the prompt at **N candidates in parallel** and a designated "judge" model picks the best answer (or merges them). For high-value tasks (architecture decisions, code review, complex reasoning), the added latency is worth the quality boost.

### Strategy variants

- `fusion-best`: fire N candidates, judge picks the best answer verbatim. Latency = max(all) + judge.
- `fusion-merge`: fire N candidates, judge merges into a single coherent answer. Latency = max(all) + judge.
- `fusion-vote`: fire N candidates, judge picks the answer that wins a majority on a structured rubric (later, optional).

### Combo schema change

```ts
interface Combo {
  // existing fields�
  strategy: "sequential" | "round_robin" | "fusion-best" | "fusion-merge";
  fusion→: {
    /** Maximum number of candidates fired in parallel (default = min(3, chain.length)). */
    maxParallel: number;
    /** Index of the candidate that serves as the judge (0-based into `chain`). */
    judgeIndex: number;
    /** Optional override model id for the judge (skips the chain's judgeIndex target). */
    judgeModel→: string;
    /** Minimum tokens reserved for the judge's response (default 1024). */
    judgeMaxOutputTokens: number;
  };
}
```

Migration 0045:

```sql
ALTER TABLE combos ADD COLUMN fusion_max_parallel INTEGER;
ALTER TABLE combos ADD COLUMN fusion_judge_index INTEGER;
ALTER TABLE combos ADD COLUMN fusion_judge_model TEXT;
ALTER TABLE combos ADD COLUMN fusion_judge_max_output_tokens INTEGER NOT NULL DEFAULT 1024;
```

Existing combos default `NULL` for the first three � runtime reads them as "use defaults" (maxParallel = min(3, chain.length), judgeIndex = 0).

### Executor changes

`src/proxy/executor.ts` adds `executeFusionRequest(req, candidates, providersRepo, policy, ctx)`:

1. Resolve all candidates via `router.resolveWithPolicy`.
2. Build the parallel plan: for each candidate, pick one non-cooling-down account via `buildAccountPlan`.
3. Cap at `fusion.maxParallel`. If fewer than 2 candidates are available, fall back to sequential (log a warn).
4. Fire `Promise.allSettled(candidates.map((entry, idx) => runCandidate(entry, idx, req, ctx)))` � each returns a normal `ExecuteResult` JSON response.
5. Pick the judge candidate (`fusion.judgeIndex` or `judgeModel`). Build a meta-prompt: the original `system` + `messages` are prefixed with the N candidate responses (labeled `[Candidate 1]`, �) and a verdict instruction: "Pick the best response, output verbatim. Do not modify."
6. Stream the judge's response (or non-stream) to the client, attributing the response to the original `req.model` (combo name).
7. Log two request rows: one with `kind: "fusion"` for the parallel candidates (latency = wall clock, attempts_detail = all N candidates), one with `kind: "fusion-judge"` for the judge call. Both count toward `daily_token_budget` and `request_logs`.

### Failure semantics

- If 0 candidates succeed: throw the last error from the parallel run.
- If =1 candidate succeeds: proceed to judge regardless of others' status. The judge prompt includes only the successful candidates (failed ones are excluded from the menu).
- If the judge call fails: fall back to the first successful candidate verbatim. Log a warn.

### Test plan

- Unit: `planFusion(candidates, maxParallel)` returns the first N non-cooling-down entries.
- Unit: `buildJudgePrompt(req, candidates)` produces a stable prompt (snapshot test).
- Integration (mocked): fire 3 candidates, all return distinct answers, judge selects #2, response streamed matches judge choice verbatim.
- Integration: 2 of 3 candidates fail → judge proceeds with the 1 survivor.
- Integration: judge fails → fallback to first survivor verbatim.
- Cost guardrail: `daily_token_budget` decrements by 2� on a fusion call (candidates + judge).

### UI surface

`Combos` page → combo edit modal → new "Strategy" radio:
- `Sequential` (existing)
- `Round-robin` (existing)
- `Fusion (best answer)` → reveals Max parallel, Judge source dropdown
- `Fusion (merge answers)` → same fields

Each fusion variant shows: a live "Estimated cost multiplier" hint (e.g. "2.3� � 3 candidates + judge").

### Effort

~500 LoC executor + 200 LoC UI (modal additions) + 8 tests. Estimated 1 day.

## 3.2 Semantic cache

### Motivation

Vector caches are a standard speedup for LLM gateways. If two requests have semantically similar prompts, return the cached answer instead of paying for a second inference. 9router doesn't ship this yet but several competitors (Portkey, LiteLLM) do. With Mirais's Tier 1 embeddings endpoint already shipping, the dependency is free.

### Behaviour

For every successful non-streaming chat request:
1. Embed the request's last user message via the configured embedding model.
2. Lookup in the cache: a SQLite-backed vector table (`semantic_cache`) using cosine similarity = `threshold` (default 0.92).
3. If hit: return the cached response, log `kind: "semantic-cache-hit"`, decrement `daily_token_budget` only for the (much smaller) estimated cost of the cache miss (so the operator doesn't lose budget visibility).
4. If miss: forward to the upstream, cache the response on success.

Streaming requests always bypass the cache (response chunks don't fit a vector lookup well). Embeddings requests bypass the cache (they ARE the embedding that drives the cache).

### Settings schema

```ts
interface SemanticCacheConfig {
  enabled: boolean;                          // default false
  /** Embedding model used for prompt fingerprinting. */
  embeddingModel: string;                    // default "openai/text-embedding-3-small"
  /** Cosine similarity threshold above which a cached response is reused. */
  threshold: number;                         // default 0.92
  /** TTL for cache rows in seconds (default 86400 = 24h). */
  ttlSeconds: number;
  /** Maximum prompt length to consider (in characters; default 8192). */
  maxPromptChars: number;
  /** Skip when the request contains tools (cache key is too volatile). */
  skipWhenTools: boolean;                    // default true
}
```

### Storage schema

Migration 0046:

```sql
CREATE TABLE IF NOT EXISTS semantic_cache (
  id            TEXT PRIMARY KEY,
  cache_key     TEXT NOT NULL UNIQUE,           -- sha256(model + normalized_messages)
  embedding     BLOB NOT NULL,                   -- packed Float32[] of the prompt embedding
  model         TEXT NOT NULL,
  request_hash  TEXT NOT NULL,                   -- hash of the full canonical request (for replay)
  response_body TEXT NOT NULL,                   -- serialized CanonicalResponse
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  last_hit_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires ON semantic_cache(expires_at);
```

Cosine similarity over `embedding` is implemented via a small in-process brute-force scan (acceptable up to ~5k rows; beyond that the operator should prune via `purge_expired` or manually). For larger deployments a future tier could swap in `sqlite-vec` or a separate vector store, but that's out of scope for v1.

### Cosine-similarity search

For a query embedding `q`:
1. Fetch all rows where `expires_at > now()` (cheap index range scan).
2. Compute `cos_sim(q, row.embedding)` for each; track the best.
3. If best = `threshold`, return the row's `response_body`.

Implementation lives in `src/proxy/semanticCache.ts`:

```ts
export function findCachedResponse(
  queryEmbedding: Float32Array,
  model: string,
  threshold: number,
  nowMs: number,
  candidates: Array<{ id: string; embedding: Float32Array; responseBody: string; � }>,
): { id: string; responseBody: string; similarity: number } | null;
```

Brute force is fine because we cap at 5k live rows. The dashboard exposes a manual `purge_expired` button.

### Cache-key normalisation

The `cache_key` is `sha256(model + "\n" + normalized_messages_json)` where:
- System messages are concatenated.
- User messages are concatenated in order, with whitespace collapsed (`\s+` → ` `), emoji stripped, line breaks normalised to `\n`.
- Tool calls and tool results are excluded from the key (the full request_hash includes them; if tools differ, the response shouldn't match).

`normalized_messages_json` is computed once at request time, both for embedding and for the cache key � they share the same string.

### Cost / safety guards

- A response with `usage.total_tokens > 4096` is **not cached** (large outputs are too expensive to risk returning for a near-match query).
- A response with `finish_reason !== "stop"` (length, tool_calls, content_filter) is **not cached**.
- A response containing `tool_calls` is **not cached**.
- The cache is per-model and per-key � `x-mirais-key` (or the gateway key id) is part of the key so a different tenant with the same prompt gets a different cache namespace. **Wait, that breaks the cross-tenant benefit.** We make it per-key by default but operators can opt into a shared cache via `semantic_cache.shared_namespace: true`.

### Test plan

- Unit: `normalizeMessages(req)` produces a stable string for two requests with equivalent prompts but different formatting.
- Unit: `cosineSimilarity(a, b)` is 1.0 for identical vectors, 0.0 for orthogonal, -1.0 for opposite.
- Unit: `findCachedResponse` returns null when best similarity < threshold; returns the best row above threshold.
- Integration (mocked upstream + mock embedding): first request misses → upstream called → response cached. Second request with a paraphrased prompt → cache hit. Third request with a totally different prompt → miss again.
- Cost: daily_token_budget decrements by `cached.cost` (not the full upstream cost) on a hit.
- Safety: tool-call response not cached; long response not cached; non-stop finish reason not cached.
- TTL: expired rows skipped.

### UI surface

Settings page → **Semantic cache** card:
- Master toggle + the settings (model, threshold, TTL)
- Stats: cache hit rate (last 24h), rows stored, oldest row age
- "Purge expired" button
- "Clear cache" button (with typed-confirm)

### Effort

~600 LoC (semantic cache fn + cache-key normalizer + brute-force search + integration) + 150 LoC UI (settings card + stats) + 12 tests. Estimated 1�3 days.

---

# Summary

| Feature | Tier | Backend | Dashboard UI | Tests | Status |
|---|---|---|---|---|---|
| 1.1 `/v1/embeddings` | 1 | ✅ shipped | ⏳ pending | 19/19 ✅ | **shipped** |
| 1.2 CLI setup scripts | 1 | ✅ shipped | ⏳ pending | 11/11 ✅ | **shipped** |
| 1.3 Combo presets | 1 | ✅ shipped | ⏳ pending | 9/9 ✅ | **shipped** |
| 2.1 Quota auto-ping | 2 | ⏳ pending | ⏳ pending | — | **pending** |
| 2.2 Cloudflare Tunnel | 2 | ⏳ pending | ⏳ pending | — | **pending** |
| 3.1 Fusion strategy | 3 | ⏳ pending | ⏳ pending | — | **pending** |
| 3.2 Semantic cache | 3 | ⏳ pending | ⏳ pending | — | **pending** |
| **Total remaining** | | **~5–7 days** | | | |

**Pickup notes for the next session (5 things that will speed up Tier 2/3 implementation):**

1. **Quota auto-ping** (`src/admin/autoPing.ts`) is the smallest Tier 2 piece — ~300 LoC, no frontend beyond an "on/off" toggle on OAuth accounts. Start here.
2. **`quota_ping_log` migration** is the only persistence needed for Tier 2.1. `src/store/repos/quotaPings.ts` is a thin wrapper over `db.query` — copy the shape from `src/store/repos/audit.ts`.
3. **Cloudflare Tunnel** requires shelling out to `cloudflared` — confirm the operator installs it (or make it optional with a graceful "no tunnel" mode).
4. **Fusion strategy** only needs the `combos` table migration (`fusion_max_parallel`, `fusion_judge_index`, etc.) and a new `executeFusionRequest` next to `executeRequest`. No new persisted tables.
5. **Semantic cache** depends on `quota_auto_ping` for `quota_ping_log` patterns but NOT on `fusion`. Do it last.

## Phased rollout

1. **Phase A (Tier 1, ~4h):** ✅ **DONE 2026-10-01** — embeddings + CLI scripts + combo presets. Backend shipped; dashboard UI follow-ups pending.
2. **Phase B (Tier 2, ~1 day):** ⏳ — quota auto-ping + Cloudflare tunnel. Daily-user impact.
3. **Phase C (Tier 3, ~3–4 days):** ⏳ — fusion + semantic cache. Strategic / competitive features.

Each phase is independently shippable behind a `features.*` flag. Operators opt in per-phase from the Settings page.

## Migration inventory

**Tier 1 (shipped) — no migrations.**

| # | Name | Adds | Status |
|---|---|---|---|
| 0044 | `quota_ping_log` | table for Tier 2.1 | **pending** |
| 0045 | `combo_fusion_columns` | 4 columns for Tier 3.1 | **pending** |
| 0046 | `semantic_cache` | table for Tier 3.2 | **pending** |

Embeddings (1.1), CLI scripts (1.2), combo presets (1.3), and Cloudflare tunnel (2.2) need no migration — they reuse existing tables or persist to `dataDir/cloudflared/`.

## Test coverage target

**Tier 1 (shipped):** 39 new tests, 0 fail. Total: 324 pass / 0 fail (up from 285).

After Tier 2 + 3 land, the test suite should sit at ~340–360 passing tests:
- Tier 2: ~14 new tests (auto-ping logic + Cloudflare URL parser + subprocess mock)
- Tier 3: ~20 new tests (fusion judge flow + semantic cache lookup)

## Documentation follow-ups

- `docs/03-api-specification.md` — ✅ **add `/v1/embeddings` (Tier 1.1 — done)** + ⏳ Cloudflare tunnel endpoint (Tier 2.2)
- `docs/05-uiux-design.md` — ⏳ Settings page additions for each tier (CLI tools tab + Tunnel card + Semantic cache card)
- `docs/06-implementation-phases.md` — ⏳ append the three new phases
- `docs/07-deployment-windows-ubuntu.md` — ⏳ add `cloudflared` install instructions
- New `docs/11-cli-tools-reference.md` — ⏳ operator-facing reference for `mirais tools …`

> **When you (or I, on a future session) pick up Tier 2/3 implementation:** re-read this doc from top. The Status snapshot table at the top will need updating, and any deviations from the original spec should be noted inline next to the relevant section.

## Reference: actual code locations shipped for Tier 1

| File | Purpose |
|---|---|
| `src/shared/types.ts` | `EmbeddingRequest`, `EmbeddingResponse`, `EmbeddingInput`, `EmbeddingDataItem` |
| `src/shared/schemas.ts` | `embeddingsCreateSchema` |
| `src/proxy/executor.ts` | `executeEmbedding()` + `EmbeddingResult` interface; `clearAllCooldowns()` (test-only export) |
| `src/proxy/routes.ts` | `app.post("/embeddings", ...)` route + log kind extension to `"embedding"` |
| `src/proxy/comboPresets.ts` | `COMBO_PRESETS` (6 entries), `resolveComboPreset()`, `ComboSlot`, `ComboSlotTag` |
| `src/admin/routes.ts` | `comboRoutes` extensions: `GET /api/combos/presets`, `POST /api/combos/presets/preview`, `POST /api/combos/presets/apply` |
| `scripts/cli-tools/index.ts` | `TOOLS`, `GUIDES`, `runTools()` dispatcher |
| `scripts/cli-tools/shared.ts` | `resolveConfigDir()`, `patchJsonFile()`, `stripManaged()`, `writeIfChanged()` |
| `scripts/cli-tools/{claude-code,codex,cline,continue,kilo,roo,factory-droid}.ts` | Per-tool patcher |
| `scripts/cli-tools/guides.ts` | `guideCursor()`, `guideAntigravity()`, `guideGithubCopilot()` |
| `scripts/cli.ts` | `case "tools"` subcommand dispatch |
| `package.json` | `scripts.tools` script alias |
| `test/embeddings.test.ts` | 19 tests for schema + executor |
| `test/cli-tools.test.ts` | 11 tests for patchers + TOML round-trip |
| `test/combo-presets.test.ts` | 9 tests for `resolveComboPreset()` (literal, tag, override, disabled provider, fallback, round-robin) |

