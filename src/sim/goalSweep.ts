// Grade every goal table one goal search derived, with real culling.
//
// The search (goalSearch.ts) measures once and derives a table per percentile;
// this plays the strategy grid against each of them on held-out seeds and
// prints the trade-off in one table: how many runs win, how far the median run
// gets, and how many clears come on the opening roll. It is the step between
// "what does the field score" and "which percentile is the game".
//
//   npm run goals:sweep
//   TABLES="0.5;0.6;0.7" SEEDS=300 npm run goals:sweep
//
// | env     | default                  | what it does                                |
// | ------- | ------------------------ | ------------------------------------------- |
// | SEARCH  | sim-out/goal-search.json | the search whose tables are graded          |
// | TABLES  | every table in it        | `;`-separated table keys (a key may be a     |
// |         |                          | per-rank schedule like `0.5,0.6,…`)          |
// | SEEDS   | 200                      | seeds per table                             |
// | SEED    | 2                        | base seed, held out from the search's       |
// | OUT     | sim-out/goal-sweep.json  | every table's validation summary            |
// | GRID_*  | see goalGrid.ts          | the strategy grid                           |

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WIN_TRIAL } from "../config";
import {
  gridFromEnv,
  gridSeed,
  progressPrinter,
  runGrid,
  type GridJob,
} from "./goalGrid";
import { readGoalTable, summarise, type ValidateSummary } from "./goalValidate";

const SEARCH = process.env.SEARCH ?? "sim-out/goal-search.json";
const SEEDS = Number(process.env.SEEDS ?? 200);
const SEED = Number(process.env.SEED ?? 2);
const OUT = process.env.OUT ?? "sim-out/goal-sweep.json";

async function main(): Promise<void> {
  const search = JSON.parse(readFileSync(SEARCH, "utf8")) as {
    tables: Record<string, unknown>;
  };
  const keys = process.env.TABLES
    ? process.env.TABLES.split(";").map((k) => k.trim())
    : Object.keys(search.tables);
  const grid = gridFromEnv();
  const summaries: ValidateSummary[] = [];
  for (const key of keys) {
    const goals = readGoalTable(`${SEARCH}#${key}`);
    const jobs: GridJob[] = [];
    for (let i = 0; i < SEEDS; i++)
      for (const point of grid)
        jobs.push({
          mode: "validate",
          point,
          seedIndex: i,
          seed: gridSeed(SEED, i),
          goals,
          cadence: null,
          clearGold: null,
        });
    const results = await runGrid(jobs, progressPrinter(`p ${key}`));
    summaries.push(summarise(results, grid, goals, `percentile ${key}`));
  }

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(
    "\npercentile       |   win | median trial | reach rank 4 | reach rank 7 | 1-roll clears | budget used",
  );
  for (const s of summaries) {
    const clears = s.trials.slice(1, WIN_TRIAL - 1);
    const weight = clears.reduce((a, t) => a + t.entered * t.clearRate, 0);
    const budget =
      clears.reduce((a, t) => a + t.entered * t.clearRate * t.budgetShare, 0) /
      (weight || 1);
    console.log(
      `${s.label.replace("percentile ", "").padEnd(16)} | ${pct(s.winRate).padStart(5)} | ` +
        `${String(s.medianTrialReached).padStart(12)} | ${pct(s.trials[9].alive).padStart(12)} | ` +
        `${pct(s.trials[18].alive).padStart(12)} | ${pct(s.firstRollShare).padStart(13)} | ${pct(budget).padStart(11)}`,
    );
  }
  const outPath = resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ kind: "goal-sweep", summaries }, null, 1),
  );
  console.log(`\nSweep → ${outPath}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
