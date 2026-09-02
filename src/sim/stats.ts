// Aggregate raw RunRecords into the numbers the HTML report charts. Pure — takes
// records in, returns plain data out, no I/O.

import { TRIALS_PER_RANK, trialGoal, WIN_TRIAL } from "../config";
import type { BossModifierId } from "../systems/Boss";
import { BOSS_MODIFIERS } from "../systems/Boss";
import { ITEMS, PriceBand, Rarity, ShopItemId } from "../systems/Items";
import { sourceLabel } from "../systems/ItemPoints";
import { RunRecord } from "./bot";

const ITEM_META = new Map(ITEMS.map((it) => [it.id, it]));

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx];
}
function median(xs: number[]): number {
  return percentile(
    [...xs].sort((a, b) => a - b),
    50,
  );
}

export interface ItemStat {
  id: ShopItemId;
  name: string;
  priceBand: PriceBand;
  rarity: Rarity;
  gated: boolean;
  buyRuns: number; // runs that bought it at least once
  buyRate: number; // buyRuns / runs
  totalBought: number; // copies bought across all runs
  avgPerRun: number;
  winRateIfBought: number; // win rate among runs that bought it
  avgTrialIfBought: number; // mean trial reached among runs that bought it
  unlockRate: number; // (gated) fraction of runs whose play met the criterion
  medianUnlockTrial: number | null; // (gated) median trial it was first met
}

/** How many points a single item contributed, averaged over winning runs. */
export interface ItemPointStat {
  id: string; // item id, or the starter-die sentinel
  label: string; // display name
  avgDice: number; // mean base rolling points from this item's dice, per winning run
  avgBonus: number; // mean bonus + multiplier points, per winning run
  avgPoints: number; // avgDice + avgBonus
  shareOfWinPoints: number; // fraction of all points earned across winning runs
}

export interface TrialCurvePoint {
  trial: number;
  meanTrialScore: number;
  medianTrialScore: number;
  goal: number;
  runsReached: number; // runs that played this trial
  /** How long the trial took to clear, over the runs that cleared it. A trial
   *  whose mean sits at 1 is being won on the opening roll — the goal is beneath
   *  what the field walks in with, and the roll budget is decoration. */
  meanRollsUsed: number;
  medianRollsUsed: number;
  /** Mean roll budget the trial granted (Metronome/Overtime/afflictions move
   *  it, so it is not simply ROLLS_PER_TRIAL). */
  meanRollBudget: number;
  /** meanRollsUsed / meanRollBudget — the share of the trial actually played. */
  rollShare: number;
  /** Share of clears that landed on the very first roll. */
  firstRollClearRate: number;
  /** Share of entrants that cleared at all. */
  clearRate: number;
}

/** How a single boss modifier fared: how often runs met it, and how often they
 *  got past it. The signal for whether one modifier is out of line with its
 *  peers. */
export interface BossStat {
  id: BossModifierId;
  name: string;
  faced: number;
  cleared: number;
  clearRate: number;
}

export interface StrategyStats {
  name: string;
  runs: number;
  wins: number;
  winRate: number;
  trial: {
    mean: number;
    median: number;
    min: number;
    max: number;
    histogram: number[];
  }; // histogram[trial-1]
  rank: { mean: number; median: number };
  score: {
    mean: number;
    median: number;
    p10: number;
    p90: number;
    max: number;
  };
  /** The purse over a run: what it earned, what it spent, and what it was
   *  holding at each trial clear. */
  gold: { earned: number; spent: number; medianHeld: number };
  /** Roll pacing across every trial the strategy cleared: how much of a trial's
   *  budget it spent, and how often it needed only the opening roll. */
  rolls: {
    meanUsed: number;
    meanBudget: number;
    meanShare: number;
    firstRollClearRate: number;
  };
  bosses: BossStat[];
  finalDice: { mean: number; median: number; max: number };
  trialCurve: TrialCurvePoint[];
  items: ItemStat[];
  winningRuns: number; // runs used for the point ranking below
  itemPointRanking: ItemPointStat[]; // points per item across winning runs, desc
}

export interface BatchStats {
  generatedAt: string;
  winTrial: number;
  trialsPerRank: number;
  runsPerStrategy: number;
  seed: number;
  unlockPools: { name: string; gatedItems: number }[];
  goals: { trial: number; goal: number }[];
  strategies: StrategyStats[];
}

function itemStats(records: RunRecord[]): ItemStat[] {
  const runs = records.length;
  return ITEMS.map((def) => {
    let buyRuns = 0;
    let totalBought = 0;
    let winsIfBought = 0;
    const trialsIfBought: number[] = [];
    let unlockRuns = 0;
    const unlockTrials: number[] = [];

    for (const r of records) {
      const n = r.purchases[def.id] ?? 0;
      if (n > 0) {
        buyRuns += 1;
        totalBought += n;
        if (r.won) winsIfBought += 1;
        trialsIfBought.push(r.trialReached);
      }
      const ur = r.unlocksAchieved[def.id];
      if (ur !== undefined) {
        unlockRuns += 1;
        unlockTrials.push(ur);
      }
    }

    return {
      id: def.id,
      name: def.name,
      priceBand: def.priceBand,
      rarity: def.rarity,
      gated: !!def.unlock,
      buyRuns,
      buyRate: runs ? buyRuns / runs : 0,
      totalBought,
      avgPerRun: runs ? totalBought / runs : 0,
      winRateIfBought: buyRuns ? winsIfBought / buyRuns : 0,
      avgTrialIfBought: mean(trialsIfBought),
      unlockRate: runs ? unlockRuns / runs : 0,
      medianUnlockTrial: unlockTrials.length ? median(unlockTrials) : null,
    };
  });
}

/** Rank items by the points they contributed, averaged over winning runs only.
 *  Base rolling points from an item's dice and its bonus/multiplier points are
 *  summed separately so the report can show the split. */
function itemPointRanking(records: RunRecord[]): {
  winningRuns: number;
  ranking: ItemPointStat[];
} {
  const wins = records.filter((r) => r.won);
  const diceTotals = new Map<string, number>();
  const bonusTotals = new Map<string, number>();
  let allPoints = 0;

  for (const r of wins) {
    for (const [id, pts] of Object.entries(r.dicePoints)) {
      diceTotals.set(id, (diceTotals.get(id) ?? 0) + pts);
      allPoints += pts;
    }
    for (const [id, pts] of Object.entries(r.itemPoints)) {
      bonusTotals.set(id, (bonusTotals.get(id) ?? 0) + pts);
      allPoints += pts;
    }
  }

  const ids = new Set<string>([...diceTotals.keys(), ...bonusTotals.keys()]);
  const n = wins.length;
  const ranking: ItemPointStat[] = [...ids].map((id) => {
    const dice = diceTotals.get(id) ?? 0;
    const bonus = bonusTotals.get(id) ?? 0;
    return {
      id,
      label: sourceLabel(id),
      avgDice: n ? dice / n : 0,
      avgBonus: n ? bonus / n : 0,
      avgPoints: n ? (dice + bonus) / n : 0,
      shareOfWinPoints: allPoints ? (dice + bonus) / allPoints : 0,
    };
  });
  ranking.sort((a, b) => b.avgPoints - a.avgPoints);
  return { winningRuns: n, ranking };
}

/** Roll pacing over the whole ladder, weighted by how many clears each trial
 *  contributed — otherwise the deep trials only a handful of runs reach would
 *  count as much as the opening ones every run plays. */
function rollSummary(curve: TrialCurvePoint[]): StrategyStats["rolls"] {
  let clears = 0;
  let used = 0;
  let budget = 0;
  let firstRoll = 0;
  for (const p of curve) {
    const n = p.runsReached * p.clearRate;
    clears += n;
    used += p.meanRollsUsed * n;
    budget += p.meanRollBudget * n;
    firstRoll += p.firstRollClearRate * n;
  }
  if (clears === 0)
    return { meanUsed: 0, meanBudget: 0, meanShare: 0, firstRollClearRate: 0 };
  return {
    meanUsed: used / clears,
    meanBudget: budget / clears,
    meanShare: budget > 0 ? used / budget : 0,
    firstRollClearRate: firstRoll / clears,
  };
}

function strategyStats(name: string, records: RunRecord[]): StrategyStats {
  const runs = records.length;
  const wins = records.filter((r) => r.won).length;
  const ranking = itemPointRanking(records);
  const trials = records.map((r) => r.trialReached);
  const ranks = records.map((r) => r.rankReached);
  const scores = records.map((r) => r.totalScore).sort((a, b) => a - b);
  const dice = records.map((r) => r.finalDiceTotal);

  const histogram = new Array(WIN_TRIAL).fill(0);
  for (const t of trials)
    histogram[Math.min(WIN_TRIAL, Math.max(1, t)) - 1] += 1;

  // Achieved-vs-goal curve: peak score reached per trial, across runs that
  // played that trial. Roll pacing rides along on the same walk, but counts only
  // CLEARED trials — a trial a run died on always spent its whole budget, so
  // folding failures in would report the deadliest goals as the best paced.
  const byTrial = new Map<number, number[]>();
  const rollsByTrial = new Map<number, { used: number[]; budget: number[] }>();
  const clearsByTrial = new Map<number, { entered: number; cleared: number }>();
  const goldHeld: number[] = [];
  for (const rec of records) {
    for (const p of rec.trajectory) {
      if (p.trial > WIN_TRIAL) continue; // endless tail would skew the curve
      const arr = byTrial.get(p.trial) ?? [];
      arr.push(p.trialScore);
      byTrial.set(p.trial, arr);
      goldHeld.push(p.goldAfter);

      const tally = clearsByTrial.get(p.trial) ?? { entered: 0, cleared: 0 };
      tally.entered += 1;
      if (p.cleared) tally.cleared += 1;
      clearsByTrial.set(p.trial, tally);
      if (!p.cleared) continue;
      const pace = rollsByTrial.get(p.trial) ?? { used: [], budget: [] };
      pace.used.push(p.clearedOnRoll ?? p.rollsUsed);
      pace.budget.push(p.rollBudget);
      rollsByTrial.set(p.trial, pace);
    }
  }
  const trialCurve: TrialCurvePoint[] = [...byTrial.keys()]
    .sort((a, b) => a - b)
    .map((trial) => {
      const peaks = byTrial.get(trial)!;
      const pace = rollsByTrial.get(trial) ?? { used: [], budget: [] };
      const tally = clearsByTrial.get(trial) ?? { entered: 0, cleared: 0 };
      const meanUsed = mean(pace.used);
      const meanBudget = mean(pace.budget);
      return {
        trial,
        meanTrialScore: mean(peaks),
        medianTrialScore: median(peaks),
        goal: Number(trialGoal(trial)), // sim reporting is Number
        runsReached: peaks.length,
        meanRollsUsed: meanUsed,
        medianRollsUsed: median(pace.used),
        meanRollBudget: meanBudget,
        rollShare: meanBudget > 0 ? meanUsed / meanBudget : 0,
        firstRollClearRate: pace.used.length
          ? pace.used.filter((r) => r <= 1).length / pace.used.length
          : 0,
        clearRate: tally.entered ? tally.cleared / tally.entered : 0,
      };
    });

  const bossTally = new Map<string, { faced: number; cleared: number }>();
  for (const rec of records) {
    for (const [id, tally] of Object.entries(rec.bossesFaced)) {
      const acc = bossTally.get(id) ?? { faced: 0, cleared: 0 };
      acc.faced += tally!.faced;
      acc.cleared += tally!.cleared;
      bossTally.set(id, acc);
    }
  }
  const bosses: BossStat[] = BOSS_MODIFIERS.map((boss) => {
    const tally = bossTally.get(boss.id) ?? { faced: 0, cleared: 0 };
    return {
      id: boss.id,
      name: boss.name,
      faced: tally.faced,
      cleared: tally.cleared,
      clearRate: tally.faced ? tally.cleared / tally.faced : 0,
    };
  });

  return {
    name,
    runs,
    wins,
    winRate: runs ? wins / runs : 0,
    trial: {
      mean: mean(trials),
      median: median(trials),
      min: trials.length ? Math.min(...trials) : 0,
      max: trials.length ? Math.max(...trials) : 0,
      histogram,
    },
    rank: { mean: mean(ranks), median: median(ranks) },
    score: {
      mean: mean(scores),
      median: median(scores),
      p10: percentile(scores, 10),
      p90: percentile(scores, 90),
      max: scores.length ? scores[scores.length - 1] : 0,
    },
    gold: {
      earned: mean(records.map((r) => r.goldEarned)),
      spent: mean(records.map((r) => r.goldSpent)),
      medianHeld: median(goldHeld),
    },
    rolls: rollSummary(trialCurve),
    bosses,
    finalDice: {
      mean: mean(dice),
      median: median(dice),
      max: dice.length ? Math.max(...dice) : 0,
    },
    trialCurve,
    items: itemStats(records),
    winningRuns: ranking.winningRuns,
    itemPointRanking: ranking.ranking,
  };
}

export function aggregate(
  byStrategy: Record<string, RunRecord[]>,
  meta: {
    seed: number;
    unlockPools: { name: string; gatedItems: number }[];
  },
): BatchStats {
  const names = Object.keys(byStrategy);
  const runsPerStrategy = names.length ? byStrategy[names[0]].length : 0;
  const goals = Array.from({ length: WIN_TRIAL }, (_, i) => ({
    trial: i + 1,
    goal: Number(trialGoal(i + 1)),
  }));
  return {
    generatedAt: new Date().toISOString(),
    winTrial: WIN_TRIAL,
    trialsPerRank: TRIALS_PER_RANK,
    runsPerStrategy,
    seed: meta.seed,
    unlockPools: meta.unlockPools,
    goals,
    strategies: names.map((n) => strategyStats(n, byStrategy[n])),
  };
}

export { ITEM_META };
