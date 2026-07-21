# The Order of Order
The Order of Order is an incremental roguelike game built around rolling dice. 
The player will attempt to roll a specific number, earning points when they do.
The points can be spent in a store for upgrades.
The player must meet score thresholds at the end of every round (20 rolls) to ensure they survive, if they do not meet the threshold their run ends. Surviving a round clears the score back to 0, so
banked points must be spent in the shop before the round ends or they're lost.

The game is built using Phaser 4 (TypeScript + Vite). Rolling a **1** scores; "Extra number"
upgrades add 2 and then 3 as scoring faces. Score and shop currency are one pool, so every
purchase is a gamble against the round threshold (`ceil(5 × 1.85^(round−1))`), which climbs
steeply — survival gets much harder round over round.

## Development

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # typecheck + production build to dist/ (deploy anywhere static)
npm run preview  # serve the production build locally
```

All art is drawn procedurally at runtime and all audio is synthesized with WebAudio — the
repo contains no binary assets. Tuning knobs (round targets, shop rules) live in
`src/config.ts`. A Playwright smoke driver is included as a devDependency for headless
playtesting; the game instance is exposed as `window.__game` for that purpose.

The game is responsive and runs in both landscape and portrait, on any window size — the
canvas resizes to fill the page (`Phaser.Scale.RESIZE`) rather than being letterboxed to a
fixed resolution. Every scene lays itself out from `scene.scale.width/height` and rebuilds
its whole display list on resize/orientation-change (see `src/ui/layout.ts`'s `responsive()`
helper), so rotating a device or resizing the browser window reflows the UI live.

## Gameplay

The main game screen features a centered grid of dice, starting with only a single die.
A single button with "Roll" sits below that. The HUD (round/roll/score/target) lays out as a
row across the top in landscape, and shrinks into a stacked column in the top-left in portrait.

Dice are shaped by their side count, so the grid reads at a glance: d1/d2 render as coins,
d4 as a triangle, d6 as the classic square, d8/d10 as an octagon, and d20/d100 as a hexagonal
d20 shape. Only d6 shows pips; every other die shows its numeral. During the roll animation a
die only flickers through values up to its own side count, and newly added dice spawn showing
their max face instead of appearing blank.

The grid has no practical limit on dice count — as more dice are added, the whole grid scales
itself down ("shrinks out") to keep every die visible on screen.
A small GUI should show:
- The current score
- The current roll count, out of the round's roll count (20 by default, raised by Overtime and Metronome)
- The target score for the current round
- The current round count

A round is 20 rolls by default. Extra rolls granted by Overtime and Metronome are appended to
the end of the round, so a round can run past 20; shop visits stay pinned to the 5th and 15th
rolls regardless.

Surviving a round clears the score back to 0 (unless the player owns Vault).

## The shop

A shop is encountered every 10 rolls, on the 5th and 15th rolls, after the roll.
The shop replaces the dice grid and the button.
The shop should show 3 item cards for the player to choose from (4 once the player owns Ledger).
The cards sit in a horizontally scrollable carousel — drag/swipe, mouse wheel, or the
scrollbar — so they stay full size and readable instead of shrinking to cram into a narrow
(portrait) screen; the carousel only appears at all once the cards don't already fit.
The player can purchase a single item.

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
  eligible items left, fall back to the next tier down, then up.

### Common (yellow)

| Item | Cost | Effect |
|---|---|---|
| Extra die | 0 pt | +1 die |
| Pocket Change | 0 pt | Gain 2 points immediately |
| Spike | 1 pt | Adds a d4 to the grid |
| Shrink die | 1 pt | Shrinks a die of the player's choice one step: 1d1 < 1d2 < 1d4 < 1d6 < 1d8 < 1d10 < 1d20 < 1d100 |
| Whetstone | 1 pt | Shrinks a random die one step |
| Twin | 1 pt | Duplicates a die of the player's choice, same size |
| Overtime | 1 pt | +1 roll, appended to the end of this round only |

### Uncommon (blue)

| Item | Cost | Effect |
|---|---|---|
| Chip | 0 pt | Adds a d2 to the grid |
| Extra dice | 1 pt | +3 dice |
| Rollplayer | 1 pt | Adds a d20 to the grid, rolling 20 grants 20 points |
| Multiply dice x2 | 2 pt | Doubles the number of dice |
| Metronome | 2 pt | +1 roll every round, appended to the end, permanent |
| Grindstone | 2 pt | Shrinks 3 dice of the player's choice one step each |
| Loaded Die | 2 pt | Choose a die; it never rolls its highest face |
| Snake Eyes | 2 pt | When 2 or more dice show the same number, score that number (once per number, per roll) |
| Ledger | 2 pt | The shop offers 4 cards from now on |
| Double the Fun 🔒 | 1 pt | Whenever any die rolls a 6, add another copy of that die to the grid. **Unlockable** — see below |

### Rare (purple)

| Item | Cost | Effect |
|---|---|---|
| Extra point | 1 pt | Adds +1 per scoring die |
| Multiply dice x3 | 3 pt | Triples the number of dice |
| Extra number | 3 pt | Provides points on an additional number. Stacks 2, then 3, then can't show up anymore |
| Amplifier | 3 pt | Doubles all points earned from rolls |
| Refinement | 3 pt | Shrinks every die one step |
| Wild Face | 3 pt | Choose a die; it scores on every face |
| Centurion | 3 pt | Adds a d100 to the grid, rolling 100 grants 100 points |
| Vault | 3 pt | Keep 20% of your points (rounded down) when a round clears |

### Gating

An item is only offered when it can actually do something:
- Shrink die, Whetstone, Grindstone, Refinement — require at least one die above d1
  (Grindstone requires 3).
- Loaded Die — requires a die that isn't already loaded.
- Wild Face, Twin — require at least one die.
- Extra number — stops appearing once the face 3 has been added.

Some items are **single-time**: a second copy would do nothing, so once bought they never
appear again for the rest of the run. These are Snake Eyes, Amplifier, Vault, and Ledger.
Everything else can be bought repeatedly and stacks.

## Unlocks and the Codex

Most items are available from the very first run. A few are **locked** behind an achievement and
never appear in the shop until the player has earned them. An unlock is permanent: once met, the
item is offered from that moment on — in the current run and every future run — and can never be
re-locked (short of resetting all progress).

Unlock progress is meta-progression: it lives in `localStorage` (key `ooo_progress_v1`), separate
from the ephemeral per-run state, so it survives reloads and carries across runs.

Currently unlockable:

| Item | Unlock criterion |
|---|---|
| Double the Fun | Hold **more than 1000 dice** in your grid at once (in any single run) |

Criteria are checked live during a run, so crossing the threshold unlocks the item mid-run — a
banner announces it, and it can be offered in that same run's later shops. The criteria engine is
data-driven (`src/systems/Items.ts` — `UnlockCriterion` / `meetsCriterion`), so new unlock
conditions (win a run, reach a round, score N in one round, …) can be added by tagging an item with
an `unlock` field.

### The Codex (Items screen)

A fourth main-menu entry, **Items**, opens the Codex: a scrollable gallery of every shop item as a
card, exactly as it appears in the shop. Under each card is the number of times that item has been
selected from the shop across all runs (dev-panel grants don't count). Items that are still locked
render greyed out, with their name, rarity, cost, and description replaced by `???` and their unlock
hint shown underneath.

The Items button itself stays locked until the player has **completed a single game** (a win or a
loss — including abandoning a run), at which point the Codex becomes available.

## Other screens

The game should also have a simple menu with options:
- Start new run
- Hall of High Scores
- Items (the Codex — locked until the first game is completed)
- Settings

The Hall of High Scores should show a list of high scores with:
- The date the run was started, short format
- The round that the player made it to
- the grid of dice they ended with

The settings menu should control
- Volume of music
- Volume of sound effects
- Fullscreen
- Abandon Run (mid-run only) — ends and records the current run as a loss, then shows Game Over
- Reset all progress (from the menu) — wipes item unlocks, Codex selection counts, and the Hall of
  High Scores (audio settings are kept); a two-tap confirm guards it