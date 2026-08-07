# 03 — API Specification

Base URL: `http://localhost:1463`

Two API surfaces:
- **Client API** (`/v1/*`) — used by AI tools; authenticated with gateway API keys (`Authorization: Bearer mirais-…`).
- **Admin API** (`/api/*`) — used by the dashboard; authenticated with a session cookie from password login.

---

## A. Client API (`/v1`)

### POST `/v1/chat/completions`
OpenAI Chat Completions. Streaming via `"stream": true` (SSE).

```bash
curl http://localhost:1463/v1/chat/completions \
  -H "Authorization: Bearer mirais-XXXX" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "combo:never-stop",
    "messages": [{"role":"user","content":"Say hi"}],
    "stream": true
  }'
```

**Model string forms:**
| Form | Example | Meaning |
|------|---------|---------|
| Direct | `gpt-5.2`, `claude-opus-4-7` | Routed to the provider that owns the model |
| Qualified | `openai/gpt-5.2`, `anthropic/claude-opus-4-7` | Force a specific provider |
| Alias | `fast`, `smart` | Admin-defined alias → concrete model |
| Combo | `combo:never-stop` | Fallback chain defined in dashboard |

**Extra headers:**
- `X-Mirais-Token-Saver: off` — skip compression for this request.
- `X-Mirais-No-Fallback: 1` — fail on first upstream error instead of trying the chain.

### POST `/v1/responses`
OpenAI Responses API shape. Translated to canonical and routed the same way. Streaming supported.

### POST `/v1/messages`
Anthropic Messages shape (`model`, `max_tokens`, `messages`, optional `system`, `tools`, `stream`). Response returned in Anthropic format.

### GET `/v1/models`
Unified catalog in OpenAI list format: every enabled model from every enabled provider + aliases + combos (`id`, `object: "model"`, `owned_by`).

### GET `/health`
`200 { "status": "ok", "uptime": 12345, "version": "0.1.0" }` — no auth.

### Client error shape
```json
{ "error": { "message": "…", "type": "authentication_error|rate_limit_error|invalid_request_error|server_error", "code": "…" } }
```

| Status | When |
|--------|------|
| 401 | Missing/invalid gateway key |
| 403 | Key's model ACL denies this model |
| 429 | Key rate/concurrency/token-budget exceeded, or all upstreams rate-limited |
| 400 | Bad request payload (validated with zod) |
| 502 | All upstream candidates failed |

---

## B. Admin API (`/api`)

All `/api/*` routes require the session cookie `mirais_session`, **except** `/api/auth/*` and `/api/health`. The guard is enforced globally (any `/api/*` request without a valid session → `401 { "error": "Unauthorized" }`).

### Auth

| Method | Path | Body → Response |
|--------|------|-----------------|
| POST | `/api/auth/login` | `{ "password": "…", "remember"?: bool }` → `200 { ok: true, setup_required: bool }` + Set-Cookie; `401` on wrong password (rate-limited: 5 tries / 5 min / IP). Session TTL: `SESSION_TTL_HOURS` (default 12h — set ≤ 6 for short logins); `remember: true` extends to 30 days |
| POST | `/api/auth/logout` | → clears cookie |
| GET | `/api/auth/check` | Always `200` → `{ authenticated: bool, setup_required: bool }` — lets the SPA distinguish "no password set" from "not logged in" |
| POST | `/api/auth/setup` | `{ "password": "…" }` → first-run password set (only when none configured; `409` otherwise) + Set-Cookie |
| POST | `/api/auth/change-password` | `{ "current": "…", "next": "…" }` → change dashboard password (requires session) |

### Overview / analytics

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/stats/summary?range=24h\|7d\|30d` | `{ requests, inputTokens, outputTokens, estCostUsd, avgLatencyMs, successRate }` + delta vs previous range |
| GET | `/api/stats/timeseries?range=…&bucket=hour\|day` | `[{ t, requests, tokens, cost }]` for charts |
| GET | `/api/stats/by-model?range=…` | `[{ model, requests, tokens, cost, errors }]` |
| GET | `/api/stats/by-provider?range=…` | `[{ provider, requests, tokens, cost, errors, avgLatencyMs }]` |

### Providers & accounts

`Provider` = an upstream service. Built-in types: `openai`, `anthropic`, `gemini`, `openrouter`, `deepseek`, `groq`, `xai`, `glm`, `blackbox`, `antigravity`, `custom` (custom = any OpenAI-compatible base URL).

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/providers` | List providers with accounts, models, health |
| POST | `/api/providers` | Create: `{ name, type, baseUrl?, enabled }` |
| PATCH | `/api/providers/:id` | Update fields / enable-disable |
| DELETE | `/api/providers/:id` | Remove (blocked if referenced by a combo) |
| POST | `/api/providers/:id/accounts` | Add account: `{ label, apiKey, priority? }` |
| POST | `/api/providers/:id/accounts/bulk` | Bulk import: `{ apiKeys: string[], labelPrefix? }` (max 200) → `{ added, skipped }`; labels auto-generated, duplicates skipped |
| GET | `/api/providers/:id/accounts/usage` | Per-account usage from request logs → `[{ account, requests_today, tokens_today, requests_total, tokens_total }]` |
| GET | `/api/providers/accounts/:accId/codex-quota` | ChatGPT/Codex quota snapshot (OAuth accounts only) → `{ plan_type, email, limit_reached, primary, secondary, credits }`; each window has `used_percent, remaining_percent, window_seconds, resets_in_seconds, reset_at`. `secondary` = the 5-hour window when the plan has one |
| POST | `/api/providers/accounts/:accId/codex-quota/reset` | Attempt ChatGPT/Codex banked reset for an OAuth account → `{ ok, message }` |
| GET | `/api/logs?kind=` | Request logs; `kind=request\|warmup` filters warmup pings. When `TRACK_PAYLOADS=full`, each entry includes `request_body` (prompt preview) + `response_body` (reply or `ERROR: …`) |
| GET | `/api/logs/usage?days=` | Usage log — real traffic (`kind='request'`) aggregated per provider+model → `[{ provider, model, requests, input_tokens, output_tokens, avg_latency_ms, errors, last_ts }]` |
| POST | `/api/oauth/openai/start` | Start ChatGPT (Codex) OAuth login: `{ providerId }` → `{ url }` to open in the browser (openai-type providers only) |
| GET | `/oauth/callback` | OAuth redirect target — exchanges the code (PKCE) for tokens and creates the account labeled `ChatGPT (email)`. Public route, no session |
| PATCH | `/api/providers/:id/accounts/:accId` | Update key/priority/enabled |
| DELETE | `/api/providers/:id/accounts/:accId` | Remove account |
| POST | `/api/providers/:id/accounts/:accId/test` | Live test → `{ ok, latencyMs, error? }` |
| POST | `/api/providers/:id/test` | Connectivity test against the upstream `/models` endpoint → `{ ok, status, latency_ms, account }`. For OAuth accounts: a token refresh stands in for the test (Codex backend has no `/models`) |
| POST | `/api/providers/:id/sync` | Fetch full model list from upstream `/models` and register all → `{ synced, models }`. For OAuth accounts: syncs the live Codex catalog (`{codex}/models?client_version=1.0.0`) |
| POST | `/api/providers/:id/models/:modelId/test` | Per-model test: tiny chat completion (`max_tokens: 16`) against the upstream → `{ ok, status, latency_ms, model, detail? }`. For OAuth accounts: a streaming Codex `/responses` call (backend requires `stream: true`) |
| GET | `/api/providers/:id/models` | Models known for this provider |
| PUT | `/api/providers/:id/models/:modelId` | Update one model's metadata (display name, enabled state, context/capability metadata) |

### Aliases

| Method | Path | Notes |
|--------|------|-------|
| GET / POST | `/api/aliases` | List / create `{ alias, target }` (`fast` → `openrouter/auto`). **Target must use the qualified `provider/model` slash form** (same as the router) — the dashboard builds it as `` `${providerName}/${modelId}` `` |
| DELETE | `/api/aliases/:id` | Remove |

### Combos (fallback chains)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/combos` | List combos with their chains |
| POST | `/api/combos` | `{ name, strategy: "sequential", chain: ["anthropic/claude-opus-4-7", "openai/gpt-5.2", "glm/glm-5.1"] }` |
| PATCH | `/api/combos/:id` | Rename / reorder chain |
| DELETE | `/api/combos/:id` | Remove |
| POST | `/api/combos/:id/test` | Dry-run resolution → shows which providers would be tried |

### Gateway API keys

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/keys` | List (never returns plaintext; shows prefix, limits, usage) |
| POST | `/api/keys` | `{ label, allowedModels?: [], rateLimitRpm?, concurrency?, dailyTokenBudget?, expiresAt? }` → returns the key record plus a `plaintext` field — **shown once, never stored** |
| PATCH | `/api/keys/:id` | Update limits, enable/disable |
| DELETE | `/api/keys/:id` | Revoke |
| GET | `/api/keys/:id/usage?range=…` | Per-key stats |

### Logs

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/logs?cursor=&status=&model=&provider=&keyId=&q=` | Paginated request history (id, ts, model, provider, status, tokens, latency, cost, error) |
| GET | `/api/logs/:id` | Detail incl. payloads if `TRACK_PAYLOADS=full` |
| DELETE | `/api/logs` | Purge (body: `{ before: "ISO-date" }`) |

### Settings

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/settings` | Token saver toggle/rules, terse mode, retention days, server info |
| PATCH | `/api/settings` | Update any of the above |
| GET | `/api/settings/export` | Full config export (JSON, secrets redacted) |
| POST | `/api/settings/import` | Import config (merge) |

### Dashboard exposure and auth behavior

- Dashboard passwordless mode is supported only when Mirais is bound to loopback (`127.0.0.1`, `::1`, or `localhost`).
- If Mirais is configured with a non-loopback host such as `0.0.0.0`, startup is rejected unless a dashboard password is configured through `DASHBOARD_PASSWORD` or the stored password hash.
- The dashboard Settings page can toggle network binding, but switching to exposed mode still requires a password before the server can successfully start.

---

## C. Static & Misc

| Path | Behavior |
|------|----------|
| `/` | Dashboard SPA (redirects to `/login` if unauthenticated) |
| `/assets/*` | Static dashboard files |
| `GET /health` | Liveness |
| Anything else | 404 JSON |
