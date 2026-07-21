// The headless balance bot: drives full runs through the shared engine while a
// pluggable strategy shops. It reuses the game's real economy end to end
// (scoreRoll, applyOffer, applyRoundStart via the engine) so results reflect the
// live rules, and records everything a balance pass needs — where runs die, what
// they bought, and which unlock criteria they hit along the way.

import { newRun, RunState } from '../state/RunState';
import { canLoad, canShrink, Die, rollAll } from '../systems/Dice';
import { ITEMS, ItemDef, meetsCriterion, ShopItemId } from '../systems/Items';
import { applyOffer, canAfford, rollShopOffers, ShopOffer } from '../systems/Shop';
import { roundRollTarget, resolveRoll, resolveRoundEnd, shouldOpenShop } from './engine';
import { roundTarget } from '../config';
import { mulberry32 } from './localStorageShim';
import { SimConfig } from './config';

export type StrategyName = 'random' | 'noBuy' | 'greedy';

/** One round's result, captured the moment its rolls run out (before the
 *  cleared-score carryover). `roundScore` is the peak reached that round. */
export interface RoundPoint {
  round: number;
  scoreAtEnd: number;
  roundScore: number;
  target: number;
}

export interface RunRecord {
  strategy: StrategyName;
  seed: number;
  roundReached: number;         // the round the run ended on
  rollsTaken: number;
  totalScore: number;           // cumulative points across the run (the leaderboard number)
  won: boolean;
  outcome: 'victory' | 'gameOver';
  finalDiceTotal: number;
  finalDiceCounts: Record<number, number>; // sides -> count
  hitDiceCap: boolean;          // the dice pool was truncated to cfg.maxDice at least once
  purchases: Partial<Record<ShopItemId, number>>;
  trajectory: RoundPoint[];
  /** id -> the round at which this gated item's unlock criterion was first met
   *  during play (independent of whether the item was in the shop pool). */
  unlocksAchieved: Partial<Record<ShopItemId, number>>;
}

// ---- target selection for needs-a-die items --------------------------------

function shrinkableIndices(dice: Die[]): number[] {
  return dice.map((d, i) => (canShrink(d) ? i : -1)).filter((i) => i >= 0);
}
function loadableIndices(dice: Die[]): number[] {
  return dice.map((d, i) => (canLoad(d) ? i : -1)).filter((i) => i >= 0);
}
function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}
/** Sample `n` distinct entries from `arr` (which must have length >= n). */
function sampleN<T>(arr: T[], n: number, rng: () => number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let k = 0; k < n; k++) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/** Choose valid die target(s) for an offer, or null if none are eligible.
 *  Mirrors the dev panel's auto-target logic but with random valid picks. */
function chooseTargets(
  state: RunState,
  offer: ShopOffer,
  rng: () => number
): { index?: number; indices?: number[] } | null {
  if (!offer.needsTarget) return {};
  const dice = state.dice;
  switch (offer.id) {
    case 'shrink': {
      const idxs = shrinkableIndices(dice);
      return idxs.length ? { index: pick(idxs, rng) } : null;
    }
    case 'loaded_die': {
      const idxs = loadableIndices(dice);
      return idxs.length ? { index: pick(idxs, rng) } : null;
    }
    case 'twin':
    case 'wild_face':
      return dice.length ? { index: Math.floor(rng() * dice.length) } : null;
    case 'grindstone': {
      const need = offer.targetCount ?? 3;
      const idxs = shrinkableIndices(dice);
      return idxs.length >= need ? { indices: sampleN(idxs, need, rng) } : null;
    }
    default:
      return {};
  }
}

/** Attempt to buy one offer, resolving its die target(s). Returns whether the
 *  purchase went through (applyOffer only charges on success). */
function attemptBuy(state: RunState, offer: ShopOffer, rng: () => number): boolean {
  if (!canAfford(state, offer)) return false;
  const targets = chooseTargets(state, offer, rng);
  if (!targets) return false;
  return applyOffer(state, offer, targets.index, targets.indices);
}

// ---- strategies ------------------------------------------------------------

export interface Strategy {
  name: StrategyName;
  /** Shop once. Each offer card is a one-time purchase this visit. */
  visit(state: RunState, offers: ShopOffer[], rng: () => number): void;
}

export const STRATEGIES: Record<StrategyName, Strategy> = {
  // Never buys — the raw survival baseline.
  noBuy: {
    name: 'noBuy',
    visit() {
      /* intentionally empty */
    }
  },
  // Buys affordable cards in random order (order matters once the budget runs
  // out, so which items land is genuinely random).
  random: {
    name: 'random',
    visit(state, offers, rng) {
      for (const offer of sampleN(offers, offers.length, rng)) attemptBuy(state, offer, rng);
    }
  },
  // Buys the most expensive affordable card first — biases toward the big-ticket
  // items, an upper-ish bound on how much shopping can help.
  greedy: {
    name: 'greedy',
    visit(state, offers, rng) {
      for (const offer of [...offers].sort((a, b) => b.cost - a.cost)) attemptBuy(state, offer, rng);
    }
  }
};

// ---- run driver ------------------------------------------------------------

const GATED_DEFS: ItemDef[] = ITEMS.filter((it) => it.unlock);

function trackUnlocks(state: RunState, achieved: Partial<Record<ShopItemId, number>>): void {
  for (const def of GATED_DEFS) {
    if (achieved[def.id] !== undefined) continue;
    if (meetsCriterion(def.unlock!, state)) achieved[def.id] = state.round;
  }
}

function diceCounts(dice: Die[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const d of dice) counts[d.sides] = (counts[d.sides] ?? 0) + 1;
  return counts;
}

/** Simulate one complete run under a strategy with a per-run seed. */
export function simulateRun(strategyName: StrategyName, seed: number, cfg: SimConfig): RunRecord {
  const strategy = STRATEGIES[strategyName];
  const rng = mulberry32(seed);
  const state = newRun();

  const record: RunRecord = {
    strategy: strategyName,
    seed,
    roundReached: 1,
    rollsTaken: 0,
    totalScore: 0,
    won: false,
    outcome: 'gameOver',
    finalDiceTotal: 0,
    finalDiceCounts: {},
    hitDiceCap: false,
    purchases: {},
    trajectory: [],
    unlocksAchieved: {}
  };

  const capDice = () => {
    if (state.dice.length > cfg.maxDice) {
      state.dice.length = cfg.maxDice;
      record.hitDiceCap = true;
    }
  };

  let rolls = 0;
  for (;;) {
    rollAll(state.dice, rng);
    resolveRoll(state);
    rolls += 1;
    capDice();
    trackUnlocks(state, record.unlocksAchieved);

    if (state.roll >= roundRollTarget(state)) {
      record.trajectory.push({
        round: state.round,
        scoreAtEnd: state.score,
        roundScore: state.roundScore,
        target: roundTarget(state.round)
      });
      const end = resolveRoundEnd(state);
      if (end.phase === 'victory') {
        record.outcome = 'victory';
        break;
      }
      if (end.phase === 'gameOver') {
        record.outcome = 'gameOver';
        break;
      }
      capDice(); // Foundry dice can push the pool over the cap
      trackUnlocks(state, record.unlocksAchieved); // Foundry dice can satisfy dice-count unlocks
      continue;
    }

    if (shouldOpenShop(state)) {
      const offers = rollShopOffers(state, state.ownedLedger ? 4 : 3, rng);
      strategy.visit(state, offers, rng);
      capDice(); // multiply / twin / addDice can push the pool over the cap
      trackUnlocks(state, record.unlocksAchieved); // buys can change the grid
    }

    if (rolls >= cfg.maxRollsPerRun) {
      record.outcome = 'gameOver';
      break;
    }
  }

  record.roundReached = state.round;
  record.rollsTaken = rolls;
  record.totalScore = state.totalScore;
  record.won = record.outcome === 'victory';
  record.finalDiceTotal = state.dice.length;
  record.finalDiceCounts = diceCounts(state.dice);
  record.purchases = { ...state.purchases };
  return record;
}
