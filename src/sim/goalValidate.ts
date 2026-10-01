// The validation pass: the strategy grid plays the real game, goals on and
// culling on, and this measures what share of it gets where.
//
// The grid is the same one the goal search designs from (sim/goalGrid.ts), but
// played on a different base seed, so a goal table is never graded on the
// very runs it was measured from. The report (sim/goalReport.ts) compares two of
// these summaries — a baseline and a candidate — side by side.
//
//   npm run goals:validate                                   # the live goals
//   GOALS=sim-out/goal-search.json npm run goals:validate    # a candidate table
//   LABEL=before OUT=sim-out/goal-validate-before.json npm run goals:validate
//
// | env          | default                       | what it does                               |
// | ------------ | ----------------------------- | ------------------------------------------ |
// | SEEDS        | 200                           | seeds; every grid point plays every one    |
// | SEED         | 2                             | base seed (the search's default is 1)      |
// | GOALS        | live                          | `live`, or a goal-search JSON's `goals`    |
// | LABEL        | the GOALS value               | a name for the report                      |
// | EXPERT_SEEDS | 0                             | also run the (slow) expert on N seeds      |
// | OUT          | sim-out/goal-validate.json    | the summary the report reads               |
// | GRID_*       | see goalGrid.ts               | the strategy grid                          |

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  rankOf,
  rollsForTrial,
  TRIALS_PER_RANK,
  trialGoal,
  trialInRank,
  WIN_TRIAL,
} from "../config";
import { AFFLICTIONS } from "../systems/Afflictions";
import { BOOSTER_PACKS, PRICE_BANDS, rerollCost } from "../systems/Shop";
import {
  gridFromEnv,
  gridSeed,
  nearestRank,
  progressPrinter,
  runGrid,
  sortedCopy,
  type GridJob,
  type GridPoint,
  type GridResult,
} from "./goalGrid";

const SEEDS = Number(process.env.SEEDS ?? 200);
const SEED = Number(process.env.SEED ?? 2);
const GOALS = process.env.GOALS ?? "live";
const LABEL = process.env.LABEL ?? GOALS;
const EXPERT_SEEDS = Number(process.env.EXPERT_SEEDS ?? 0);
const OUT = process.env.OUT ?? "sim-out/goal-validate.json";

/**
 * The goal table a GOALS value names: `live` for config.ts, a goal-search JSON
 * for its primary table, or `<file>#<key>` for one of the tables it derived
 * (`sim-out/goal-search.json#0.6`, or a per-rank schedule's key).
 */
export function readGoalTable(spec: string): bigint[] {
  if (spec === "live")
    return Array.from({ length: WIN_TRIAL }, (_, i) => trialGoal(i + 1));
  const [file, key] = spec.split("#");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    goals?: string[];
    tables?: Record<string, { goals: string[] }>;
  };
  const goals = key === undefined ? parsed.goals : parsed.tables?.[key]?.goals;
  if (!goals || goals.length < WIN_TRIAL)
    throw new Error(
      `${spec}: no ${WIN_TRIAL}-entry goal table` +
        (key !== undefined && parsed.tables
          ? `. Tables: ${Object.keys(parsed.tables).join(" | ")}`
          : ""),
    );
  return goals.slice(0, WIN_TRIAL).map((g) => BigInt(g));
}

function log10OfBig(v: bigint): number {
  if (v <= 0n) return -1;
  const digits = v.toString();
  const head = digits.slice(0, 15);
  return digits.length - head.length + Math.log10(Number(head));
}

/** Per-trial tallies over a set of runs. */
interface TrialTally {
  entered: number;
  cleared: number;
  firstRoll: number;
  /** Sum over clears of the share of the budget spent before the goal fell. */
  budgetShare: number;
  rollsToClear: number[];
}

function tallyTrials(runs: GridResult[]): TrialTally[] {
  const out: TrialTally[] = Array.from({ length: WIN_TRIAL }, () => ({
    entered: 0,
    cleared: 0,
    firstRoll: 0,
    budgetShare: 0,
    rollsToClear: [],
  }));
  for (const run of runs) {
    for (const t of run.trials) {
      const row = out[t.trial - 1];
      if (!row) continue;
      row.entered += 1;
      if (!t.cleared) continue;
      row.cleared += 1;
      // The duel has no goal to fall; it always runs its ten rolls.
      const on = t.clearedOnRoll ?? t.rollsUsed;
      if (t.trial < WIN_TRIAL && on === 1) row.firstRoll += 1;
      row.budgetShare += on / t.budget;
      row.rollsToClear.push(on);
    }
  }
  return out;
}

export interface ValidateTrialRow {
  trial: number;
  rank: number;
  slot: number;
  budget: number;
  goal: string;
  goalLog10: number;
  /** Share of all runs that entered this trial. */
  alive: number;
  /** Of the runs that entered, the share that cleared it. */
  clearRate: number;
  /** Of the clears, the share that came on the opening roll. */
  firstRollShare: number;
  /** Of the clears, the mean share of the roll budget spent. */
  budgetShare: number;
  medianRollsToClear: number | null;
  entered: number;
}

export interface ValidateSummary {
  kind: "goal-validate";
  label: string;
  createdAt: string;
  seeds: number;
  baseSeed: number;
  cadence: number[];
  rerollPrices: number[];
  priceBands: Record<string, number>;
  packPrices: Record<string, number>;
  hungerRolls: number;
  goals: string[];
  runs: number;
  winRate: number;
  /** Clears on the opening roll, as a share of all clears (duel excluded). */
  firstRollShare: number;
  medianTrialReached: number;
  trials: ValidateTrialRow[];
  /** Runs that ended on each trial (index = trial - 1); winners are counted
   *  separately in `wins`. */
  deaths: number[];
  wins: number;
  strategies: {
    strategy: string;
    runs: number;
    winRate: number;
    medianTrialReached: number;
    firstRollShare: number;
    alive: number[];
  }[];
  points: {
    id: string;
    runs: number;
    winRate: number;
    medianTrialReached: number;
  }[];
  bosses: { boss: string; faced: number; cleared: number }[];
  /** What a shop opens with, by rank, among the runs that reached it. */
  shopGold: {
    rank: number;
    p25: number;
    p50: number;
    p75: number;
    rerollsAffordable: Record<string, number>;
  }[];
}

function firstRollShareOf(tallies: TrialTally[]): number {
  let first = 0;
  let clears = 0;
  tallies.forEach((t, i) => {
    if (i + 1 >= WIN_TRIAL) return;
    first += t.firstRoll;
    clears += t.cleared;
  });
  return clears ? first / clears : 0;
}

function medianTrial(runs: GridResult[]): number {
  return nearestRank(
    sortedCopy(runs.map((r) => (r.won ? WIN_TRIAL + 1 : r.trialReached))),
    0.5,
  );
}

export function summarise(
  results: GridResult[],
  grid: GridPoint[],
  goals: bigint[],
  label = LABEL,
): ValidateSummary {
  const tallies = tallyTrials(results);
  const total = results.length;
  const deaths = new Array<number>(WIN_TRIAL).fill(0);
  let wins = 0;
  for (const r of results) {
    if (r.won) wins += 1;
    else deaths[r.trialReached - 1] += 1;
  }

  const trials: ValidateTrialRow[] = tallies.map((t, i) => ({
    trial: i + 1,
    rank: rankOf(i + 1),
    slot: trialInRank(i + 1),
    budget: rollsForTrial(i + 1),
    goal: goals[i].toString(),
    goalLog10: log10OfBig(goals[i]),
    alive: total ? t.entered / total : 0,
    clearRate: t.entered ? t.cleared / t.entered : 0,
    firstRollShare: t.cleared ? t.firstRoll / t.cleared : 0,
    budgetShare: t.cleared ? t.budgetShare / t.cleared : 0,
    medianRollsToClear: t.rollsToClear.length
      ? nearestRank(sortedCopy(t.rollsToClear), 0.5)
      : null,
    entered: t.entered,
  }));

  const byStrategy = new Map<string, GridResult[]>();
  const byPoint = new Map<string, GridResult[]>();
  for (const r of results) {
    const strategy = r.pointId.split("/")[0];
    (
      byStrategy.get(strategy) ?? byStrategy.set(strategy, []).get(strategy)!
    ).push(r);
    (byPoint.get(r.pointId) ?? byPoint.set(r.pointId, []).get(r.pointId)!).push(
      r,
    );
  }

  const bossTally = new Map<string, { faced: number; cleared: number }>();
  for (const r of results)
    for (const t of r.trials) {
      if (!t.boss) continue;
      const b = bossTally.get(t.boss) ?? { faced: 0, cleared: 0 };
      b.faced += 1;
      if (t.cleared) b.cleared += 1;
      bossTally.set(t.boss, b);
    }

  const shopGold: ValidateSummary["shopGold"] = [];
  for (let rank = 1; rank <= WIN_TRIAL / TRIALS_PER_RANK; rank++) {
    const purses = sortedCopy(
      results.flatMap((r) =>
        r.trials
          .filter(
            (t) => rankOf(t.trial) === rank && t.cleared && t.trial < WIN_TRIAL,
          )
          .map((t) => t.goldAfter),
      ),
    );
    if (purses.length === 0) continue;
    const afford: Record<string, number> = {};
    for (const purse of purses) {
      let k = 0;
      let spent = 0;
      while (k < 6 && spent + rerollCost(k) <= purse) spent += rerollCost(k++);
      afford[k] = (afford[k] ?? 0) + 1 / purses.length;
    }
    shopGold.push({
      rank,
      p25: nearestRank(purses, 0.25),
      p50: nearestRank(purses, 0.5),
      p75: nearestRank(purses, 0.75),
      rerollsAffordable: afford,
    });
  }

  return {
    kind: "goal-validate",
    label,
    createdAt: new Date().toISOString(),
    seeds: SEEDS,
    baseSeed: SEED,
    cadence: [1, 2, 3].map((t) => rollsForTrial(t)),
    rerollPrices: [0, 1, 2, 3].map((k) => rerollCost(k)),
    priceBands: { ...PRICE_BANDS },
    packPrices: Object.fromEntries(BOOSTER_PACKS.map((p) => [p.id, p.cost])),
    hungerRolls: AFFLICTIONS.hunger.rollDelta ?? 0,
    goals: goals.map(String),
    runs: total,
    winRate: total ? wins / total : 0,
    firstRollShare: firstRollShareOf(tallies),
    medianTrialReached: medianTrial(results),
    trials,
    deaths,
    wins,
    strategies: [...byStrategy.entries()].map(([strategy, runs]) => {
      const t = tallyTrials(runs);
      return {
        strategy,
        runs: runs.length,
        winRate: runs.filter((r) => r.won).length / runs.length,
        medianTrialReached: medianTrial(runs),
        firstRollShare: firstRollShareOf(t),
        alive: t.map((row) => row.entered / runs.length),
      };
    }),
    points: grid
      .filter((p) => byPoint.has(p.id))
      .map((p) => {
        const runs = byPoint.get(p.id)!;
        return {
          id: p.id,
          runs: runs.length,
          winRate: runs.filter((r) => r.won).length / runs.length,
          medianTrialReached: medianTrial(runs),
        };
      }),
    bosses: [...bossTally.entries()]
      .map(([boss, b]) => ({ boss, ...b }))
      .sort((a, b) => b.cleared / b.faced - a.cleared / a.faced),
    shopGold,
  };
}

async function main(): Promise<void> {
  const goals = readGoalTable(GOALS);
  const grid = gridFromEnv();
  const jobs: GridJob[] = [];
  const job = (point: GridPoint, i: number): GridJob => ({
    mode: "validate",
    point,
    seedIndex: i,
    seed: gridSeed(SEED, i),
    goals,
    cadence: null,
    clearGold: null,
  });
  for (let i = 0; i < SEEDS; i++)
    for (const point of grid) jobs.push(job(point, i));
  const expert: GridPoint = {
    id: "expert/all/a0.5",
    strategy: "expert",
    pool: "all",
    curseAppetite: 0.5,
    character: grid[0]?.character ?? "diebert",
  };
  if (EXPERT_SEEDS > 0 && !grid.some((p) => p.strategy === "expert")) {
    grid.push(expert);
    for (let i = 0; i < EXPERT_SEEDS; i++) jobs.push(job(expert, i));
  }

  console.log(
    `Validating "${LABEL}": ${jobs.length} runs (${SEEDS} seeds × ${grid.length} grid points` +
      (EXPERT_SEEDS > 0 ? `, expert on ${EXPERT_SEEDS}` : "") +
      `), cadence ${[1, 2, 3].map((t) => rollsForTrial(t)).join("/")}, goals on`,
  );
  const results = await runGrid(jobs, progressPrinter("validate"));
  const summary = summarise(results, grid, goals);
  const outPath = resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 1));
  print(summary);
  console.log(`\nSummary → ${outPath}`);
}

export function print(s: ValidateSummary): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);
  console.log(
    `\n${s.runs} runs · win ${pct(s.winRate)} · median trial ${s.medianTrialReached} · ` +
      `${pct(s.firstRollShare)} of clears on roll 1`,
  );
  console.log(
    "\ntrial | r-s |      goal |  alive | clear% | 1-roll | budget used | med roll",
  );
  for (const t of s.trials) {
    if (t.entered === 0) continue;
    console.log(
      `${String(t.trial).padStart(5)} | ${t.rank}-${t.slot}`.padEnd(13) +
        ` | ${(t.goalLog10 < 6 ? Number(t.goal).toLocaleString() : `1e${t.goalLog10.toFixed(1)}`).padStart(9)} | ` +
        `${pct(t.alive)} | ${pct(t.clearRate)} | ${pct(t.firstRollShare)} | ${pct(t.budgetShare).padStart(11)} | ${String(t.medianRollsToClear ?? "-").padStart(8)}`,
    );
  }
  console.log("\nBy strategy (over appetites):");
  for (const st of [...s.strategies].sort((a, b) => b.winRate - a.winRate)) {
    console.log(
      `  ${st.strategy.padEnd(11)} win ${pct(st.winRate)}  median trial ${String(st.medianTrialReached).padStart(2)}  1-roll ${pct(st.firstRollShare)}  (${st.runs} runs)`,
    );
  }
  console.log("\nBoss Trials:");
  for (const b of s.bosses)
    console.log(
      `  ${b.boss.padEnd(8)} ${pct(b.cleared / b.faced)} cleared of ${b.faced}`,
    );
  console.log("\nGold as a shop opens:");
  for (const g of s.shopGold) {
    const afford = Object.entries(g.rerollsAffordable)
      .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
      .join(" ");
    console.log(
      `  rank ${String(g.rank).padStart(2)}  p25 ${g.p25}  p50 ${g.p50}  p75 ${g.p75}  · rerolls affordable ${afford}`,
    );
  }
}

// Imported by goalSweep.ts for `summarise` and `readGoalTable`; run as a
// script only when it is the entry point.
if (process.argv[1]?.endsWith("goalValidate.ts")) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
