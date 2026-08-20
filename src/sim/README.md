# Balance simulation

A headless bot that plays full runs of The Order of Order to gather balance
statistics — win rates, where runs die, what gets bought, how gold is earned and
spent, how often each Boss Trial modifier is beaten, and how likely each gated
item is to unlock during play — and writes a self-contained HTML report.

The bot reuses the game's real economy end to end (`scoreRollHistogram`,
`applyOffer`, booster generation/selection, `applyTrialStart`, the shop) through a shared trial-loop engine
(`engine.ts`) that `GameScene` also uses, so results reflect the live rules
rather than a re-implementation.

That includes the gold economy. Every simulated shop resolves its prices from the
item's strength band, the copies already bought, that visit's −25%…+25% market
adjustment, and any discount items the run owns; the bot pays for its rerolls;
the two booster types stay fixed while loose cards reroll; each bot may buy one
pack per visit and chooses its strongest suitable reveal; and clearing a trial
pays it the same gold a player would earn. The shared rates
live in `systems/Shop.ts` and `systems/Gold.ts`; item bands, stacking and build
themes live beside their effects in `systems/Items.ts`.

## Run it

```bash
npm run sim                      # defaults from config.ts → sim-out/report.html
npm run sim -- --runs=5000       # more runs = tighter numbers (slower)
npm run sim -- --seed=42         # reproducible; same seed → same report
npm run sim -- --out=sim-out/base-only.html
```

Open the resulting `sim-out/report.html` in any browser (no server needed).

## Strategies compared

Nine series, chosen so the field resembles how the game is actually played
rather than bracketing it. There is no "never buy" baseline: with gold split out
from score, hoarding it forever buys nothing, so a no-buy run measures a game
nobody is playing.

**Price-driven** — these bracket how far a purse stretches, and each runs against
both the base pool and the fully unlocked one on a matched seed stream:

- **Greedy** — spends everything, most expensive affordable card first.
- **Thrifty** — spends everything, cheapest first, maximising card count.

**Themed** — each chases one build archetype, with the full unlock pool (roughly
half of every theme is gated, so a base-pool themed bot would just be a worse
price-driven bot). Their spread is the signal for whether every archetype is
viable:

- **Swarm** — grow the grid.
- **Multiplier** — compound the run multiplier.
- **Precision** — make each die score more often.
- **Economy** — build the purse.
- **Tempo** — more rolls, and safety nets.

Themed bots prefer a matching booster and take their own loose cards cheapest-first, then spend what is left on
anything affordable — a visit with no in-theme card would otherwise sit on its
gold and read as a broken strategy rather than an unlucky shop. Each also keeps a
`goldFloor` banked to earn interest; the economy bot keeps a full interest bar,
which is its whole build. Theme membership is a total `Record` in
`systems/Items.ts` (`ITEM_THEMES`), so adding an item without theming it is a
compile error.

## Designing the goal curve

`tuneCurve.ts` is the one to use. It is a fixed-point iteration against REAL
culling: simulate the whole field under the current curve, re-pick every goal as
the quantile of the peak scores of the runs that actually entered that trial,
repeat. Survivors get richer each pass, so the curve tightens until the win rate
settles on the intended one.

```bash
npx tsx src/sim/tuneCurve.ts                # RUNS / ITERATIONS via env
CURVE="TUNED (real culling)" npx tsx src/sim/validate.ts
npx tsx src/sim/endlessCurve.ts
```

`designTargets.ts` is the older approach and is kept for reference: it designs
from one non-culling pass, where an unreachable goal and `setCulling(false)` let
every run play all fifteen trials to the end of its roll budget. That measures
capacity honestly but income dishonestly — with no clears, no trial pays for
rolls left in hand and no Boss Trial pays its bonus — so its builds are poorer
than real ones and its curve lands far too easy. Its first pass designed a 23%
win rate that measured 65% under real culling.

`validate.ts` re-tests a named curve from `sim-out/candidate.json` with real
culling, prints the per-trial attrition and the per-modifier Boss Trial clear
rates, and regenerates the report. `endlessCurve.ts` projects the strongest
builds forward to confirm the endless ladder eventually outruns all of them.

## Assertion suites

```bash
npm run items:check      # item mechanics, including every boss modifier
npm run trials:check     # the trial loop: clears, advances, ranks, endings
npm run gold:check       # payouts, interest, prices, rerolls, discounts
npm run scoring:check    # the two scorers agree, per-die vs bucketed
```

`scoring:check` is the safety net for anything that touches scoring: the live
histogram scorer and the per-die reference implementation must produce identical
totals, boss modifiers included.

## Configuring auxiliary runs — `config.ts`

`DEFAULT_CONFIG` holds the knobs; CLI flags override `runs`, `seed`, `out`. Each
series builds its own config through `seriesConfig()` so it gets its own unlock
pool — passing the shared config straight to `simulateRun` silently gives every
series the full pool, which makes the base/all comparison measure nothing.

`DEFAULT_CONFIG.unlockedAtStart` remains available to auxiliary analysis scripts
that run a single configured pool:

```ts
unlockedAtStart: []; // base items only
unlockedAtStart: ["dividend", "momentum"]; // base + two candidates
```

This only changes what the shop _offers_. Unlock likelihood is measured for
**all** gated items regardless, so you always see how reachable each card's
unlock is.

Grid-growing builds (Double the Fun, Genesis, multiply) let the dice pool grow
without bound; the sim runs the real scoring path over it, which stays cheap
because the pool flips to bucket mode (`O(buckets × faces)`, not per-die) once it
crosses the bucket threshold.

## Files

| File                  | Role                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `engine.ts`           | Pure trial-loop rules shared with `GameScene` (roll → score → grow, trial-end win/lose/advance). |
| `bot.ts`              | Strategies, die-target selection, `simulateRun`, per-run unlock and boss tracking.               |
| `stats.ts`            | Aggregates `RunRecord[]` into the report's numbers.                                              |
| `report.ts`           | Renders `BatchStats` to one self-contained HTML file (inline SVG charts).                        |
| `config.ts`           | `DEFAULT_CONFIG` + the editable `unlockedAtStart`.                                               |
| `series.ts`           | The nine series, their seed offsets, and `seriesConfig`.                                         |
| `localStorageShim.ts` | In-memory `localStorage` + seeded `Math.random` for Node/reproducibility.                        |
| `runBatch.ts`         | CLI entry (`npm run sim`).                                                                       |
| `tuneCurve.ts`        | Fixed-point goal-curve tuner against real culling.                                               |
| `designTargets.ts`    | Older single-pass curve designer, kept for reference.                                            |
| `validate.ts`         | Re-test a candidate curve with real culling; prints boss clear rates.                            |
| `endlessCurve.ts`     | Confirms the endless ladder terminates.                                                          |
| `itemCheck.ts`        | Item + boss-modifier assertions.                                                                 |
| `trialEndCheck.ts`    | Trial-loop assertions.                                                                           |
| `goldCheck.ts`        | Gold-economy assertions.                                                                         |
| `compareScoring.ts`   | Per-die vs histogram scorer parity + perf timing.                                                |
