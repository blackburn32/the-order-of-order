# The Order of Order

The Order of Order is an incremental roguelike built around rolling dice. The player rolls a
grid of dice trying to hit specific numbers, earning points when they do. Points are progress
toward the current **trial's** goals and nothing else — they reset to zero the moment a trial
ends. The shop runs on a separate currency, **gold**, earned by clearing trials.

A run climbs a ladder of **trials** grouped into **ranks**. Each rank is three trials — the
Lesser Trial (7 rolls), the Greater Trial (10 rolls), and the Boss Trial (10 rolls). Every
trial is played to its last roll and asks four goals: **bronze** must be met to survive it, and
**silver**, **gold** and **legendary** pay extra gold for climbing past it. A route screen
previews all three trials of a rank, stamps completed ones, marks the next one, and reveals the
rank's Boss modifier before play begins. Clearing a trial opens its results, then the shop,
then the route back to the next trial. Clearing a rank's Boss Trial raises the rank and returns
the player to a Lesser Trial with every goal raised.

**Rank 10's Boss Trial is the finish line**: a duel against the Order of Disorder, which plays an
exact copy of the player's own grid. Winning it wins the game, and the victory screen then offers
to press on into an endless ladder that no build can outrun forever. Each run is played as one
of four **novices** (see [Novices](#novices)), and the **Daily Rite** offers one shared seeded
run a day.

The game is built with Phaser 4 (TypeScript + Vite). Rolling a **1** scores; the **Decree** card
adds 2, then 3, then 4 as scoring faces. The per-trial goals are measured tables
(`MEASURED_GOALS` for bronze and `MEASURED_TIER_GOALS` for the tiers above it, in
`src/config.ts`) fitted with `npm run goals:tiers` in `src/sim`: a grid of 43 bot strategies
plays hundreds of seeds with real culling, and each goal is set, trial by trial, so the share of
runs still alive lands on a survival curve.

The curve gives the game definite pacing. It is pinned at about 70% of runs through rank 1, 46%
through rank 3, 25% through rank 6 (just before the Betrayal), and a 6.5% win rate, so a casual
player sees a good part of the ladder and the finish stays a hard ceiling. Measured on the same
grid playing held-out seeds (a thinking player does better), the share of runs still alive after
each rank:

| After rank      | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | 10 (win) |
| --------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | -------- |
| Wanted (bronze) | 70% | 57% | 46% | 38% | 31% | 25% | 21% | 18% | 15% | 6.5%     |
| Held out        | 60% | 51% | 41% | 33% | 27% | 22% | 19% | 16% | 14% | 5.7%     |

Rank 1's goals are authored (1, 2 and 3 points) rather than fitted: the lone starting die ends
nearly 30% of runs in trial 1 by bad luck, so rank 1 lands under 70%. The duel at rank 10 is a
fair coin against a copy of the run's own grid, so about half the runs that reach it win.

The curve also **saw-tooths**, which is the shape of a rank rather than a mistake: a rank's
seven-roll Lesser Trial can ask for less than the ten-roll Boss Trial before it. What always
rises is the same slot from one rank to the next. To refit, move the checkpoints and fit with
`npm run goals:tiers`, then grade the result on held-out seeds with
`VALIDATE=1 SEED=2 npm run goals:tiers`; see "Goal tiers and run ranks" in `src/sim/README.md`.

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

### Hosting the website on Cloudflare

The production web deployment combines the static marketing site and the game
into one Cloudflare Worker with static assets:

| URL                                    | Content        |
| -------------------------------------- | -------------- |
| `https://the-order-of-order.com/`      | Marketing site |
| `https://the-order-of-order.com/game/` | Browser game   |

Build the combined artifact with `npm run build:web`. It writes `site-dist/`,
including a game build whose Vite base is `/game/`; the other game targets keep
their existing portable relative base. Preview the complete site locally with
`npm run preview:web`.

To work on the combined site, run `npm run dev:web`. It serves the same layout
at [http://localhost:5174](http://localhost:5174) — marketing at `/`, game at
`/game/` — from the sources rather than from `site-dist/`, so there is no build
step between an edit and the browser. The game keeps the hot module replacement
of `npm run dev`; saving anything under `marketing-site/` reloads the page.
Set `PORT` to move it off 5174 (`npm run dev` stays free on 5173). Unlike
`npm run preview:web`, this does not run Wrangler, so the `_headers` and
`_redirects` rules are not applied — only the `/game` → `/game/` redirect is
mirrored. Check anything that depends on those headers with `npm run preview:web`.

For a first deployment, add the domain to Cloudflare and point the registrar's
nameservers to Cloudflare. Then authenticate and deploy from the repository root:

```bash
npm run cloudflare:login
npm run deploy:web
```

`wrangler.jsonc` creates the `the-order-of-order-web` Worker and attaches
`the-order-of-order.com` as its custom domain. Later deploys use the same
`npm run deploy:web` command.

For automatic deploys, import this repository in **Workers & Pages**, keep the
root directory at `/`, use `npm run build:web` as the build command, and leave
the deploy command at its default (`npx wrangler deploy`). The Worker name must
remain `the-order-of-order-web`, matching `wrangler.jsonc`.

#### Build flags

Build-time switches live in `src/buildFlags.ts` and are set from `VITE_*` env vars, so their
values are frozen into `dist/` when it is built (unlike the gameplay knobs in `src/config.ts`
or the player's own settings).

| Flag          | Env var            | Default | What it does                                                    |
| ------------- | ------------------ | ------- | --------------------------------------------------------------- |
| `GOLD_BORDER` | `VITE_GOLD_BORDER` | off     | Gold frame around the outside of the game                       |
| `PHONE_BUILD` | `VITE_PHONE_BUILD` | off     | Hides browser-only UI in the Capacitor phone app                |
| `DEV_PANEL`   | `VITE_DEV_PANEL`   | off     | Ships the dev panel in a production bundle (always on in `dev`) |

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

Plain `npm run build` (static hosts) and `npm run dev` leave every flag at its default. The itch
build enables the frame; the phone build hides the fullscreen setting. `npm run build:web` turns
on the dev panel for Cloudflare preview builds of branches other than `main`.

### Other scripts

```bash
npm run lint           # ESLint
npm run format:check   # Prettier (npm run format to fix)
npm run sim            # headless balance simulation → sim-out/report.html (see src/sim)
npm run trees:csv      # every strategy tree → sim-out/item-trees.csv
npm run licenses       # regenerate the third-party licence list the Credits screen shows
```

The assertion suites are listed under [Balance simulation](#balance-simulation).

Nearly all art is drawn procedurally at runtime and most audio is synthesized with WebAudio; the
only binary assets are the story and character art in `images/` and the music track in
`audio/songs/`. Tuning knobs (trial goals and goal tiers, rolls per trial, the winning rank,
endless growth, shop rarity weights) live in `src/config.ts`; the gold economy's knobs live in
`src/systems/Gold.ts`, the Boss Trial modifiers in `src/systems/Boss.ts`, every drawback they
share with cursed cards in `src/systems/Afflictions.ts`, and the novices in
`src/systems/Characters.ts`. Playwright is included as a devDependency for headless playtesting
and the marketing capture scripts; the game instance is exposed as `window.__game` for that
purpose.

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

Production builds use the board in `PRODUCTION_API` (`src/systems/GlobalScores.ts`); the dev
server and the simulations stay offline. One optional Vite variable overrides that, in a local
`.env` (gitignored; see `.env.example`):

| Variable               | What it targets                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `VITE_LEADERBOARD_API` | Base URL of a Worker, no trailing slash. Set it empty to build with the board off. |

Posting is opt-in: the initials prompt asks the first time, and Settings has the switch, the
player's Board ID, and a button that deletes their record (`DELETE /v1/players/me`).

Vite inlines env vars at build time, so changes to `.env` only take effect on the next
`npm run dev` / `npm run build` — a running server won't pick them up.

The number of rows fetched (`GLOBAL_TOP_N`) is a constant in `src/systems/GlobalScores.ts`.

## Gameplay

The main game screen features a grid of dice, starting with one die (a d6 for most novices), and
a roll seal below it. The HUD lays out as a row across the top in landscape and shrinks into a
stacked column in the top-left in portrait. It shows:

- **ROLLS** — rolls used, out of this trial's budget
- **RANK** — the ladder position as `rank-trial`, so `2-3` is the Boss Trial of rank 2
- **GOAL** — the next goal tier this trial is climbing toward
- **SCORE** — progress toward it, reset to zero every trial
- **GOLD** — the purse, which the shop is the only thing that spends

An **Inventory** link opens an overlay of every item bought this run (as cards, with a copy-count
badge on stacked items), and a **Settings** link opens the settings panel mid-run. After a roll,
a panel breaks down what each card contributed; the roll favours (below) are spent from it.

Dice are shaped by their side count, so the grid reads at a glance: d1/d2 render as coins, d4 as
a triangle, d6 as a square, d8/d10 as an octagon, d12 as a pentagon, and d20/d100 as a hexagon.
Every die shows its numeral. During the roll animation a die only flickers through values up to
its own side count, and newly added dice spawn showing their max face instead of appearing blank.

The grid has no practical limit on dice count. It is a pannable, zoomable viewport
(`src/ui/windowedGrid.ts`) that fits itself to the dice it holds; zoomed far enough out, regions of
the grid condense into summary cards, and per-die flourishes stop drawing past the cutoff set by
the Graphics Level setting. Dice can be dragged to new places in the grid, which matters for the
radius dice.

### Ranks and trials

| Trial in rank | Name          | Rolls | Notes                         |
| ------------- | ------------- | ----- | ----------------------------- |
| 1             | Lesser Trial  | 7     | A sprint against a small goal |
| 2             | Greater Trial | 10    | Room to build                 |
| 3             | Boss Trial    | 10    | Carries a hostile modifier    |

Every trial plays to its last roll. Meeting bronze no longer ends a trial; it starts the climb
toward silver, gold and legendary, and the highest tier met by the last roll is what the trial
pays for (`src/systems/GoalTiers.ts`). Finishing below bronze ends the run, unless the player
owns **Dispensation** and finished at 75% of the goal, which clears the trial and destroys the
card.

A run starts with one die, and the first trial's goal is 1. Because only 1s score at the outset,
some runs will lose in the first trial or two; that early risk is intentional. See
`STARTING_DICE` and `MEASURED_GOALS` in `src/config.ts`.

Roll budgets move with cards and drawbacks: The Bell adds a roll to every trial, The Long Sitting
adds rolls to the next one, Haste and The Hunger take three away, and The Long Night adds five.
The duel's ten rolls are fixed and ignore all of them (`MIRROR_TRIAL_ROLLS`).

### The story and the duel

The ladder is told in four acts, each pinned to a Boss Trial (`src/systems/Endings.ts`; the prose
lives in `src/story.ts` and is collected in `STORY.md`):

| When                        | Act               | What it does                                                                 |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| After rank 3's Boss Trial   | The King's demand | The player must accept one of three standing drawbacks (five with Ledger)    |
| After rank 6's Boss Trial   | The Betrayal      | Dice that add nothing to a roll may defect to the Order of Disorder for good |
| After rank 9's Boss Trial   | The summons       | Costs nothing; puts the duel on the horizon a rank ahead                     |
| Before rank 10's Boss Trial | The duel          | Introduces the Order of Disorder; winning leads on to the Victory screen     |

The duel (`src/systems/Rival.ts`) replaces rank 10's Boss Trial goal with a race: the Order of
Disorder opens holding an exact copy of the player's grid and rolls it under the player's own
rules, build and afflictions, for ten rolls. A tie goes to the Order; **The Edge** is the one card
that gives the player a point the mirror cannot copy. Rank 10 rolls no Boss modifier, since it
would fall on one side of the mirror only. `npm run duel:check` asserts the duel is a fair coin.

Winning the duel opens the Victory screen, which asks the player to either end the run and
submit its score or **Press On — Endless**. Continuing lifts the King's drawback and the
Betrayal, keeps the run open and unrecorded until it fails or is abandoned, and carries it past
rank 10 with goals that grow faster and faster (see `ENDLESS_BASE` / `ENDLESS_ACCEL`). The growth
rate itself accelerates, because builds compound geometrically and a fixed ratio could be
outrun forever.

### Medals

Each cleared trial is stamped with the highest tier it met, and the Results screen pays tier gold
for it (+2 silver, +4 gold, +6 legendary). A won run is also given a run rank, read off its total
score against `RUN_RANK_THRESHOLDS` in `src/config.ts`: every win is at least bronze, and
silver, gold and legendary were fitted to the top 50%, 20% and 2% of winning runs. A run that
fails is not ranked.

### Boss Trials

Each rank rolls one of eight modifiers as the rank begins. It is previewed on the route screen
throughout the rank, then activates on the third trial and is shown beside the GOAL pill. The same
modifier never appears in consecutive ranks, and The Long Night makes every Boss Trial roll two.

| Name        | Effect                                                    |
| ----------- | --------------------------------------------------------- |
| The Famine  | Deeper Stillness and Enlightenment grant nothing          |
| The Drought | No dice are added this trial                              |
| The Eclipse | The roll multiplier is halved                             |
| The Silence | Only 1s score — the numbers you unlocked are silenced     |
| The Hunger  | Three fewer rolls                                         |
| The Warden  | Consensus, The Congregation and Lucky Seven grant nothing |
| The Toll    | A tenth of your dice score nothing                        |
| The Hoard   | The goal is 40% higher, but clearing it pays double gold  |

Beating a Boss Trial pays a gold bonus and buys the next shop **boosted rarity odds**
(`BOON_RARITY_WEIGHTS` in `src/config.ts`) — better cards, not just more of them. The modifiers
are named in `src/systems/Boss.ts`, but what each one _does_ is an affliction in
`src/systems/Afflictions.ts`, the same vocabulary cursed cards, the King's demands and the Daily
Rite's banes write their drawbacks in.

The Toll (the boss, not the card of the same name) is applied to the roll's _aggregate counts_,
never by removing individual dice, because past 2,000 dice the pool switches to bucket storage
and individual dice stop existing. Scaling the counts is the only definition that means the same
thing at every grid size — a hundred dice under The Toll score exactly what ninety dice score
without it.

### Scoring

Each roll is scored as a stack of modifiers (`src/systems/Scoring.ts`), so new rules are added
by pushing another modifier rather than threading a new field through the scene. The additive
part includes:

- **Scoring** — each die showing a scoring number (1, plus 2, 3 and 4 from Decree) or a face
  made to score by Contentment, Royal Seal or The Scales is worth 1 point, +1 per Deeper
  Stillness owned, and +2 per Enlightenment owned when it's a d1.
- **Consensus** — any value shown by 2+ dice scores that value × the number showing it.
- **The Congregation** — 25 points for every 5 dice that score, per copy owned.
- **Windfall** — a Rollplayer/Centurion die's current highest face always scores and applies
  that card's ×2/×4 roll multiplier; shrinking the die makes the effect more likely.
- **Rhythm** — adds twice the consecutive-scoring-roll streak as points, per copy owned.
- **Small Mercies**, **Strength in Numbers** and **Solitude** pay flat amounts every roll.
- **Counterpoint** and **A New Voice** pay dice that stand alone on their face.

The subtotal is then multiplied by the run multiplier: Resonance ×2, Clarity ×3 per copy, the
cursed cards' flat factors, The Toll ×2 on every fourth roll, Vespers ×4 on a trial's final roll,
Lucky Seven ×7 on any roll that shows a 7, Hourglass on the first two and last two rolls, the
conditional The Procession / The Whole Order / Of One Mind factors, the strategy trees'
multipliers (The Gilded Altar, The Choirmaster, The Canticle, Gravitas, The Cell, The Ashen
Crown), Windfall, and a blessed roll's Benediction — all compounding, then halved by The Eclipse. Stacking
multipliers (Clarity, Vespers, The Toll) sell two copies at most.

On top of that sit the **growth engines** (`src/systems/GrowthEngines.ts`): each strategy tree's
third card permanently grows the multiplier by up to 10% a roll when its condition is met (see
[Strategy trees](#strategy-trees)).

Trial-start passives fire as each trial opens (`openTrial` in `src/sim/engine.ts`): The Inner
Circle adds 10 dice of the grid's most common size, A Full Choir adds a d100, and Backsliding
grows every die a size — unless a drought blocks new dice.

The **radius dice** (`src/systems/RadiusDice.ts`) reach out to the dice within two cells of them
when they roll their top face: The Halo (d8) makes the scoring dice around it score ×4, Grace (d6)
re-rolls the dice around it that missed, and The Censer (d12) turns neighbours with a top-face
power to that face. Where they stand on the grid decides which dice they touch.

The **roll favours** (`src/systems/RollFavours.ts`) are spent by hand from the score panel on a
roll just seen: Absolution strikes it and rolls again, and Benediction blesses it for ×2 (×4,
×8 … with each Doxology). Each copy is one use a trial.

Scoring lives in two implementations that must agree exactly: `ScoringHistogram.ts` is the live
path (O(distinct faces), works when the pool is bucketed) and `Scoring.ts` is a per-die reference
kept only for the parity harness. `npm run scoring:check` fails loudly if they drift, and it
covers the boss modifiers too.

## Novices

Each run is played as one of four novices (`src/systems/Characters.ts`). A novice changes the
run's mechanics, never its goals: the ladder is the same for all of them.

| Novice  | Rules                                                                                  | Unlocked by                                        |
| ------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Diebert | Begins every run with 10 gold                                                          | Available from the start                           |
| Melodie | Starts on a d4; pays 35% less for everything in the shop, but never holds over 20 dice | Holding 100 gold at once                           |
| Roland  | Starts on a d20; every die is remade at a new size after each roll                     | Holding one die of every size, d1 to d100, at once |
| Dieanne | Starts on Grace, the radius die that gives its neighbours a second roll                | Shrinking a Centurion to a d1                      |

## The shop

A shop opens after every cleared trial, after the Results screen and before the next route screen.
Its upper row offers 3 loose item cards (5 once the player owns Ledger). The lower row holds two
sealed booster packs and the reroll/continue controls. Responsive grids and scrollable card bands
keep both rows readable in narrow portrait layouts.

The player may buy **as many loose cards and packs as they can afford** (Sealed Doors cuts that to
one), then continues to the trial route. Rerolling refreshes only the loose cards; the two packs
remain fixed for the visit. A reroll costs 5 gold and each further reroll in the same visit costs
double the last (5, 10, 20, 40…), so a typical purse covers one or two; The Second Look makes the
first reroll of every shop free. If no loose card is affordable, the free Two Newcomers is
guaranteed onto the first row of the visit so the shop is never a dead screen. Leaving without
buying anything pays Abstinence's gold.

**Cursed cards** are strong cards paid for with a standing drawback instead of gold: they cost
nothing, are drawn less often than ordinary cards of their tier (`CURSE_DRAW_WEIGHT`), and at most
one appears on any row or booster reveal.

### Booster packs

Buying a booster opens it immediately and reveals 3 currently legal cards. The player chooses
one without paying again and the rest disappear. Ledger increases both the loose-card row and
each booster reveal to 5 cards. A chosen die-targeting card continues into the normal die picker.

The pack catalog contains the Common Parcel, Uncommon Folio and Rare Reliquary, plus the themed
Gathering, Ritual, Artificer's, Treasury and Hourglass Packs, which draw from the swarm,
multiplier, precision, economy and tempo themes. A Boss clear improves the rarity table for the
whole next shop visit, including rerolls and themed-pack contents, and favours the higher-rarity
packs. Fair Weights, Pawnbroker and Melodie's discount apply to pack prices; The Benefactor's
free card is always a loose card rather than a sealed pack.

### Gold

Gold is deliberately not the score. It is a small, slow-growing purse that persists across the
whole run, and it is the only thing the shop takes. A run opens with 4 gold (Diebert's with 10);
clearing a trial pays:

| Source       | Amount                                                                |
| ------------ | --------------------------------------------------------------------- |
| The trial    | 3 / 4 / 6 for the Lesser / Greater / Boss Trial                       |
| Goal tier    | +2 for silver, +4 for gold, +6 for legendary                          |
| Interest     | 1 per 5 gold banked, up to 5 (Vault raises the cap to 10)             |
| Boss cleared | +2                                                                    |
| Gold items   | Counting House (+1 per copy), Prospector (+1 per 25 dice held, max 5) |
| Reliquary    | +25% of everything above except interest                              |

The Hoard doubles the same share, and Iron Debt cuts it to 40%. Interest is what makes banking a
real alternative to spending: gold left unspent compounds a little at every clear. Tithe Bowl,
Lucky Coin and An Offering also pay out mid-trial, during rolls, while Tollkeeper charges a gold
a roll and Pauper's Vow seizes everything above 7 as a trial ends.

The economy once paid for rolls left in hand. Now that every trial plays to its last roll, the
three cards built on that (Reserve, The Almsbag and Held Breath) are kept defined but off the
shelf.

The knobs all live in `src/systems/Gold.ts`. Gold is a plain `number` while every score field is
a `bigint` — if the purse ever needs bigint, the economy has already gone wrong.

### Pricing

Item prices are flat gold amounts by strength band, deliberately decoupled from the exponential
goal curve so "8 gold" means the same thing on trial 1 and trial 30:

| Strength band  | Price |
| -------------- | ----: |
| Free           |     0 |
| Low            |     4 |
| Standard       |     6 |
| Strong         |    10 |
| Build-defining |    15 |

```text
price = band × markup × repeat multiplier × market variation × novice discount × Fair Weights − Pawnbroker
```

Repeatable effects become more expensive for each copy already bought: ordinary linear stacks
grow by 1.35× per copy, while multipliers and explosive grid-growth effects grow by 1.8× per
copy. Single-time items have no repeat multiplier. The grid multipliers (Like Minds, The
Gathering, The Great Gathering) carry a 1.2× markup over their band. Every non-free card also
rolls a market adjustment from −25% to +25% each time it appears, so price stays an imperfect
signal of power. Fair Weights takes 25% off everything and Pawnbroker a flat 2 gold; no paid card
ever drops below 1 gold. Two Newcomers is the sole free card and the guaranteed fallback.

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
  that tier, weighted within it (curses below ordinary cards, opened tree cards above them).
- Cards are drawn without replacement, so one shop never offers duplicates.
- An item is only eligible if it has a legal effect (see gating below). If a rolled tier has no
  eligible items left, fall back toward common first, then to whatever tier still has items.

### The items

Every item — its name, rarity, price band, description, gating predicate, unlock criterion,
build theme, and effects — is defined in one place: **`src/systems/Items.ts`**, as a single
`ITEMS` array. That file is the source of truth for the shop pool, the Codex gallery, the dev
panel's grant list, and the balance simulation's item tables. Build themes are declared beside
them in `ITEM_THEMES`.

It is deliberately not duplicated here. A table in this README would be a second copy of the
roster that drifts from the code the first time an item is retuned or renamed, which is exactly
what happened to the tables this section replaced.

### Strategy trees

Most builds are organised as eight **strategy trees** (`src/systems/ItemTrees.ts`): The Lessons,
The Gathering, Resonance, The Hermitage, The Weighing, The Treasury, The Canticle and The Pyre.
Each is a chain of four cards — a root that pays on its own, a fixed-factor card, an engine that
compounds for the rest of the run, and a boost that raises the engine's rate. Buying a card opens
the next one to the shop for the rest of the run, drawn three times as often as an ordinary card
of its tier (`TREE_UPGRADE_WEIGHT`), and a card whose parent is not owned is never shown. Supports
and branches hang off the chains the same way. `npm run trees:csv` exports every tree.

### Gating

An item is only offered when it can actually do something:

- A Lesson, Group Study, Refinement — require at least one die above d1.
- The Vow — requires a die size that isn't already loaded.
- Enlightenment — requires at least one d1 in the grid.
- Decree — stops appearing once the face 4 has been added.
- Royal Seal — requires a die size that isn't already sealed.
- Flat starters (Two Adepts, Two Students, Two Novices, Small Mercies, A Lesson, Tithe Bowl) drop
  out of the shop once the grid reaches 75 dice, since their fixed adds become noise at that
  scale. Two Newcomers is exempt — it's the guaranteed free fallback.
- Tree cards wait for the card above them; boosts wait for their engine and stop at three.
- After The Final Sermon, nothing that adds dice is offered again.

Some items are **single-time**: a second copy would do nothing, so once bought they never
appear again for the rest of the run — every item carrying `unique: true` in `ITEMS`. Everything
else can be bought repeatedly and stacks, compounding per copy owned.

## Unlocks and the Codex

Most items are available from the very first run. Some are **locked** behind an achievement and
never appear in the shop until the player has earned them. An unlock is permanent: once met, the
item is offered starting with the next run and can never be re-locked (short of resetting all
progress). A tree card's unlock is its root's, so unlocking Rhythm opens the whole Resonance tree
along with the cards that branch from it.

Unlock progress is meta-progression: it lives in `localStorage` (key `ooo_progress_v2`), separate
from the ephemeral per-run state, so it survives reloads and carries across runs.

Currently unlockable:

| Card                | Unlock criterion                                        |
| ------------------- | ------------------------------------------------------- |
| Strength in Numbers | Reach rank 2                                            |
| Tollkeeper          | Reach rank 2                                            |
| Testimony           | Reach rank 4                                            |
| Rhythm              | Score on 12 rolls in a row (in one run)                 |
| Enlightenment       | Hold 10 or more d1 at once                              |
| The Inner Circle    | Hold more than 29 dice in your grid at once             |
| The Final Sermon    | Hold more than 1000 dice in your grid at once           |
| The Congregation    | Show the same number on 6 or more dice in a single roll |
| Prospector          | Hold 25 gold at once                                    |
| Iron Debt           | Hold 25 gold at once                                    |
| Pawnbroker          | Hold 40 gold at once                                    |
| Sealed Doors        | Hold 40 gold at once                                    |
| Reliquary           | Clear 3 Boss Trials in one run                          |
| The Long Night      | Clear 3 Boss Trials in one run                          |
| Ouroboros           | Win a run                                               |
| Leaden Dice         | Win a run                                               |

Rhythm's unlock also opens the rest of the Resonance tree: The Toll, The Resonant Hall,
Harmonics, and the cards that branch from it (Resonance, Clarity, Vespers, Hourglass, Haste, Old
Habits and The Reckoning). The definitive list is whatever carries an `unlock` field in `ITEMS`, read
through `metaUnlockOwner` in `src/systems/Shop.ts`.

Criteria are checked and persisted live during a run, but newly earned cards are collected and
revealed together on the Trial Results screen. Each run snapshots its eligible card pool when it
begins, so newly unlocked cards first appear in the next run. The criteria engine is data-driven
(`src/systems/Items.ts` — `UnlockCriterion` / `meetsCriterion`), so new unlock conditions can be
added by tagging an item with an `unlock` field.

### The Codex (Items screen)

A main-menu entry, **Codex**, opens a scrollable gallery of every shop item as a card, exactly
as it appears in the shop, with sorting and filters by rarity and build theme. Under each card is
the number of times that item has been selected from the shop across all runs (dev-panel grants
don't count). Items that are still locked render greyed out, with their name, rarity, cost, and
description replaced by `???` and their unlock hint shown underneath. A second tab, **Stats**,
holds the player's lifetime record.

The Codex button itself stays locked until the player has **completed a single game** (a win or a
loss — including abandoning a run), at which point it becomes available.

## Other screens

The game opens on a menu (the Vestibule) with:

- Start New Run
- The Daily Rite (locked until the first win)
- Hall of High Scores
- Codex (locked until the first game is completed)
- Settings

On a new run started from the menu, an illustrated **intro** sets the premise before the first
roll (skippable, and toggled off permanently from its own checkbox or from Settings), followed
by the novice selection. On a player's first run, a **callout tutorial** follows the run's own
loop rather than one screen: the route screen teaches the shape of a rank and the boss waiting at
the end of it, the table teaches the score, the roll seal, the grid, the goal tiers and the roll
budget, the Results screen teaches what a clear pays, the shop teaches spending it, and the Boss
Trial is explained when the route first reaches one. Its steps are deliberately one short line
each; the script is in `TUTORIAL.md`. A tutorial run cannot lose its first trial: once that trial
has only as many rolls left as it still needs points, those rolls are rigged to come up 1. The
tutorial self-disables after one run (however that run ends) and can be re-enabled from Settings.

An in-progress run is saved as it goes and resumes where it left off.

### The Daily Rite

One seeded run a day, the same for everyone (`src/systems/Daily.ts`). The UTC date fixes the
seed, the novice (played whether or not the player has unlocked them), two **boons** — mostly
free cards, plus The Crown's Purse, The Blessed Market and The Steady Hand — and two **banes**,
milder cousins of the curses. The shop draws from every card in the game rather than from the
player's own unlocks. Only the first attempt each day counts, and it has its own board.

### The Hall of High Scores

The Hall has three tabs: the player's local runs, the global board, and the Daily Rite's board.
Each local run shows:

- The date the run was started, short format
- The rank and trial the player reached (and the medal, for a win)
- The total score accumulated across the run
- The grid of dice they ended with

Tapping a run opens its analysis: per-card and per-die point shares, and curves of the score and
the dice pool across the run.

Runs are ranked by **how far they got first, with total points only breaking ties** between runs
that reached the same rank. The global leaderboard sorts on the same two keys, held as separate
columns rather than packed into one number. Points ride as an exact decimal string: a strong
run's total leaves `Number.MAX_SAFE_INTEGER` behind early and has no ceiling at all in endless.
The sort key is therefore `(rank, digit count, decimal)` — for integers written without leading
zeros the longer number is always the larger one, and equal-length values compare correctly as
text, which orders arbitrary-length scores exactly.

Scores recorded before the ranks/trials/gold restructure measured a different game and cannot be
ranked against these, so they are filtered out rather than shown with invented values. The local
storage keys moved to `_v2` for the same reason.

### Settings

- Music Volume
- Sound Effects
- Show Intro
- Show Tutorial
- Visual Effects (see [Visual effects](#visual-effects) below)
- Graphics Level — how many dice may be in view before per-die effects stop drawing
- Fullscreen (hidden in the phone build)
- Interface Size
- Post to the Global Hall, and Delete My Board Record (when the board is configured)
- Send Crash Reports
- Export Save / Import Save
- Privacy Policy, and Credits & Licences (from the menu)
- Abandon Run (mid-run only) — ends and records the current run as a loss, then shows Game Over
- Reset All Progress (from the menu) — wipes item unlocks, Codex selection counts, lifetime
  stats, games-completed, any in-progress run, and the Hall of High Scores (settings are kept); a
  two-tap confirm guards it

## Visual effects

Beyond the base feedback (die-border flashes and floating score labels), the game layers
on a set of flourishes: the HUD score eases up to its new value and its plaque punches, the dice
rock as they tumble and settle in a ripple, chain lightning and spotlights mark the dice a card
paid for, a sigil turns behind the grid and brightens as the trial's goal comes into reach, the
felt and grid backdrop warm toward gold with it (and go red on a final roll that arrives short),
big rolls shake the screen and throw gold sparks, the roll seal breathes and rings when pressed,
route cards deal into place, Results stages its seal/gold/unlock reveals, and shop cards are
dealt onto the table with rare ones lit by a glow. Booster packs focus over the shop, shake open
in a burst, and flip their choices into view.

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
_hasn't_ asked for less motion still gets the cheap motion cues. A third control, the **Graphics
Level** (`src/systems/GraphicsLevel.ts`), sets how far out the per-die flourishes keep drawing on
a large grid; until the player picks one it follows the effect tier.

Everything resolves through the `fx` singleton in `src/systems/Effects.ts`, which mirrors the
`audio` one — initialized once in `BootScene` from the live renderer, updated live by the
Settings toggle. Call sites branch on `fx.on` / `fx.rich` / `fx.motion` rather than re-deriving
any of this, and the helpers are self-gating, so calling `fx.burst` on a basic device is a
no-op rather than a crash. New effects should be added the same way: pick the axis that
describes the cost, and let the helper decline.

## Balance simulation

`src/sim` is a headless bot that plays full runs to gather balance statistics — win rates, where
runs die, what gets bought, which curses are taken, how gold is earned and spent, how often each
Boss Trial modifier is beaten, and how likely each gated item is to unlock — and writes a
self-contained HTML report. It reuses the game's real economy end to end (scoring, shop,
trial-start passives) through a shared trial-loop engine that `GameScene` also uses, so results
reflect the live rules.

Eleven series make up the field: **greedy** (most expensive card first) and **thrifty** (cheapest
first) bracket how far a purse stretches and each run against both the base and the fully
unlocked item pool; five themed shoppers — **swarm**, **multiplier**, **precision**, **economy**
and **tempo** — each chase one build archetype with the full pool, so their spread shows whether
every archetype is viable; and two judged shoppers, the **expert** (which appraises every card by
playing it out) and the **player** (which follows a written plan), are held out of the field the
goal curve is fitted against. Theme membership is declared beside the items in `ITEM_THEMES`.

The balancing workflow:

```bash
npm run sim                                   # the report → sim-out/report.html
SEEDS=500 npm run goals:tiers                 # fit bronze, the tiers and the run ranks
VALIDATE=1 SEED=2 SEEDS=500 npm run goals:tiers  # grade the live tables on held-out seeds
npm run goals:report                          # before/after page → sim-out/goal-report.html
```

`goals:tiers` is the one that matters. Trial by trial, every run that reaches a trial plays it
against unreachable goals to see what each could score there, and each tier is set at the score a
chosen share of those entrants reach: bronze to the survival curve, silver a little harder than
the single goal it replaced, gold at 30% of entrants, legendary at 2%. The older tuners
(`goals:tune`, `goals:search`, `goals:sweep`, the engine-gated and smart-field curves) remain for
reference; `src/sim/README.md` says what each measures.

Assertion suites, all runnable and all part of the quality gate:

```bash
npm run items:check       # item mechanics, including every boss modifier
npm run trials:check      # the trial loop: clears, advances, ranks, endings
npm run gold:check        # payouts, interest, prices, rerolls, discounts
npm run scoring:check     # the two scorers agree, per-die vs bucketed
npm run characters:check  # the novices' rules and the seams that read them
npm run daily:check       # the Daily Rite's contract, and a balance read
npm run duel:check        # the duel is a fair mirror: 50% wins, build by build
npm run radius:check      # the radius dice: reach, rules and resolution order
npm run persistence:check # an in-progress run survives a save/restore round trip
npm run history:check     # the per-roll run timeline the analysis screen charts
npm run rng:check         # a run is a function of its seed and unlock snapshot
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
