# 04 — Database Schema

SQLite (`bun:sqlite`), WAL mode, foreign keys ON. File: `${DATA_DIR}/mirais.db`.
Migrations live in `src/store/migrations/` and run at boot (`0001_init.sql`, `0002_…sql`, applied in order, tracked in `_migrations`).

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
  type        TEXT NOT NULL,                 -- openai|anthropic|gemini|openrouter|deepseek|groq|xai|glm|custom
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

CREATE INDEX idx_accounts_provider ON provider_accounts(provider_id, enabled);

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
  strategy   TEXT NOT NULL DEFAULT 'sequential',
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
  credit_usage    REAL,                      -- provider credit units; null when unavailable
  credit_source   TEXT,                      -- 'upstream' (reported) | 'estimated' (from credit_rate)
  latency_ms      INTEGER,
  tokens_saved    INTEGER DEFAULT 0,         -- by token saver
  reasoning_effort TEXT,                     -- requested thinking mode; never reasoning content
  request_body    TEXT,                      -- only when TRACK_PAYLOADS=full
  response_body   TEXT
);
CREATE INDEX idx_logs_ts       ON request_logs(ts DESC);
CREATE INDEX idx_logs_model    ON request_logs(model);
CREATE INDEX idx_logs_provider ON request_logs(provider);
CREATE INDEX idx_logs_key      ON request_logs(key_id);

-- ── Settings (singleton KV) ───────────────────────────────
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                        -- JSON
);

-- ── Dashboard password (bcrypt-style hash) ────────────────
-- stored in settings: key='dashboard_password_hash'
```

## Notes & Policies

**IDs** — ULIDs generated in code (`Bun.randomUUIDv7()` is fine too). Time-sortable, URL-safe.

**Usage accounting flow**
1. Request finishes (or aborts) → count tokens (from upstream `usage` when provided; otherwise local estimate).
2. Insert one `request_logs` row. Aggregation queries in `usage/aggregate.ts` read only this table.

**Migration note** — `0008_remove_pricing.sql` removes the legacy `pricing` table and old money-related columns from existing databases.

**Retention** — nightly task deletes `request_logs` older than `settings.log_retention_days` (default 30). If `TRACK_PAYLOADS=full`, bodies are purged after 7 days regardless.

**Backups** — SQLite online backup: `bun run scripts/backup.ts` copies `mirais.db` via the `VACUUM INTO` command to `DATA_DIR/backups/mirais-<ts>.db` (keep last 7).

**Secrets at rest** — `provider_accounts.api_key` is plaintext by design (needed to call upstreams). `DATA_DIR` must be `chmod 700` on Ubuntu and ACL-restricted on Windows. Gateway keys are stored plaintext (migration 0021+) so operators can recover them; the legacy `key_hash` column remains for lookup fallback on pre-0021 databases.

**Account selection** — each provider owns an `account_strategy`. `priority` always starts with the lowest-priority healthy account (use account priorities to express Free → Plus → Pro). `round_robin` rotates the first healthy account independently per provider/model. Retriable failures continue through the remaining accounts; persisted quota cooldowns remove exhausted accounts until their window expires. `routing_policy.maxAttempts` limits account attempts per model candidate, so later combo entries are still reachable.

**Settings keys**

| key | JSON value |
|-----|------------|
| `dashboard_password_hash` | string (scrypt via `Bun.password`) |
| `token_saver` | `{ enabled: bool, rules: { gitDiff: bool, grep: bool, ls: bool, longOutputMaxLines: int } }` |
| `terse_mode` | `{ enabled: bool, prompt: string }` |
| `log_retention_days` | number |
| `ui` | `{ theme: "dark"\|"light", accent: string }` |
