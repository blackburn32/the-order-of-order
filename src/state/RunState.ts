import { Die, makeDie } from '../systems/Dice';
import type { ShopItemId } from '../systems/Items';

export interface RunState {
  round: number; // 1-based
  roll: number;  // rolls completed this round, 0..20
  score: number; // one pool: survival score AND shop currency
  roundScore: number; // peak `score` reached in the current round (for unlock criteria)
  totalScore: number; // cumulative points across the whole run, never reset
  dice: Die[];
  scoringNumbers: number[]; // starts [1]; Extra number adds 2, then 3
  extraPoints: number;      // +1 per stack each time a die scores
  extraNumberCount: number; // 0..2
  startedAt: number;        // epoch ms, for the Hall of High Scores
  bonusRollsThisRound: number; // Overtime — consumed at round end
  bonusRollsPerRound: number;  // Metronome — permanent
  ownedLedger: boolean;
  hasSnakeEyes: boolean;
  hasAmplifier: boolean;
  hasVault: boolean;
  hasDoubleTheFun: boolean; // duplicate any die that rolls a 6
  // Stacking passives — the count of each owned (incremented per purchase), read
  // at their relevant moment (scoring, round start, round clear). Unlike the
  // boolean flags above, these items are repeatable and their effects compound.
  dividend: number;   // +1 pt per 5 dice at round start, per copy
  momentum: number;   // + scoreStreak per copy on each scoring roll
  keenEdge: number;   // +1 per copy when a d1 scores
  foundry: number;    // +3 copies of the smallest die at round start, per copy
  jackpot: number;    // 4+ matching dice score face×count, per copy
  genesis: number;    // scoring dice spawn copies, cap +10/roll per copy
  reserve: number;    // keep 50% of points on round clear, per copy
  prism: number;      // ×3 all roll points per copy
  lastCall: number;   // ×3 points on the final roll per copy
  // Always-maintained trackers that drive unlock criteria (not tied to owning
  // any particular item).
  scoreStreak: number;  // consecutive scoring rolls this run; a dud resets it
  clutchClear: boolean; // has ever crossed the target on a round's final roll
  ownedUnique: ShopItemId[]; // single-time items already purchased this run
  // Every item bought this run, keyed by id, with the number of times purchased.
  // The single source of truth for the inventory screen (ownership is otherwise
  // scattered across flags/counters/dice and can't be reconstructed by id).
  purchases: Partial<Record<ShopItemId, number>>;
}

export function newRun(): RunState {
  return {
    round: 1,
    roll: 0,
    score: 0,
    roundScore: 0,
    totalScore: 0,
    dice: [makeDie(6)],
    scoringNumbers: [1],
    extraPoints: 0,
    extraNumberCount: 0,
    startedAt: Date.now(),
    bonusRollsThisRound: 0,
    bonusRollsPerRound: 0,
    ownedLedger: false,
    hasSnakeEyes: false,
    hasAmplifier: false,
    hasVault: false,
    hasDoubleTheFun: false,
    dividend: 0,
    momentum: 0,
    keenEdge: 0,
    foundry: 0,
    jackpot: 0,
    genesis: 0,
    reserve: 0,
    prism: 0,
    lastCall: 0,
    scoreStreak: 0,
    clutchClear: false,
    ownedUnique: [],
    purchases: {}
  };
}

const KEY = 'run';

export function setRun(registry: Phaser.Data.DataManager, state: RunState): void {
  registry.set(KEY, state);
}

export function getRun(registry: Phaser.Data.DataManager): RunState {
  let state = registry.get(KEY) as RunState | undefined;
  if (!state) {
    state = newRun();
    registry.set(KEY, state);
  }
  return state;
}
