# 04 — Database Schema

SQLite (single file at `${DATA_DIR}/mirais.db`) via Bun's native `Bun.SQL` client. WAL mode is on for atomic writes; foreign keys are enforced. Migrations live in `src/store/migrations/*.sql` and run at boot in order, tracked in `_migrations`.

## Migration runner

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 0001_init.sql

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Providers ─────────────────────────────────────────────
CREATE TABLE providers (
  id          TEXT PRIMARY KEY,              -- ulid
  name        TEXT NOT NULL UNIQUE,          -- "openai", "my-groq"
  type        TEXT NOT NULL,                 -- openai (API key or browser OAuth)|codex (imported OAuth)|anthropic|gemini|openrouter|deepseek|groq|xai|glm|custom
  base_url    TEXT,                          -- override; null → type default
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 100,  -- lower = preferred when routing ambiguous
  -- 0024_provider_account_strategy: priority | round_robin
  account_strategy TEXT NOT NULL DEFAULT 'priority',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Provider accounts (multi-account round-robin) ─────────
CREATE TABLE provider_accounts (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,                 -- "personal", "work"
  api_key     TEXT NOT NULL,                 -- upstream secret (plaintext; protect DATA_DIR)
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 0003_account_oauth: ChatGPT (Codex) OAuth login metadata
-- auth_kind 'api_key' | 'oauth', refresh_token / id_token / account_id / expires_at (unix ms)
ALTER-ish columns on provider_accounts: auth_kind TEXT DEFAULT 'api_key', refresh_token TEXT, id_token TEXT, account_id TEXT, expires_at INTEGER;
-- 0009_plan_type: latest ChatGPT/Codex plan from the usage endpoint; used to keep
-- Plus/Pro-gated models away from Free OAuth accounts.
ALTER-ish column on provider_accounts: plan_type TEXT;
-- 0025_account_base_url: optional account-specific upstream endpoint; GitHub Copilot uses one local SDK sidecar per account.
ALTER-ish column on provider_accounts: base_url TEXT;
-- 0027_account_reauth: terminal OAuth refresh state; routing skips the account until reconnection.
ALTER-ish columns on provider_accounts: reauth_required INTEGER NOT NULL DEFAULT 0, reauth_reason TEXT;

CREATE INDEX idx_accounts_provider ON provider_accounts(provider_id, enabled);

-- 0026_account_model_cooldowns: restart-safe model-scoped rate limits.
CREATE TABLE account_model_cooldowns (
  account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  model_id   TEXT NOT NULL,
  until      INTEGER NOT NULL,
  reason     TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, model_id)
);
CREATE INDEX idx_account_model_cooldowns_until ON account_model_cooldowns(until);

-- ── Provider models ───────────────────────────────────────
CREATE TABLE provider_models (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL,                -- upstream id, e.g. "gpt-5.2"
  display_name TEXT,                         -- optional friendly name
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- 0002_model_meta: captured from upstream /models during sync
  context_length    INTEGER,                 -- e.g. 128000
  max_output_tokens INTEGER,
  capabilities      TEXT,                    -- JSON array, e.g. ["reasoning","vision","pdf","tools"]
  -- 0023_model_credit_rate: fallback cost estimate; null = unknown, never guessed
  credit_rate       REAL,                    -- credit units per 1,000 tokens
  credit_unit       TEXT,                    -- token | credit | request | image
  -- 0014_provider_model_source: sync pruning never removes manual models
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sync')),
  UNIQUE(provider_id, model_id)
);

-- ── Aliases ───────────────────────────────────────────────
CREATE TABLE aliases (
  id         TEXT PRIMARY KEY,
  alias      TEXT NOT NULL UNIQUE,           -- "fast", "smart"
  target     TEXT NOT NULL,                  -- "openai/gpt-5.2-mini" or plain model id
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Combos (fallback chains) ──────────────────────────────
CREATE TABLE combos (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,           -- used as "combo:<name>"
  strategy   TEXT NOT NULL DEFAULT 'sequential', -- sequential | round_robin
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE combo_entries (
  id         TEXT PRIMARY KEY,
  combo_id   TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,               -- 0-based order
  target     TEXT NOT NULL,                  -- "provider/model" or model id or alias
  UNIQUE(combo_id, position)
);

-- ── Gateway API keys (plaintext, local install) ──────────
CREATE TABLE gateway_keys (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  key_hash           TEXT NOT NULL UNIQUE,   -- sha256 hex (legacy lookup fallback)
  key_plain          TEXT,                   -- plaintext key (0021+); local single-user install
  key_prefix         TEXT NOT NULL,          -- "mirais-a1b2" for display
  enabled            INTEGER NOT NULL DEFAULT 1,
  allowed_models     TEXT,                   -- JSON array; null = all
  rate_limit_rpm     INTEGER,                -- null = unlimited
  concurrency        INTEGER,
  daily_token_budget INTEGER,
  expires_at         TEXT,                   -- ISO; null = never
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at       TEXT
);

`gateway_keys` supports multiple independent client credentials. Each key can have its own model allowlist, RPM limit, concurrency limit, expiration, enabled state, and non-resetting `token_budget`. Request usage is associated through `request_logs.key_id`, so token budgets are enforced per key rather than globally.

-- ── Request logs ──────────────────────────────────────────
CREATE TABLE request_logs (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  key_id          TEXT REFERENCES gateway_keys(id) ON DELETE SET NULL,
  endpoint        TEXT NOT NULL,             -- /v1/chat/completions …
  requested_model TEXT NOT NULL,             -- as sent by client (incl. combo:)
  provider        TEXT,                      -- winning provider name
  model           TEXT,                      -- upstream model id
  account_label   TEXT,                      -- selected account label; never a plaintext API key
  attempts        INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,             -- success | error | client_error | rate_limited
  http_status     INTEGER,
  error           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cached_tokens   INTEGER,                     -- prompt-cache reads (0028)
  cache_write_tokens INTEGER,                   -- prompt-cache writes (0028)
  credit_usage    REAL,                      -- provider credit units; null when unavailable
  credit_source   TEXT,                      -- 'upstream' (reported) | 'estimated' (from credit_rate)
  latency_ms      INTEGER,
  tokens_saved    INTEGER DEFAULT 0,         -- by token saver
  reasoning_effort TEXT,                     -- requested thinking mode; never reasoning content
  request_body    TEXT,                      -- only when TRACK_PAYLOADS=full; capped at 32 KB by LogsRepo.insert
  response_body   TEXT                       -- same
);
CREATE INDEX idx_logs_ts       ON request_logs(ts DESC);
CREATE INDEX idx_logs_model    ON request_logs(model);
CREATE INDEX idx_logs_provider ON request_logs(provider);
CREATE INDEX idx_logs_key      ON request_logs(key_id);

### Admin audit log

Migration `0033_audit_log.sql` adds a metadata-only audit trail for dashboard configuration changes. It stores action, resource, resource ID, and sanitized JSON detail; credentials, tokens, passwords, request bodies, and response bodies must never be written here.

```sql
CREATE TABLE admin_audit_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  resource_id TEXT,
  detail      TEXT
);
```

-- ── Settings (singleton KV) ───────────────────────────────
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                        -- JSON
);

-- ── Dashboard password + session state ────────────────────
-- stored in settings: key='dashboard_password_hash' (empty string = turned off)
-- stored in settings: key='session_secret'
-- stored in settings: key='dashboard_session_hours'

### Daily usage rollup

Migration `0037_daily_usage.sql` adds a long-lived counter table that survives the 1-day `request_logs` purge. `LogsRepo.insert()` upserts one row per `(utc_day, provider, model, account_label)` for `kind='request'` only — warmups/claims/tests are not rolled up. Stats, Overview, and per-account usage all read from here.

```sql
CREATE TABLE daily_usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  utc_day             TEXT NOT NULL,            -- 'YYYY-MM-DD' UTC
  provider            TEXT,
  model               TEXT,
  account_label       TEXT,
  requests            INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  tokens_saved        INTEGER NOT NULL DEFAULT 0,
  errors              INTEGER NOT NULL DEFAULT 0,
  total_latency_ms    INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(utc_day, provider, model, account_label)
);
CREATE INDEX idx_daily_usage_day      ON daily_usage(utc_day);
CREATE INDEX idx_daily_usage_provider ON daily_usage(provider);
```

Retention is `settings.log_retention_days` (default 30); the hourly sweep calls `dailyUsage.purgeOlderThan(days)` once per hour.
```

## Notes & Policies

**IDs** — ULIDs generated in code (`Bun.randomUUIDv7()` is fine too). Time-sortable, URL-safe.

**Usage accounting flow**
1. Request finishes (or aborts) → normalize upstream usage, including cache reads/writes when reported; otherwise estimate ordinary input/output tokens locally.
2. Insert one `request_logs` row (lives 1 day) **and** upsert one `daily_usage` row for the matching `(utc_day, provider, model, account_label)` bucket (lives `log_retention_days`). Overview/Stats/usageByAccount all read from `daily_usage` after the log rows disappear.

**Migration note** — `0008_remove_pricing.sql` removes the legacy `pricing` table and old money-related columns from existing databases.

**Retention** — one hourly sweep in `src/server.ts#purgeOldLogs()` applies these windows. `request_logs` is short-lived (operational telemetry); `daily_usage` is the long-lived rollup that powers Overview/Stats after the logs disappear:

| table | window | scope |
|------|--------|-------|
| `request_logs` (every `kind`) | **1 day** (fixed) | operational telemetry, request/error detail, captured bodies (capped at 32 KB per body), replay |
| `daily_usage` rows | `settings.log_retention_days` (default 30) | per-day counters that survive the `request_logs` purge so Overview/Stats still have history |
| `admin_audit_log` rows | `settings.audit_retention_days` (default 90) | metadata-only trail; oldest rows drop before the table can grow unbounded |
| `gateway_keys` | never | credentials; only the operator's rotation touches this |

`daily_usage` is upserted by `LogsRepo.insert()` for `kind='request'` only — warmups, claims, and model-test pings stay short-lived. The sweep runs hourly rather than nightly so the one-day window never slips to almost 48 hours. Operators can also clear a kind (or every log) on demand from the Logs page or `DELETE /api/logs/all?kind=`. The dashboard's "Clear all logs" button invokes the same endpoint without a `kind`, which additionally empties `admin_audit_log` and the `daily_usage` rollup. Use `DELETE /api/logs/files` to truncate the on-disk log files (`data/mirais.log`, `data/xai-farm.log.jsonl`, `data/xfarm-device-debug.json`) — file handles the gateway already holds keep appending after truncation, so restart Mirais to start a fresh log.

**Disk safety** — three guards keep the SQLite file under a few hundred MB at sustained traffic: (1) `TRACK_PAYLOADS` defaults to `meta`, so request/response bodies are not stored unless the operator opts into `full`; (2) when `full` is on, `LogsRepo.insert()` truncates every free-form text column (`request_body`, `response_body`, `attempts_detail`) to 32 KB UTF-8 so a 500 KB streaming reply cannot push a single row past 1 MB; (3) warmup/claim/test rows never write bodies, since `daily_usage` only counts `kind='request'` and nothing else reads them.

**Backups** — `bun run scripts/backup.ts` writes `DATA_DIR/backups/mirais-accounts-<ts>.json`. It contains providers and provider-account credentials only. Restore adds missing accounts and leaves gateway keys, models, settings, logs, and usage unchanged.

**Secrets at rest** — `provider_accounts.api_key` is plaintext by design (needed to call upstreams). `DATA_DIR` must be `chmod 700` on Ubuntu and ACL-restricted on Windows. Gateway keys are stored plaintext (migration 0021+) so operators can recover them; the legacy `key_hash` column remains for lookup fallback on pre-0021 databases.

**Account selection** — each provider owns an `account_strategy`. `priority` always starts with the lowest-priority healthy account (use account priorities to express Free → Plus → Pro). `round_robin` rotates the first healthy account independently per provider/model. Persisted cooldowns are keyed by account and model, so one model's rate limit does not disable unrelated models. Terminal OAuth failures persist `reauth_required`; those accounts are skipped until reconnection. `routing_policy.maxAttempts` limits account attempts per model candidate, so later combo entries remain reachable.

**Settings keys**

| key | JSON value |
|-----|------------|
| `dashboard_password_hash` | string (`Bun.password` hash); seeded with `12345678` on first start, empty string means turned off |
| `session_secret` | string (random hex; combined with the password hash to sign session cookies) |
| `dashboard_session_hours` | number (how long a login lasts before the password is asked again) |
| `token_saver` | `{ enabled: bool, rules: { gitDiff: bool, grep: bool, ls: bool, longOutputMaxLines: int } }` |
| `terse_mode` | `{ enabled: bool, prompt: string }` |
| `log_retention_days` | number |
| `ui` | `{ theme: "dark"\|"light", accent: string }` |
