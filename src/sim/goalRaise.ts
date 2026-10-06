// How fast the win rate falls as the late goals rise.
//
// The shipped table sets each goal at the field's 80th percentile, yet whoever
// survives to the late ranks still clears about half of those trials on the
// opening roll. The obvious lever is to raise the late goals; this measures
// what that costs. It multiplies every goal from a chosen rank on by each
// factor in turn, plays the strategy grid (and, optionally, the expert) against
// each table with real culling, and prints win rate against first-roll clears.
//
// A variant changes goals only from its start trial on, and a run's trials
// before that depend only on the goals before it, so a run that died earlier
// under the base table dies the same way under every variant. Only the runs
// that reached the start trial are replayed (a few percent of the grid, so far
// more seeds are affordable than a full sweep), and every replay is checked
// against its base run up to that trial. The expert is the exception: its
// roll-outs play the ladder ahead, so it sees a raised goal from its first
// shop, and every expert run is replayed whole.
//
//   npm run goals:raise
//   FROM_RANK=5,8 FACTORS=2,10,100 SEEDS=3000 EXPERT_SEEDS=1000 npm run goals:raise
//
// | env          | default                      | what it does                              |
// | ------------ | ---------------------------- | ----------------------------------------- |
// | GOALS        | live                         | the base table (as goals:validate reads)  |
// | FROM_RANK    | 5                            | comma list: first rank whose goals rise   |
// | FACTORS      | 1.5,2,3,5,10,30,100,1000     | multipliers tried at each FROM_RANK       |
// | SHAPE        | flat                         | flat: every raised goal × factor. ramp:   |
// |              |                              | rises rank by rank to × factor at rank 10 |
// | SEEDS        | 2000                         | grid seeds                                |
// | EXPERT_SEEDS | 0                            | also run the (slow) expert on N seeds     |
// | SEED         | 3                            | base seed, held out from search/validate  |
// | SEARCH_RAW   | sim-out/goal-search-raw.json | goals-removed runs, to say what           |
// |              |                              | percentile of the field a goal sits at    |
// | OUT          | sim-out/goal-raise.json      | every variant's measurements              |
// | GRID_*       | see goalGrid.ts              | the strategy grid                         |

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { rankOf, TRIALS_PER_RANK, WIN_TRIAL } from "../config";
import {
  gridFromEnv,
  gridSeed,
  progressPrinter,
  runGrid,
  sortedCopy,
  type GridJob,
  type GridPoint,
  type GridResult,
} from "./goalGrid";
import { readGoalTable } from "./goalValidate";

const GOALS = process.env.GOALS ?? "live";
const FROM_RANKS = (process.env.FROM_RANK ?? "5").split(",").map(Number);
const FACTORS = (process.env.FACTORS ?? "1.5,2,3,5,10,30,100,1000")
  .split(",")
  .map(Number);
const SHAPE = (process.env.SHAPE ?? "flat") as "flat" | "ramp";
const SEEDS = Number(process.env.SEEDS ?? 2000);
const EXPERT_SEEDS = Number(process.env.EXPERT_SEEDS ?? 0);
const SEED = Number(process.env.SEED ?? 3);
const SEARCH_RAW = process.env.SEARCH_RAW ?? "sim-out/goal-search-raw.json";
const OUT = process.env.OUT ?? "sim-out/goal-raise.json";

/** The last rank with goals; the rank after it holds the duel. */
const LAST_RANK = (WIN_TRIAL - 1) / TRIALS_PER_RANK;
const firstTrialOf = (rank: number) => (rank - 1) * TRIALS_PER_RANK + 1;

if (SHAPE !== "flat" && SHAPE !== "ramp")
  throw new Error(`SHAPE: "${String(SHAPE)}" is not flat or ramp`);
for (const r of FROM_RANKS)
  if (!Number.isInteger(r) || r < 1 || r > Math.ceil(LAST_RANK))
    throw new Error(`FROM_RANK: ${r} is not a rank with goals`);
for (const f of FACTORS)
  if (!(f >= 1)) throw new Error(`FACTORS: ${f} must be at least 1`);

/** What a raised trial's goal is multiplied by. */
function factorAt(trial: number, fromRank: number, factor: number): number {
  const rank = rankOf(trial);
  if (rank < fromRank || trial >= WIN_TRIAL) return 1;
  if (SHAPE === "flat") return factor;
  const steps = Math.ceil(LAST_RANK) - fromRank + 1;
  return factor ** ((rank - fromRank + 1) / steps);
}

function raise(base: bigint[], fromRank: number, factor: number): bigint[] {
  return base.map((goal, i) => {
    const f = factorAt(i + 1, fromRank, factor);
    if (f === 1) return goal;
    // Exact for the integer factors; three decimals of a fractional one.
    return (goal * BigInt(Math.round(f * 1000))) / 1000n;
  });
}

function log10OfBig(v: bigint): number {
  if (v <= 0n) return -1;
  const digits = v.toString();
  const head = digits.slice(0, 15);
  return digits.length - head.length + Math.log10(Number(head));
}

// ---- the goals-removed field, for "this goal sits at pXX" ------------------

/** Per trial, every goals-removed run's full-budget score (log10), sorted. */
function loadField(): number[][] | null {
  const path = resolve(process.cwd(), SEARCH_RAW);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    results: { trials: { trial: number; log10: number }[] }[];
  };
  const byTrial: number[][] = Array.from({ length: WIN_TRIAL }, () => []);
  for (const run of raw.results)
    for (const t of run.trials) byTrial[t.trial - 1]?.push(t.log10);
  return byTrial.map(sortedCopy);
}

/** The share of the field whose full budget falls short of `goalLog10`. */
function fieldPercentile(sorted: number[], goalLog10: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < goalLog10) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length ? lo / sorted.length : NaN;
}

// ---- measuring one table ---------------------------------------------------

interface Measure {
  runs: number;
  wins: number;
  winRate: number;
  /** Runs that entered the first raised trial (identical in every variant). */
  reachedStart: number;
  /** Of those, the share that went on to win. */
  winGivenStart: number;
  /** Over the raised trials (duel excluded): clears, and of them the share on
   *  the opening roll and the mean share of the roll budget spent. */
  raisedClears: number;
  firstRollShare: number;
  budgetShare: number;
  /** Of the entries into a raised trial, the share cleared. */
  clearRate: number;
  /** Share of all runs that entered each trial (index = trial - 1). */
  alive: number[];
}

function measure(runs: GridResult[], fromTrial: number): Measure {
  const entered = new Array<number>(WIN_TRIAL).fill(0);
  let wins = 0;
  let reachedStart = 0;
  let winsFromStart = 0;
  let raisedEntries = 0;
  let raisedClears = 0;
  let firstRoll = 0;
  let budget = 0;
  for (const run of runs) {
    if (run.won) wins += 1;
    const reached = run.trials.some((t) => t.trial === fromTrial);
    if (reached) {
      reachedStart += 1;
      if (run.won) winsFromStart += 1;
    }
    for (const t of run.trials) {
      entered[t.trial - 1] += 1;
      if (t.trial < fromTrial || t.trial >= WIN_TRIAL) continue;
      raisedEntries += 1;
      if (!t.cleared) continue;
      raisedClears += 1;
      const on = t.clearedOnRoll ?? t.rollsUsed;
      if (on === 1) firstRoll += 1;
      budget += on / t.budget;
    }
  }
  return {
    runs: runs.length,
    wins,
    winRate: runs.length ? wins / runs.length : 0,
    reachedStart,
    winGivenStart: reachedStart ? winsFromStart / reachedStart : 0,
    raisedClears,
    firstRollShare: raisedClears ? firstRoll / raisedClears : 0,
    budgetShare: raisedClears ? budget / raisedClears : 0,
    clearRate: raisedEntries ? raisedClears / raisedEntries : 0,
    alive: entered.map((n) => (runs.length ? n / runs.length : 0)),
  };
}

interface Variant {
  fromRank: number;
  fromTrial: number;
  factor: number;
  shape: "flat" | "ramp";
  goals: string[];
  /** Median, over the raised trials, of the share of the goals-removed field
   *  whose whole budget falls short of the goal (null without SEARCH_RAW). */
  fieldPercentile: number | null;
  grid: Measure;
  expert: Measure | null;
}

async function main(): Promise<void> {
  const base = readGoalTable(GOALS);
  const grid = gridFromEnv();
  const expertPoint: GridPoint = {
    id: "expert/all/a0.5",
    strategy: "expert",
    pool: "all",
    curseAppetite: 0.5,
    character: grid[0]?.character ?? "diebert",
  };
  const jobOf = (point: GridPoint, i: number, goals: bigint[]): GridJob => ({
    mode: "validate",
    point,
    seedIndex: i,
    seed: gridSeed(SEED, i),
    goals,
    cadence: null,
    clearGold: null,
  });
  const baseJobs: GridJob[] = [];
  for (let i = 0; i < SEEDS; i++)
    for (const point of grid) baseJobs.push(jobOf(point, i, base));
  const expertFrom = baseJobs.length;
  if (EXPERT_SEEDS > 0 && !grid.some((p) => p.strategy === "expert"))
    for (let i = 0; i < EXPERT_SEEDS; i++)
      baseJobs.push(jobOf(expertPoint, i, base));
  const isExpert = (index: number) =>
    index >= expertFrom || baseJobs[index].point.strategy === "expert";

  console.log(
    `Raising goals from rank ${FROM_RANKS.join(" / ")} by ×${FACTORS.join(", ×")} (${SHAPE}): ` +
      `base ${GOALS}, ${SEEDS} seeds × ${grid.length} grid points` +
      (EXPERT_SEEDS > 0 ? `, expert on ${EXPERT_SEEDS}` : ""),
  );
  const baseResults = await runGrid(baseJobs, progressPrinter("base table"));
  const field = loadField();
  if (!field) console.log(`  (no ${SEARCH_RAW}: field percentiles skipped)`);

  const split = (results: GridResult[]) => ({
    grid: results.filter((_, i) => !isExpert(i)),
    expert: results.filter((_, i) => isExpert(i)),
  });

  const variants: Variant[] = [];
  let mismatches = 0;
  for (const fromRank of FROM_RANKS) {
    const fromTrial = firstTrialOf(fromRank);
    // The expert is replayed whole: its roll-outs play the ladder ahead, so a
    // raised late goal changes how it shops from the first visit on.
    const replay = baseResults
      .map((r, i) => ({ r, i }))
      .filter(
        ({ r, i }) =>
          isExpert(i) || r.trials.some((t) => t.trial === fromTrial),
      )
      .map(({ i }) => i);
    for (const factor of [1, ...FACTORS.filter((f) => f !== 1)]) {
      const goals = raise(base, fromRank, factor);
      let results = baseResults;
      if (factor !== 1) {
        const jobs = replay.map((i) => ({ ...baseJobs[i], goals }));
        const replayed = await runGrid(
          jobs,
          progressPrinter(`rank ${fromRank}+ ×${factor}`),
        );
        results = [...baseResults];
        replay.forEach((index, k) => {
          const before = baseResults[index].trials.filter(
            (t) => t.trial < fromTrial,
          );
          const after = replayed[k].trials.filter((t) => t.trial < fromTrial);
          const same =
            before.length === after.length &&
            before.every(
              (t, j) =>
                t.log10 === after[j].log10 &&
                t.clearedOnRoll === after[j].clearedOnRoll &&
                t.goldAfter === after[j].goldAfter,
            );
          if (!same && !isExpert(index)) mismatches += 1;
          results[index] = replayed[k];
        });
      }
      const raised = goals
        .map((g, i) => ({ trial: i + 1, log10: log10OfBig(g) }))
        .filter((g) => g.trial >= fromTrial && g.trial < WIN_TRIAL);
      const pcts = field
        ? sortedCopy(
            raised.map((g) => fieldPercentile(field[g.trial - 1], g.log10)),
          )
        : [];
      const { grid: gridRuns, expert: expertRuns } = split(results);
      variants.push({
        fromRank,
        fromTrial,
        factor,
        shape: SHAPE,
        goals: goals.map(String),
        fieldPercentile: pcts.length ? pcts[Math.floor(pcts.length / 2)] : null,
        grid: measure(gridRuns, fromTrial),
        expert: expertRuns.length ? measure(expertRuns, fromTrial) : null,
      });
    }
  }
  if (mismatches > 0)
    console.warn(
      `\n  WARNING: ${mismatches} grid replays diverged from their base run before the raised ` +
        `trials — a bot reads goals ahead, so the replay shortcut is not exact for this grid.`,
    );

  print(variants);
  const outPath = resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        kind: "goal-raise",
        createdAt: new Date().toISOString(),
        base: GOALS,
        baseGoals: base.map(String),
        seeds: SEEDS,
        expertSeeds: EXPERT_SEEDS,
        baseSeed: SEED,
        shape: SHAPE,
        grid: grid.map((p) => p.id),
        replayMismatches: mismatches,
        variants,
      },
      null,
      1,
    ),
  );
  console.log(`\nRaise sweep → ${outPath}`);
}

function print(variants: Variant[]): void {
  const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
  for (const fromRank of new Set(variants.map((v) => v.fromRank))) {
    const rows = variants.filter((v) => v.fromRank === fromRank);
    const base = rows.find((v) => v.factor === 1)!;
    const hasExpert = base.expert !== null;
    console.log(
      `\nGoals from rank ${fromRank} (trial ${base.fromTrial}) on, ${SHAPE}. ` +
        `Reached it: grid ${pct(base.grid.reachedStart / base.grid.runs)} (${base.grid.reachedStart} runs)` +
        (hasExpert
          ? `, expert ${pct(base.expert!.reachedStart / base.expert!.runs)} (${base.expert!.reachedStart} runs)`
          : ""),
    );
    console.log(
      "  factor | field pct | grid win | of reached | 1-roll | budget" +
        (hasExpert ? " | expert win | of reached | 1-roll | budget" : ""),
    );
    for (const v of rows) {
      const cells = [
        `×${v.factor}`.padStart(8),
        (v.fieldPercentile === null
          ? "-"
          : `p${(v.fieldPercentile * 100).toFixed(0)}`
        ).padStart(9),
        pct(v.grid.winRate, 2).padStart(8),
        pct(v.grid.winGivenStart).padStart(10),
        pct(v.grid.firstRollShare).padStart(6),
        pct(v.grid.budgetShare, 0).padStart(6),
      ];
      if (v.expert)
        cells.push(
          pct(v.expert.winRate).padStart(10),
          pct(v.expert.winGivenStart).padStart(10),
          pct(v.expert.firstRollShare).padStart(6),
          pct(v.expert.budgetShare, 0).padStart(6),
        );
      console.log(cells.join(" | "));
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
