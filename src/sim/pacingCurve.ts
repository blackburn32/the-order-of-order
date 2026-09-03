// The goal-curve tuner: designs each goal from UNCENSORED capacity, and reports
// the roll pacing it buys.
//
// tuneCurve.ts picks each goal as a quantile of the peak scores of the runs that
// entered a trial. The flaw is that a trial ENDS the moment its goal is met, so
// those peaks are capped by the very goal being replaced: under an easy curve
// every peak reads as "a hair over the goal", and the fixed point sits happily
// on a ladder the field clears on its opening roll. That is how the shipped
// curve came to be cleared in a median of two rolls out of twenty, better than
// half of them on roll one.
//
// This measures capacity instead. One trial at a time, that trial — and only
// that trial — plays its whole roll budget out (the engine's
// `setFullBudgetTrial`), so what comes back is what each build COULD have
// scored, not what the old goal let it. The goal is then the quantile of that
// distribution which leaves `CLEAR` of the entrants able to reach it.
//
// Two things make the measurement honest:
//
//   - One trial plays out, not all of them. The grid grows per roll and never
//     resets between trials, so a pass that played every trial to its budget
//     would hand trial 20 a grid no real run could arrive with.
//   - Trials are tuned front to back, each measured under the goals already
//     chosen for everything before it. A harder rank 4 means poorer rank 5
//     shops, and that has to be in the numbers rank 5 is designed from.
//
// PACING IS A READOUT, NOT A CONTROL, and the printed columns say why. A goal is
// one number, so its attrition fixes it, and the tempo it produces is whatever
// the field's spread makes it: across the bot field a trial's full-budget
// capacity runs about a thousandfold from p10 to p90, so any goal the weakest
// tenth can survive is met on the opening roll by the strongest tenth. Lowering
// CLEAR buys tempo directly out of survival — read the `rolls` and `1-roll`
// columns against the `clear` column and spend accordingly.
//
// Run:
//   node node_modules/tsx/dist/cli.mjs src/sim/pacingCurve.ts
//   RUNS=600 CLEAR=0.88 node node_modules/tsx/dist/cli.mjs src/sim/pacingCurve.ts
//
// Not shipped with the game; delete when balancing is done.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  TRIALS_PER_RANK,
  WIN_RANK,
  WIN_TRIAL,
  setTrialGoals,
  trialGoal,
} from "../config";
import { DEFAULT_CONFIG } from "./config";
import { setFullBudgetTrial } from "./engine";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { simulateRun, type TrialPoint } from "./bot";
import { seriesConfig, seriesSeed, SHOPPER_SERIES } from "./series";

const RUNS = Number(process.env.RUNS ?? 400);

/**
 * The share of a trial's entrants that should be able to reach its goal.
 *
 * This is the one control. Over the `WIN_TRIAL - FROM` trials it is applied to
 * it compounds, so it sets the run's win rate as much as any single trial's
 * difficulty: 0.92 across 23 trials leaves 15% of the field that entered them
 * alive at the end, 0.88 leaves 5%.
 */
const CLEAR = Number(process.env.CLEAR ?? 0.9);

/** Boss Trials are allowed to bite harder than the two trials that lead up to
 *  them — the modifier is already doing work, and a rank should close on its
 *  hardest ask. Expressed as a share of CLEAR's own cull. */
const BOSS_CULL_SCALE = Number(process.env.BOSS_CULL_SCALE ?? 1.5);

/** The first trial to redesign. Everything before it keeps the goal it has: the
 *  opening ranks are hand-tuned against how the game actually opens — one die,
 *  single-digit goals — and a quantile of a two-point score distribution is not
 *  a better number than the one a designer chose. */
const FROM = Number(process.env.FROM ?? 7);

/**
 * Stop measuring once a rank's trials draw fewer entrants than this, and
 * continue the curve by the growth the measured ranks establish.
 *
 * The deep ranks are reached by a handful of runs, and a quantile of fourteen
 * samples is not a measurement — it is a number with the right units. Worse, it
 * is a quantile of the SURVIVORS, the strongest builds the field produced, so
 * trusting it authors a wall out of noise. Ranks past the sampled ones continue
 * at the rank-over-rank ratio the sampled ones actually grew by, which is how
 * `src/config.ts` extends its own table.
 */
const MIN_SAMPLE = Number(process.env.MIN_SAMPLE ?? 250);

/** Round to two significant figures, so the shipped table reads as authored
 *  numbers rather than as sim exhaust. */
function round2sig(n: number): number {
  if (n < 100) return Math.max(1, Math.ceil(n));
  const exp = Math.floor(Math.log10(n));
  const mant = Math.round(n / Math.pow(10, exp - 1));
  return Number(BigInt(mant) * 10n ** BigInt(Math.max(0, exp - 1)));
}

function bigLiteral(n: number): string {
  return n
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "_")
    .concat("n");
}

function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 1;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx];
}

/** Every entrant's trace of one trial, gathered with that trial — and only that
 *  trial — played out to its whole roll budget. */
function measureTrial(trial: number, curve: number[]): TrialPoint[] {
  setTrialGoals(curve);
  setFullBudgetTrial(trial);
  const points: TrialPoint[] = [];
  for (const series of SHOPPER_SERIES) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    for (let i = 0; i < RUNS; i++) {
      const record = simulateRun(
        series.strategy,
        seriesSeed(DEFAULT_CONFIG.seed, i, series.seedOffset),
        {
          ...seriesConfig(DEFAULT_CONFIG, series),
          traceRolls: true,
          stopAfterTrial: trial,
        },
      );
      const point = record.trajectory.find((p) => p.trial === trial);
      if (point?.rollScores?.length) points.push(point);
    }
  }
  setFullBudgetTrial(null);
  return points;
}

/** The roll a trace first reached `goal` on, or null if it never did. */
function rollToReach(scores: number[], goal: number): number | null {
  for (let i = 0; i < scores.length; i++) if (scores[i] >= goal) return i + 1;
  return null;
}

/** What a run scored over the trial's whole roll budget. */
function capacity(p: TrialPoint): number {
  return p.rollScores![p.rollScores!.length - 1];
}

/** How much every affliction in force multiplied this run's goal by, recovered
 *  from the effective goal it faced and the table entry behind it. */
function goalMultiplier(p: TrialPoint, tableGoal: number): number {
  if (!tableGoal || !p.goal) return 1;
  return Math.max(1, p.goal / tableGoal);
}

const curve = Array.from({ length: WIN_TRIAL }, (_, i) =>
  Number(trialGoal(i + 1)),
);

console.log(
  `Goal-curve tune — ${RUNS} runs/series × ${SHOPPER_SERIES.length} series, ` +
    `target clear ${(CLEAR * 100).toFixed(0)}% (Boss Trials ${(100 - (1 - CLEAR) * BOSS_CULL_SCALE * 100).toFixed(0)}%)`,
);
console.log(
  `trials ${FROM}..${WIN_TRIAL - 1} redesigned; 1..${FROM - 1} kept as authored\n`,
);
console.log(
  "trial | rank | entrants |          goal | clear | rolls | share | 1-roll | p90",
);

// The deepest trial the field sampled well enough to design from. Everything
// past it is continued by formula rather than measured.
let lastMeasured = FROM - 1;

for (let trial = FROM; trial < WIN_TRIAL; trial++) {
  const rank = Math.ceil(trial / TRIALS_PER_RANK);
  const isBoss = trial % TRIALS_PER_RANK === 0;
  const previous = curve[trial - 1];
  const points = measureTrial(trial, curve);
  if (points.length < MIN_SAMPLE) {
    console.log(
      `${String(trial).padStart(5)} | ${String(rank).padStart(4)} | ` +
        `${String(points.length).padStart(8)} | too few to design from — ` +
        `rank ${rank} onward continued by formula`,
    );
    break;
  }

  // Capacity, normalised back onto the BASE goal scale. What a trial actually
  // asks is `Boss.goalFor` — the table's number times whatever every affliction
  // in force multiplies it by (The Hoard, The Reckoning, and any drawback the
  // King's writ left standing). Two runs on the same trial can therefore be
  // facing different bars, and the table holds only the number they are both
  // multiplied from. Each point carries the effective goal it faced, so its
  // multiplier is recoverable — divide capacity through by it and the quantile
  // is taken in the units the table is written in.
  const full = points
    .map((p) => capacity(p) / goalMultiplier(p, previous))
    .sort((a, b) => a - b);
  const cull = (1 - CLEAR) * (isBoss ? BOSS_CULL_SCALE : 1);
  let goal = round2sig(Math.max(1, quantile(full, cull)));
  // The two monotonicity rules the authored table is cut with: a slot always
  // asks more than the same slot one rank down, and within a rank the goals rise
  // with the roll budget. The sawtooth between ranks is deliberate — a rank
  // opens on a seven-roll Lesser Trial and closes on an eighteen-roll Boss Trial.
  if (trial > TRIALS_PER_RANK)
    goal = Math.max(goal, curve[trial - TRIALS_PER_RANK - 1] + 1);
  if ((trial - 1) % TRIALS_PER_RANK !== 0)
    goal = Math.max(goal, curve[trial - 2] + 1);
  curve[trial - 1] = goal;
  lastMeasured = trial;

  // What that goal does to this same field, read off the traces rather than
  // predicted: who gets there, and how long it takes them.
  const reached = points
    .map((p) => rollToReach(p.rollScores!, goal * goalMultiplier(p, previous)))
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  const budget = points.reduce((a, p) => a + p.rollBudget, 0) / points.length;
  const median = reached.length ? quantile(reached, 0.5) : budget;
  console.log(
    `${String(trial).padStart(5)} | ${String(rank).padStart(4)} | ` +
      `${String(points.length).padStart(8)} | ${goal.toLocaleString().padStart(13)} | ` +
      `${((reached.length / points.length) * 100).toFixed(0).padStart(4)}% | ` +
      `${median.toFixed(0).padStart(5)} | ` +
      `${((median / budget) * 100).toFixed(0).padStart(4)}% | ` +
      `${((reached.filter((r) => r <= 1).length / Math.max(1, reached.length)) * 100).toFixed(0).padStart(5)}% | ` +
      `${(reached.length ? quantile(reached, 0.9) : budget).toFixed(0).padStart(3)}`,
  );
}

// A half-measured rank is no use: its Lesser Trial would be a measurement and
// its Boss Trial a guess, and the sawtooth between them would be an accident. So
// the formula picks up from the last WHOLE rank — and the final rank counts as
// whole once its two scored trials are in, because its third is the duel, which
// has no goal to measure.
let measuredThrough = 0;
for (let rank = 1; rank <= WIN_RANK; rank++) {
  const lastOfRank = Math.min(rank * TRIALS_PER_RANK, WIN_TRIAL - 1);
  if (lastMeasured >= lastOfRank) measuredThrough = rank;
}

const bossOf = (rank: number) => curve[rank * TRIALS_PER_RANK - 1];

// Continue the curve past what the field sampled, at the growth the sampled
// ranks actually grew by — the same shape src/config.ts extends its own table
// with, but with the ratio read off this measurement rather than off the old
// one. Slot shares come from the last measured rank, so the sawtooth carries.
if (measuredThrough < WIN_RANK) {
  const RATIO_RANKS = 3;
  const ratioFrom = Math.max(1, measuredThrough - RATIO_RANKS);
  const rankRatio =
    measuredThrough > ratioFrom
      ? Math.pow(
          bossOf(measuredThrough) / bossOf(ratioFrom),
          1 / (measuredThrough - ratioFrom),
        )
      : 9;
  const shares = Array.from(
    { length: TRIALS_PER_RANK },
    (_, slot) =>
      curve[(measuredThrough - 1) * TRIALS_PER_RANK + slot] /
      bossOf(measuredThrough),
  );
  console.log(
    `\nranks ${measuredThrough + 1}..${WIN_RANK} continued by formula: ` +
      `${rankRatio.toFixed(1)}× per rank (measured over ranks ${ratioFrom}..${measuredThrough}), ` +
      `slot shares ${shares.map((x) => x.toFixed(3)).join(" / ")}`,
  );
  let boss = bossOf(measuredThrough);
  for (let rank = measuredThrough + 1; rank <= WIN_RANK; rank++) {
    boss *= rankRatio;
    for (let slot = 0; slot < TRIALS_PER_RANK; slot++) {
      curve[(rank - 1) * TRIALS_PER_RANK + slot] = round2sig(
        boss * shares[slot],
      );
    }
  }
}

// The duel has no goal — it is won by leading when the rolls run out — so trial
// WIN_TRIAL is never measured. Its entry still has to be a number, because the
// endless ladder walks out from it, so it continues the boss slot's own growth.
const duelRatio =
  bossOf(WIN_RANK - 2) > 0 ? bossOf(WIN_RANK - 1) / bossOf(WIN_RANK - 2) : 9;
// Boss slot to boss slot, not from the trial before it — the sawtooth means the
// Greater Trial beneath it asks a fraction of what a Boss Trial does, and
// growing from that number would smuggle the slot share in a second time.
curve[WIN_TRIAL - 1] = round2sig(bossOf(WIN_RANK - 1) * duelRatio);
console.log(
  `\ntrial ${WIN_TRIAL} is the duel and has no goal. Its entry continues the ` +
    `ladder at ${duelRatio.toFixed(1)}× so the endless run has somewhere to walk ` +
    `out from: ${curve[WIN_TRIAL - 1].toLocaleString()}`,
);

console.log("\nAUTHORED_GOALS (paste into src/config.ts):");
for (let rank = 1; rank <= WIN_RANK; rank++) {
  const slice = curve.slice(
    (rank - 1) * TRIALS_PER_RANK,
    rank * TRIALS_PER_RANK,
  );
  console.log(`  // rank ${rank}`);
  console.log("  " + slice.map(bigLiteral).join(",\n  ") + ",");
}

setTrialGoals(null);
const candidatePath = "sim-out/candidate.json";
const curves = existsSync(candidatePath)
  ? JSON.parse(readFileSync(candidatePath, "utf8"))
  : {};
curves["PACED"] = curve;
writeFileSync(candidatePath, JSON.stringify(curves, null, 2));
console.log('\n(wrote curve to sim-out/candidate.json under "PACED")');
console.log(
  "confirm with:  CURVE=PACED node node_modules/tsx/dist/cli.mjs src/sim/validate.ts",
);
