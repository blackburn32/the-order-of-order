-- Adds the crash-report table (see src/index.ts, "Crash reports"). The Worker
-- also creates it itself on its first request after a deploy, so this is only
-- for a database you want ready beforehand. Safe to run twice.
CREATE TABLE IF NOT EXISTS errors (
  fingerprint  TEXT PRIMARY KEY,  -- hash of build + message + top of stack
  build        TEXT NOT NULL,
  version      TEXT NOT NULL,
  platform     TEXT NOT NULL,     -- "web", "itch" or "android"
  scene        TEXT NOT NULL,     -- the scene on screen when it threw
  message      TEXT NOT NULL,
  stack        TEXT NOT NULL,
  user_agent   TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,  -- epoch ms
  last_seen    INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS errors_recent ON errors (last_seen DESC);
