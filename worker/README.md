# Global leaderboard Worker

The backend for the Hall of High Scores' Global tab. A Cloudflare Worker with two
bindings: **D1** for the sortable board index, **R2** for one gzipped run analysis
per player.

It exists so a global row can carry the run's whole per-roll timeline — 100–300 KB
of JSON — and open the same analysis screen a local run does. No hosted leaderboard
product has a metadata field within three orders of magnitude of that.

## Setup

You need a Cloudflare account. Everything below stays inside the free tier; see
[Cost](#cost).

```bash
cd worker
npm install
npx wrangler login
```

**1. Create the D1 database.**

```bash
npx wrangler d1 create order-of-order
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_ID_FROM_wrangler_d1_create`.

**2. Create the R2 bucket.**

```bash
npx wrangler r2 bucket create order-of-order-runs
```

> R2 requires a payment method on the account before it can be enabled, even for
> the free tier. Nothing is charged inside the allowance. If you would rather not
> add one yet, see [Running without R2](#running-without-r2).

**3. Create the tables.**

```bash
npm run db:init
```

**4. Deploy.**

```bash
npm run deploy
```

It prints a URL like `https://order-of-order-leaderboard.<subdomain>.workers.dev`.
Put that in the game's `.env` at the repo root:

```
VITE_LEADERBOARD_API=https://order-of-order-leaderboard.<subdomain>.workers.dev
```

Rebuild the game (Vite inlines env vars at build time) and the Global tab is live.

**5. Optional — the submit key.**

```bash
npx wrangler secret put SUBMIT_KEY
```

Set the same value as `VITE_LEADERBOARD_SUBMIT_KEY` in the game's `.env`. This is
not a secret: it ships in the client bundle and anyone who opens devtools can read
it. It turns away scanners that have not looked, and nothing more. Leave both
sides unset to run without it.

## Upgrading a board that predates run ranks

The `medal` column was added after the board shipped. A database created before
it needs the column added once, **before** the Worker that writes it is deployed:

```bash
npm run db:migrate:medal
npm run deploy
```

Existing rows read as unranked. A database created from the current
`schema.sql` already has the column; skip the migration there.

## Adding the Daily Rite's boards

The `daily_runs` table was added after the board shipped. Like the medal
column, it has to exist **before** the Worker that reads it is deployed:

```bash
npm run db:migrate:medal   # if that one has not been run yet
npm run db:migrate:daily
npm run deploy
```

`0002_daily.sql` only creates what is missing, so it is safe on a database of
any age and safe to run twice. A database created from the current `schema.sql`
already has the table. Locally, `npm run db:migrate:daily:local`.

## Local development

```bash
npm run db:init:local   # once, to create the tables in the local D1
npm run dev             # serves on http://localhost:8787 with local D1 + R2
```

Point the game at it with `VITE_LEADERBOARD_API=http://localhost:8787`.

## Resetting the board

After a rebalance, when old scores no longer compare with new ones:

```bash
npm run board:reset                  # remote; backs up, then asks you to type the db name
npm run board:reset -- --local       # the `wrangler dev` database instead
npm run board:reset -- --keep-blobs  # clear D1 only, leave R2 alone
npm run board:reset -- --yes         # skip the prompt
```

It exports the `runs` table to `backups/` (gitignored, since it holds initials and
device ids), deletes every row in `runs` and `throttle`, then deletes the R2 blob of
each row that had an analysis. The schema stays, so no redeploy or `db:init` is
needed. Players' local Halls are untouched; they live in each device's storage.

## API

| Route                             | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `GET /v1/top?limit=n`             | The board, best first. `limit` clamps to `MAX_BOARD_SIZE`.         |
| `POST /v1/runs?…`                 | Submit a run. Index fields in the query, gzipped analysis as body. |
| `GET /v1/runs/:member`            | That player's analysis blob, as stored (gzip bytes).               |
| `GET /v1/health`                  | Liveness.                                                          |
| `GET /v1/daily/:day/top?limit=n`  | One day's Daily Rite board, best first.                            |
| `POST /v1/daily/:day/runs?…`      | Submit a daily run. Same fields and body as `/v1/runs`.            |
| `GET /v1/daily/:day/runs/:member` | That player's analysis blob for the day.                           |

`POST /v1/runs` takes `member`, `initials`, `rank`, `trial`, `endless`, `score`
(exact decimal) and `rolls` as query parameters, plus optional `character` and
`medal` (the run's goal-tier rank, `0`–`3`, or `-1` for a loss), and the gzipped analysis as the
raw request body. The Worker validates the query fields and passes the body
through to R2 untouched — it never parses, decompresses or re-serializes it,
which is what keeps a submission inside the free plan's 10 ms CPU limit.

A submission that does not beat the player's existing row returns
`{ accepted: true, improved: false }` and changes nothing.

The daily routes take `:day` as a UTC date (`2026-10-23`). A daily board keeps
each player's **first** run of the day rather than their best: the day's seed
fixes every roll, so a second run would be played with the answers, and the
game offers only one attempt. A later submission for the same day returns
`improved: false` and changes nothing. Submissions are accepted for today, the
two days before it (a run begun before midnight, or resumed later, still
counts), and tomorrow (clock skew). The daily cron sweeps boards older than 30
days, rows and R2 blobs (`daily/<day>/<member>`) together. The day's seed and
modifiers are derived from the date in the client; the Worker never needs to
know them.

## Design notes

**One row and one blob per player.** `member_id` is both the D1 primary key and
the R2 object key, so a new personal best overwrites both in place. Storage grows
with players, not with runs, and there is no pruning job. The only scheduled work
is sweeping expired throttle rows.

**Scores are decimal strings, and they are enormous.** A run's total passes
`Number.MAX_SAFE_INTEGER` within the first few trials and has no upper bound in
endless — a full ladder run lands around **80 digits**, 1000 rolls around 200,
2500 rolls around 550. It is never narrowed through a JS number or a SQLite
`INTEGER`.

Because there is no ceiling, there is no fixed width to zero-pad to either. The
sort key is instead `(score_len, score_exact)`: for non-negative integers written
without leading zeros, more digits always means a larger number, and two of equal
length compare correctly as text. That orders arbitrary-length values exactly.
`MAX_SCORE_DIGITS` (4096) is only a sanity cap against a submission carrying a
megabyte of digits, not a real game limit.

**Ordering is `rank DESC, score_len DESC, score_exact DESC`** — how far the run
got first, points only as the tiebreak. This mirrors `compareHallEntries` in the
game's `src/systems/SaveData.ts`, so the local and global halls agree on what
"better" means.

**CORS is wide open.** The game is served from three origins we do not control and
cannot enumerate: itch.io's per-project CDN subdomain, the Capacitor Android
WebView, and a local dev server. Every endpoint is anonymous with no cookie or
credential to protect; write access is bounded by the per-device throttle instead.

## What this does and does not check

The Worker validates the shape of every index field and throttles submissions per
device (`SUBMITS_PER_HOUR`, default 20). It cannot prove a run happened — no
client-submitted leaderboard can, and a determined player can post any score.

The stronger check this design leaves room for is replaying the submitted timeline
through the game's own `src/sim/engine.ts` and confirming it produces the claimed
score. That is not possible today: `RunState` carries no RNG seed (the live game
uses `Math.random`), so a run cannot be re-derived. Making the live run's RNG
deterministic and persisting the seed would open that door.

## Cost

Free-tier allowances, all well clear of an indie release:

| Resource | Free tier                                          |
| -------- | -------------------------------------------------- |
| Workers  | 100,000 requests/day, 10 ms CPU per request        |
| D1       | 5 GB, 5M row reads/day, 100k row writes/day        |
| R2       | 10 GB, 1M writes/month, 10M reads/month, no egress |

A submission costs 1 row read + 2 row writes + 1 R2 write; opening the board costs
one query; opening a global analysis costs one R2 read. At 100 daily players ×
3 runs you are using well under 1% of the request budget, and the ~40 KB blob per
player means 10 GB holds a couple of hundred thousand players.

The step past the free tier is the Workers Paid plan at $5/month, which raises the
CPU limit and removes the daily request cap; D1 and R2 stay inside their included
allowances long past that.

## Running without R2

If you do not want to add a payment method yet, the board still works — it just
carries no analyses. Remove the `[[r2_buckets]]` block from `wrangler.toml` and
make `env.RUNS` optional in `src/index.ts`: guard the `put` in `postRun` and
return 404 from `getAnalysis`. Rows land with `has_analysis = 0`, the Hall's
global rows become untappable, and everything else is unchanged. Adding R2 later
needs no client change.
