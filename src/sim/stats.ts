// Aggregate raw RunRecords into the numbers the HTML report charts. Pure — takes
// records in, returns plain data out, no I/O.

import { WIN_ROUND, roundTarget } from '../config';
import { ITEMS, Rarity, ShopItemId } from '../systems/Items';
import { RunRecord, StrategyName } from './bot';

const ITEM_META = new Map(ITEMS.map((it) => [it.id, it]));

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}
function median(xs: number[]): number {
  return percentile([...xs].sort((a, b) => a - b), 50);
}

export interface ItemStat {
  id: ShopItemId;
  name: string;
  cost: number;
  rarity: Rarity;
  gated: boolean;
  buyRuns: number;      // runs that bought it at least once
  buyRate: number;      // buyRuns / runs
  totalBought: number;  // copies bought across all runs
  avgPerRun: number;
  winRateIfBought: number;  // win rate among runs that bought it
  avgRoundIfBought: number; // mean round reached among runs that bought it
  unlockRate: number;       // (gated) fraction of runs whose play met the criterion
  medianUnlockRound: number | null; // (gated) median round it was first met
}

export interface RoundCurvePoint {
  round: number;
  meanRoundScore: number;
  medianRoundScore: number;
  target: number;
  runsReached: number; // runs that played this round
}

export interface StrategyStats {
  name: StrategyName;
  runs: number;
  wins: number;
  winRate: number;
  round: { mean: number; median: number; min: number; max: number; histogram: number[] }; // histogram[r-1]
  score: { mean: number; median: number; p10: number; p90: number; max: number };
  finalDice: { mean: number; median: number; max: number };
  diceCapHitRate: number; // fraction of runs whose dice pool hit the cap
  roundCurve: RoundCurvePoint[];
  items: ItemStat[];
}

export interface BatchStats {
  generatedAt: string;
  winRound: number;
  runsPerStrategy: number;
  seed: number;
  maxDice: number;
  unlockedAtStart: ShopItemId[];
  targets: { round: number; target: number }[];
  strategies: StrategyStats[];
}

function itemStats(records: RunRecord[]): ItemStat[] {
  const runs = records.length;
  return ITEMS.map((def) => {
    let buyRuns = 0;
    let totalBought = 0;
    let winsIfBought = 0;
    const roundsIfBought: number[] = [];
    let unlockRuns = 0;
    const unlockRounds: number[] = [];

    for (const r of records) {
      const n = r.purchases[def.id] ?? 0;
      if (n > 0) {
        buyRuns += 1;
        totalBought += n;
        if (r.won) winsIfBought += 1;
        roundsIfBought.push(r.roundReached);
      }
      const ur = r.unlocksAchieved[def.id];
      if (ur !== undefined) {
        unlockRuns += 1;
        unlockRounds.push(ur);
      }
    }

    return {
      id: def.id,
      name: def.name,
      cost: def.cost,
      rarity: def.rarity,
      gated: !!def.unlock,
      buyRuns,
      buyRate: runs ? buyRuns / runs : 0,
      totalBought,
      avgPerRun: runs ? totalBought / runs : 0,
      winRateIfBought: buyRuns ? winsIfBought / buyRuns : 0,
      avgRoundIfBought: mean(roundsIfBought),
      unlockRate: runs ? unlockRuns / runs : 0,
      medianUnlockRound: unlockRounds.length ? median(unlockRounds) : null
    };
  });
}

function strategyStats(name: StrategyName, records: RunRecord[]): StrategyStats {
  const runs = records.length;
  const wins = records.filter((r) => r.won).length;
  const rounds = records.map((r) => r.roundReached);
  const scores = records.map((r) => r.totalScore).sort((a, b) => a - b);
  const dice = records.map((r) => r.finalDiceTotal);

  const histogram = new Array(WIN_ROUND).fill(0);
  for (const r of rounds) histogram[Math.min(WIN_ROUND, Math.max(1, r)) - 1] += 1;

  // Achieved-vs-target curve: peak score reached per round, across runs that
  // played that round.
  const byRound = new Map<number, number[]>();
  for (const rec of records) {
    for (const p of rec.trajectory) {
      const arr = byRound.get(p.round) ?? [];
      arr.push(p.roundScore);
      byRound.set(p.round, arr);
    }
  }
  const roundCurve: RoundCurvePoint[] = [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((round) => {
      const peaks = byRound.get(round)!;
      return {
        round,
        meanRoundScore: mean(peaks),
        medianRoundScore: median(peaks),
        target: roundTarget(round),
        runsReached: peaks.length
      };
    });

  return {
    name,
    runs,
    wins,
    winRate: runs ? wins / runs : 0,
    round: {
      mean: mean(rounds),
      median: median(rounds),
      min: rounds.length ? Math.min(...rounds) : 0,
      max: rounds.length ? Math.max(...rounds) : 0,
      histogram
    },
    score: {
      mean: mean(scores),
      median: median(scores),
      p10: percentile(scores, 10),
      p90: percentile(scores, 90),
      max: scores.length ? scores[scores.length - 1] : 0
    },
    finalDice: {
      mean: mean(dice),
      median: median(dice),
      max: dice.length ? Math.max(...dice) : 0
    },
    diceCapHitRate: runs ? records.filter((r) => r.hitDiceCap).length / runs : 0,
    roundCurve,
    items: itemStats(records)
  };
}

export function aggregate(
  byStrategy: Record<StrategyName, RunRecord[]>,
  meta: { seed: number; maxDice: number; unlockedAtStart: ShopItemId[] }
): BatchStats {
  const names = Object.keys(byStrategy) as StrategyName[];
  const runsPerStrategy = names.length ? byStrategy[names[0]].length : 0;
  const targets = Array.from({ length: WIN_ROUND }, (_, i) => ({ round: i + 1, target: roundTarget(i + 1) }));
  return {
    generatedAt: new Date().toISOString(),
    winRound: WIN_ROUND,
    runsPerStrategy,
    seed: meta.seed,
    maxDice: meta.maxDice,
    unlockedAtStart: meta.unlockedAtStart,
    targets,
    strategies: names.map((n) => strategyStats(n, byStrategy[n]))
  };
}

export { ITEM_META };
