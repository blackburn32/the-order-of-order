# Balance simulation

A headless bot that plays full runs of The Order of Order to gather balance
statistics — win rates, where runs die, how long each trial takes to clear, what
gets bought, how gold is earned and spent, how often each Boss Trial modifier is
beaten, and how likely each gated item is to unlock during play — and writes a
self-contained HTML report.

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

### Reading the report

Most of it is self-explanatory, with one section worth calling out. **Rolls spent
per trial** answers a question attrition cannot: not whether a goal kills the
right share of runs, but whether the survivors had to play the trial to get past
it. It plots, for each trial, the share of the roll budget spent before the goal
was crossed — cleared trials only, since a trial a run died on always burned its
whole budget — against a 70% design target, and the table beneath it pools the
same numbers across strategies alongside the share of clears that landed on the
opening roll. A flat line along the bottom of that chart is a trial whose roll
budget is decoration, and it is the shape the goal curve is tuned to avoid. Each
strategy tile also carries `rolls per clear` and `cleared on roll 1`.

Per-trial roll traces are what the goal tuner designs from; they are recorded
only when `SimConfig.traceRolls` is set, since a number per roll per trial per
run is far too much memory for a full batch to carry by default.

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

`pacingCurve.ts` is the one to use. It designs each goal from what the field
**could** score rather than from what the old goal let it score, and it reports
the roll tempo the goal buys.

The distinction is the whole point. A trial ends the instant its goal is met, so
the peak scores a run records are capped by the goal being replaced: measure
those and an easy curve looks like a correct one, because every peak reads as "a
hair over the goal". So the tuner replays the field one trial at a time with that
trial — and only that trial — playing its whole roll budget out (the engine's
`setFullBudgetTrial`), and takes the goal as the quantile of THAT distribution
which leaves `CLEAR` of the entrants able to reach it. One trial rather than all
of them, because the grid grows per roll and never resets between trials: a pass
that played every trial out would hand trial 20 a grid no real run could arrive
with. Trials are designed front to back, so each rank is measured against the
shops the ranks before it could actually afford.

```bash
node node_modules/tsx/dist/cli.mjs src/sim/pacingCurve.ts
RUNS=800 CLEAR=0.90 FROM=4 node node_modules/tsx/dist/cli.mjs src/sim/pacingCurve.ts
CURVE=PACED node node_modules/tsx/dist/cli.mjs src/sim/validate.ts
```

| env               | default | what it does                                                 |
| ----------------- | ------- | ------------------------------------------------------------ |
| `CLEAR`           | 0.90    | share of a trial's entrants that should be able to clear it  |
| `BOSS_CULL_SCALE` | 1.5     | how much harder a Boss Trial culls than the two before it    |
| `FROM`            | 7       | first trial to redesign; earlier ones keep their goals       |
| `MIN_SAMPLE`      | 250     | stop measuring below this many entrants, continue by formula |
| `RUNS`            | 400     | runs per series per trial                                    |

**`CLEAR` is the only real control, and tempo is a readout, not a second knob.**
A goal is one number, so its attrition fixes it, and the tempo it produces is
whatever the field's spread makes it. A trial's full-budget capacity runs about a
thousandfold from the field's tenth percentile to its ninetieth, so any goal the
weakest tenth survives is met on the opening roll by the strongest tenth.
`pacingSweep.ts` prints that trade-off directly — for a given trial, what every
attrition target costs in rolls — and is the thing to read before moving `CLEAR`:

```bash
TRIALS=5,11,17,23 node node_modules/tsx/dist/cli.mjs src/sim/pacingSweep.ts
```

`validate.ts` re-tests a curve with real culling and prints the per-trial
attrition, the roll pacing, and the per-modifier Boss Trial clear rates, then
regenerates the report. `CURVE=LIVE` re-tests the curve `src/config.ts` actually
ships, which is how a hand-edited `TRIAL_GOALS` is measured without a round trip
through `candidate.json`. `endlessCurve.ts` projects the strongest builds forward
to confirm the endless ladder eventually outruns all of them.

`tuneCurve.ts` and `designTargets.ts` are the older approaches, superseded and
kept for reference. `tuneCurve` iterates against real culling but reads the
censored peaks described above, so it cannot raise a goal past the goal it is
replacing. `designTargets` designs from one non-culling pass, which measures
capacity honestly but income dishonestly — with no clears, no trial pays for
rolls left in hand and no Boss Trial pays its bonus — so its builds are poorer
than real ones and its curve lands far too easy.

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
| `pacingCurve.ts`      | The goal-curve tuner: designs from uncensored capacity, reports roll tempo.                      |
| `pacingSweep.ts`      | What every attrition target costs in rolls, for one trial. Read before moving `CLEAR`.           |
| `tuneCurve.ts`        | Superseded. Fixed-point tuner against censored peaks.                                            |
| `designTargets.ts`    | Superseded. Single-pass curve designer.                                                          |
| `validate.ts`         | Re-test a curve with real culling; prints attrition, roll pacing and boss clear rates.           |
| `endlessCurve.ts`     | Confirms the endless ladder terminates.                                                          |
| `itemCheck.ts`        | Item + boss-modifier assertions.                                                                 |
| `trialEndCheck.ts`    | Trial-loop assertions.                                                                           |
| `goldCheck.ts`        | Gold-economy assertions.                                                                         |
| `compareScoring.ts`   | Per-die vs histogram scorer parity + perf timing.                                                |
