-- Adds the goal-tier rank column to a `runs` table created before it existed.
-- Run once, BEFORE deploying the Worker that writes it:
--
--   npx wrangler d1 execute order-of-order --remote --config wrangler.toml \
--     --file=./migrations/0001_medal.sql
--
-- Existing rows take the default, -1 (unranked). A table created from the
-- current schema.sql already has the column, and this would fail on it.
ALTER TABLE runs ADD COLUMN medal INTEGER NOT NULL DEFAULT -1;
