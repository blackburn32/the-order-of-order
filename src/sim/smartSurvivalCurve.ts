// Designs the live goal table against the coherent all-unlocked bot field and
// an absolute rank-survival schedule. Each trial is replayed uncensored so the
// next goal is chosen from what entrants could score, not from the old goal.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  setTrialGoals,
  TRIALS_PER_RANK,
  trialGoal,
  WIN_RANK,
  WIN_TRIAL,
} from "../config";
import { simulateRun, type TrialPoint } from "./bot";
import { DEFAULT_CONFIG } from "./config";
import { setFullBudgetTrial } from "./engine";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { seriesConfig, seriesSeed, tunerField, tunerFieldName } from "./series";
import { targetSurvivalAfterTrial } from "./survivalTargets";

const FIELD = tunerField();
const RUNS = Math.max(1, Number(process.env.RUNS ?? 300) | 0);
const FROM = Math.max(2, Number(process.env.FROM ?? 2) | 0);

function round2sig(value: number): number {
  if (value < 100) return Math.max(1, Math.ceil(value));
  const exponent = Math.floor(Math.log10(value));
  const mantissa = Math.round(value / 10 ** (exponent - 1));
  return Number(BigInt(mantissa) * 10n ** BigInt(Math.max(0, exponent - 1)));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 1;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * (sorted.length - 1))),
  );
  return sorted[index];
}

function measureTrial(trial: number, curve: number[]): TrialPoint[] {
  setTrialGoals(curve);
  setFullBudgetTrial(trial);
  const points: TrialPoint[] = [];
  for (const series of FIELD) {
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
      if (point?.rollScores?.length) points.push(point);
    }
  }
  setFullBudgetTrial(null);
  return points;
}

function capacity(point: TrialPoint): number {
  return point.rollScores![point.rollScores!.length - 1];
}

function rollReached(scores: number[], goal: number): number | null {
  const index = scores.findIndex((score) => score >= goal);
  return index < 0 ? null : index + 1;
}

const totalRuns = RUNS * FIELD.length;
const curve = Array.from({ length: WIN_TRIAL }, (_, index) =>
  Number(trialGoal(index + 1)),
);

console.log(
  `Survival tune against the ${tunerFieldName()} field — ` +
    `${RUNS} runs × ${FIELD.length} series`,
);
console.log(
  "trial | rank | entrants | target alive | goal | projected alive | median roll",
);

// Trial 1 is intentionally left alone. Its single-d6 variance sets the maximum
// surviving cohort; the rest of the opening acts are tuned around that fact.
for (let trial = FROM; trial < WIN_TRIAL; trial++) {
  const points = measureTrial(trial, curve);
  const target = targetSurvivalAfterTrial(trial);
  const desiredSurvivors = target * totalRuns;
  const keep = Math.min(1, desiredSurvivors / Math.max(1, points.length));
  const oldGoal = curve[trial - 1];
  const normalized = points
    .map((point) => {
      const multiplier = Math.max(1, point.goal / Math.max(1, oldGoal));
      return capacity(point) / multiplier;
    })
    .sort((a, b) => a - b);
  let goal = round2sig(quantile(normalized, 1 - keep));
  if (trial > TRIALS_PER_RANK)
    goal = Math.max(goal, curve[trial - TRIALS_PER_RANK - 1]);
  if ((trial - 1) % TRIALS_PER_RANK !== 0)
    goal = Math.max(goal, curve[trial - 2]);
  curve[trial - 1] = goal;

  const reached = points
    .map((point) => {
      const multiplier = Math.max(1, point.goal / Math.max(1, oldGoal));
      return rollReached(point.rollScores!, goal * multiplier);
    })
    .filter((roll): roll is number => roll !== null)
    .sort((a, b) => a - b);
  const projected = reached.length / totalRuns;
  const medianRoll = reached.length ? quantile(reached, 0.5) : 0;
  console.log(
    `${String(trial).padStart(5)} | ${String(Math.ceil(trial / 3)).padStart(4)} | ` +
      `${String(points.length).padStart(8)} | ${(target * 100).toFixed(1).padStart(11)}% | ` +
      `${goal.toLocaleString().padStart(13)} | ${(projected * 100).toFixed(1).padStart(14)}% | ` +
      `${String(medianRoll).padStart(11)}`,
  );
}

// The duel has no score goal. Continue the last real Boss-slot growth so the
// endless ladder still has a sound first step after it.
const rank8Boss = curve[8 * TRIALS_PER_RANK - 1];
const rank9Boss = curve[9 * TRIALS_PER_RANK - 1];
const bossRatio = rank8Boss > 0 ? rank9Boss / rank8Boss : 2;
curve[WIN_TRIAL - 1] = round2sig(rank9Boss * Math.max(1, bossRatio));

console.log("\nAUTHORED_GOALS:");
for (let rank = 1; rank <= WIN_RANK; rank++) {
  const values = curve.slice((rank - 1) * 3, rank * 3);
  console.log(`  // rank ${rank}`);
  for (const value of values)
    console.log(
      `  ${BigInt(Math.round(value)).toLocaleString("fullwide", { useGrouping: false })}n,`,
    );
}

setTrialGoals(null);
const candidatePath = "sim-out/candidate.json";
const candidates = existsSync(candidatePath)
  ? JSON.parse(readFileSync(candidatePath, "utf8"))
  : {};
// Named for the field it was designed against: a curve set by the expert is a
// different design decision from one set by the price-and-theme shoppers, and
// two of them must not overwrite each other in the candidate file.
const curveName =
  tunerFieldName() === "smart"
    ? "SMART_SURVIVAL"
    : `${tunerFieldName().toUpperCase()}_SURVIVAL`;
candidates[curveName] = curve;
writeFileSync(candidatePath, JSON.stringify(candidates, null, 2));
console.log(`\nWrote ${curveName} to ${candidatePath}`);
