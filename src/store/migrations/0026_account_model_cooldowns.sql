-- Per-(account, model) cooldown windows.
--
-- `provider_accounts.rate_limited_until` has no model dimension, so a 429 on
-- one model removed the account from rotation for every model it serves. Model
-- scoped upstream failures now land here instead; the account-wide column is
-- reserved for account-wide problems (auth/quota for the whole account).
CREATE TABLE IF NOT EXISTS account_model_cooldowns (
  account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  model_id   TEXT NOT NULL,
  until      INTEGER NOT NULL,
  reason     TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_account_model_cooldowns_until
  ON account_model_cooldowns (until);
