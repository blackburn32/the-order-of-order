# The Order of Order
The Order of Order is an incremental roguelike game built around rolling dice. 
The player will attempt to roll a specific number, earning points when they do.
The points can be spent in a store for upgrades.
The player must meet score thresholds at the end of every round (20 rolls) to ensure they survive, if they do not meet the threshold their run ends. Surviving a round clears the score back to 0, so
banked points must be spent in the shop before the round ends or they're lost.

The game is built using Phaser 4 (TypeScript + Vite). Rolling a **1** scores; "Extra number"
upgrades add 2, 3, 4, 5, 6 as scoring faces. Score and shop currency are one pool, so every
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

`npm run dev` also loads a small dev-only panel (top-right, collapsible with the "DEV" button
or the `` ` `` key) for setting the run's dice count/composition instantly, without playing
through the shop — handy for testing the grid at scale. It's compiled out of `npm run build`
entirely (gated on `import.meta.env.DEV`), so it never ships.

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

The grid has no practical limit on dice count. Up to ~1,500 dice it scales itself down
("shrinks out") to keep every die visible on screen at once. Past that it switches to a
fixed-size scrollable/zoomable window (drag to pan, scroll to zoom) instead of continuing to
shrink dice into illegible specks — only the dice currently in view are ever actually rendered,
so the grid stays fast regardless of whether the run has a thousand dice or a million. The
shrink-die shop card follows the same threshold: past it, dice are grouped by type ("×50,000
d6") rather than listed individually, since huge stacks of identical dice are indistinguishable
anyway.
A small GUI should show:
- The current score
- The current roll count, out of 20
- The target score for the current round
- The current round count

A shop is encountered every 10 rolls, on the 5th and 15th rolls, after the roll.
The shop replaces the dice grid and the button.
The shop should show 3 item cards for the player to choose from.
The cards sit in a horizontally scrollable carousel — drag/swipe, mouse wheel, or the
scrollbar — so they stay full size and readable instead of shrinking to cram into a narrow
(portrait) screen; the carousel only appears at all once the cards don't already fit.
The player can purchase a single item.
The cards each cost 0~3 points, and grant one of the following:
- Extra die (0 pt) - +1 dice
- Extra dice (1 pt) - +3 dice
- Extra point (1 pt) - Adds +1 each time your roll gives you points
- Extra number (3 pt) - Provides points on an additional number. Stacks 2,3,4,5,6 then can't show up anymore
- Multiply dice x2 (2 pt) - Doubles the number of dice
- Multiply dice x3 (3 pt) - Triples the number of dice
- Shrink die (1 pt) - Shrinks a die of the player's choice one step: 1d1 < 1d2 < 1d4 < 1d6 < 1d8 < 1d10 < 1d20 < 1d100
- Rollplayer (1 pt) - Adds a d20 to the grid, rolling 20 grants 20 points
- Spike (1 pt) - Adds a d4 to the grid

## Other screens

The game should also have a simple menu with options:
- Start new run
- Hall of High Scores
- Settings

The Hall of High Scores should show a list of high scores with:
- The date the run was started, short format
- The round that the player made it to
- the grid of dice they ended with

The settings menu should control
- Volume of music
- Volume of sound effects
- Fullscreen