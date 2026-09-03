// Matched-seed, simulation-only experiments for shorter trial cadences. Every
// scenario is restored before the next one; this file never changes live goals
// or live roll counts.

import {
  ROLLS_PER_TRIAL,
  setTrialGoals,
  setTrialRollCadenceForSimulation,
  trialGoal,
  type TrialRollCadence,
  WIN_TRIAL,
} from "../config";
import { simulateRun, type RunRecord, type TrialPoint } from "./bot";
import { DEFAULT_CONFIG } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { seriesConfig, seriesSeed, SMART_SERIES } from "./series";

interface Scenario {
  id: string;
  label: string;
  cadence: TrialRollCadence;
  goalScale?: number;
  goalScaleFromTrial?: number;
}

interface Metrics {
  scenario: Scenario;
  rankSurvival: number[];
  trialClearRate: number[];
  slotRollShare: number[];
  slotFirstRollRate: number[];
  meanGold: number;
  meanPurchases: number;
  winRate: number;
}

const RUNS = Math.max(1, Number(process.env.RUNS ?? 300) | 0);
const LIVE_GOALS = Array.from({ length: WIN_TRIAL }, (_, index) =>
  Number(trialGoal(index + 1)),
);

const SCENARIOS: Scenario[] = [
  {
    id: "baseline",
    label: `Live ${ROLLS_PER_TRIAL.join(" / ")}`,
    cadence: ROLLS_PER_TRIAL,
  },
  { id: "long-rollback", label: "7 / 15 / 20 rollback", cadence: [7, 15, 20] },
  { id: "modest", label: "7 / 13 / 18", cadence: [7, 13, 18] },
  { id: "balanced", label: "7 / 12 / 16", cadence: [7, 12, 16] },
  { id: "compact", label: "7 / 10 / 14", cadence: [7, 10, 14] },
  {
    id: "modest-late-95",
    label: "7 / 13 / 18 + ranks 4–9 goals ×0.95",
    cadence: [7, 13, 18],
    goalScale: 0.95,
    goalScaleFromTrial: 10,
  },
  {
    id: "modest-late-90",
    label: "7 / 13 / 18 + ranks 4–9 goals ×0.90",
    cadence: [7, 13, 18],
    goalScale: 0.9,
    goalScaleFromTrial: 10,
  },
  {
    id: "balanced-95",
    label: "7 / 12 / 16 + goals ×0.95",
    cadence: [7, 12, 16],
    goalScale: 0.95,
  },
  {
    id: "balanced-90",
    label: "7 / 12 / 16 + goals ×0.90",
    cadence: [7, 12, 16],
    goalScale: 0.9,
  },
];

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function clearedRank(record: RunRecord, rank: number): boolean {
  const trial = rank * 3;
  return record.trajectory.some(
    (point) => point.trial === trial && point.cleared,
  );
}

function pacing(points: TrialPoint[]): { share: number; firstRoll: number } {
  const clears = points.filter((point) => point.cleared && point.trial < 30);
  return {
    share: mean(
      clears.map(
        (point) =>
          (point.clearedOnRoll ?? point.rollsUsed) /
          Math.max(1, point.rollBudget),
      ),
    ),
    firstRoll: clears.length
      ? clears.filter((point) => (point.clearedOnRoll ?? point.rollsUsed) <= 1)
          .length / clears.length
      : 0,
  };
}

function applyScenario(scenario: Scenario): void {
  setTrialRollCadenceForSimulation(scenario.cadence);
  setTrialGoals(
    scenario.goalScale === undefined
      ? null
      : LIVE_GOALS.map((goal, index) =>
          index === WIN_TRIAL - 1 ||
          index + 1 < (scenario.goalScaleFromTrial ?? 1)
            ? goal
            : Math.max(1, Math.round(goal * scenario.goalScale!)),
        ),
  );
}

function runScenario(scenario: Scenario): Metrics {
  applyScenario(scenario);
  const records: RunRecord[] = [];
  for (const series of SMART_SERIES) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    for (let run = 0; run < RUNS; run++) {
      records.push(
        simulateRun(
          series.strategy,
          seriesSeed(DEFAULT_CONFIG.seed, run, series.seedOffset),
          seriesConfig(DEFAULT_CONFIG, series),
        ),
      );
    }
  }

  const points = records.flatMap((record) => record.trajectory);
  const slotPacing = Array.from({ length: 3 }, (_, slot) =>
    pacing(points.filter((point) => (point.trial - 1) % 3 === slot)),
  );
  return {
    scenario,
    rankSurvival: Array.from({ length: 10 }, (_, rank) =>
      mean(records.map((record) => (clearedRank(record, rank + 1) ? 1 : 0))),
    ),
    trialClearRate: Array.from({ length: WIN_TRIAL }, (_, index) => {
      const trialPoints = points.filter((point) => point.trial === index + 1);
      return mean(trialPoints.map((point) => (point.cleared ? 1 : 0)));
    }),
    slotRollShare: slotPacing.map((entry) => entry.share),
    slotFirstRollRate: slotPacing.map((entry) => entry.firstRoll),
    meanGold: mean(records.map((record) => record.goldEarned)),
    meanPurchases: mean(
      records.map((record) =>
        Object.values(record.purchases).reduce(
          (sum, count) => sum + (count ?? 0),
          0,
        ),
      ),
    ),
    winRate: mean(records.map((record) => (record.won ? 1 : 0))),
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

const requested = new Set(
  (process.env.SCENARIOS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
const selected = requested.size
  ? SCENARIOS.filter(
      (scenario) => scenario.id === "baseline" || requested.has(scenario.id),
    )
  : SCENARIOS;

console.log(
  `Duration experiments — ${RUNS} runs × ${SMART_SERIES.length} smart series`,
);
const results: Metrics[] = [];
try {
  for (const scenario of selected) {
    const started = Date.now();
    const metrics = runScenario(scenario);
    results.push(metrics);
    console.log(
      `  ${scenario.id.padEnd(13)} r3 ${pct(metrics.rankSurvival[2])} · ` +
        `r9 ${pct(metrics.rankSurvival[8])} · win ${pct(metrics.winRate)} · ` +
        `gold ${metrics.meanGold.toFixed(1)} · buys ${metrics.meanPurchases.toFixed(1)} ` +
        `(${((Date.now() - started) / 1_000).toFixed(1)}s)`,
    );
  }
} finally {
  setTrialGoals(null);
  setTrialRollCadenceForSimulation(null);
}

console.log("\nSmart-build survival by rank:");
console.log(
  "scenario          r1    r2    r3    r4    r5    r6    r7    r8    r9   r10",
);
for (const result of results) {
  console.log(
    `${result.scenario.label.padEnd(25)} ${result.rankSurvival
      .map((value) => pct(value).padStart(5))
      .join(" ")}`,
  );
}

console.log("\nPacing by slot (budget used / opening-roll clears):");
for (const result of results) {
  console.log(
    `${result.scenario.label.padEnd(25)} ` +
      result.slotRollShare
        .map(
          (share, index) =>
            `${pct(share)}/${pct(result.slotFirstRollRate[index])}`,
        )
        .join("  "),
  );
}

console.log("\nConditional clear rates by trial:");
console.log(
  "scenario          t1    t2    t3    t4    t5    t6    t7    t8    t9  ...",
);
for (const result of results) {
  const opening = result.trialClearRate.slice(0, 9).map(pct).join(" ");
  const late = mean(result.trialClearRate.slice(9, 29));
  console.log(
    `${result.scenario.label.padEnd(25)} ${opening}  late ${pct(late)}`,
  );
}
