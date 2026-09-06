// Validation pass for a candidate goal curve (the "re-test" step).
//
// designTargets.ts designs curves analytically from trivial-goal trajectories,
// where nothing is ever culled. This script sets one of those curves as the live
// override and runs the REAL sim — actual survival gate, real culling, real
// gold spent on real shops — so it confirms the predicted death spread holds up,
// and regenerates sim-out/report.html against the new curve.
//
// Run: CURVE="DESIGNED (5-rank intent)" npx tsx src/sim/validate.ts
//
// Not shipped with the game; delete when balancing is done.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, GATED_ITEM_IDS } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { RunRecord, simulateRun } from "./bot";
import { aggregate } from "./stats";
import { buildReport } from "./report";
import {
  seriesConfig,
  seriesSeed,
  SHOPPER_SERIES,
  SIM_SERIES,
  tunerField,
  tunerFieldName,
} from "./series";
import { targetSurvivalAfterTrial } from "./survivalTargets";
import {
  setTrialGoals,
  TRIALS_PER_RANK,
  trialGoal,
  WIN_RANK,
  WIN_TRIAL,
} from "../config";

// CURVE=LIVE re-tests the curve the game actually ships (src/config.ts) rather
// than a candidate, which is how a hand-edited TRIAL_GOALS gets measured without
// a round trip through candidate.json. RUNS overrides the batch size.
const label = process.env.CURVE ?? "DESIGNED (5-rank intent)";
const runs = Number(process.env.RUNS ?? DEFAULT_CONFIG.runs);
let curve: number[];
if (label === "LIVE") {
  curve = Array.from({ length: WIN_TRIAL }, (_, i) => Number(trialGoal(i + 1)));
} else {
  const curves = JSON.parse(
    readFileSync("sim-out/candidate.json", "utf8"),
  ) as Record<string, number[]>;
  const found = curves[label];
  if (!found)
    throw new Error(
      `No curve "${label}" in candidate.json. Have: ${Object.keys(curves).join(" | ")}`,
    );
  curve = found;
  setTrialGoals(curve); // <-- the real survival gate now uses the candidate curve
}

console.log(`Validating "${label}" with REAL culling - ${runs} runs/series`);
console.log("curve = [" + curve.join(", ") + "]\n");

const byStrategy: Record<string, RunRecord[]> = {};
for (const series of SIM_SERIES) {
  seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
  installStorage([...series.unlockedAtStart]);
  const records: RunRecord[] = [];
  for (let i = 0; i < runs; i++) {
    records.push(
      simulateRun(
        series.strategy,
        seriesSeed(DEFAULT_CONFIG.seed, i, series.seedOffset),
        seriesConfig(DEFAULT_CONFIG, series),
      ),
    );
  }
  byStrategy[series.id] = records;
  const wins = records.filter((r) => r.won).length;
  const hist = new Array(WIN_RANK).fill(0);
  for (const r of records) hist[Math.min(WIN_RANK, r.rankReached) - 1]++;
  const bars = hist
    .map((c, i) => (c > 0 ? `rank${i + 1}=${c}` : ""))
    .filter(Boolean)
    .join("  ");
  console.log(
    `${series.id.padEnd(20)} win ${((wins / records.length) * 100).toFixed(1)}%  | deaths: ${bars}`,
  );
}

const pooled = SHOPPER_SERIES.flatMap((series) => byStrategy[series.id]);
const field = tunerField().flatMap((series) => byStrategy[series.id]);
let alive = pooled;
console.log("\nPooled field (the README attrition measure):");
console.log(
  "trial | rank |     goal | entrants | died | die% field | survivors | field alive",
);
for (let trial = 1; trial <= WIN_TRIAL; trial++) {
  const rank = Math.ceil(trial / TRIALS_PER_RANK);
  const entrants = alive.length;
  const survivors = alive.filter(
    (record) => record.won || record.trialReached > trial,
  );
  const died = entrants - survivors.length;
  console.log(
    `${String(trial).padStart(5)} | ${String(rank).padStart(4)} | ${trialGoal(trial).toLocaleString().padStart(8)} | ` +
      `${String(entrants).padStart(8)} | ${String(died).padStart(4)} | ` +
      `${((died / pooled.length) * 100).toFixed(1).padStart(10)}% | ` +
      `${String(survivors.length).padStart(9)} | ${((survivors.length / pooled.length) * 100).toFixed(1).padStart(10)}%`,
  );
  alive = survivors;
}

console.log(`\n${tunerFieldName()}-field survival by rank:`);
for (let rank = 1; rank <= WIN_RANK; rank++) {
  const lastTrial = rank * TRIALS_PER_RANK;
  const survivors = field.filter(
    (record) => record.won || record.trialReached > lastTrial,
  ).length;
  console.log(
    `  rank ${String(rank).padStart(2)}  ` +
      `${((survivors / field.length) * 100).toFixed(1).padStart(5)}% alive` +
      `  (target ${(targetSurvivalAfterTrial(lastTrial) * 100).toFixed(1)}%)`,
  );
}

printPacing(pooled);

// Per-boss clear rates: the signal for whether any one modifier is unfair. A
// modifier far outside the average is doing more (or less) than its peers.
const bossTally = new Map<string, { faced: number; cleared: number }>();
for (const record of pooled) {
  for (const [id, tally] of Object.entries(record.bossesFaced)) {
    const acc = bossTally.get(id) ?? { faced: 0, cleared: 0 };
    acc.faced += tally!.faced;
    acc.cleared += tally!.cleared;
    bossTally.set(id, acc);
  }
}
if (bossTally.size > 0) {
  const rates = [...bossTally.entries()].map(([id, t]) => ({
    id,
    faced: t.faced,
    rate: t.faced > 0 ? t.cleared / t.faced : 0,
  }));
  const mean = rates.reduce((a, r) => a + r.rate, 0) / rates.length;
  console.log(
    "\nBoss Trial clear rates (mean " + (mean * 100).toFixed(1) + "%):",
  );
  for (const r of rates.sort((a, b) => b.rate - a.rate)) {
    const ratio = mean > 0 ? r.rate / mean : 1;
    const flag = ratio < 0.6 || ratio > 1.4 ? "  <-- out of band" : "";
    console.log(
      `  ${r.id.padEnd(11)} ${(r.rate * 100).toFixed(1).padStart(5)}%  (${r.faced} faced, ${ratio.toFixed(2)}x mean)${flag}`,
    );
  }
}

/**
 * Pooled roll pacing: how much of each trial's budget the field spent before
 * crossing its goal. The companion to the attrition table — attrition says
 * whether a goal kills the right number of runs, this says whether the survivors
 * had to play the trial to get past it. Cleared trials only, since a trial a run
 * died on always burned its whole budget.
 */
function printPacing(pooled: RunRecord[]): void {
  console.log("\nRoll pacing (cleared trials only):");
  console.log(
    "trial | rank | rolls used | budget | share | 1-roll clears | clears",
  );
  for (let trial = 1; trial <= WIN_TRIAL; trial++) {
    let used = 0;
    let budget = 0;
    let firstRoll = 0;
    let clears = 0;
    for (const record of pooled) {
      const point = record.trajectory.find((p) => p.trial === trial);
      if (!point || !point.cleared) continue;
      const at = point.clearedOnRoll ?? point.rollsUsed;
      clears += 1;
      used += at;
      budget += point.rollBudget;
      if (at <= 1) firstRoll += 1;
    }
    if (clears === 0) continue;
    console.log(
      `${String(trial).padStart(5)} | ${String(Math.ceil(trial / TRIALS_PER_RANK)).padStart(4)} | ` +
        `${(used / clears).toFixed(1).padStart(10)} | ${(budget / clears).toFixed(1).padStart(6)} | ` +
        `${((used / budget) * 100).toFixed(0).padStart(4)}% | ` +
        `${((firstRoll / clears) * 100).toFixed(0).padStart(12)}% | ${String(clears).padStart(6)}`,
    );
  }
}

const stats = aggregate(byStrategy, {
  seed: DEFAULT_CONFIG.seed,
  unlockPools: [
    { name: "Base items only", gatedItems: 0 },
    { name: "All unlocked", gatedItems: GATED_ITEM_IDS.length },
  ],
});
const out = resolve(process.cwd(), "sim-out/report.html");
mkdirSync(resolve(process.cwd(), "sim-out"), { recursive: true });
writeFileSync(out, buildReport(stats), "utf8");
console.log(`\nRegenerated report against the candidate curve -> ${out}`);
