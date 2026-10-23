-- Adds the Daily Rite's boards: one per UTC day, keeping each player's FIRST
-- run of that day (see src/index.ts, "The Daily Rite"). Safe to run on a board
-- of any age, and safe to run twice — it only creates what is missing, and
-- touches no existing row. Run once, BEFORE deploying the Worker that reads it:
--
--   npx wrangler d1 execute order-of-order --remote --config wrangler.toml \
--     --file=./migrations/0002_daily.sql
--
-- A database created from the current schema.sql already has the table.
CREATE TABLE IF NOT EXISTS daily_runs (
  day          TEXT NOT NULL,     -- the UTC date, "2026-10-23"
  member_id    TEXT NOT NULL,
  initials     TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  trial        INTEGER NOT NULL,
  endless      INTEGER NOT NULL,
  character    TEXT NOT NULL DEFAULT 'diebert',
  medal        INTEGER NOT NULL DEFAULT -1,
  score_exact  TEXT NOT NULL,
  score_len    INTEGER NOT NULL,
  rolls        INTEGER NOT NULL,
  has_analysis INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (day, member_id)
);

CREATE INDEX IF NOT EXISTS daily_runs_board
  ON daily_runs (day, rank DESC, score_len DESC, score_exact DESC);
