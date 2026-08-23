# 03 — API Specification

Base URL: `http://localhost:1463`

Two API surfaces:
- **Client API** (`/v1/*`) — used by AI tools; authenticated with gateway API keys (`Authorization: Bearer mirais-…`). The dashboard password never applies here.
- **Admin API** (`/api/*`) — used by the dashboard; session-protected by the dashboard password (on by default, can be turned off), with external access controlled by a reverse proxy, firewall, VPN, or private network.

### Payload logging

Set `TRACK_PAYLOADS=full` in `.env` to retain request and response payloads for new gateway requests. The dashboard **Logs** detail view displays captured bodies and provides copy controls. This mode can contain user prompts, tool outputs, and model responses; use it only on a trusted machine and switch back to `meta` when troubleshooting is complete. Authorization headers and provider credentials are never recorded by request logging.

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
- `X-Mirais-Session-Id: <opaque-id>` — optional stable conversation ID. For xAI Grok CLI OAuth routes, Mirais maps this to the Grok CLI session/conversation and tracks the turn index in memory. `X-Grok-Session-Id` is accepted as a compatibility alias.

**Tool calling:** When a tools-enabled upstream emits DeepSeek DSML markup in text deltas, Mirais converts it incrementally to OpenAI `delta.tool_calls` events. DSML markup is never forwarded as `delta.content`; valid calls finish with `finish_reason: "tool_calls"`. Malformed DSML terminates the SSE stream with an OpenAI-shaped `dsml_parse_error` event followed by `[DONE]`.

**Universal reasoning/thinking block:**
Clients can control reasoning/thinking without speaking provider-specific dialect:
```json
{ "reasoning": { "enabled": true, "effort": "medium", "budget_tokens": 2048 } }
```
- `enabled` (default true) — turns thinking-style output on/off for this request.
- `effort` — `minimal | low | medium | high | xhigh`. Mapped to OpenAI/Codex `reasoning.effort`.
- `budget_tokens` — Anthropic extended-thinking budget (Anthropic providers only).
When enabled, the executor strips `temperature`/`top_p` for Anthropic upstreams as required by their API.

### POST `/v1/responses`
Stateless OpenAI Responses compatibility. Supports string/easy-message input, instructions, image URLs, client-executed function calls and outputs, strict function schemas, reasoning effort, structured JSON output, `max_output_tokens`, parallel function-call SSE, and usage events. `store` and `background` may be omitted or `false`; persistent response IDs, conversations, prompts, hosted web/file/code/computer/MCP tools, and retrieval/delete/cancel-by-ID resources are rejected rather than silently ignored. Disconnecting the HTTP request still cancels the active upstream operation.

Responses/OpenAI endpoints return `x-request-id`. `/v1/messages` accepts either `Authorization: Bearer <gateway-key>` or the Anthropic SDK's `x-api-key: <gateway-key>` and returns `request-id` plus `x-request-id`. Sampling, service-tier, logprob, and strict-schema behavior can remain provider-dependent when a request is translated across API dialects.

### POST `/v1/messages`
Anthropic Messages shape (`model`, `max_tokens`, `messages`, optional `system`, `tools`, `stream`). Response returned in Anthropic format.

### GET `/v1/models`
Unified catalog in OpenAI list format: policy-allowed enabled models from enabled providers plus aliases and combos that currently resolve (`id`, `object: "model"`, `owned_by`). Key model ACLs are applied to the exposed catalog ID.

### GET `/health`
`200 { "status": "ok", "uptime_sec": 12345, "version": "0.1.0" }` — no auth.

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
| 413 | Request body exceeds `REQUEST_BODY_LIMIT_MB` (default 25 MB) |
| 502 | All upstream candidates failed |
| 503 | No healthy account is available, or a Plus/Pro-gated Codex model has no eligible paid ChatGPT account |

---

## B. Admin API (`/api`)

`/api/*` routes require the `mirais_session` cookie (`HttpOnly`, `SameSite=Lax`, HMAC-signed) except `/api/auth/*` and `/api/health`. The password is enabled on first start (default `12345678` — change it) and can be turned off in Settings → General. Session lifetime is operator-configurable (default `SESSION_TTL_HOURS`, 30 days with "remember"), so refreshing a page does not re-prompt. Changing or removing the password invalidates existing sessions. The **client API (`/v1/*`) is never affected** — it authenticates with gateway keys. Do not expose these routes directly to untrusted networks; use a reverse proxy, firewall, VPN, or private network as the outer access-control layer.

### Auth

| Method | Path | Body → Response |
|--------|------|-----------------|
| GET | `/api/auth/check` | `{ password_set, authenticated, session_hours, setup_required: false, passwordless }` |
| POST | `/api/auth/login` | `{ password, remember? }` → sets the session cookie; `401` on a wrong password, `429` after 5 failures per IP within 5 minutes |
| POST | `/api/auth/logout` | Clears the session cookie → `{ ok: true }` |
| POST | `/api/auth/session-hours` | `{ hours }` (1–720) → how long a login lasts before the password is asked again |
| POST | `/api/auth/password` | `{ new_password, current_password? }` → change the password (requires the current password and a valid session) or turn it off with `new_password: null`/`""`. Minimum 8 characters |
| POST | `/api/oauth/openai/callback` | `{ "url": "http://localhost:1455/auth/callback?code=…&state=…" }` → accepts the OpenAI Codex callback URL pasted from a remote/VPS browser and completes the pending PKCE login |

### Overview / analytics

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/stats/summary?range=24h\|7d\|30d` | `{ requests, inputTokens, outputTokens, estCostUsd, avgLatencyMs, successRate }` + delta vs previous range |
| GET | `/api/stats/timeseries?range=…&bucket=hour\|day` | `[{ t, requests, tokens, cost }]` for charts |
| GET | `/api/stats/by-model?range=…` | `[{ model, requests, tokens, cost, errors }]` |
| GET | `/api/stats/by-provider?range=…` | `[{ provider, requests, tokens, cost, errors, avgLatencyMs }]` |
| GET | `/api/health` | Runtime health: version, uptime, provider/account counts, storage, memory, in-flight requests, and active cooldowns |
| GET | `/api/autostart` | Start-on-boot state → `{ platform, method: "windows-startup" \| "systemd" \| "unsupported", enabled, manageable, detail }` |
| POST | `/api/autostart` | `{ enabled: boolean }` → enable/disable start-on-boot. Windows uses the per-user Startup folder; Linux writes a systemd unit and needs root or passwordless sudo (`400` with an actionable message otherwise) |

### Music

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/music/search?q=&limit=&page=` | YouTube search results. Defaults to 30 results per page; `limit` is capped at 30 and pages are available through page 20. |
| GET | `/api/music/trending?limit=&page=` | Paged music discovery feed. `limit` is capped at 50 and pages are available through page 20. |
| GET | `/api/music/stream?id=` | Range-capable proxied audio stream for the Music player. |
| GET | `/api/music/video-stream?id=` | Range-capable proxied progressive video stream for the muted, native Music visual player. |

### Providers & accounts

`Provider` = an upstream service. Built-in types include `openai`, `anthropic`, `deepseek`, `xai`, `glm`, `blackbox`, `codebuddy-global`, `codebuddy-cn`, `github-copilot`, and `custom` (custom = any OpenAI-compatible base URL). `github-copilot` uses a local OpenAI-compatible Copilot SDK sidecar for each account.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/providers` | List providers with accounts, models, health |
| POST | `/api/providers` | Create: `{ name, type, baseUrl?, enabled?, priority?, accountStrategy? }`; strategy is `priority` (default) or `round_robin` |
| PATCH | `/api/providers/:id` | Update fields / enable-disable, including `accountStrategy` |
| DELETE | `/api/providers/:id` | Remove (blocked if referenced by a combo) |
| POST | `/api/providers/:id/accounts` | Add account: `{ label, apiKey?, baseUrl?, priority? }`. GitHub Copilot accounts require a per-account local sidecar `baseUrl`; `apiKey` is optional only when that loopback sidecar has no auth. |
| POST | `/api/providers/:id/accounts/bulk` | Bulk import: `{ apiKeys: string[], labelPrefix? }` (max 200) → `{ added, skipped }`; labels auto-generated, duplicates skipped |
| DELETE | `/api/providers/:id/accounts` | Remove every account belonging to the provider → `{ ok: true, removed }` |
| GET | `/api/providers/:id/accounts/usage` | Per-account usage from request logs → `[{ account, requests_today, tokens_today, requests_total, tokens_total }]` |
| GET | `/api/providers/:id/accounts/export` | Full account export for backup/migration → account rows with **unmasked** `api_key`, `refresh_token`, `account_id`. Dashboard "Export" downloads this as CSV. Treat the response and the file as credentials |
| GET | `/api/providers/accounts/:accId/codex-quota` | ChatGPT/Codex quota snapshot (OAuth accounts only) → `{ plan_type, email, limit_reached, primary, secondary, credits }`; each window has `used_percent, remaining_percent, window_seconds, resets_in_seconds, reset_at`. `secondary` = the 5-hour window when the plan has one |
| POST | `/api/providers/accounts/:accId/codex-quota/reset` | Attempt ChatGPT/Codex banked reset for an OAuth account → `{ ok, message }` |
| GET | `/api/providers/accounts/:accId/copilot-quota` | Live GitHub Copilot quota snapshots keyed by type (`premium_interactions`, `chat`, `completions`) with remaining percentage, entitlement usage, and reset date |
| GET | `/api/logs?kind=` | Request logs; `kind=request\|warmup` filters warmup pings. When `TRACK_PAYLOADS=full`, new entries include `request_body` (prompt preview) + `response_body` (reply or `ERROR: …`); earlier entries remain without bodies. |
| GET | `/api/logs/usage?days=` | Usage log — real traffic (`kind='request'`) aggregated per provider+model → `[{ provider, model, requests, input_tokens, output_tokens, cached_tokens, cache_write_tokens, avg_latency_ms, errors, last_ts }]` |
| POST | `/api/oauth/openai/start` | Start ChatGPT (Codex) OAuth login: `{ providerId }` → `{ url }` to open in the browser (openai-type providers only) |
| POST | `/api/copilot/start` | Start an isolated GitHub Copilot browser login: `{ providerId, label }` → `{ accountId, url }`. Opens GitHub's official login flow; no GitHub password is sent to Mirais. |
| POST | `/api/copilot/:accountId/reconnect` | Restart GitHub device authorization for an existing Copilot account while preserving its ID, metadata, and usage history. |
| GET | `/api/copilot/:accountId/login-info` | Poll the device code and terminal login result → `{ code, done, ok?, error?, url }`. |
| DELETE | `/api/copilot/:accountId/login` | Cancel an unfinished Copilot login. Removes a new disabled placeholder account, but preserves an existing account being reconnected. |
| GET | `/api/copilot/:accountId/status` | Poll Copilot login and local sidecar health → `{ done, ok, message? }`. |
| GET | `/oauth/callback` | OAuth redirect target — exchanges the code (PKCE) for tokens and creates the account labeled `ChatGPT (email)`. Public route, no session |
| PATCH | `/api/providers/:id/accounts/:accId` | Update key/priority/enabled. Accounts with a permanent OAuth refresh failure expose persisted `reauth_required`/`reauth_reason` and remain unroutable until reconnection. |
| DELETE | `/api/providers/:id/accounts/:accId` | Remove account |
| POST | `/api/providers/:id/accounts/:accId/test` | Live test → `{ ok, latencyMs, error? }` |
| POST | `/api/providers/:id/warmup/stream` | Server-Sent Events for sequential enabled-account warmup. Emits `start`, `account_start`, `account_result`, and `complete`; results include account ID, `warmup_status`, upstream status, latency, and detail. Copilot warmup starts its local sidecar and preserves SDK errors; xAI OAuth retries one transient connection failure; Blackbox uses a minimal chat completion. |
| POST | `/api/providers/:id/test` | Connectivity test against the upstream `/models` endpoint → `{ ok, status, latency_ms, account }`. For OAuth accounts: a token refresh stands in for the test (Codex backend has no `/models`) |
| POST | `/api/providers/:id/sync` | Fetch full model list from upstream `/models` and register all → `{ synced, models }`. For OAuth accounts: syncs the live Codex catalog (`{codex}/models?client_version=1.0.0`) |
| POST | `/api/providers/:id/models/:modelId/test` | Per-model test: tiny chat completion (`max_tokens: 16`) against the upstream → `{ ok, status, latency_ms, model, detail? }`. For OAuth accounts: a streaming Codex `/responses` call (backend requires `stream: true`) |
| GET | `/api/providers/:id/models` | Models known for this provider |
| GET | `/api/xai/farm/check` | xAI Farm prerequisite report for IMAP settings, Python, Python packages, and Camoufox browser. |
| POST | `/api/xai/farm/install-missing` | Starts a fixed-command background installation job. Creates `<install-root>/.venv` when absent, installs its packages, and downloads Camoufox into `<install-root>/.camoufox`. Returns the initial job status; concurrent jobs return `409`. |
| GET | `/api/xai/farm/install-status` | Current install job state: `{ status, progress, stage, error?, checks? }`; `progress` is stage-based from 0–100. |
| PUT | `/api/providers/:id/models/:modelId` | Update one model's metadata (display name, enabled state, context/capability metadata, `creditRate` + `creditUnit` for cost estimation) |

### Aliases

| Method | Path | Notes |
|--------|------|-------|
| GET / POST | `/api/aliases` | List / create `{ alias, target }` (`fast` → `openrouter/auto`). Targets accept the same forms as client model requests; qualified `provider/model` is recommended to avoid ambiguity. |
| DELETE | `/api/aliases/:id` | Remove |

### Combos (fallback chains)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/combos` | List combos with their chains |
| POST | `/api/combos` | `{ name, strategy?: "sequential" | "round_robin", chain: [...] }`; round-robin rotates the leading entry while preserving ordered fallback |
| PATCH | `/api/combos/:id` | Rename, change strategy, or reorder chain |
| DELETE | `/api/combos/:id` | Remove |
| POST | `/api/combos/:id/test` | Sends a tiny inference request to every resolved provider/model candidate in order and returns per-candidate status, latency, account, and error detail |

### Gateway API keys

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/keys` | List (includes plaintext `key` field; also shows prefix, limits, usage) |
| POST | `/api/keys` | `{ label, allowedModels?: [], rateLimitRpm?, concurrency?, dailyTokenBudget?, expiresAt? }` → returns the key record plus a `plaintext` field; the plaintext is **persisted** (recoverable) |
| PATCH | `/api/keys/:id` | Update label, model ACL, RPM, concurrency, daily budget, expiry, or enabled state |
| DELETE | `/api/keys/:id` | Revoke |
| GET | `/api/keys/:id/usage?range=…` | Per-key stats |

### Logs

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/logs?cursor=&status=&model=&provider=&keyId=&q=` | Paginated request history (id, ts, model, provider, status, thinking mode, tokens, cache-read/cache-write tokens, latency, cost, error). Only the requested thinking setting is stored; reasoning content is never logged. |
| GET | `/api/logs/:id` | Detail incl. payloads if `TRACK_PAYLOADS=full` |
| DELETE | `/api/logs` | Purge (body: `{ before: "ISO-date" }`) |

### Grok-4.5 reasoning and tool work

- Mirais requests xAI's concise reasoning summary for Grok-4.5 and streams it in the OpenAI-compatible `reasoning_content` channel. Clients that support reasoning views can display it without mixing it into the final answer.
- Raw internal chain-of-thought is never requested, logged, or exposed.
- Grok-4.5 uses `reasoning.effort: "high"`, its maximum effective effort level. Requests with tools receive a verified-workflow instruction: inspect first, make minimal changes, preserve existing behavior, and verify before reporting completion.
- Mirais waits for xAI's first SSE byte before committing a streaming response. If a connection aborts before any bytes arrive, the normal retry/failover policy can select another eligible account. Once a byte is forwarded, Mirais never replays the request, preventing duplicate tool calls. Every translated xAI stream failure is closed with `data: [DONE]` so clients do not wait indefinitely.

### ChatGPT (Codex) reasoning models

- Reasoning deltas (`response.reasoning_text.delta`, `response.reasoning_summary_text.delta`) are streamed in the `reasoning_content` channel, never mixed into `content`.
- When a model returns its answer only in the final `response.completed` payload instead of text deltas, Mirais emits that text before the finish chunk so the client never receives an empty assistant turn.
- `response.incomplete` maps to `finish_reason: "length"`; `response.completed` maps to `stop` (or `tool_calls`).
- For non-streaming requests, a reasoning-only response falls back to the reasoning text as content.

### Settings

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/settings` | Token saver toggle/rules, terse mode, retention days, server info |
| PATCH | `/api/settings` | Update any of the above |
| GET | `/api/settings/export` | Full config export (JSON, secrets redacted) |
| POST | `/api/settings/import` | Import config (merge) |

### Dashboard exposure and auth behavior

- The dashboard login is on by default (`12345678` until changed) and can be turned off in Settings → General. It protects the dashboard only — `/v1/*` gateway traffic is unaffected.
- Restrict exposed instances with a reverse proxy, firewall, VPN, or private network regardless of the login.
- A startup warning is logged when Mirais binds to a non-loopback host without a dashboard password.
- The dashboard Settings page can toggle network binding; restart Mirais to apply the change.

---

## C. Static & Misc

| Path | Behavior |
|------|----------|
| `/` | Dashboard SPA (redirects to `/login` if unauthenticated) |
| `/assets/*` | Static dashboard files |
| `GET /health` | Liveness |
| Anything else | 404 JSON |
