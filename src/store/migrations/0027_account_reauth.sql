-- Revocation-aware OAuth state.
--
-- A permanently failed token refresh (revoked grant, expired refresh token)
-- used to throw a 401 and persist nothing, so the dead account was retried on
-- every request and the dashboard still showed it as healthy. Persist the
-- terminal state instead so routing skips it until the operator reconnects.
ALTER TABLE provider_accounts ADD COLUMN reauth_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_accounts ADD COLUMN reauth_reason TEXT;
