# Balance simulation

A headless bot that plays full runs of The Order of Order to gather balance
statistics — win rates, where runs die, how long each trial takes to clear, what
gets bought, which curses are offered and accepted, how gold is earned and
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
npm run curse:check              # appetite 0 vs 1 curse decisions
npm run pacing:feasibility       # survival-vs-duration frontier, no rule changes
npm run benchmark                # your exported runs vs the whole field
npm run expert:tune              # the expert's knobs, swept against those runs
```

Open the resulting `sim-out/report.html` in any browser (no server needed).

**On timing.** The expert series measures every card it considers by rolling it
out, so it costs about 1.3s per run against 0.01s for the other ten — a default
1,000-run batch spends roughly twenty minutes there and seconds everywhere else.
That is the price of having the report contain a shopper that plays well, which
is exactly the blind spot the rest of this file is about. Use `--runs` freely
while iterating; the expert's numbers are steadier per run than the field's,
because it is the one series whose decisions are not mostly luck.

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

**Cursed cards** reports exposure, take rate, and win correlation for every
curse. The bot appraises the real boon and affliction against its current grid,
economy, roll budget, and remaining ladder; all main-series shoppers use a 0.5
appetite, bar the player, whose rule 11 declines every cursed card without
appraising it. `curse:check` reruns the field at appetite 0 and 1 to expose
curses that no reasonable run accepts or that dominate every alternative.

Per-trial roll traces are what the goal tuner designs from; they are recorded
only when `SimConfig.traceRolls` is set, since a number per roll per trial per
run is far too much memory for a full batch to carry by default.

## Strategies compared

Eleven series, chosen so the field resembles how the game is actually played
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

Themed bots prefer a matching booster and take their own loose cards
cheapest-first, then spend what is left on anything affordable — a visit with no
in-theme card would otherwise sit on its gold and read as a broken strategy
rather than an unlucky shop. They spend freely through rank 3 so a coherent
build exists before they begin banking; from rank 4 onward each keeps a
`goldFloor` for interest. The economy bot keeps a full interest bar, which is its
whole build. Theme membership is a total `Record` in
`systems/Items.ts` (`ITEM_THEMES`), so adding an item without theming it is a
compile error.

**Judged** — the two that shop on their own opinion rather than on price or
theme. Both are held out of the pooled fields the goal curve is designed
against, and both have a section of their own below:

- **Expert** — appraises every card by playing it out (`expert.ts`).
- **Player** — follows one written plan of twelve rules (`player.ts`).

## Measuring the field against a run you actually played

A goal is set from what the field can score, so a field that plays worse than the
people it is designed for produces goals those people meet on their opening roll.
That is not arguable from the outside — it needs a run somebody actually played,
measured against the bots at the same point on the ladder.

Play the game (`npm run dev`), open the dev panel with the `` ` `` key, and press
**Export run (JSON)** at the point you want measured. Save the download into
`sim-fixtures/` and:

```bash
npm run benchmark                                   # everything in sim-fixtures/
npm run benchmark -- sim-fixtures/my-rank-5.json
RUNS=150 SAMPLES=15 npm run benchmark               # tighter, slower
```

For each fixture it prints that trial's live goal, what your build reaches with
its whole roll budget (p10/p50/p90), how often that build meets the goal and how
often it does so **on roll 1**, and then the same three numbers for every series
in the field. The column to read is `vs you`: it is log10 of the capacity ratio,
so `-1.00` means the bot reaches a tenth of what you reach and a goal tuned to
challenge it is one you clear tenfold — which the `1-roll` column then confirms.

The export is written through `serializeRunState`, the same function the
active-run save uses, and read back through `hydrateRunState`. There is no second
serializer to drift, and the raw `the-order-of-order.active-run` localStorage
value loads as a fixture unchanged. `sim-fixtures/sample-generated-trial-13.json`
is a stand-in produced by a bot so the command has something to show; replace it
with your own runs, which is the only reason the tool exists.

### Playing a trial out, in the real game

The dev panel also carries **Play every trial to full budget**, which is
`engine.setFullBudgetAllTrials` — the same switch the tuners throw, thrown for
every trial at once so a person can feel it rather than read it. Trials stop
ending the instant their goal is met, so what a trial scores when it is played to
the end of its budget becomes something you can watch.

It is a measuring instrument, not a way to play. A trial played out has no rolls
left over, so it earns no unused-roll gold, no Reserve bonus and no Rain Check
carry: a run under the toggle is poorer than a real one at the same rank. The
setting persists across reloads, and production builds never read it.

## The expert shopper

`expert.ts` is the strategy that plays well, and it is the field the goal curve
should be designed against once you are happy with it.

The seven price-and-theme series decide what to buy from a card's **price**
(greedy, thrifty) or its **theme**, and none of them decides where to point a
card that needs a die — `bot.chooseTargets` picks a valid target uniformly at
random. The expert asks the question a player asks instead, literally: it buys
each candidate on a throwaway copy of the run (`cloneRun.ts`), plays the next
four trials out on it, and keeps the card that moved the score most per gold
(`appraise.ts`).

Nothing in it encodes an opinion about which items are good. An item rebalanced
in `Items.ts` changes the bot's behaviour on the next run with no edit here, and
a synergy nobody wrote down is found because it shows up in the score. Two
measurements make that affordable: capacity is read in log10, so builds orders of
magnitude apart still compare; and every candidate is rolled against the **same
seeds** as the baseline it is compared to, which cancels most of the variance and
lets three roll-outs stand in for thirty.

Over 192 matched runs it reaches trial **15.4** and wins 16 of them, at about
1.3s a run against 0.01s for the rest of the field — which is why it is not in
the default pooled fields.

## The player shopper

`player.ts` is the other strategy that plays well, and it gets there the
opposite way. Where the expert measures every card and holds no opinion, the
player holds nothing but opinions: it is one person's plan for the game, written
down as twelve numbered rules and implemented rule by rule at the top of the
file. Buy recurring dice creation in the opening shop, then economy; bank from
the fifth shop; duplicate the grid; walk the Rollplayer and the Centurion down
to a d1 so their multiplier fires on every roll; reroll aggressively; never take
a curse or a card that changes a trial's length.

It is not a themed bot with extra steps. The plan crosses swarm, economy,
multiplier and precision and refuses cards inside each of them, so it is a
ranking (`playerRank`) rather than an `ITEM_THEMES` filter, and four of its
rules live in seams the themed bots never touch: which die a size-naming card is
pointed at (rules 5 and 6), whether a shelf is worth rerolling (rule 7), how
much gold to keep back (rules 3 and 8), and which of the King's demands to
accept (rule 12). Those are the optional hooks on `Strategy` — `chooseTargets`,
`wantsReroll`, `accepts`, `rank`, `chooseDemand` — which default to the
field-wide behaviour when a strategy leaves them off, as all seven of the
price-and-theme bots do.

Its median grid crosses rule 4's 200 dice around trial 11 and compounds from
there — 277 dice at trial 11, 1,917 at 13, 20M at 24 — and both special dice end
the run walked all the way down to a d1, so their ×2 and ×4 fire on every roll.
That shape is what the plan is built to produce, and the reason it is held out
of the pooled fields alongside the expert.

**How good is it, exactly.** Measured on a _shared_ seed stream rather than each
series' own — 300 runs over two base seeds, so the only difference between two
columns is the shopping — it wins **14.3%** against the expert's **7.0%**
(z = 2.91, p ≈ 0.004) and the field's 0.7–4.0%, at the field's 0.01s a run
rather than the expert's 1.3s.

Read that with its companion number, though: it does **not** get further. Median
trial reached is tied with the expert, and run for run on the same game the two
are close to a coin flip (player further 112, expert further 91, tied 97). The
plan is higher variance, not uniformly stronger — it converts into outright
victories about twice as often while dying along the ladder at much the same
rate. Comparing the two on their own seed offsets, as `SIM_SERIES` does, is not
a fair fight in either direction; use a shared stream for any claim about which
shops better.

The expert also holds an advantage no win rate shows. It encodes no opinion
about which items are good, so a rebalance in `Items.ts` changes its behaviour
on the next run with no edit. The player's twelve rules name specific cards, and
retuning The Open Gate or Like Minds is a reason to revisit the plan.

The value of having both is that they disagree for legible reasons. The expert
finds synergies nobody wrote down; the player is a hypothesis about what a
person actually does, and a rule of it that measures badly is a rule to argue
with rather than a bug.

| knob                            | default | what it does                                      |
| ------------------------------- | ------- | ------------------------------------------------- |
| `SimConfig.expertSamples`       | 3       | roll-outs averaged per hypothesis                 |
| `SimConfig.expertHorizonScale`  | 2       | trials each card is judged over                   |
| `SimConfig.expertCrossTrials`   | true    | a roll-out resolves a trial and plays the next    |
| `SimConfig.expertRelativeFloor` | 0.25    | how far below the visit's best card a card may be |
| `SimConfig.expertPasses`        | 2       | shelf re-appraisals per visit                     |
| `SimConfig.expertGoldWeight`    | 1       | scales what a gold in hand is judged to be worth  |
| `SimConfig.expertBundleSize`    | 1       | cards weighed together as one purchase            |
| `SimConfig.expertObjective`     | score   | what a roll-out is scored by                      |

Every one of them is swept by `expert:tune` below rather than argued about here.

`expertRelativeFloor` is the whole of the spending discipline: a card is bought
when it is worth at least a quarter of what the best card the visit could BUY is
worth per gold, and the visit ends at the first card under that line. The best
card it could buy, not the best card on the shelf — a free card converts no gold
into points at all, so it is infinitely efficient, and a floor taken off one of
those is a floor nothing can clear. Every curse is free and so is anything a
Coupon Book has zeroed, so that is not a corner case: it is a shelf in two, and
it used to end the visit with the run's whole purse still in the bank.

### Read the paired interval, not the mean

**A run of this game swings whole ranks on its seed.** Mean trial reached over 48
runs moves by two or three for no reason at all: on one such sweep, handing the
appraiser strictly MORE samples — more information, same objective, same window —
read three trials WORSE. That is the measurement calling itself a liar, and every
knob in the table above was at some point adopted or rejected on differences that
size.

So `expert:tune` differences the variants **per run** and bootstraps a 95%
interval over those differences. The variants play identical seeds, so run 7
under one setting and run 7 under the other differ by the knob and nothing else;
comparing their means throws that away. An interval straddling zero means the
knob did nothing this sweep could see, which is a result. Wins are differenced
the same way — a win is the rarer event and the sharper signal, and it is the row
the one surviving change below was decided on.

Nothing here is settled by a single 48-run sweep any more. 192 pairs is what a
default costs.

### A roll-out crosses the trial boundary

Income is paid when a trial **ends**. Interest, the Boss Trial bonus, Counting
House, Deep Pockets and Reserve all arrive at a clear, so a roll-out that plays
one trial far past its goal prices the entire economy at exactly zero, however
long it runs. A bot that cannot see income does not buy income, and this one did
not: over twelve runs it bought Deep Pockets never and Counting House once.

So the horizon plays the game: the goal is met, `resolveTrialEnd` pays the trial
out and advances the ladder exactly as the live game does, and the rest of the
horizon is rolled in the next trial. A hypothesis that cannot clear the trial in
front of it simply ends there, which is also what the run would do.

Over 192 paired runs:

| crossing | reach | Δ reach (paired 95%) | wins   | cost       |
| -------- | ----- | -------------------- | ------ | ---------- |
| off      | 15.0  | (reference)          | 9/192  | 2.58 s/run |
| on       | 16.2  | +1.16 [-0.10, +2.34] | 28/192 | 2.14 s/run |

The reach interval only just touches zero; the decision rests on the rest of the
picture agreeing with it. Wins go from a twentieth of the runs to a seventh,
reach at trial 28 goes 7% → 26%, capacity is up at every fixture, and crossing is
CHEAPER than not crossing — a roll-out that ends a trial when its goal is met
stops playing one enormous trial forever. Several independent readouts, one
direction.

### How long a window — unsettled

`expertHorizonScale` is **2**, and that is a confession rather than a finding.

Four looked worth two trials of reach on a 48-run sweep and was shipped on it.
At 192 pairs the gap is **+0.74, interval [-0.23, +1.79]** — straddling zero,
for 60% more time per run (2.08s against 1.29s). Six was worse than four on both
of the sweeps that looked at it, so the shape is probably a hump rather than a
ladder, but none of it clears the noise.

The window is only worth anything at all because a roll-out crosses the trial
boundary: judged on one trial played four times as long, longer windows read
**17.5 / 17.1 / 16.8** for two, four and six — lengthening into nothing, because
a trial played four times as long is not four trials. That reading is what sent
this pass looking for what the roll-out could not see, and it was the one thing
this file measured that turned out to be about the bot rather than about noise.

Raise it for a curve-design pass, where an hour of clock is cheaper than a bot
that stops short.

### Cards in pairs, and why the late game is the real problem

`expertBundleSize` is a measured negative, kept because the reason it failed is
the most useful thing this file knows. Set to two it also weighs the top few
cards in **pairs**, as one hypothesis bought together, and takes the pair when it
beats every single card per gold. The target was the combination lock: a Genesis
breeds off dice that SCORE, so on a grid that rarely scores it measures at
nothing, and the scoring numbers that would make it enormous measure at nothing
without it — each correctly priced at zero alone, the pair worth the run.

Over 48 matched runs on three seed streams it did not pay: reach
15.6 / 17.3 / 12.8 against 15.8 / 18.6 / 12.8, 23 wins of 144 against 21, and
25-35% slower for it. Those are unpaired means, from before this file learned
better — but a knob has to beat the noise to be worth re-measuring, and this one
did not come close on any of the three.

A trace of what the pairs actually found says why, and it is not about pairs:

```
visit t2  bundle devils_bargain+spike     worth 0.3867  vs best single 0.3327  TAKEN
visit t5  bundle the_reckoning+brick_mold worth 0.1369  vs best single 0.0402  TAKEN
visit t15 bundle reliquary+overtime       worth 0.0000  vs best single 0.0000  -
visit t18 bundle double_the_fun+twin      worth 0.0000  vs best single 0.0000  -
visit t24 bundle extra_die+counting_house worth 0.0000  vs best single 0.0000  -
```

Pairs fire about five times a run and almost all of them before trial 10, because
**from the mid ladder on every hypothesis measures zero** — singles and pairs
alike. Once a build compounds, one more die or one more flat bonus does not
change the growth rate, so it does not move log10 of a 1e14 score at all, and a
pair of cards that each measure nothing measures nothing. The appraiser has no
gradient left to follow and the late shops are effectively coin flips; that, not
the combination lock, is what stands between this bot and a played run that built
a compounding engine. Whatever closes it has to give the late game a signal —
measuring against the ladder's next goal rather than the build's own score is the
obvious candidate, and is not tried here.

### Scoring a roll-out by the ladder instead — also measured, also no

`expertObjective` is the other kept negative. Set to `"ladder"`, a roll-out
reports how far up the goal ladder it walked — trials cleared, plus part of one
for how close it came on the trial that stopped it — instead of the log10 of the
best trial it played. The argument was the same saturation the pairs ran into: a
compounding build one-rolls its goals, so what it posts is one roll of its grid
however large the grid is, and a card that adds a die or a flat bonus moves
log10 of a 1e14 score by nothing. Depth up the ladder keeps its gradient exactly
where score loses it, because the ladder is what eventually outruns a build.

It read flat on one 48-run sweep (reach 15.8 → 15.9, wins 4 → 10) and badly on
another (18.6 → 15.5, wins 11 → 6). The obvious confound was resolution — depth
is quantised, and at three samples a card can only move it in thirds — so the
next sweep crossed the objective with the sample count, and that is the sweep
that broke this file's faith in its own numbers: **more samples made the SCORE
objective read three trials worse** (18.6 → 15.5), which cannot be a real effect.
See the paired-interval note above. The objective is off, unproven rather than
disproven, and any future attempt on it wants 192 pairs and the paired readout.

A measurement worth keeping from it: on a played run's deep build the score
objective is not as dead as the bot's own trace suggested — at trial 20 it still
moves for 33 of 70 cards, against 23 for the ladder. Whatever is holding the late
game shut, "no gradient at all" is too simple a story for it.

### Tuning it against runs you played

`expertTune.ts` is the loop that produced the table above: it sweeps the knobs
over a matched seed stream and prints, for every trial one of your exported runs
was taken at, what that setting of the bot arrives with against what you arrived
with.

```bash
npm run expert:tune                                  # every axis at its default
RUNS=192 CROSS_TRIALS=0,1 npm run expert:tune        # the A/B above
HORIZONS=2,4 FLOORS=0.25,0.08 npm run expert:tune    # two axes crossed
RUNS=192 npm run expert:tune -- sim-fixtures/trial-20-*.json
```

| env              | default | axis                           |
| ---------------- | ------- | ------------------------------ |
| `RUNS`           | 24      | matched runs per variant       |
| `SAMPLES`        | 9       | roll-outs per captured state   |
| `HORIZONS`       | 2       | `expertHorizonScale`           |
| `EXPERT_SAMPLES` | 3       | `expertSamples`                |
| `APPETITES`      | 0.5     | curse appetite                 |
| `FLOORS`         | 0.25    | `expertRelativeFloor`          |
| `PASSES`         | 2       | `expertPasses`                 |
| `GOLD_WEIGHTS`   | 1       | `expertGoldWeight`             |
| `CROSS_TRIALS`   | 1       | `expertCrossTrials`, as 0 or 1 |
| `BUNDLES`        | 1       | `expertBundleSize`             |
| `LADDERS`        | 0       | `expertObjective`, as 0 or 1   |

Every axis takes a comma-separated list and the sweep is their cross product, so
one axis at a time keeps the table readable and two crossed answers whether the
knobs interact. Bot-made fixtures (`sample-*`) are skipped by default: measuring
this bot against a bot is measuring it against itself.

`series.ts` keeps the expert and the player **out** of `SHOPPER_SERIES` and
`SMART_SERIES` on purpose. Every shipped goal was designed against the
price-and-theme field, and quietly adding a stronger shopper to that pool would
move the whole curve as a side effect of a file being edited. `EXPERT_SERIES`
and `PLAYER_SERIES` are there to point a tuner at one deliberately, as
`FIELD=expert` and `FIELD=player`.

## Designing the smart-field survival curve

`smartSurvivalCurve.ts` is the shipped curve's tuner. It uses the coherent,
fully unlocked field (all-unlocked greedy/thrifty plus swarm, multiplier,
precision, and tempo) to set absolute rank-survival checkpoints. Base-pool runs
and the intentionally weak economy hoarder remain visible in validation, but do
not make the opening lethal for builds that spend toward power.

The current schedule leaves about 65% alive through rank 1, 62% through rank 2,
and 57% through rank 3, then falls gradually to about 9% entering rank 10. Trial
1 is deliberately left untouched; its single d6 and seven rolls set a roughly
72% maximum cohort before shopping begins. Trials 2–9 rise strictly from 2 to
280 instead of repeating the minimum goal through the opening acts. Every rank
uses the same 7 / 14 / 18 base-roll cadence.

```bash
node node_modules/tsx/dist/cli.mjs src/sim/smartSurvivalCurve.ts
RUNS=800 FROM=9 node node_modules/tsx/dist/cli.mjs src/sim/smartSurvivalCurve.ts
CURVE=SMART_SURVIVAL node node_modules/tsx/dist/cli.mjs src/sim/validate.ts
```

The older `pacingCurve.ts` remains useful for studying goal-vs-tempo tradeoffs:

It designs each goal from what the field
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

`pacingFeasibility.ts` applies that question to the coherent smart field and the
absolute survival schedule. For each selected trial it reports the live goal,
the highest scalar goal that preserves the target clear rate, a clear-rate
frontier, per-archetype results, capacity deciles, and sensitivity at ±5% and
±10%. A `NO scalar-goal fit` result means no easier goal can reach both the
survival target and the requested median-roll/one-roll tempo; it diagnoses the
need for another pacing control but does not introduce one.

```bash
node node_modules/tsx/dist/cli.mjs src/sim/pacingFeasibility.ts
RUNS=500 TRIALS=2,3,6,9,12,18,24,27,29 PACE_SHARE=0.6 MAX_ONE_ROLL=0.15 node node_modules/tsx/dist/cli.mjs src/sim/pacingFeasibility.ts
```

`validate.ts` re-tests a curve with real culling and prints the per-trial
attrition, the roll pacing, and the per-modifier Boss Trial clear rates, then
regenerates the report. `CURVE=LIVE` re-tests the curve `src/config.ts` actually
ships, which is how a hand-edited `TRIAL_GOALS` is measured without a round trip
through `candidate.json`. `endlessCurve.ts` projects the strongest builds forward
to confirm the endless ladder eventually outruns all of them.

`economyExperiment.ts` compares payout and item-access variants with matched
seeds. Payout overrides exist only in `SimConfig`, and item metadata is restored
after each scenario, so running the experiment never changes the live economy.
It reports the complete smart-build survival and roll-pacing curves as well as
gold, purchase counts, score-tail size, and modified-item buy rates. Use
`SCENARIOS` to run only named variants (the baseline is always included):

```bash
RUNS=500 SCENARIOS=unused-cap-4,lucky-seven-uncommon node node_modules/tsx/dist/cli.mjs src/sim/economyExperiment.ts
```

`durationExperiment.ts` performs the same matched-seed comparison for alternate
7 / Greater / Boss roll cadences. Its cadence and optional goal overrides are
simulation-only and are always restored, so the live duration cannot change by
running it:

```bash
RUNS=500 SCENARIOS=long-rollback,modest,balanced node node_modules/tsx/dist/cli.mjs src/sim/durationExperiment.ts
```

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
npm run persistence:check # an in-progress run survives a save/restore round trip
npm run history:check    # the per-roll run timeline the analysis screen charts
npm run expert:check     # the appraiser: its clone, its measurement, its targeting
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

| File                    | Role                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `benchmark.ts`          | An exported run measured against every series at the same trial. Start here.                     |
| `expertTune.ts`         | The expert's knobs swept against those runs, over a matched seed stream.                         |
| `importRun.ts`          | Reads a dev-panel run export (or a raw active-run save) back into a `RunState`.                  |
| `cloneRun.ts`           | A run a hypothesis may ruin. Not the save path — see the file for why.                           |
| `appraise.ts`           | Capacity measured by rolling it out; what a card is worth, and which die it wants.               |
| `expert.ts`             | The appraising shopper. The only strategy that measures anything.                                |
| `player.ts`             | The written plan: twelve numbered rules, and the ranking and hooks that carry them out.          |
| `expertCheck.ts`        | Appraiser assertions: clone isolation, shared seeds, and that cards land on the right die.       |
| `engine.ts`             | Pure trial-loop rules shared with `GameScene` (roll → score → grow, trial-end win/lose/advance). |
| `bot.ts`                | Strategies, die-target selection, `simulateRun`, per-run unlock and boss tracking.               |
| `stats.ts`              | Aggregates `RunRecord[]` into the report's numbers.                                              |
| `report.ts`             | Renders `BatchStats` to one self-contained HTML file (inline SVG charts).                        |
| `config.ts`             | `DEFAULT_CONFIG` + the editable `unlockedAtStart`.                                               |
| `series.ts`             | The eleven series, their seed offsets, the named fields, and `seriesConfig`.                     |
| `localStorageShim.ts`   | In-memory `localStorage` + seeded `Math.random` for Node/reproducibility.                        |
| `runBatch.ts`           | CLI entry (`npm run sim`).                                                                       |
| `smartSurvivalCurve.ts` | Shipped tuner: designs absolute survival checkpoints from the smart field.                       |
| `pacingCurve.ts`        | Alternate tuner: designs from uncensored capacity and reports roll tempo.                        |
| `pacingFeasibility.ts`  | Tests whether one score goal can meet survival and duration targets, without changing rules.     |
| `economyExperiment.ts`  | Matched-seed payout and item-access experiments; never mutates the live authored values.         |
| `durationExperiment.ts` | Matched-seed roll-cadence experiments with optional temporary goal compensation.                 |
| `curseValue.ts`         | State-aware curse boon/risk appraisal used by every bot strategy.                                |
| `curseCheck.ts`         | Appetite 0/1 curse acceptance and outcome report.                                                |
| `pacingSweep.ts`        | What every attrition target costs in rolls, for one trial. Read before moving `CLEAR`.           |
| `tuneCurve.ts`          | Superseded. Fixed-point tuner against censored peaks.                                            |
| `designTargets.ts`      | Superseded. Single-pass curve designer.                                                          |
| `validate.ts`           | Re-test a curve with real culling; prints attrition, roll pacing and boss clear rates.           |
| `endlessCurve.ts`       | Confirms the endless ladder terminates.                                                          |
| `itemCheck.ts`          | Item + boss-modifier assertions.                                                                 |
| `trialEndCheck.ts`      | Trial-loop assertions.                                                                           |
| `runHistoryCheck.ts`    | Run-timeline assertions: what is recorded, and how it survives both saves.                       |
| `goldCheck.ts`          | Gold-economy assertions.                                                                         |
| `compareScoring.ts`     | Per-die vs histogram scorer parity + perf timing.                                                |
