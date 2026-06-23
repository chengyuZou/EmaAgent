-- Remove cost_usd from turns: no longer tracked.
-- SQLite 3.35+ (Node 20 ships 3.39+) supports DROP COLUMN directly.
ALTER TABLE turns DROP COLUMN cost_usd;
