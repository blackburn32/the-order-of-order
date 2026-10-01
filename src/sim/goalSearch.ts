// The goal search: what every trial COULD score, across seeds and a grid of
// strategies, with the goals taken away — and the goal table that falls out.
//
// For each seed, every grid point (sim/goalGrid.ts) plays a full run with no
// goals: every trial runs its whole roll budget, nothing is culled, and every
// trial is paid as a clear on its final roll plus an assumed early-completion
// bonus. That gives, per seed and per trial, one full-budget score per grid
// point, from which this script takes:
//
//   max    the best score any strategy reached on that seed — the seed's
//          ceiling as far as this grid can find it.
//   pXX    the PERCENTILE-th score across the grid on that seed (the shipped
//          schedule: the 50th for rank 1, the 80th — what the top fifth of
//          strategies reach — from rank 2 on).
//
// The proposed goal for a trial is the median across seeds of the per-seed pXX,
// rounded to three significant figures, with the opening trials in PIN kept as
// authored, and then raised where needed so the table never drops within a rank
// or from one rank's slot to the next (the shape `trials:check` asserts).
//
// PERCENTILE may also be a per-rank schedule — ten comma-separated values, one
// per rank — because the field a goal has to challenge changes along the
// ladder: by the late ranks only strong builds are still alive, and a goal set
// on the whole field's 80th percentile is one they clear on the opening roll.
// The same search also derives a table for every value in PERCENTILES, so one
// measurement can be graded at many percentiles (`goalSweep.ts` does that).
//
// The per-roll traces are kept, so the script can also say, without another
// simulation, how the proposed goal reads against the very runs it was
// measured on: the share of runs whose full budget reaches it, the share that
// reach it on the first roll, and the median roll they get there on. That is an
// uncensored preview; `goalValidate.ts` is the real thing, with culling.
//
//   npm run goals:search
//   SEEDS=200 npm run goals:search
//   PERCENTILE=0.8 CLEAR_GOLD=1-3 PIN=1=1 npm run goals:search
//   FROM=sim-out/goal-search-raw.json PERCENTILE=0.6 npm run goals:search
//
// | env         | default                   | what it does                                 |
// | ----------- | ------------------------- | -------------------------------------------- |
// | SEEDS       | 120                       | seeds; every grid point plays every one      |
// | SEED        | 1                         | base seed (validation uses a different one)  |
// | PERCENTILE  | GOAL_PERCENTILE_BY_RANK   | the per-seed quantile (or ten, one per rank) |
// | PERCENTILES | 0.2,0.3,…,0.9             | extra flat tables written for goalSweep.ts   |
// | CLEAR_GOLD  | 1-3                       | assumed early-completion gold per trial      |
// | PIN         | 1=1                       | trial=goal pairs kept as authored            |
// | SIG         | 3                         | significant figures a goal is rounded to     |
// | OUT         | sim-out/goal-search.json  | the summary the report and validator read    |
// | RAW         | OUT with -raw.json        | every run's per-trial scores, for FROM       |
// | FROM        | (simulate)                | re-derive from a RAW file, no simulation     |
// | GRID_*      | see goalGrid.ts           | the strategy grid                            |

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  GOAL_PERCENTILE_BY_RANK,
  rankOf,
  rollsForTrial,
  TRIALS_PER_RANK,
  trialGoal,
  trialInRank,
  WIN_TRIAL,
} from "../config";
import {
  gridFromEnv,
  gridSeed,
  nearestRank,
  progressPrinter,
  runGrid,
  sortedCopy,
  type GridJob,
  type GridResult,
} from "./goalGrid";
import { rerollCost } from "../systems/Shop";

const SEEDS = Number(process.env.SEEDS ?? 120);
const SEED = Number(process.env.SEED ?? 1);
// The default is the schedule the shipped table was made with, so a rerun on
// unchanged rules reproduces config.ts's MEASURED_GOALS (to seed noise).
const PERCENTILE = parseSchedule(
  process.env.PERCENTILE ?? GOAL_PERCENTILE_BY_RANK.join(","),
);
const PERCENTILES = (
  process.env.PERCENTILES ?? "0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9"
)
  .split(",")
  .map(Number)
  .filter((q) => q > 0 && q < 1);

/** One quantile per rank: a single value is used for every rank. */
function parseSchedule(text: string): number[] {
  const values = text.split(",").map(Number);
  const ranks = WIN_TRIAL / TRIALS_PER_RANK;
  if (values.some((q) => !(q > 0 && q <= 1)))
    throw new Error(`PERCENTILE=${text}: every value must be in (0, 1]`);
  if (values.length === 1) return new Array<number>(ranks).fill(values[0]);
  if (values.length !== ranks)
    throw new Error(
      `PERCENTILE=${text}: give one value, or one per rank (${ranks})`,
    );
  return values;
}

/** A schedule's name, for labels and JSON keys: "0.8", or "0.5…0.9". */
export function scheduleName(schedule: readonly number[]): string {
  return schedule.every((q) => q === schedule[0])
    ? String(schedule[0])
    : schedule.join(",");
}
const SIG = Number(process.env.SIG ?? 3);
const OUT = process.env.OUT ?? "sim-out/goal-search.json";
const CLEAR_GOLD = parseRange(process.env.CLEAR_GOLD ?? "1-3");
const RAW = process.env.RAW ?? OUT.replace(/\.json$/, "") + "-raw.json";
const FROM = process.env.FROM;
const PIN = parsePins(process.env.PIN ?? "1=1");

function parseRange(text: string): [number, number] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`CLEAR_GOLD=${text}: expected N or MIN-MAX`);
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : Number(m[2]);
  return [Math.min(min, max), Math.max(min, max)];
}

function parsePins(text: string): Map<number, bigint> {
  const pins = new Map<number, bigint>();
  for (const pair of text.split(",").filter(Boolean)) {
    const [t, g] = pair.split("=");
    pins.set(Number(t), BigInt(g));
  }
  return pins;
}

/** Round a log10 score to a goal with `sig` significant figures, as an exact
 *  bigint (late goals are far past Number's integer range). */
export function goalFromLog10(x: number, sig = SIG): bigint {
  if (x < 0) return 1n; // a zero score: the smallest goal there is
  if (x < sig) return BigInt(Math.max(1, Math.round(10 ** x)));
  let exponent = Math.floor(x) - (sig - 1);
  let mantissa = Math.round(10 ** (x - exponent));
  if (mantissa >= 10 ** sig) {
    mantissa = Math.round(mantissa / 10);
    exponent += 1;
  }
  return BigInt(mantissa) * 10n ** BigInt(exponent);
}

function log10OfBig(v: bigint): number {
  if (v <= 0n) return -1;
  const digits = v.toString();
  const head = digits.slice(0, 15);
  return digits.length - head.length + Math.log10(Number(head));
}

/** The cadence actually in force, for the record. */
function cadence(): number[] {
  return [1, 2, 3].map((t) => rollsForTrial(t));
}

export interface TrialSummary {
  trial: number;
  rank: number;
  slot: number;
  budget: number;
  /** Quantiles of every run's full-budget score, as log10. */
  all: { p10: number; p50: number; p80: number; p90: number; max: number };
  /** Median across seeds of each seed's best score, and of each seed's pXX. */
  medianSeedMax: number;
  medianSeedPct: number;
  /** The same, as the 20th/80th percentile across seeds — the band. */
  seedPctBand: [number, number];
  seedMaxBand: [number, number];
  /** The proposed goal (decimal string) and the goal it replaces. */
  goal: string;
  goalLog10: number;
  previousGoal: string;
  previousGoalLog10: number;
  /** How the proposed goal reads against these runs, uncensored. */
  reach: number;
  firstRoll: number;
  medianRollsToReach: number | null;
  /** Median full-budget score per strategy (log10), over seeds and appetites. */
  byStrategy: Record<string, number>;
}

interface RawSearch {
  kind: "goal-search-raw";
  seeds: number;
  baseSeed: number;
  clearGold: [number, number];
  cadence: number[];
  grid: string[];
  results: GridResult[];
}

async function main(): Promise<void> {
  let raw: RawSearch;
  if (FROM) {
    // Re-derive from a previous measurement: the percentile, the pins and the
    // rounding are all choices made AFTER the simulation, so trying another
    // one should not cost another simulation.
    if (!existsSync(FROM)) throw new Error(`FROM=${FROM}: no such file`);
    raw = JSON.parse(readFileSync(FROM, "utf8")) as RawSearch;
    console.log(
      `Goal search re-derived from ${FROM}: ${raw.results.length} runs, percentile ${scheduleName(PERCENTILE)}`,
    );
  } else {
    const grid = gridFromEnv();
    const jobs: GridJob[] = [];
    for (let i = 0; i < SEEDS; i++) {
      for (const point of grid) {
        jobs.push({
          mode: "search",
          point,
          seedIndex: i,
          seed: gridSeed(SEED, i),
          goals: null,
          cadence: null,
          clearGold: CLEAR_GOLD,
        });
      }
    }
    console.log(
      `Goal search: ${SEEDS} seeds × ${grid.length} grid points = ${jobs.length} runs, goals removed, ` +
        `cadence ${cadence().join("/")}, assumed clear gold ${CLEAR_GOLD.join("-")}, percentile ${scheduleName(PERCENTILE)}`,
    );
    const results = await runGrid(jobs, progressPrinter("search"));
    raw = {
      kind: "goal-search-raw",
      seeds: SEEDS,
      baseSeed: SEED,
      clearGold: CLEAR_GOLD,
      cadence: cadence(),
      grid: grid.map((p) => p.id),
      results,
    };
    const rawPath = resolve(process.cwd(), RAW);
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(rawPath, JSON.stringify(raw));
  }
  const summary = summarise(raw);
  const outPath = resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 1));
  printSummary(summary);
  console.log(`\nSummary → ${outPath}`);
}

/** A goal table derived from the search at one percentile schedule, with how
 *  it reads against the very runs it was measured on (uncensored). */
export interface DerivedTable {
  schedule: number[];
  goals: string[];
  /** Median across seeds of each seed's quantile, before rounding/pinning. */
  raw: number[];
  /** Share of runs whose full budget reaches each goal. */
  reach: number[];
  /** Share of runs whose opening roll alone reaches it. */
  firstRoll: number[];
  /** Share of runs whose full budget reached EVERY goal up to and including
   *  this one — a culling-free preview of survival. Optimistic, because a real
   *  clear pays for rolls left in hand only as the assumed bonus here. */
  chained: number[];
}

interface SearchSummary {
  kind: "goal-search";
  createdAt: string;
  seeds: number;
  baseSeed: number;
  percentile: number[];
  clearGold: [number, number];
  pins: Record<string, string>;
  cadence: number[];
  grid: string[];
  trials: TrialSummary[];
  /** Gold in hand as each shop opens, by rank: quantiles, and how many
   *  rerolls in a row that purse could pay for at the live reroll prices. */
  shopGold: {
    rank: number;
    p25: number;
    p50: number;
    p75: number;
    rerollsAffordable: Record<string, number>;
  }[];
  /** The table for PERCENTILE — what `GOALS=<this file>` validates. */
  goals: string[];
  /** Every table this search derived, keyed by `scheduleName`, for
   *  `GOALS=<this file>#<key>` and for goalSweep.ts. */
  tables: Record<string, DerivedTable>;
  /** Where the late spread comes from, at a few trials (see `engineBreakdown`). */
  engines: EngineBreakdown[];
}

/**
 * How much of a trial's score spread the strategy trees' engines explain.
 *
 * Read as log10 variance, split three ways: which engine a run owns (or none),
 * then the trial that engine arrived on, then what is left over between runs
 * that own the same engine from the same trial. The last share is the spread
 * equalizing the engines cannot touch.
 */
export interface EngineBreakdown {
  trial: number;
  /** Share of runs that own no engine going into this trial. */
  noEngine: number;
  /** p10-p90 of every run's score, in decades. */
  spread: number;
  /** Shares of the log10 variance (they sum to 1). */
  byEngine: number;
  byArrival: number;
  leftOver: number;
  /** Median score (log10) per engine among runs that owned it by trial 9, so
   *  engines are compared at equal timing; with the runs counted. */
  atEqualTiming: Record<string, { median: number; runs: number }>;
  /** Median decades between a run's opening roll and its full budget: how wide
   *  the window is in which a goal needs most of the trial's rolls. */
  openingRollGap: number;
}

const EARLY_ENGINE_TRIAL = 9;

function engineBreakdown(
  results: GridResult[],
  trial: number,
): EngineBreakdown {
  const variance = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length;
  };
  const pooledWithin = (groups: Map<string, number[]>) => {
    let n = 0;
    let v = 0;
    for (const g of groups.values()) {
      v += variance(g) * g.length;
      n += g.length;
    }
    return n ? v / n : 0;
  };
  const rows = results.flatMap((r) => {
    const t = r.trials[trial - 1];
    if (!t) return [];
    const first = r.engines
      .filter((e) => e.trial <= trial)
      .sort((a, b) => a.trial - b.trial)[0];
    return [
      {
        y: t.log10,
        gap: t.rolls && t.rolls[0] >= 0 ? t.log10 - t.rolls[0] : null,
        tree: (first?.tree ?? "none") as string,
        at: first?.trial ?? 0,
      },
    ];
  });
  const total = variance(rows.map((r) => r.y)) || 1;
  const byType = new Map<string, number[]>();
  const byTypeAndArrival = new Map<string, number[]>();
  for (const r of rows) {
    (byType.get(r.tree) ?? byType.set(r.tree, []).get(r.tree)!).push(r.y);
    const key = `${r.tree}@${r.at}`;
    (byTypeAndArrival.get(key) ?? byTypeAndArrival.set(key, []).get(key)!).push(
      r.y,
    );
  }
  const afterType = pooledWithin(byType);
  const afterArrival = pooledWithin(byTypeAndArrival);
  const early = new Map<string, number[]>();
  for (const r of rows) {
    if (r.tree === "none" || r.at > EARLY_ENGINE_TRIAL) continue;
    (early.get(r.tree) ?? early.set(r.tree, []).get(r.tree)!).push(r.y);
  }
  const sorted = sortedCopy(rows.map((r) => r.y));
  return {
    trial,
    noEngine: rows.filter((r) => r.tree === "none").length / rows.length,
    spread: nearestRank(sorted, 0.9) - nearestRank(sorted, 0.1),
    byEngine: 1 - afterType / total,
    byArrival: (afterType - afterArrival) / total,
    leftOver: afterArrival / total,
    atEqualTiming: Object.fromEntries(
      [...early.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tree, ys]) => [
          tree,
          { median: nearestRank(sortedCopy(ys), 0.5), runs: ys.length },
        ]),
    ),
    openingRollGap: nearestRank(
      sortedCopy(rows.map((r) => r.gap).filter((g): g is number => g !== null)),
      0.5,
    ),
  };
}

/** Each trial's scores, sorted, one list per seed (index = trial - 1). */
type SeedScores = number[][][];

function seedScores(results: GridResult[]): SeedScores {
  const bySeed = new Map<number, GridResult[]>();
  for (const r of results) {
    const list = bySeed.get(r.seedIndex) ?? [];
    list.push(r);
    bySeed.set(r.seedIndex, list);
  }
  const out: SeedScores = [];
  for (let trial = 1; trial <= WIN_TRIAL; trial++) {
    const perSeed: number[][] = [];
    for (const runs of bySeed.values()) {
      const scores = runs
        .map((run) => run.trials[trial - 1]?.log10)
        .filter((x): x is number => x !== undefined);
      if (scores.length > 0) perSeed.push(sortedCopy(scores));
    }
    out.push(perSeed);
  }
  return out;
}

/** The goal table for one percentile schedule: per seed, that quantile across
 *  the grid; across seeds, the median; then rounded, pinned and kept in shape. */
function deriveTable(
  scores: SeedScores,
  results: GridResult[],
  schedule: readonly number[],
): DerivedTable {
  const raw = scores.map((perSeed, i) => {
    const q = schedule[rankOf(i + 1) - 1];
    return nearestRank(
      sortedCopy(perSeed.map((sorted) => nearestRank(sorted, q))),
      0.5,
    );
  });

  // Round, pin, and keep the shape the curve checks assert: never below the
  // trial before it in its own rank, never below the same slot a rank down.
  const goals: bigint[] = raw.map((x) => goalFromLog10(x));
  for (let t = 1; t <= WIN_TRIAL; t++) {
    const pinned = PIN.get(t);
    if (pinned !== undefined) {
      goals[t - 1] = pinned;
      continue;
    }
    let g = goals[t - 1];
    if (trialInRank(t) > 1 && goals[t - 2] > g) g = goals[t - 2];
    if (t > TRIALS_PER_RANK && goals[t - 1 - TRIALS_PER_RANK] > g)
      g = goals[t - 1 - TRIALS_PER_RANK];
    goals[t - 1] = g;
  }

  const bar = goals.map((g) => log10OfBig(g) - 1e-9);
  const reach = new Array<number>(WIN_TRIAL).fill(0);
  const firstRoll = new Array<number>(WIN_TRIAL).fill(0);
  const chained = new Array<number>(WIN_TRIAL).fill(0);
  for (const run of results) {
    let alive = true;
    for (let i = 0; i < WIN_TRIAL; i++) {
      const t = run.trials[i];
      if (!t) break;
      const made = t.log10 >= bar[i];
      if (made) reach[i] += 1;
      if ((t.rolls?.[0] ?? -Infinity) >= bar[i]) firstRoll[i] += 1;
      // The duel has no goal to reach; it is won against the mirror.
      alive = alive && (made || i + 1 === WIN_TRIAL);
      if (alive) chained[i] += 1;
    }
  }
  const n = results.length || 1;
  return {
    schedule: [...schedule],
    goals: goals.map(String),
    raw,
    reach: reach.map((x) => x / n),
    firstRoll: firstRoll.map((x) => x / n),
    chained: chained.map((x) => x / n),
  };
}

function summarise(raw: RawSearch): SearchSummary {
  const results = raw.results;
  const scores = seedScores(results);
  const primary = deriveTable(scores, results, PERCENTILE);
  const tables: Record<string, DerivedTable> = {
    [scheduleName(PERCENTILE)]: primary,
  };
  for (const q of PERCENTILES) {
    const schedule = new Array<number>(WIN_TRIAL / TRIALS_PER_RANK).fill(q);
    tables[scheduleName(schedule)] ??= deriveTable(scores, results, schedule);
  }

  const trials: TrialSummary[] = [];
  for (let trial = 1; trial <= WIN_TRIAL; trial++) {
    const i = trial - 1;
    const q = PERCENTILE[rankOf(trial) - 1];
    const perSeed = scores[i];
    const all = sortedCopy(perSeed.flat());
    const seedMax = sortedCopy(perSeed.map((s) => s[s.length - 1]));
    const seedPct = sortedCopy(perSeed.map((s) => nearestRank(s, q)));
    const byStrategy = new Map<string, number[]>();
    const rollsToReach: number[] = [];
    const bar = log10OfBig(BigInt(primary.goals[i])) - 1e-9;
    for (const run of results) {
      const t = run.trials[i];
      if (!t) continue;
      const strategy = run.pointId.split("/")[0];
      (
        byStrategy.get(strategy) ?? byStrategy.set(strategy, []).get(strategy)!
      ).push(t.log10);
      const at = (t.rolls ?? []).findIndex((x) => x >= bar);
      if (at >= 0) rollsToReach.push(at + 1);
    }
    trials.push({
      trial,
      rank: rankOf(trial),
      slot: trialInRank(trial),
      budget: rollsForTrial(trial),
      all: {
        p10: nearestRank(all, 0.1),
        p50: nearestRank(all, 0.5),
        p80: nearestRank(all, 0.8),
        p90: nearestRank(all, 0.9),
        max: all[all.length - 1],
      },
      medianSeedMax: nearestRank(seedMax, 0.5),
      medianSeedPct: nearestRank(seedPct, 0.5),
      seedPctBand: [nearestRank(seedPct, 0.2), nearestRank(seedPct, 0.8)],
      seedMaxBand: [nearestRank(seedMax, 0.2), nearestRank(seedMax, 0.8)],
      goal: primary.goals[i],
      goalLog10: log10OfBig(BigInt(primary.goals[i])),
      previousGoal: trialGoal(trial).toString(),
      previousGoalLog10: log10OfBig(trialGoal(trial)),
      reach: primary.reach[i],
      firstRoll: primary.firstRoll[i],
      medianRollsToReach: rollsToReach.length
        ? nearestRank(sortedCopy(rollsToReach), 0.5)
        : null,
      byStrategy: Object.fromEntries(
        [...byStrategy.entries()].map(([k, v]) => [
          k,
          nearestRank(sortedCopy(v), 0.5),
        ]),
      ),
    });
  }

  // What a shop opens with, by rank. The trial's own `goldAfter` plus the
  // assumed bonus is the purse the shop that follows it sees.
  const shopGold: SearchSummary["shopGold"] = [];
  const bonus = (raw.clearGold[0] + raw.clearGold[1]) / 2;
  for (let rank = 1; rank <= WIN_TRIAL / TRIALS_PER_RANK; rank++) {
    const purses: number[] = [];
    for (const run of results)
      for (const t of run.trials)
        if (rankOf(t.trial) === rank && t.trial < WIN_TRIAL)
          purses.push(t.goldAfter + bonus);
    const sorted = sortedCopy(purses);
    const afford: Record<string, number> = {};
    for (const purse of sorted) {
      let k = 0;
      let spent = 0;
      while (k < 6 && spent + rerollCost(k) <= purse) spent += rerollCost(k++);
      afford[k] = (afford[k] ?? 0) + 1 / sorted.length;
    }
    shopGold.push({
      rank,
      p25: nearestRank(sorted, 0.25),
      p50: nearestRank(sorted, 0.5),
      p75: nearestRank(sorted, 0.75),
      rerollsAffordable: afford,
    });
  }

  return {
    kind: "goal-search",
    createdAt: new Date().toISOString(),
    seeds: raw.seeds,
    baseSeed: raw.baseSeed,
    percentile: PERCENTILE,
    clearGold: raw.clearGold,
    pins: Object.fromEntries(
      [...PIN.entries()].map(([t, g]) => [String(t), g.toString()]),
    ),
    cadence: raw.cadence,
    grid: raw.grid,
    trials,
    shopGold,
    goals: primary.goals,
    tables,
    // Old raw files predate engine tracking; skip the breakdown for them.
    engines: results.some((r) => r.engines)
      ? [13, 19, 25, 29].map((t) => engineBreakdown(results, t))
      : [],
  };
}

function fmtLog(x: number): string {
  if (x < 0) return "0";
  if (x < 6) return Math.round(10 ** x).toLocaleString();
  return `1e${x.toFixed(1)}`;
}

function printSummary(s: SearchSummary): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);
  console.log(
    `\ntrial | r-s | budget |   old goal |  seed max |  seed pXX |   new goal | reach | 1-roll | med roll`,
  );
  for (const t of s.trials) {
    console.log(
      `${String(t.trial).padStart(5)} | ${t.rank}-${t.slot} | ${String(t.budget).padStart(6)} | ` +
        `${fmtLog(t.previousGoalLog10).padStart(10)} | ${fmtLog(t.medianSeedMax).padStart(9)} | ` +
        `${fmtLog(t.medianSeedPct).padStart(9)} | ${fmtLog(t.goalLog10).padStart(10)} | ` +
        `${pct(t.reach)} | ${pct(t.firstRoll)} | ${String(t.medianRollsToReach ?? "-").padStart(8)}`,
    );
  }
  console.log("\nGold as a shop opens (assumed clear bonus included):");
  for (const g of s.shopGold) {
    const afford = Object.entries(g.rerollsAffordable)
      .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
      .join(" ");
    console.log(
      `  rank ${String(g.rank).padStart(2)}  p25 ${g.p25}  p50 ${g.p50}  p75 ${g.p75}  · rerolls affordable ${afford}`,
    );
  }
  if (s.engines.length > 0) {
    console.log(
      "\nWhere the spread comes from (log10 variance; engines compared among runs that owned one by trial 9):",
    );
    for (const e of s.engines) {
      const equal = Object.entries(e.atEqualTiming)
        .map(([tree, v]) => `${tree} ${v.median.toFixed(1)}`)
        .join(", ");
      console.log(
        `  trial ${String(e.trial).padStart(2)}: spread ${e.spread.toFixed(1)} decades · no engine ${pct(e.noEngine)} · ` +
          `which engine ${pct(e.byEngine)}, when it arrived ${pct(e.byArrival)}, left over ${pct(e.leftOver)} · ` +
          `opening roll is ${e.openingRollGap.toFixed(1)} decades under the full budget`,
      );
      console.log(
        `           engines at equal timing (log10 median): ${equal}`,
      );
    }
  }
  console.log("\nEvery derived table, against these runs (uncensored):");
  console.log(
    "  percentile     | reach (mean) | 1-roll (mean) | reach all 29 goals",
  );
  for (const [name, t] of Object.entries(s.tables)) {
    const mean = (xs: number[]) =>
      xs.slice(1, WIN_TRIAL - 1).reduce((a, b) => a + b, 0) / (WIN_TRIAL - 2);
    console.log(
      `  ${name.padEnd(14)} | ${pct(mean(t.reach)).padStart(12)} | ${pct(mean(t.firstRoll)).padStart(13)} | ${pct(t.chained[WIN_TRIAL - 1]).padStart(9)}`,
    );
  }
  console.log("\nPaste into config.ts as MEASURED_GOALS:");
  const rows: string[] = [];
  for (let r = 0; r < s.goals.length / TRIALS_PER_RANK; r++) {
    const cells = s.goals
      .slice(r * TRIALS_PER_RANK, (r + 1) * TRIALS_PER_RANK)
      .map((g) => `"${g}",`)
      .join(" ");
    rows.push(`  ${cells.padEnd(44)}// rank ${r + 1}`);
  }
  console.log(`[\n${rows.join("\n")}\n]`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
