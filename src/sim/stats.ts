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
  // played that trial.
  const byTrial = new Map<number, number[]>();
  const goldHeld: number[] = [];
  for (const rec of records) {
    for (const p of rec.trajectory) {
      if (p.trial > WIN_TRIAL) continue; // endless tail would skew the curve
      const arr = byTrial.get(p.trial) ?? [];
      arr.push(p.trialScore);
      byTrial.set(p.trial, arr);
      goldHeld.push(p.goldAfter);
    }
  }
  const trialCurve: TrialCurvePoint[] = [...byTrial.keys()]
    .sort((a, b) => a - b)
    .map((trial) => {
      const peaks = byTrial.get(trial)!;
      return {
        trial,
        meanTrialScore: mean(peaks),
        medianTrialScore: median(peaks),
        goal: Number(trialGoal(trial)), // sim reporting is Number
        runsReached: peaks.length,
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
