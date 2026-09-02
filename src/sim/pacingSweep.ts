// Diagnostic for the roll-pacing tuner: the trade-off curve between how hard a
// goal is and how long it takes to reach.
//
// A goal has to buy two things at once — an attrition rate and a tempo — and
// they are bought with the same coin. This prints, for one trial, what every
// price along that curve actually gets: set the goal at the qth percentile of
// what the field can score in the whole budget, and you get (1 - q) of the field
// clearing, in the median number of rolls shown. Read it to choose the CLEAR
// target pacingCurve.ts is run with, rather than guessing at one.
//
// Run: TRIAL=12 node node_modules/tsx/dist/cli.mjs src/sim/pacingSweep.ts
//
// Not shipped with the game; delete when balancing is done.

import { TRIALS_PER_RANK, WIN_TRIAL, trialGoal } from "../config";
import { DEFAULT_CONFIG } from "./config";
import { setFullBudgetTrial } from "./engine";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { simulateRun, type TrialPoint } from "./bot";
import { seriesConfig, seriesSeed, SHOPPER_SERIES } from "./series";

const RUNS = Number(process.env.RUNS ?? 300);
const TRIALS = (process.env.TRIALS ?? "5,8,11,14,17")
  .split(",")
  .map((t) => Number(t.trim()))
  .filter((t) => t >= 1 && t <= WIN_TRIAL);

function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 1;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx];
}

function measureTrial(trial: number): TrialPoint[] {
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

function rollToReach(scores: number[], goal: number): number | null {
  for (let i = 0; i < scores.length; i++) if (scores[i] >= goal) return i + 1;
  return null;
}

const CLEAR_RATES = [0.995, 0.98, 0.95, 0.9, 0.85, 0.75, 0.6, 0.5];

for (const trial of TRIALS) {
  const points = measureTrial(trial);
  const rank = Math.ceil(trial / TRIALS_PER_RANK);
  const slot = ((trial - 1) % TRIALS_PER_RANK) + 1;
  if (points.length === 0) {
    console.log(`\ntrial ${trial} — nobody reached it\n`);
    continue;
  }
  const budget = points.reduce((a, p) => a + p.rollBudget, 0) / points.length;
  const full = points
    .map((p) => p.rollScores![p.rollScores!.length - 1])
    .sort((a, b) => a - b);
  console.log(
    `\ntrial ${trial} (rank ${rank}, slot ${slot}) — ${points.length} entrants, ` +
      `${budget.toFixed(1)} rolls, live goal ${trialGoal(trial).toLocaleString()}`,
  );
  console.log(
    "  full-budget capacity: p10 " +
      quantile(full, 0.1).toLocaleString() +
      "  median " +
      quantile(full, 0.5).toLocaleString() +
      "  p90 " +
      quantile(full, 0.9).toLocaleString(),
  );
  console.log(
    "  target clear |         goal | median rolls | share | 1-roll | p90 rolls",
  );
  for (const clear of CLEAR_RATES) {
    const goal = Math.max(1, Math.round(quantile(full, 1 - clear)));
    const reached = points
      .map((p) => rollToReach(p.rollScores!, goal))
      .filter((r): r is number => r !== null)
      .sort((a, b) => a - b);
    if (!reached.length) continue;
    console.log(
      `  ${(clear * 100).toFixed(1).padStart(12)}% | ${goal.toLocaleString().padStart(12)} | ` +
        `${quantile(reached, 0.5).toFixed(0).padStart(12)} | ` +
        `${((quantile(reached, 0.5) / budget) * 100).toFixed(0).padStart(4)}% | ` +
        `${((reached.filter((r) => r <= 1).length / reached.length) * 100).toFixed(0).padStart(5)}% | ` +
        `${quantile(reached, 0.9).toFixed(0).padStart(9)}`,
    );
  }
}
