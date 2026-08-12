-- Persist account rate-limit window so cooling-down accounts are skipped
-- across restarts and recover to healthy automatically once the window passes.
ALTER TABLE provider_accounts ADD COLUMN rate_limited_until INTEGER;
