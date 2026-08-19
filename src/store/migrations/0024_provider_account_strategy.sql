-- Account selection is configured per provider.
-- priority: always try lower account priority first (useful for Free -> Plus -> Pro).
-- round_robin: rotate the first account while retaining failover across the pool.
BEGIN;

ALTER TABLE providers ADD COLUMN account_strategy TEXT NOT NULL DEFAULT 'priority'
  CHECK (account_strategy IN ('priority', 'round_robin'));

COMMIT;
