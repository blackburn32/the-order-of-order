# The Order of Order

The Order of Order is an incremental roguelike built around rolling dice. The player rolls a
grid of dice trying to hit specific numbers, earning points when they do. Those points are also
the shop's currency, so every purchase is a gamble. The player must meet a score threshold at
the end of every round (20 rolls) to survive; falling short ends the run. Surviving a round
clears the score back to 0, so banked points must be spent in the shop before the round ends or
they're lost — unless the player owns a carryover item (Vault keeps 20%, Reserve keeps 50%).
Clearing **all 20 rounds** wins the game.

The game is built with Phaser 4 (TypeScript + Vite). Rolling a **1** scores; "Extra Number"
upgrades add 2 and then 3 as scoring faces. Score and shop currency are one pool, so every
purchase is weighed against the round threshold. The per-round survival targets are a
hand-authored table (`ROUND_TARGETS` in `src/config.ts`), tuned with the balance simulation
in `src/sim` so runs end across the whole game rather than being decided in the first few
rounds; the legacy geometric formula (`ceil(5 × 1.85^(round−1))`) survives only as a fallback
for rounds beyond the authored table.

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
Reserve, which carry a fraction over). Clearing round 20 ends the run in victory.

### Scoring

Each roll is scored as a stack of modifiers (`src/systems/Scoring.ts`), so new rules are added
by pushing another modifier rather than threading a new field through the scene:

- **Scoring** — each die showing a scoring number (1, plus 2 and 3 from Extra Number) or a wild
  face is worth 1 point, +1 per Extra Point owned, and +1 per Keen Edge owned when it's a d1.
- **Snake Eyes** — any value shown by 2+ dice scores that value once (needs the item).
- **Jackpot** — any value shown by 4+ dice scores value × count, per Jackpot owned (item).
- **Windfall** — a max-face-bonus die (Rollplayer, Centurion) that rolls its top face scores its
  full size.
- **Momentum** — adds the current consecutive-scoring-roll streak as points, per Momentum owned.

The subtotal is then multiplied by a single run multiplier: Amplifier ×2, Prism ×3 per copy,
and Last Call ×3 per copy on the final roll of a round — all compounding.

Two passives fire at the **start** of each round (`applyRoundStart`): Dividend grants points per
5 dice owned, and Foundry adds copies of the smallest die.

## The shop

A shop is encountered every 10 rolls, on the 5th and 15th rolls, after the roll. The shop
replaces the dice grid and the button, and offers 3 item cards for the player to choose from
(4 once the player owns Ledger). The cards sit in a horizontally scrollable carousel —
drag/swipe, mouse wheel, or the scrollbar — so they stay full size and readable instead of
shrinking to cram into a narrow (portrait) screen; the carousel only appears once the cards
don't already fit. The player can purchase a single item. If nothing is affordable, the free
Extra Die is guaranteed onto a card so the shop is never a dead screen.

### Rarity

Every item belongs to one of three rarity tiers, shown by card colour:

| Tier | Colour | Draw weight |
|---|---|---|
| Common | Yellow | 60% |
| Uncommon | Blue | 30% |
| Rare | Purple | 10% |

Rarity is about power and swing, not price — a 1 pt Common and a 1 pt Rare can share a price
tag and be very different cards.

Draw rules:
- Each card in a shop rolls its tier independently against the 60/30/10 weights, then picks an
  item from that tier.
- Cards are drawn without replacement, so one shop never offers duplicates.
- An item is only eligible if it has a legal effect (see gating below). If a rolled tier has no
  eligible items left, fall back toward common first, then to whatever tier still has items.

### Common (yellow)

| Item | Cost | Effect |
|---|---|---|
| Extra Die | 0 pt | Adds one d6 to the grid |
| Pocket Change | 0 pt | Gain 2 points immediately |
| Spike | 1 pt | Adds a d4 to the grid |
| Shrink Die | 1 pt | Shrinks a die of the player's choice one step: d1 < d2 < d4 < d6 < d8 < d10 < d20 < d100 |
| Whetstone | 1 pt | Shrinks a random die one step |
| Twin | 1 pt | Duplicates a die of the player's choice, same size |
| Overtime | 1 pt | +1 roll, appended to the end of this round only |
| Dividend 🔒 | 1 pt | At the start of each round, gain 1 point for every 5 dice owned. **Unlockable** |
| Momentum 🔒 | 1 pt | Each consecutive scoring roll adds +1 to points earned; a scoreless roll resets it. **Unlockable** |
| Keen Edge 🔒 | 1 pt | Each d1 scores +1 when it scores (a d1 is worth 2). **Unlockable** |

### Uncommon (blue)

| Item | Cost | Effect |
|---|---|---|
| Chip | 0 pt | Adds a d2 to the grid |
| Extra Dice | 1 pt | Adds three d6 to the grid |
| Rollplayer | 1 pt | Adds a d20; rolling 20 grants 20 points |
| Multiply Dice ×2 | 2 pt | Doubles the number of dice |
| Metronome | 2 pt | +1 roll every round, appended to the end, permanent |
| Grindstone | 2 pt | Shrinks 3 dice of the player's choice one step each |
| Loaded Die | 2 pt | Choose a die; it never rolls its highest face |
| Snake Eyes | 2 pt | When 2 or more dice show the same number, score that number (once per number, per roll) |
| Ledger | 2 pt | The shop offers 4 cards from now on |
| Double the Fun 🔒 | 1 pt | Whenever any die rolls a 6, add another copy of that die to the grid. **Unlockable** |
| Foundry 🔒 | 2 pt | At the start of each round, add 3 copies of the smallest die. **Unlockable** |
| Jackpot 🔒 | 2 pt | When 4+ dice show the same face, score that face × the number of dice showing it (each face separately). **Unlockable** |
| Last Call 🔒 | 2 pt | Points earned on the final roll of each round are tripled. **Unlockable** |

### Rare (purple)

| Item | Cost | Effect |
|---|---|---|
| Extra Point | 1 pt | Adds +1 per scoring die |
| Multiply Dice ×3 | 3 pt | Triples the number of dice |
| Extra Number | 3 pt | Provides points on an additional number. Stacks 2, then 3, then can't show up anymore |
| Amplifier | 3 pt | Doubles all points earned from rolls |
| Refinement | 3 pt | Shrinks every die one step |
| Wild Face | 3 pt | Choose a die; it scores on every face |
| Centurion | 3 pt | Adds a d100; rolling 100 grants 100 points |
| Vault | 3 pt | Keep 20% of your points (rounded down) when a round clears |
| Genesis 🔒 | 3 pt | Whenever a die scores, add a copy of that die to the grid (max +10 dice per roll). **Unlockable** |
| Reserve 🔒 | 3 pt | Keep 50% of your points (rounded down) when a round clears. **Unlockable** |
| Prism 🔒 | 3 pt | Triples all points earned from rolls (multiplies with Amplifier). **Unlockable** |

### Gating

An item is only offered when it can actually do something:
- Shrink Die, Whetstone, Grindstone, Refinement — require at least one die above d1
  (Grindstone requires 3).
- Loaded Die — requires a die that isn't already loaded.
- Keen Edge — requires at least one d1 in the grid.
- Extra Number — stops appearing once the face 3 has been added.

Some items are **single-time**: a second copy would do nothing, so once bought they never
appear again for the rest of the run. These are Snake Eyes, Ledger, Amplifier, Vault, and
Double the Fun. Everything else can be bought repeatedly and stacks — the stacking passives
(Dividend, Momentum, Keen Edge, Foundry, Jackpot, Last Call, Genesis, Reserve, Prism) compound
per copy owned.

## Unlocks and the Codex

Most items are available from the very first run. Some are **locked** behind an achievement and
never appear in the shop until the player has earned them. An unlock is permanent: once met, the
item is offered from that moment on — in the current run and every future run — and can never be
re-locked (short of resetting all progress).

Unlock progress is meta-progression: it lives in `localStorage` (key `ooo_progress_v1`), separate
from the ephemeral per-run state, so it survives reloads and carries across runs.

Currently unlockable:

| Item | Unlock criterion |
|---|---|
| Dividend | Reach round 6 |
| Momentum | Score on 12 rolls in a row (in one run) |
| Keen Edge | Hold 10 or more d1 at once |
| Foundry | Hold more than 29 dice in your grid at once |
| Double the Fun | Hold more than 1000 dice in your grid at once |
| Jackpot | Show the same number on 6 or more dice in a single roll |
| Last Call | Clear a round on its final roll |
| Genesis | Reach round 10 |
| Reserve | Reach 2× the current round's target score |
| Prism | Win a run (clear all 20 rounds) |

Criteria are checked live during a run, so crossing a threshold unlocks the item mid-run — a
banner announces it, and it can be offered in that same run's later shops. The criteria engine is
data-driven (`src/systems/Items.ts` — `UnlockCriterion` / `meetsCriterion`), so new unlock
conditions can be added by tagging an item with an `unlock` field.

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
