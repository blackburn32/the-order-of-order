# The Order of Order

The Order of Order is an incremental roguelike built around rolling dice. The player rolls a
grid of dice trying to hit specific numbers, earning points when they do. Points are progress
toward the current **trial's** goal and nothing else — they reset to zero the moment a trial
ends. The shop runs on a separate currency, **gold**, earned by clearing trials.

A run climbs a ladder of **trials** grouped into **ranks**. Each rank is three trials — the
Lesser Trial (7 rolls), the Greater Trial (15 rolls), and the Boss Trial (20 rolls). A route
screen previews all three, stamps completed trials, marks the next one, and reveals the rank's
Boss modifier before play begins. Clearing a trial opens its results, then the shop, then the
route back to the next trial. Clearing a rank's Boss Trial raises the rank and returns the player
to a Lesser Trial with every goal raised. **Reaching rank 5 wins the game**; the victory screen
then offers to press on into an endless ladder that no build can outrun forever.

The game is built with Phaser 4 (TypeScript + Vite). Rolling a **1** scores; "Extra Number"
upgrades add 2 and then 3 as scoring faces. The per-trial goals are a hand-authored table
(`TRIAL_GOALS` in `src/config.ts`), tuned with the balance simulation in `src/sim` so runs end
across the whole ladder rather than being decided in the first few trials.

The curve is designed to a deliberate attrition shape (measured on the pooled bot field; a
thinking player does better) — the fraction of the field still alive after each rank:

| After rank | 1   | 2   | 3   | 4   | 5         |
| ---------- | --- | --- | --- | --- | --------- |
| Alive      | 97% | 88% | 70% | 47% | 25% (win) |

Early goals remain small integers, but the single starting die deliberately allows bad luck to
end some runs in the first rank. Within later ranks, most of the cull lands on the Boss Trial,
whose modifier is already doing work.

The curve also **saw-tooths**, which is the shape of a rank rather than a mistake: rank 3's
seven-roll Lesser Trial asks for less than rank 2's twenty-roll Boss Trial. What always rises is
the same slot from one rank to the next. Design a curve with `src/sim/tuneCurve.ts` and confirm
it against the real survival gate with `src/sim/validate.ts`.

## Development

The project uses [Vite](https://vitejs.dev) with TypeScript and Phaser 4. Install the
dependencies once before anything else:

```bash
npm install
```

### Running the development server

```bash
npm run dev
```

This starts the Vite dev server at [http://localhost:5173](http://localhost:5173) with hot
module replacement — saving a source file reloads the game in the browser automatically. To
share the server on your local network (e.g. to playtest on a phone), run `npm run dev -- --host`
and open the printed network URL.

The global leaderboard is off by default in development; copy `.env.example` to `.env` and fill
in the leaderboard Worker's URL to enable it (see [Global leaderboard](#global-leaderboard-optional)
below). Without it, everything else runs fully offline.

### Building for production

```bash
npm run build    # typecheck (tsc --noEmit) + bundle to dist/
npm run preview  # serve the built dist/ locally to verify it
```

`npm run build` first type-checks the whole project and then emits an optimized, static bundle
into `dist/`. The build fails if there are any TypeScript errors, so a green build is also a
clean typecheck. The contents of `dist/` are fully self-contained (no server, no external
assets) and can be deployed to any static host — GitHub Pages, itch.io, Netlify, an S3 bucket,
etc. Use `npm run preview` to serve that production build locally and confirm it before deploying.

#### Build flags

Build-time switches live in `src/buildFlags.ts` and are set from `VITE_*` env vars, so their
values are frozen into `dist/` when it is built (unlike the gameplay knobs in `src/config.ts`
or the player's own settings).

| Flag          | Env var            | Default | What it does                                     |
| ------------- | ------------------ | ------- | ------------------------------------------------ |
| `GOLD_BORDER` | `VITE_GOLD_BORDER` | off     | Gold frame around the outside of the game        |
| `PHONE_BUILD` | `VITE_PHONE_BUILD` | off     | Hides browser-only UI in the Capacitor phone app |

Targeted builds use Vite modes, which load their committed mode-specific env file on top of
the usual `.env`.

```bash
npm run package:itch  # itch build (flags on) + zip for upload
npm run build:itch    # itch build only, into dist/
npm run dev:itch      # dev server with the itch flags, to preview them
npm run phone         # phone build (fullscreen setting hidden) + Capacitor copy
npm run build:phone   # phone build only, into dist/
npm run dev:phone     # dev server with the phone flags, to preview them
```

Plain `npm run build` (GitHub Pages and other static hosts) and `npm run dev` leave every flag
at its default. The itch build enables the frame; the phone build hides the fullscreen setting.

### Other scripts

```bash
npm run sim            # headless balance simulation → sim-out/report.html (see src/sim)
npm run items:check    # item mechanics, including every boss modifier
npm run trials:check   # the trial loop: clears, advances, ranks, endings
npm run gold:check     # payouts, interest, prices, rerolls, discounts
npm run scoring:check  # the two scorers agree, per-die vs bucketed
npm run history:check  # the per-roll run timeline the analysis screen charts
```

Nearly all art is drawn procedurally at runtime and most audio is synthesized with WebAudio; the
only binary assets are the intro cutscene art in `images/` and the music track in `audio/songs/`.
Tuning knobs (trial goals, rolls per trial, the winning rank, endless growth, shop rarity
weights) live in `src/config.ts`; the gold economy's knobs live in `src/systems/Gold.ts` and the
Boss Trial modifiers in `src/systems/Boss.ts`. A Playwright smoke driver is included as a devDependency for headless
playtesting; the game instance is exposed as `window.__game` for that purpose.

The game is responsive and runs in both landscape and portrait, at any window size — the
canvas resizes to fill the page (`Phaser.Scale.RESIZE`) rather than being letterboxed to a
fixed resolution. Every scene lays itself out from `scene.scale.width/height` and rebuilds
its whole display list on resize/orientation-change (see `src/ui/layout.ts`'s `responsive()`
helper), so rotating a device or resizing the browser window reflows the UI live.

### Global leaderboard (optional)

A shared online leaderboard is backed by the Cloudflare Worker in [`worker/`](worker/) and
reached over plain `fetch` (see `src/systems/GlobalScores.ts`). Players are anonymous — a
per-device UUID is the board's member id — and a 1–3 letter arcade-style initials prompt
supplies the display name when a run sets a new personal best. Configure it by copying
`.env.example` to `.env` and filling in the deployed Worker's URL. When it is absent the feature
disables gracefully and the game runs fully offline against the local Hall of High Scores.

What makes it worth running our own backend rather than a hosted leaderboard service: **a global
row carries the run's whole analysis, not just its score.** A finished run's per-roll timeline is
100–300 KB of JSON, three orders of magnitude past the metadata field of any "submit a score"
product, so tapping a global row used to show approximate per-item shares and no curves at all.
Now the analysis goes up gzipped alongside the score and a global row opens exactly the screen a
local one does.

The split is: **D1** holds the board index (one row per player, their best run), **R2** holds one
gzipped analysis blob per player, keyed by the same member id so a new personal best overwrites
both in place. Storage therefore grows with players rather than with runs, and nothing needs
pruning. The client gzips the blob itself and posts it as opaque bytes with the index fields in
the query string, so the Worker never parses or decompresses the payload — that keeps a
submission inside the free plan's 10 ms CPU budget and cuts the upload roughly sevenfold, which
is what a phone on a slow connection notices.

Setup and deployment live in [`worker/README.md`](worker/README.md).

#### Pointing at a different leaderboard backend

Two Vite environment variables, both optional:

| Variable                      | What it targets                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `VITE_LEADERBOARD_API`        | Base URL of the deployed Worker, no trailing slash. Absent disables the global board.      |
| `VITE_LEADERBOARD_SUBMIT_KEY` | Optional, must match the Worker's `SUBMIT_KEY` secret. Ships in the bundle — a bot filter. |

Vite inlines env vars at build time, so changes to `.env` only take effect on the next
`npm run dev` / `npm run build` — a running server won't pick them up.

The number of rows fetched (`GLOBAL_TOP_N`) is a constant in `src/systems/GlobalScores.ts`.

## Gameplay

The main game screen features a centered grid of dice, starting with one d6, and a "Roll"
button below it. The HUD lays out as a row across the top in landscape and shrinks into a
stacked column in the top-left in portrait. It shows:

- **ROLLS** — rolls used, out of this trial's budget
- **RANK** — the ladder position as `rank-trial`, so `2-3` is the Boss Trial of rank 2
- **GOAL** — the score this trial must reach
- **SCORE** — progress toward it, reset to zero every trial
- **GOLD** — the purse, which the shop is the only thing that spends

An **Inventory** link opens an overlay of every item bought this run (as cards, with a copy-count
badge on stacked items), and a **Settings** link opens the settings panel mid-run.

Dice are shaped by their side count, so the grid reads at a glance: d1/d2 render as coins, d4 as
a triangle, d6 as the classic square, d8/d10 as an octagon, and d20/d100 as a hexagonal d20
shape. Only d6 shows pips; every other die shows its numeral. During the roll animation a die
only flickers through values up to its own side count, and newly added dice spawn showing their
max face instead of appearing blank.

The grid has no practical limit on dice count — as more dice are added, the whole grid scales
itself down ("shrinks out") to keep every die visible on screen.

### Ranks and trials

| Trial in rank | Name          | Rolls | Notes                         |
| ------------- | ------------- | ----- | ----------------------------- |
| 1             | Lesser Trial  | 7     | A sprint against a small goal |
| 2             | Greater Trial | 15    | Room to build                 |
| 3             | Boss Trial    | 20    | Carries a hostile modifier    |

Meeting the goal ends the trial on the spot — the remaining rolls are forfeit, but they are paid
out as gold. Falling short ends the run, unless the player owns an Insurance Policy and finished
at 75% of the goal, which clears the trial and destroys the policy.

A run starts with one d6, and the first trial's goal is 2. Because only 1s score at the outset,
some runs will lose in the first trial or two; that early risk is intentional. See
`STARTING_DICE` and `TRIAL_GOALS` in `src/config.ts`.

Extra rolls granted by Overtime and Metronome are appended to the end of a trial. Clearing rank
5 wins the game, then the Victory screen asks the player to either end the run and submit its
score or **Press On — Endless**. Continuing keeps the run open and unrecorded until it fails or
is abandoned, and carries it past rank 5 with goals that grow faster and faster (see
`ENDLESS_BASE` / `ENDLESS_ACCEL`). The growth rate itself accelerates, because builds compound
geometrically and a fixed ratio could be outrun forever. In simulation the median winner reaches
about rank 10 and the strongest build seen dies by rank 20.

### Boss Trials

Each rank rolls one of eight modifiers as the rank begins. It is previewed on the route screen
throughout the rank, then activates on the third trial and is shown beside the GOAL pill. The same
modifier never appears in consecutive ranks.

| Name        | Effect                                                   |
| ----------- | -------------------------------------------------------- |
| The Famine  | Extra Point and Keen Edge grant nothing                  |
| The Drought | No dice are added this trial                             |
| The Eclipse | The roll multiplier is halved (never below ×1)           |
| The Silence | Only 1s score — the numbers you unlocked are silenced    |
| The Hunger  | Five fewer rolls                                         |
| The Warden  | Snake Eyes, Jackpot and Lucky Seven grant nothing        |
| The Toll    | A tenth of your dice score nothing                       |
| The Hoard   | The goal is 40% higher, but clearing it pays double gold |

Beating a Boss Trial pays a gold bonus and buys the next shop **boosted rarity odds**
(`BOON_RARITY_WEIGHTS` in `src/config.ts`) — better cards, not just more of them. The modifiers
live in `src/systems/Boss.ts`; each is a small guarded branch in code that already exists rather
than a subsystem of its own.

The Toll is applied to the roll's _aggregate counts_, never by removing individual dice, because
past 2,000 dice the pool switches to bucket storage and individual dice stop existing. Scaling
the counts is the only definition that means the same thing at every grid size — a hundred dice
under The Toll score exactly what ninety dice score without it.

### Scoring

Each roll is scored as a stack of modifiers (`src/systems/Scoring.ts`), so new rules are added
by pushing another modifier rather than threading a new field through the scene:

- **Scoring** — each die showing a scoring number (1, plus 2 and 3 from Extra Number) or a wild
  face is worth 1 point, +1 per Extra Point owned, and +2 per Keen Edge owned when it's a d1.
- **Snake Eyes** — any value shown by 2+ dice scores that value × the number showing it.
- **Jackpot** — any value shown by 3+ dice scores value × count, per Jackpot owned.
- **Windfall** — a Rollplayer/Centurion die's current highest face always scores and applies
  that card's ×2/×4 roll multiplier; shrinking the die makes the effect more likely.
- **Momentum** — adds twice the consecutive-scoring-roll streak as points, per Momentum owned.
- **Lucky Seven** — 7 points per written digit "7" across the rolled values (77 pays 14).
- **Pocket Change** and **Dividend** pay flat amounts every roll.

The subtotal is then multiplied by a single run multiplier: Amplifier ×2, Prism ×3 per copy,
Last Call ×4 per copy on the final roll of a trial, plus the conditional Parade / Menagerie /
Uniform / Hourglass factors and any Windfall — all compounding, then halved by The Eclipse.

Foundry fires at the **start** of each trial (`applyTrialStart`), adding copies of the smallest
die — unless The Drought is in force.

Scoring lives in two implementations that must agree exactly: `ScoringHistogram.ts` is the live
path (O(distinct faces), works when the pool is bucketed) and `Scoring.ts` is a per-die reference
kept only for the parity harness. `npm run scoring:check` fails loudly if they drift, and it
covers the boss modifiers too.

## The shop

A shop opens after every cleared trial, after the Results screen and before the next route screen.
Its upper row offers 3 loose item cards (5 once the player owns Ledger). The lower row holds two
sealed booster packs and the reroll/continue controls. Responsive grids and scrollable card bands
keep both rows readable in narrow portrait layouts.

The player may buy **as many loose cards and packs as they can afford**, then continues to the
trial route. Rerolling refreshes only the loose cards; the two packs remain fixed for the visit.
A reroll costs 1 gold plus 1 more for each reroll already taken; Dealer's Bell makes the first
reroll of every shop free. If no loose card is affordable, the free Two Bricks is guaranteed onto
the row so the shop is never a dead screen.

### Booster packs

Buying a booster opens it immediately and reveals 3 currently legal cards. The player chooses
one without paying again and the rest disappear. Ledger increases both the loose-card row and
each booster reveal to 5 cards. A chosen die-targeting card continues into the normal die picker.

The pack catalog contains Common, Uncommon, and Rare packs plus build-focused Foundry,
Ritual, Artificer's, Treasury, and Hourglass packs. The latter draw from the existing swarm,
multiplier, precision, economy, and tempo item themes. A Boss clear improves the rarity table for
the whole next shop visit, including rerolls and themed-pack contents. Shopping Cart discounts
pack prices; Coupon Book continues to affect a loose card rather than a sealed pack.

### Gold

Gold is deliberately not the score. It is a small, slow-growing purse that persists across the
whole run, and it is the only thing the shop takes. A run opens with 4 gold; clearing a trial
pays:

| Source        | Amount                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The trial     | 3 / 4 / 6 for the Lesser / Greater / Boss Trial                                                                               |
| Rolls in hand | 1 per unused roll, up to 5 (Deep Pockets raises the paid-roll cap by 2 per copy; Reserve adds 1 more per paid roll, per copy) |
| Interest      | 1 per 5 gold banked, up to 5 (Vault raises the cap to 10)                                                                     |
| Boss cleared  | +2, and +3 more with Reliquary                                                                                                |
| Gold items    | Counting House (+1 per copy), Deep Pockets (+2 roll-gold cap per copy), Prospector (+1 per 25 dice held, max 5)               |

Interest is what makes banking a real alternative to spending: gold left unspent compounds a
little at every clear. Tithe Bowl and Lucky Coin also pay out mid-trial, during rolls.

The knobs all live in `src/systems/Gold.ts`. Gold is a plain `number` while every score field is
a `bigint` — if the purse ever needs bigint, the economy has already gone wrong.

### Pricing

Item prices are flat gold amounts by strength band, deliberately decoupled from the exponential
goal curve so "8 gold" means the same thing on trial 1 and trial 15:

| Strength band  | Price |
| -------------- | ----: |
| Free           |     0 |
| Low            |     3 |
| Standard       |     5 |
| Strong         |     8 |
| Build-defining |    12 |

```text
price = band × repeat multiplier × market variation × Shopping Cart − Pawnbroker
```

Repeatable effects become more expensive for each copy already bought: ordinary linear stacks
grow by 1.35× per copy, while multipliers and explosive grid-growth effects grow by 1.8× per
copy. Single-time items have no repeat multiplier. Every non-free card also rolls a market
adjustment from −25% to +25% each time it appears, so price stays an imperfect signal of power.
Shopping Cart takes 15% off everything and Pawnbroker a flat 2 gold; no paid card ever drops
below 1 gold. Two Bricks is the sole free item and the guaranteed fallback.

### Rarity

Every item belongs to one of three rarity tiers, shown by card colour:

| Tier     | Colour | Draw weight | After a Boss clear |
| -------- | ------ | ----------- | ------------------ |
| Common   | Yellow | 60%         | 25%                |
| Uncommon | Blue   | 30%         | 45%                |
| Rare     | Purple | 10%         | 30%                |

Both weight tables live in `src/config.ts` (`RARITY_WEIGHTS`, `BOON_RARITY_WEIGHTS`). Rarity
controls how often an item is offered; price band controls what it costs. They are intentionally
independent.

Draw rules:

- Each card in a shop rolls its tier independently against the weights, then picks an item from
  that tier.
- Cards are drawn without replacement, so one shop never offers duplicates.
- An item is only eligible if it has a legal effect (see gating below). If a rolled tier has no
  eligible items left, fall back toward common first, then to whatever tier still has items.

### The items

Every item — its name, rarity, price band, description, gating predicate, unlock criterion,
build theme, and effects — is defined in one place: **`src/systems/Items.ts`**, as a single
`ITEMS` array. That file is the source of truth for the shop pool, the Codex gallery, the dev
panel's grant list, and the balance simulation's item tables.

It is deliberately not duplicated here. A table in this README would be a second copy of the
roster that drifts from the code the first time an item is retuned, which is exactly what
happened to the tables this section replaced.

### Gating

An item is only offered when it can actually do something:

- Shrink Die, Grindstone, Refinement — require at least one die above d1.
- Loaded Die — requires a die that isn't already loaded.
- Keen Edge — requires at least one d1 in the grid.
- Extra Number — stops appearing once the face 4 has been added.
- Flat starters (Chips, Spikes, Pocket Change, Shrink Die) drop out of the shop once the grid
  passes 75 dice, since their fixed adds become noise at that scale. Two Bricks is exempt — it's
  the guaranteed free fallback.

Some items are **single-time**: a second copy would do nothing, so once bought they never
appear again for the rest of the run — every item carrying `unique: true` in `ITEMS`. Everything
else can be bought repeatedly and stacks, compounding per copy owned.

## Unlocks and the Codex

Most items are available from the very first run. Some are **locked** behind an achievement and
never appear in the shop until the player has earned them. An unlock is permanent: once met, the
item is offered starting with the next run and can never be re-locked (short of resetting all
progress).

Unlock progress is meta-progression: it lives in `localStorage` (key `ooo_progress_v2`), separate
from the ephemeral per-run state, so it survives reloads and carries across runs.

Currently unlockable:

| Item           | Unlock criterion                                        |
| -------------- | ------------------------------------------------------- |
| Dividend       | Reach rank 2                                            |
| Momentum       | Score on 12 rolls in a row (in one run)                 |
| Keen Edge      | Hold 10 or more d1 at once                              |
| Foundry        | Hold more than 29 dice in your grid at once             |
| Double the Fun | Hold more than 1000 dice in your grid at once           |
| Jackpot        | Show the same number on 6 or more dice in a single roll |
| Last Call      | Clear a trial on its final roll                         |
| Genesis        | Reach rank 4                                            |
| Reserve        | Reach 2× the current trial's goal                       |
| Prospector     | Hold 25 gold at once                                    |
| Reliquary      | Clear 3 Boss Trials in one run                          |
| Pawnbroker     | Hold 40 gold at once                                    |
| Prism          | Win a run (reach rank 5)                                |

Criteria are checked and persisted live during a run, but newly earned cards are collected and
revealed together on the Trial Results screen. Each run snapshots its eligible card pool when it
begins, so newly unlocked cards first appear in the next run. The criteria engine is data-driven (`src/systems/Items.ts` —
`UnlockCriterion` / `meetsCriterion`), so new unlock conditions can be added by tagging an item
with an `unlock` field.

### The Codex (Items screen)

A main-menu entry, **Codex**, opens a scrollable gallery of every shop item as a card, exactly
as it appears in the shop. Under each card is the number of times that item has been selected
from the shop across all runs (dev-panel grants don't count). Items that are still locked render
greyed out, with their name, rarity, cost, and description replaced by `???` and their unlock
hint shown underneath.

The Codex button itself stays locked until the player has **completed a single game** (a win or a
loss — including abandoning a run), at which point it becomes available.

## Other screens

The game opens on a menu with:

- Start New Run
- Hall of High Scores
- Codex (locked until the first game is completed)
- Settings

On a new run started from the menu, a short three-page **intro** sets the premise before the
first roll (skippable, and toggled off permanently from its own checkbox or from Settings). On a
player's first run, a **callout tutorial** follows the run's own loop rather than one screen: the
route screen teaches the shape of a rank and the boss waiting at the end of it, the table teaches
the score, the roll button, the grid viewport, the goal, the roll budget, the ladder and gold, the
Results screen teaches what a clear pays, the shop teaches spending it, and the Boss Trial
modifier is explained when the first one actually arrives. Its steps are deliberately one short
line each. A tutorial run also cannot be lost: once a trial has only as many rolls left as it
still needs points, those rolls are rigged to come up 1 — which on the seven-roll Lesser Trial is
exactly its last roll. The tutorial self-disables after one run (however that run ends) and can be
re-enabled from Settings.

The Hall of High Scores shows the top runs, each with:

- The date the run was started, short format
- The rank and trial the player reached (and whether the run was a win)
- The total score accumulated across the run
- The grid of dice they ended with

Runs are ranked by **how far they got first, with total points only breaking ties** between runs
that reached the same rank. The global leaderboard sorts on the same two keys, held as separate
columns rather than packed into one number. Points ride as an exact decimal string: a run's
total leaves `Number.MAX_SAFE_INTEGER` behind almost immediately and has no ceiling at all in
endless (a full ladder run lands near 80 digits, 1000 rolls near 200, 2500 rolls near 550). The
sort key is therefore `(rank, digit count, decimal)` — for integers written without leading
zeros the longer number is always the larger one, and equal-length values compare correctly as
text, which orders arbitrary-length scores exactly.

Scores recorded before the ranks/trials/gold restructure measured a different game and cannot be
ranked against these, so they are filtered out rather than shown with invented values. The local
storage keys moved to `_v2` for the same reason.

Settings controls:

- Volume of music
- Volume of sound effects
- Show Intro
- Show Tutorial
- Visual Effects (see [Visual effects](#visual-effects) below)
- Fullscreen
- Abandon Run (mid-run only) — ends and records the current run as a loss, then shows Game Over
- Reset all progress (from the menu) — wipes item unlocks, Codex selection counts, games-completed,
  and the Hall of High Scores (audio settings are kept); a two-tap confirm guards it

## Visual effects

Beyond the base feedback (die-border flashes and floating score labels), the game layers
on a set of flourishes: the HUD score eases up to its new value and its plaque punches, the dice
rock as they tumble and settle in a ripple, a sigil turns behind the grid and brightens as the
trial's goal comes into reach, the felt and grid backdrop warm toward gold with it (and go red
on a final roll that arrives short), big rolls shake the screen and throw gold sparks, the roll
seal breathes and rings when pressed, route cards deal into place, Results stages its seal/gold/
unlock reveals, and shop cards are dealt onto the table with rare ones lit by a glow. Booster
packs focus over the shop, shake open in a burst, and flip their choices into view.

All of it answers to one **Visual Effects** setting, on by default. What that setting _enables_
is then capped by two things the game reads from the device, in `src/renderQuality.ts`:

| Input         | Source                                | What it gates                                                  |
| ------------- | ------------------------------------- | -------------------------------------------------------------- |
| Effect tier   | Renderer type + `hardwareConcurrency` | Filter passes (glow), particle bursts, animated background art |
| Reduce-motion | `prefers-reduced-motion` media query  | Camera/grid shake, screen flashes, dice wobble, ambient drift  |

The tier is `full` on WebGL with more than 4 cores, and `basic` on a Canvas fallback or a
low-core device — Phaser 4's filters and particle renderer are WebGL-only, so on that path the
budget genuinely isn't there. The two axes are deliberately independent: capable hardware still
shouldn't shake the screen at a player who asked it not to, while a player on a weak device who
_hasn't_ asked for less motion still gets the cheap motion cues.

Everything resolves through the `fx` singleton in `src/systems/Effects.ts`, which mirrors the
`audio` one — initialized once in `BootScene` from the live renderer, updated live by the
Settings toggle. Call sites branch on `fx.on` / `fx.rich` / `fx.motion` rather than re-deriving
any of this, and the helpers are self-gating, so calling `fx.burst` on a basic device is a
no-op rather than a crash. New effects should be added the same way: pick the axis that
describes the cost, and let the helper decline.

## Balance simulation

`src/sim` is a headless bot that plays full runs to gather balance statistics — win rates, where
runs die, what gets bought, how gold is earned and spent, how often each Boss Trial modifier is
beaten, and how likely each gated item is to unlock — and writes a self-contained HTML report. It
reuses the game's real economy end to end (scoring, shop, trial-start passives) through a shared
trial-loop engine that `GameScene` also uses, so results reflect the live rules.

Nine series make up the field: **greedy** (most expensive card first) and **thrifty** (cheapest
first) bracket how far a purse stretches and each run against both the base and the fully
unlocked item pool; five themed shoppers — **swarm**, **multiplier**, **precision**, **economy**
and **tempo** — each chase one build archetype with the full pool, so their spread shows whether
every archetype is viable. Theme membership is declared beside the items in `ITEM_THEMES`.

The balancing workflow:

```bash
npm run sim                       # the report → sim-out/report.html
npx tsx src/sim/tuneCurve.ts      # design TRIAL_GOALS against real culling
CURVE="TUNED (real culling)" npx tsx src/sim/validate.ts   # confirm it
npx tsx src/sim/endlessCurve.ts   # confirm endless still terminates
```

`tuneCurve.ts` is the one that matters. It is a fixed-point iteration: simulate the whole field
under the current curve with culling on, re-pick every goal as the quantile of the peak scores of
the runs that _actually entered_ that trial, repeat. The older `designTargets.ts` designs from a
single non-culling pass, which is systematically wrong here — with no clears, no trial pays for
rolls left in hand and no Boss Trial pays its bonus, so the builds it measures are poorer than
real ones and its curve lands far too easy (a 23% designed win rate measured 65% in practice).

Assertion suites, all runnable and all part of the quality gate:

```bash
npm run items:check      # item mechanics, including every boss modifier
npm run trials:check     # the trial loop: clears, advances, ranks, endings
npm run gold:check       # payouts, interest, prices, rerolls, discounts
npm run scoring:check    # the two scorers agree, per-die vs bucketed
npm run persistence:check # an in-progress run survives a save/restore round trip
npm run history:check    # the per-roll run timeline the analysis screen charts
```

See `src/sim/README.md` for flags and details.

## License

The source code is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). You are
free to read it, run it, fork it, modify it, and share those changes for any noncommercial
purpose — personal projects, study, hobby work, and use by schools, charities, and public
institutions. Selling it, or otherwise using it for commercial advantage, requires a separate
license.

The art and audio are **not** covered by that license. Everything in [`images/`](images/LICENSE)
and [`audio/`](audio/LICENSE) is all rights reserved, so a noncommercial fork needs to supply its
own assets. The name "The Order of Order" is likewise not licensed for use in derivative works.

This project was previously MIT-licensed; commits published before the change remain available
under those terms. Commercial licensing inquiries: alexblackburn32@gmail.com.
