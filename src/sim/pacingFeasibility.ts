// Read-only diagnostic for the trade-off a single score goal can buy. It keeps
// the live "fail any trial" rule, replays selected trials to their full budget,
// and reports the highest goal that still preserves the intended smart-build
// clear rate. If that row misses the tempo targets, no easier scalar goal can
// fix tempo without an additional pacing control.

import { trialGoal, WIN_TRIAL } from "../config";
import { simulateRun, type TrialPoint } from "./bot";
import { DEFAULT_CONFIG } from "./config";
import { setFullBudgetTrial } from "./engine";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { seriesConfig, seriesSeed, SMART_SERIES } from "./series";
import { targetTrialClearRate } from "./survivalTargets";

interface Sample {
  series: string;
  point: TrialPoint;
  normalizedCapacity: number;
  goalMultiplier: number;
}

interface Result {
  goal: number;
  cleared: number;
  clearRate: number;
  medianShare: number;
  p75Share: number;
  oneRollRate: number;
}

const RUNS = Math.max(1, Number(process.env.RUNS ?? 150) | 0);
const PACE_SHARE = Math.min(
  1,
  Math.max(0, Number(process.env.PACE_SHARE ?? 0.6)),
);
const MAX_ONE_ROLL = Math.min(
  1,
  Math.max(0, Number(process.env.MAX_ONE_ROLL ?? 0.15)),
);
const TRIALS = (process.env.TRIALS ?? "2,3,6,9,12,15,18,21,24,27,29")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter(
    (trial, index, all) =>
      Number.isInteger(trial) &&
      trial >= 1 &&
      trial < WIN_TRIAL &&
      all.indexOf(trial) === index,
  );
const FRONTIER_CLEAR_RATES = [0.995, 0.985, 0.95, 0.9, 0.8, 0.7, 0.6];

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * (sorted.length - 1))),
  );
  return sorted[index];
}

function firstRoll(scores: number[], goal: number): number | null {
  const index = scores.findIndex((score) => score >= goal);
  return index < 0 ? null : index + 1;
}

function resultFor(samples: Sample[], goal: number): Result {
  const shares: number[] = [];
  let oneRoll = 0;
  for (const sample of samples) {
    const roll = firstRoll(
      sample.point.rollScores!,
      goal * sample.goalMultiplier,
    );
    if (roll === null) continue;
    shares.push(roll / Math.max(1, sample.point.rollBudget));
    if (roll === 1) oneRoll += 1;
  }
  shares.sort((a, b) => a - b);
  return {
    goal,
    cleared: shares.length,
    clearRate: samples.length ? shares.length / samples.length : 0,
    medianShare: quantile(shares, 0.5),
    p75Share: quantile(shares, 0.75),
    oneRollRate: shares.length ? oneRoll / shares.length : 0,
  };
}

/** Highest base goal whose normalized full-budget capacity still retains the
 * requested fraction. The subsequent trace evaluation accounts for exact goal
 * multipliers and exposes any discreteness around that threshold. */
function goalForClearRate(samples: Sample[], clearRate: number): number {
  const capacities = samples
    .map((sample) => sample.normalizedCapacity)
    .sort((a, b) => a - b);
  const threshold = quantile(capacities, 1 - clearRate);
  return Math.max(1, Math.floor(threshold));
}

function compact(result: Result): string {
  return `${pct(result.clearRate)} clear · ${pct(result.medianShare)} med · ${pct(result.oneRollRate)} one-roll`;
}

function sensitivityGoal(goal: number, factor: number): number {
  const scaled = goal * factor;
  return Math.max(1, factor < 1 ? Math.floor(scaled) : Math.ceil(scaled));
}

async function measureTrial(trial: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  const baseGoal = Number(trialGoal(trial));
  setFullBudgetTrial(trial);
  try {
    for (const series of SMART_SERIES) {
      seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
      installStorage([...series.unlockedAtStart]);
      for (let run = 0; run < RUNS; run++) {
        const record = simulateRun(
          series.strategy,
          seriesSeed(DEFAULT_CONFIG.seed, run, series.seedOffset),
          {
            ...seriesConfig(DEFAULT_CONFIG, series),
            traceRolls: true,
            stopAfterTrial: trial,
          },
        );
        const point = record.trajectory.find((entry) => entry.trial === trial);
        if (!point?.rollScores?.length) continue;
        const goalMultiplier = Math.max(1, point.goal / Math.max(1, baseGoal));
        samples.push({
          series: series.id,
          point,
          goalMultiplier,
          normalizedCapacity:
            point.rollScores[point.rollScores.length - 1] / goalMultiplier,
        });
      }
    }
  } finally {
    setFullBudgetTrial(null);
  }
  return samples;
}

console.log(
  `Smart pacing feasibility — ${RUNS} runs × ${SMART_SERIES.length} coherent series`,
);
console.log(
  `tempo test: median clear at ≥${pct(PACE_SHARE)} of budget; one-roll clears ≤${pct(MAX_ONE_ROLL)}`,
);

for (const trial of TRIALS) {
  const samples = await measureTrial(trial);
  if (samples.length === 0) {
    console.log(`\nTrial ${trial}: no smart builds reached it.`);
    continue;
  }

  const capacities = samples
    .map((sample) => sample.normalizedCapacity)
    .sort((a, b) => a - b);
  const p10 = quantile(capacities, 0.1);
  const p50 = quantile(capacities, 0.5);
  const p90 = quantile(capacities, 0.9);
  const spread = p10 > 0 ? p90 / p10 : Number.POSITIVE_INFINITY;
  const targetClear = targetTrialClearRate(trial);
  const live = resultFor(samples, Number(trialGoal(trial)));
  const targetGoal = goalForClearRate(samples, targetClear);
  const target = resultFor(samples, targetGoal);
  const feasible =
    target.clearRate >= targetClear - 0.01 &&
    target.medianShare >= PACE_SHARE &&
    target.oneRollRate <= MAX_ONE_ROLL;

  console.log(
    `\nTrial ${trial} — ${samples.length} entrants; target ${pct(targetClear)} clear`,
  );
  console.log(
    `capacity p10 ${p10.toLocaleString()} · p50 ${p50.toLocaleString()} · p90 ${p90.toLocaleString()} · spread ${Number.isFinite(spread) ? `${spread.toFixed(1)}×` : "∞"}`,
  );
  console.log(
    `  LIVE   goal ${live.goal.toLocaleString().padStart(14)} · ${compact(live)}`,
  );
  console.log(
    `  TARGET goal ${target.goal.toLocaleString().padStart(14)} · ${compact(target)} · ${feasible ? "FEASIBLE" : "NO scalar-goal fit"}`,
  );

  const frontier = FRONTIER_CLEAR_RATES.map((rate) => {
    const goal = goalForClearRate(samples, rate);
    return { requested: rate, result: resultFor(samples, goal) };
  }).filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) => candidate.result.goal === entry.result.goal,
      ) === index,
  );
  console.log(
    "  frontier (requested → actual clear / median share / one-roll):",
  );
  for (const entry of frontier)
    console.log(
      `    ${pct(entry.requested).padStart(6)} → goal ${entry.result.goal.toLocaleString().padStart(14)} · ${compact(entry.result)}`,
    );

  console.log("  target goal by archetype:");
  for (const series of SMART_SERIES) {
    const result = resultFor(
      samples.filter((sample) => sample.series === series.id),
      targetGoal,
    );
    console.log(`    ${series.id.padEnd(18)} ${compact(result)}`);
  }

  const ordered = [...samples].sort(
    (a, b) => a.normalizedCapacity - b.normalizedCapacity,
  );
  const deciles: string[] = [];
  for (let decile = 0; decile < 10; decile++) {
    const from = Math.floor((decile * ordered.length) / 10);
    const to = Math.floor(((decile + 1) * ordered.length) / 10);
    const result = resultFor(ordered.slice(from, to), targetGoal);
    deciles.push(
      `D${decile + 1} ${pct(result.clearRate)}/${pct(result.medianShare)}/${pct(result.oneRollRate)}`,
    );
  }
  console.log("  power deciles (clear / median share / one-roll):");
  console.log(`    ${deciles.join(" · ")}`);

  console.log("  target-goal sensitivity:");
  for (const factor of [0.9, 0.95, 1, 1.05, 1.1]) {
    const goal = sensitivityGoal(targetGoal, factor);
    const result = resultFor(samples, goal);
    console.log(
      `    ${(factor * 100).toFixed(0).padStart(3)}% → goal ${goal.toLocaleString().padStart(14)} · ${compact(result)}`,
    );
  }
}
