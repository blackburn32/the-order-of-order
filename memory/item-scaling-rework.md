---
name: item-scaling-rework
description: Late-game item fall-off rework — what changed and the pending balance retune
metadata:
  type: project
---

Reworked items that "fell off" late game (flat effects vs. a multiplicatively-scaling grid) so they scale. Done 2026-07-22.

- **Rollplayer/Centurion**: windfall is now a roll-wide **multiplier** (d20→×2, d100→×4, bounded per distinct size, max ×8), folded into the run multiplier — not flat `sides×2` points. See `windfallFactor` in Dice.ts; `windfallMult` in DiceAgg; attribution via WINDFALL_ITEM in ItemPoints.
- **Loaded Die / Wild Face**: now target a **size** and apply to the whole size + future dice, via run-level auras `state.loadedSizes` / `state.wildSizes` (merged in `withSizeAuras` on dice adds). Twin/Grindstone also size-wide (`twinAllOfSize`/`shrinkAllOfSize` in DicePool).
- **Extra Dice**: proportional add (`addDiceProportional`, 25% of grid, min 5). **Foundry**: round-start add scaled to 5% of grid (min 5).
- **Shop hygiene**: flat starters (chip, spike, pocket_change, shrink) gated by `smallGrid` (grid < STARTER_GRID_CAP=75); Two Bricks (`extra_die`) exempt (shop fallback).

**Why:** flat/additive effects are noise against a grid that grows multiplicatively; only per-grid or multiplier effects stay relevant.

**Balance retune completed 2026-07-23:** the apparent score inflation was primarily a simulator bug that let bots buy every affordable card in a shop instead of one. After fixing shopping and pooling Random/Greedy across base-only and all-unlocked item pools, `designTargets.ts` generated `[3, 19, 62, 110, 200, 420, 920, 2400, 7400, 33000]`. Real-culling validation measured 59.2% alive after round 3, roughly 5 percentage points culled in rounds 4–9, and a 21.3% pooled win rate. Parity gate: `npx tsx src/sim/compareScoring.ts` must stay ALL MATCH. Related: [[MEMORY]].
