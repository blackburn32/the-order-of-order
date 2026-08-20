// Endless-mode goal growth (throwaway balancing tooling).
//
// Endless has one job: every run must end. That is not automatic. A build's
// output grows geometrically — Prism multiplies by 3 per copy, Last Call by 4,
// Genesis and Double the Fun grow the grid without bound — so a goal curve with
// a FIXED ratio can be outrun forever by a strong enough run. The shipped curve
// therefore accelerates: each trial past the win multiplies by ENDLESS_BASE
// raised to a power that itself climbs with distance (see src/config.ts).
//
// This script takes the strongest builds the sim can produce, projects their
// growth forward, and reports the rank at which the goal finally overtakes them.
//
// Run: npx tsx src/sim/endlessCurve.ts
//      RUNS=500 npx tsx src/sim/endlessCurve.ts
//
// Not shipped with the game; delete when balancing is done.

import {
  ENDLESS_ACCEL,
  ENDLESS_BASE,
  TRIALS_PER_RANK,
  trialGoal,
  WIN_TRIAL,
} from "../config";
import { DEFAULT_CONFIG } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { simulateRun } from "./bot";
import { seriesConfig, seriesSeed, SIM_SERIES } from "./series";

const RUNS = Number(process.env.RUNS ?? 500);
// How far past the win to project before giving up and calling it unbounded.
const PROBE_TRIALS = 120;

/**
 * A run's score growth per trial, measured over the back half of its ladder.
 * Taken from the ratio between consecutive peak scores rather than from the
 * absolute numbers, because what matters for endless is the RATE a build
 * compounds at, not where it happened to be when the run ended.
 */
function growthRate(peaks: number[]): number | null {
  const usable = peaks.filter((p) => p > 0);
  if (usable.length < 4) return null;
  const half = usable.slice(Math.floor(usable.length / 2));
  let ratio = 1;
  let steps = 0;
  for (let i = 1; i < half.length; i++) {
    if (half[i - 1] <= 0 || half[i] <= 0) continue;
    ratio *= half[i] / half[i - 1];
    steps += 1;
  }
  if (steps === 0) return null;
  return Math.pow(ratio, 1 / steps);
}

/** The first trial past the win where the goal outpaces a build that starts at
 *  `score` and multiplies by `rate` every trial. null if it never does. */
function deathTrial(score: number, rate: number): number | null {
  let reach = score;
  for (let trial = WIN_TRIAL + 1; trial <= WIN_TRIAL + PROBE_TRIALS; trial++) {
    reach *= rate;
    const goal = Number(trialGoal(trial));
    if (!Number.isFinite(goal)) return trial; // goal has outrun double precision
    if (reach < goal) return trial;
  }
  return null;
}

console.log(
  `Endless growth: base ${ENDLESS_BASE}, accel ${ENDLESS_ACCEL} - ${RUNS} runs/series`,
);
console.log("\nGoal growth per trial past the win:");
for (let t = WIN_TRIAL + 1; t <= WIN_TRIAL + 20; t += 2) {
  const step = Number(trialGoal(t)) / Number(trialGoal(t - 1));
  const rank = Math.ceil(t / TRIALS_PER_RANK);
  console.log(
    `  trial ${String(t).padStart(3)} (rank ${String(rank).padStart(2)}): x${step.toFixed(2)}`,
  );
}

// Collect the fastest-compounding builds each series produces. Only runs that
// actually reached the final rank matter — a run that died at rank 2 tells us
// nothing about whether endless can be outrun.
const rates: { series: string; rate: number; finalScore: number }[] = [];
for (const series of SIM_SERIES) {
  seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
  installStorage([...series.unlockedAtStart]);
  for (let i = 0; i < RUNS; i++) {
    const rec = simulateRun(
      series.strategy,
      seriesSeed(DEFAULT_CONFIG.seed, i, series.seedOffset),
      seriesConfig(DEFAULT_CONFIG, series),
    );
    if (!rec.won) continue;
    const peaks = rec.trajectory.map((p) => p.trialScore);
    const rate = growthRate(peaks);
    if (rate === null || !Number.isFinite(rate) || rate <= 1) continue;
    rates.push({
      series: series.id,
      rate,
      finalScore: peaks[peaks.length - 1] ?? 1,
    });
  }
}

if (rates.length === 0) {
  console.log(
    "\nNo winning runs to project from. Lower the goal curve or raise RUNS.",
  );
  process.exit(0);
}

rates.sort((a, b) => b.rate - a.rate);
const median = rates[Math.floor(rates.length / 2)];
const strongest = rates[0];
const p99 = rates[Math.floor(rates.length * 0.01)];

console.log(`\nWinning runs projected: ${rates.length}`);
console.log("build            growth/trial   dies at trial   dies at rank");
for (const [label, r] of [
  ["median winner", median],
  ["99th percentile", p99],
  ["strongest seen", strongest],
] as const) {
  const trial = deathTrial(r.finalScore, r.rate);
  const rank = trial === null ? null : Math.ceil(trial / TRIALS_PER_RANK);
  console.log(
    `${label.padEnd(16)} x${r.rate.toFixed(2).padStart(10)}   ` +
      `${(trial === null ? "NEVER" : String(trial)).padStart(13)}   ` +
      `${(rank === null ? "UNBOUNDED" : String(rank)).padStart(12)}`,
  );
}

const worst = deathTrial(strongest.finalScore, strongest.rate);
if (worst === null) {
  console.log(
    `\nFAIL: the strongest build outruns the goal for ${PROBE_TRIALS} trials.` +
      "\nRaise ENDLESS_BASE or ENDLESS_ACCEL in src/config.ts until it does not.",
  );
  process.exit(1);
}
console.log(
  `\nEvery projected build dies by rank ${Math.ceil(worst / TRIALS_PER_RANK)}. Endless terminates.`,
);
