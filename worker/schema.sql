-- The global board index. One row per player: their best run, where "best" is
-- rank first and points only as the tiebreak — the same ordering the local Hall
-- uses (see src/systems/SaveData.compareHallEntries).
--
-- Keeping one row per member is what bounds this table and the R2 bucket: a new
-- personal best overwrites both in place, so storage grows with players rather
-- than with runs, and no pruning job is needed.

CREATE TABLE IF NOT EXISTS runs (
  -- The player's device UUID. Also the R2 object key for their analysis blob,
  -- which is why a replacement overwrites rather than orphans.
  member_id   TEXT PRIMARY KEY,
  initials    TEXT NOT NULL,

  rank        INTEGER NOT NULL,  -- rank reached; the PRIMARY sort key
  trial       INTEGER NOT NULL,  -- trial within that rank (1..3)
  endless     INTEGER NOT NULL,  -- 0/1

  -- The run's total points as an exact decimal, plus its digit count.
  --
  -- Points are a bigint that leaves SQLite's 64-bit INTEGER behind almost
  -- immediately: a full ladder run lands around 80 digits, and an endless run
  -- has no ceiling at all — 1000 rolls reaches ~200 digits, 2500 rolls ~550.
  -- So the sort key is (digits, decimal): for non-negative integers written
  -- without leading zeros, the longer number is always the larger one, and two
  -- of equal length compare correctly as text. That orders arbitrary-length
  -- values exactly, which zero-padding to any fixed width could not.
  --
  -- This pair is the whole reason src/systems/LeaderboardWire.ts could be
  -- deleted: there is no longer one signed int64 to pack two keys into.
  score_exact TEXT NOT NULL,
  score_len   INTEGER NOT NULL,

  rolls       INTEGER NOT NULL,  -- rolls the run took, for the analysis header
  -- 1 once an analysis blob has been stored for this row. The board list uses
  -- it to decide which rows are tappable without touching R2.
  has_analysis INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL   -- epoch ms the submission landed
);

-- The board query: ORDER BY rank DESC, score_len DESC, score_exact DESC.
CREATE INDEX IF NOT EXISTS runs_board
  ON runs (rank DESC, score_len DESC, score_exact DESC);

-- Per-device submission throttle. Rows are rewritten each hour and swept by the
-- cron trigger; nothing reads them except the rate check.
CREATE TABLE IF NOT EXISTS throttle (
  member_id    TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL, -- epoch ms, floored to the hour
  count        INTEGER NOT NULL
);
