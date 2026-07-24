# The Order of Order

The Order of Order is an incremental roguelike built around rolling dice. The player rolls a
grid of dice trying to hit specific numbers, earning points when they do. Those points are also
the shop's currency, so every purchase is a gamble. The player must meet a score threshold at
the end of every round (20 rolls) to survive; falling short ends the run. Surviving a round
clears the score back to 0, so banked points must be spent in the shop before the round ends or
they're lost — unless the player owns a carryover item (Vault keeps 20%, Reserve keeps 50%).
Clearing **all 10 rounds** wins the game.

The game is built with Phaser 4 (TypeScript + Vite). Rolling a **1** scores; "Extra Number"
upgrades add 2 and then 3 as scoring faces. Score and shop currency are one pool, so every
purchase is weighed against the round threshold. The per-round survival targets are a
hand-authored table (`ROUND_TARGETS` in `src/config.ts`), tuned with the balance simulation
in `src/sim` so runs end across the whole game rather than being decided in the first few
rounds; the legacy geometric formula (`ceil(5 × 1.85^(round−1))`) survives only as a fallback
for rounds beyond the authored table.

The 10-round curve is designed to a deliberate attrition shape (measured on the pooled
naive-bot field; a thinking player does better):

- **Rounds 1–3** — a gentle on-ramp; about **60%** of the field survives to round 4.
- **Rounds 4–9** — a steady wall; roughly **5% of the whole field** is culled at each step.
- **Round 10** — the final wall; culls about **8%** of the field, landing a ~22% bot win rate.

Deaths land on every round, so no single spike decides the run. Redesign the curve with
`src/sim/designTargets.ts` and re-test it against the real survival gate with
`src/sim/validate.ts`.

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
in the LootLocker keys to enable it (see [Global leaderboard](#global-leaderboard-optional)
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

### Other scripts

```bash
npm run sim      # headless balance simulation → sim-out/report.html (see src/sim)
```

All art is drawn procedurally at runtime and all audio is synthesized with WebAudio — the
repo contains no binary assets. Tuning knobs (round targets, shop rolls, win round) live in
`src/config.ts`. A Playwright smoke driver is included as a devDependency for headless
playtesting; the game instance is exposed as `window.__game` for that purpose.

The game is responsive and runs in both landscape and portrait, at any window size — the
canvas resizes to fill the page (`Phaser.Scale.RESIZE`) rather than being letterboxed to a
fixed resolution. Every scene lays itself out from `scene.scale.width/height` and rebuilds
its whole display list on resize/orientation-change (see `src/ui/layout.ts`'s `responsive()`
helper), so rotating a device or resizing the browser window reflows the UI live.

### Global leaderboard (optional)

A shared online leaderboard is backed by [LootLocker](https://lootlocker.com) and reached over
plain `fetch` (see `src/systems/GlobalScores.ts`). Players are anonymous — a per-device UUID
opens a guest session and doubles as the leaderboard member id, and a 1–3 letter arcade-style
initials prompt supplies the display name when a run sets a new personal best. Configure it by
copying `.env.example` to `.env` and filling in the LootLocker keys. When the keys are absent
the feature disables gracefully and the game runs fully offline against the local Hall of High
Scores.

#### Pointing at a different leaderboard backend

The backend targets are read from three Vite environment variables — the game never hard-codes a
game or leaderboard, so switching backends (e.g. from a dev project to a production one, or to a
fresh leaderboard) is purely a matter of updating `.env`:

| Variable                          | What it targets                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `VITE_LOOTLOCKER_GAME_KEY`        | The LootLocker game's public API key (`dev_…` or `prod_…`). Safe to ship in the bundle. |
| `VITE_LOOTLOCKER_LEADERBOARD_KEY` | The key of the leaderboard within that game to submit to and read from.                 |
| `VITE_LOOTLOCKER_GAME_VERSION`    | Version string sent with the guest session (defaults to `0.1.0`).                       |

To repoint the leaderboard:

1. In the [LootLocker dashboard](https://console.lootlocker.com), pick (or create) the target
   game and enable the **Guest** login platform — anonymous sessions won't open without it.
2. Create a **generic** leaderboard in that game (submissions carry an explicit `member_id`, so
   the leaderboard must be the generic type, not player-scoped) and copy its key.
3. Put the game's API key and that leaderboard key into `.env` as the two variables above.
4. Restart the dev server (or rebuild). Vite inlines env vars at build time, so changes to
   `.env` only take effect on the next `npm run dev` / `npm run build` — a running server won't
   pick them up.

The API host (`https://api.lootlocker.io/game`) and the number of rows fetched
(`GLOBAL_TOP_N`) live as constants in `src/systems/GlobalScores.ts`; change those there if you
need to target a different host or list length.

## Gameplay

The main game screen features a centered grid of dice, starting with a single die, and a "Roll"
button below it. The HUD (round / roll / score / target) lays out as a row across the top in
landscape and shrinks into a stacked column in the top-left in portrait. It shows:

- The current score
- The current roll count, out of the round's roll count (20 by default, raised by Overtime and Metronome)
- The target score for the current round
- The current round count

An **Inventory** link opens an overlay of every item bought this run (as cards, with a copy-count
badge on stacked items), and a **Settings** link opens the settings panel mid-run.

Dice are shaped by their side count, so the grid reads at a glance: d1/d2 render as coins, d4 as
a triangle, d6 as the classic square, d8/d10 as an octagon, and d20/d100 as a hexagonal d20
shape. Only d6 shows pips; every other die shows its numeral. During the roll animation a die
only flickers through values up to its own side count, and newly added dice spawn showing their
max face instead of appearing blank.

The grid has no practical limit on dice count — as more dice are added, the whole grid scales
itself down ("shrinks out") to keep every die visible on screen.

A round is 20 rolls by default. Extra rolls granted by Overtime and Metronome are appended to
the end of the round, so a round can run past 20; shop visits stay pinned to the 5th and 15th
rolls regardless. Surviving a round clears the score back to 0 (unless the player owns Vault or
Reserve, which carry a fraction over). Clearing round 10 ends the run in victory.

### Scoring

Each roll is scored as a stack of modifiers (`src/systems/Scoring.ts`), so new rules are added
by pushing another modifier rather than threading a new field through the scene:

- **Scoring** — each die showing a scoring number (1, plus 2 and 3 from Extra Number) or a wild
  face is worth 1 point, +1 per Extra Point owned, and +1 per Keen Edge owned when it's a d1.
- **Snake Eyes** — any value shown by 2+ dice scores that value once (needs the item).
- **Jackpot** — any value shown by 4+ dice scores value × count, per Jackpot owned (item).
- **Windfall** — a Rollplayer/Centurion die's current highest face always scores and applies
  that card's ×2/×4 roll multiplier; shrinking the die makes the effect more likely.
- **Momentum** — adds the current consecutive-scoring-roll streak as points, per Momentum owned.

The subtotal is then multiplied by a single run multiplier: Amplifier ×2, Prism ×3 per copy,
and Last Call ×3 per copy on the final roll of a round — all compounding.

Two passives fire at the **start** of each round (`applyRoundStart`): Dividend grants points per
5 dice owned, and Foundry adds copies of the smallest die.

## The shop

A shop is encountered every 10 rolls, on the 5th and 15th rolls, after the roll. The shop
replaces the dice grid and the button, and offers 3 item cards for the player to choose from
(5 once the player owns Ledger). The cards sit in a horizontally scrollable carousel —
drag/swipe, mouse wheel, or the scrollbar — so they stay full size and readable instead of
shrinking to cram into a narrow (portrait) screen; the carousel only appears once the cards
don't already fit. The player can purchase a single item. If nothing is affordable, the free
Two Bricks is guaranteed onto a card so the shop is never a dead screen.

### Dynamic pricing

Item prices scale with the current round instead of staying fixed while targets grow. Each item
has a strength band, and the shop resolves its concrete price from the current survival target:

```text
price = round target × strength rate × shop timing × repeat multiplier × market variation
```

| Strength band  | Target rate | First-copy minimum |
| -------------- | ----------: | -----------------: |
| Low            |          3% |            1 point |
| Standard       |          6% |            1 point |
| Strong         |         10% |           2 points |
| Build-defining |         15% |           3 points |

Two Bricks is the sole free item and remains the guaranteed fallback. Prices at the second shop
(after roll 15) are 25% lower because fewer rolls remain in the current round. Repeatable
effects become more expensive for each copy already bought: ordinary linear stacks grow by
1.35× per copy, while multipliers and explosive grid-growth effects grow by 1.8× per copy.
Single-time items have no repeat multiplier. Every non-free card also rolls a market adjustment
from −25% to +25%, in whole-percentage steps, each time it appears. This overlap makes price an
imperfect signal of power: a stronger item can be discounted below a weaker offer, and the most
expensive card is not automatically the best choice. Live shop cards show both the strength
band beside rarity and the resolved price, so the player can recognize a discount or markup.

Resolved prices round upward to readable values: whole points below 10, multiples of 5 below
100, multiples of 25 below 1,000, and multiples of 100 thereafter. For example, a first-copy
Strong item costs 2 points against round 2's target of 19, 45 points against round 6's target
of 420, and 3,300 points against round 10's target of 33,000 at the first shop before that
visit's market adjustment.

The bands are informed by the simulator's per-item point attribution, with lifetime totals
treated as supporting evidence rather than converted directly into prices. Raw totals are
highly skewed by exponential winning builds and miss indirect value from items such as Ledger,
Metronome, Shrink Die, and Vault. Balance passes should therefore read contribution rankings
alongside purchase/win correlation and matched runs, then tune the four global rates before
hand-editing individual bands.

### Rarity

Every item belongs to one of three rarity tiers, shown by card colour:

| Tier     | Colour | Draw weight |
| -------- | ------ | ----------- |
| Common   | Yellow | 60%         |
| Uncommon | Blue   | 30%         |
| Rare     | Purple | 10%         |

Rarity controls how often an item is offered; price band controls how much score it risks.
They are intentionally independent.

Draw rules:

- Each card in a shop rolls its tier independently against the 60/30/10 weights, then picks an
  item from that tier.
- Cards are drawn without replacement, so one shop never offers duplicates.
- An item is only eligible if it has a legal effect (see gating below). If a rolled tier has no
  eligible items left, fall back toward common first, then to whatever tier still has items.

### Common (yellow)

| Item          | Price band     | Effect                                                                                             |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| Two Bricks    | Free           | Adds two d6 to the grid                                                                            |
| Pocket Change | Low            | Gain 2 points on every roll                                                                        |
| Spikes        | Low            | Adds two d4 to the grid                                                                            |
| Shrink Die    | Low            | Shrinks a die of the player's choice two steps: d1 < d2 < d4 < d6 < d8 < d10 < d20 < d100          |
| Whetstone     | Low            | Each roll, a 10% chance to shrink a random die one step                                            |
| Twins         | Strong         | Choose a die; duplicate every die of its size                                                      |
| Overtime      | Low            | +2 rolls, appended to the end of this round only                                                   |
| Dividend 🔒   | Build-defining | On every roll, gain 1 point for every 3 dice owned. **Unlockable**                                 |
| Momentum 🔒   | Standard       | Each consecutive scoring roll adds +2 to points earned; a scoreless roll resets it. **Unlockable** |
| Keen Edge 🔒  | Standard       | Each d1 scores +2 when it scores (a d1 is worth 3). **Unlockable**                                 |

### Uncommon (blue)

| Item              | Price band     | Effect                                                                                                                  |
| ----------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Chips             | Low            | Adds two d2 to the grid                                                                                                 |
| Extra Dice        | Standard       | Adds d6 equal to a quarter of the grid (at least 5)                                                                     |
| Rollplayer        | Standard       | Adds a d20; its highest face always scores and doubles all points that roll                                             |
| Multiply Dice ×2  | Strong         | Doubles the number of dice                                                                                              |
| Metronome         | Standard       | +1 roll every round, appended to the end, permanent                                                                     |
| Grindstone        | Standard       | Choose a die; shrink every die of its size two steps                                                                    |
| Loaded Die        | Standard       | Choose a die; every die of its size never rolls its two highest faces, now and later                                    |
| Snake Eyes        | Strong         | When 2 or more dice show the same number, score that number × the dice showing it (per number, per roll)                |
| Ledger            | Standard       | The shop offers 5 cards from now on                                                                                     |
| Double the Fun 🔒 | Build-defining | Whenever any die rolls a 5 or 6, add another copy of that die to the grid. **Unlockable**                               |
| Foundry 🔒        | Strong         | At the start of each round, add 5 copies of the smallest die. **Unlockable**                                            |
| Jackpot 🔒        | Build-defining | When 3+ dice show the same face, score that face × the number of dice showing it (each face separately). **Unlockable** |
| Last Call 🔒      | Build-defining | Points earned on the final roll of each round are quadrupled. **Unlockable**                                            |

### Rare (purple)

| Item             | Price band     | Effect                                                                                            |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| Extra Point      | Standard       | Adds +1 per scoring die                                                                           |
| Multiply Dice ×3 | Build-defining | Triples the number of dice                                                                        |
| Extra Number     | Strong         | Provides points on an additional number. Stacks 2, then 3, then 4, then can't show up anymore     |
| Amplifier        | Build-defining | Doubles all points earned from rolls                                                              |
| Refinement       | Standard       | Shrinks every die two steps                                                                       |
| Wild Face        | Strong         | Choose a die; every die of its size scores on every face, now and later                           |
| Centurion        | Strong         | Adds a d100; its highest face always scores and quadruples all points that roll                   |
| Vault            | Standard       | Keep 33% of your points (rounded down) when a round clears                                        |
| Genesis 🔒       | Build-defining | Whenever a die scores, add a copy of that die to the grid (max +20 dice per roll). **Unlockable** |
| Reserve 🔒       | Strong         | Keep 75% of your points (rounded down) when a round clears. **Unlockable**                        |
| Prism 🔒         | Build-defining | Triples all points earned from rolls (multiplies with Amplifier). **Unlockable**                  |

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
appear again for the rest of the run. These are Snake Eyes, Ledger, Amplifier, Vault, and
Double the Fun. Everything else can be bought repeatedly and stacks — the stacking passives
(Pocket Change, Whetstone, Dividend, Momentum, Keen Edge, Foundry, Jackpot, Last Call, Genesis,
Reserve, Prism) compound per copy owned.

## Unlocks and the Codex

Most items are available from the very first run. Some are **locked** behind an achievement and
never appear in the shop until the player has earned them. An unlock is permanent: once met, the
item is offered starting with the next run and can never be re-locked (short of resetting all
progress).

Unlock progress is meta-progression: it lives in `localStorage` (key `ooo_progress_v1`), separate
from the ephemeral per-run state, so it survives reloads and carries across runs.

Currently unlockable:

| Item           | Unlock criterion                                        |
| -------------- | ------------------------------------------------------- |
| Dividend       | Reach round 6                                           |
| Momentum       | Score on 12 rolls in a row (in one run)                 |
| Keen Edge      | Hold 10 or more d1 at once                              |
| Foundry        | Hold more than 29 dice in your grid at once             |
| Double the Fun | Hold more than 1000 dice in your grid at once           |
| Jackpot        | Show the same number on 6 or more dice in a single roll |
| Last Call      | Clear a round on its final roll                         |
| Genesis        | Reach round 10                                          |
| Reserve        | Reach 2× the current round's target score               |
| Prism          | Win a run (clear all 10 rounds)                         |

Criteria are checked live during a run, so a banner announces an unlock as soon as its threshold
is crossed. Each run snapshots its eligible card pool when it begins, so newly unlocked cards
first appear in the next run. The criteria engine is data-driven (`src/systems/Items.ts` —
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
player's first run, a **callout tutorial** walks through the score, roll, target, roll count,
round, and shop in sequence; it self-disables after one run and can be re-enabled from Settings.

The Hall of High Scores shows the top runs, each with:

- The date the run was started, short format
- The round the player reached (and whether the run was a win)
- The total score accumulated across the run
- The grid of dice they ended with

Settings controls:

- Volume of music
- Volume of sound effects
- Show Intro
- Show Tutorial
- Fullscreen
- Abandon Run (mid-run only) — ends and records the current run as a loss, then shows Game Over
- Reset all progress (from the menu) — wipes item unlocks, Codex selection counts, games-completed,
  and the Hall of High Scores (audio settings are kept); a two-tap confirm guards it

## Balance simulation

`src/sim` is a headless bot that plays full runs to gather balance statistics — win rates, where
runs die, what gets bought, and how likely each gated item is to unlock — and writes a
self-contained HTML report. It reuses the game's real economy end to end (scoring, shop,
round-start passives) through a shared round-loop engine that `GameScene` also uses, so results
reflect the live rules. Run it with `npm run sim`; see `src/sim/README.md` for flags and details.

## License

Released under the [MIT License](LICENSE).
