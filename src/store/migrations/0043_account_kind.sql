-- Distinguish Codex CLI-style OAuth accounts from OpenAI browser OAuth accounts.
-- Both currently share `auth_kind = "oauth"`, but they hit different upstream
-- endpoints (chatgpt.com/backend-api/wham vs api.openai.com/v1) and use
-- different model listing paths. `account_kind` resolves that at runtime.
--
-- Allowed values:
--   "oauth-browser" — OpenAI PKCE flow via the dashboard's login dialog.
--   "oauth-cli"     — Codex CLI JSON pasted into "Paste Codex JSON".
--   "api-key"       — Plain API key (the default for everything else).
--
-- NULL means "unknown / legacy" — the runtime falls back to JWT-decode
-- heuristics so pre-existing accounts keep working without a one-off
-- migration sweep.
ALTER TABLE provider_accounts ADD COLUMN account_kind TEXT;

-- Backfill: every row that isn't an OAuth account is treated as a plain
-- API key. OAuth rows are left NULL so the runtime resolver picks them.
UPDATE provider_accounts SET account_kind = 'api-key' WHERE auth_kind != 'oauth';
