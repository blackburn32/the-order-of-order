// The headless balance bot: drives full runs through the shared engine while a
// pluggable strategy shops. It reuses the game's real economy end to end
// (scoreRoll, applyOffer, applyRoundStart via the engine) so results reflect the
// live rules, and records everything a balance pass needs — where runs die, what
// they bought, and which unlock criteria they hit along the way.

import { newRun, RunState } from "../state/RunState";
import { ITEMS, ItemDef, meetsCriterion, ShopItemId } from "../systems/Items";
import { toNumberPointMap } from "../systems/ItemPoints";
import {
  applyOffer,
  canAfford,
  rollShopOffers,
  ShopOffer,
} from "../systems/Shop";
import {
  roundRollTarget,
  resolveRoll,
  resolveRoundEnd,
  shouldOpenShop,
} from "./engine";
import { survivalTarget } from "../config";
import { mulberry32 } from "./localStorageShim";
import { SimConfig } from "./config";

export type StrategyName = "random" | "noBuy" | "greedy";

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
  roundReached: number; // the round the run ended on
  rollsTaken: number;
  totalScore: number; // cumulative points across the run (the leaderboard number)
  won: boolean;
  outcome: "victory" | "gameOver";
  finalDiceTotal: number;
  finalDiceCounts: Record<number, number>; // sides -> count
  purchases: Partial<Record<ShopItemId, number>>;
  trajectory: RoundPoint[];
  /** id -> the round at which this gated item's unlock criterion was first met
   *  during play (independent of whether the item was in the shop pool). */
  unlocksAchieved: Partial<Record<ShopItemId, number>>;
  /** Per-item point attribution for the whole run (see systems/ItemPoints):
   *  `dicePoints` is base rolling points by die source, `itemPoints` is bonus +
   *  multiplier points by item. Together they sum to `totalScore`. */
  dicePoints: Record<string, number>;
  itemPoints: Record<string, number>;
}

// ---- target selection for needs-a-die items --------------------------------

// Cap on how many candidate target indices to enumerate from the pool. Above the
// bucket threshold there can be millions of valid targets; the bot only needs a
// random valid pick, so a bounded sample keeps target selection O(1) in grid size.
const TARGET_SAMPLE_LIMIT = 4096;

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}
/** Sample `n` distinct entries from `arr` (which must have length >= n). */
function sampleN<T>(arr: T[], n: number, rng: () => number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let k = 0; k < n; k++)
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/** Choose valid die target(s) for an offer, or null if none are eligible.
 *  Mirrors the dev panel's auto-target logic but with random valid picks. */
function chooseTargets(
  state: RunState,
  offer: ShopOffer,
  rng: () => number,
): { index?: number; indices?: number[] } | null {
  if (!offer.needsTarget) return {};
  const dice = state.dice;
  switch (offer.id) {
    case "shrink": {
      const idxs = dice.shrinkableIndices(TARGET_SAMPLE_LIMIT);
      return idxs.length ? { index: pick(idxs, rng) } : null;
    }
    case "loaded_die": {
      const idxs = dice.loadableIndices(TARGET_SAMPLE_LIMIT);
      return idxs.length ? { index: pick(idxs, rng) } : null;
    }
    case "twin":
    case "wild_face":
      return dice.length ? { index: Math.floor(rng() * dice.length) } : null;
    case "royal_seal": {
      const groups = dice
        .groups()
        .filter(({ die }) => !state.royalSealSizes.includes(die.sides));
      return groups.length
        ? { index: pick(groups, rng).firstIndex }
        : null;
    }
    case "grindstone": {
      // Now a size-wide shrink: pick any one shrinkable die to name its size.
      const idxs = dice.shrinkableIndices(TARGET_SAMPLE_LIMIT);
      return idxs.length ? { index: pick(idxs, rng) } : null;
    }
    default:
      return {};
  }
}

/** Attempt to buy one offer, resolving its die target(s). Returns whether the
 *  purchase went through (applyOffer only charges on success). */
function attemptBuy(
  state: RunState,
  offer: ShopOffer,
  rng: () => number,
): boolean {
  if (!canAfford(state, offer)) return false;
  const targets = chooseTargets(state, offer, rng);
  if (!targets) return false;
  return applyOffer(state, offer, targets.index, targets.indices);
}

// ---- strategies ------------------------------------------------------------

export interface Strategy {
  name: StrategyName;
  /** Visit one shop. Shopping Cart raises the purchase limit from one to two. */
  visit(state: RunState, offers: ShopOffer[], rng: () => number): void;
}

export const STRATEGIES: Record<StrategyName, Strategy> = {
  // Never buys — the raw survival baseline.
  noBuy: {
    name: "noBuy",
    visit() {
      /* intentionally empty */
    },
  },
  // Tries cards in random order up to the visit's purchase limit.
  random: {
    name: "random",
    visit(state, offers, rng) {
      let bought = 0;
      for (const offer of sampleN(offers, offers.length, rng)) {
        if (attemptBuy(state, offer, rng)) bought += 1;
        if (bought >= (state.hasShoppingCart ? 2 : 1)) break;
      }
    },
  },
  // Tries the most expensive cards first up to the visit's purchase limit.
  greedy: {
    name: "greedy",
    visit(state, offers, rng) {
      let bought = 0;
      for (const offer of [...offers].sort((a, b) =>
        a.cost === b.cost ? 0 : a.cost > b.cost ? -1 : 1,
      )) {
        if (attemptBuy(state, offer, rng)) bought += 1;
        if (bought >= (state.hasShoppingCart ? 2 : 1)) break;
      }
    },
  },
};

// ---- run driver ------------------------------------------------------------

const GATED_DEFS: ItemDef[] = ITEMS.filter((it) => it.unlock);

function trackUnlocks(
  state: RunState,
  achieved: Partial<Record<ShopItemId, number>>,
): void {
  for (const def of GATED_DEFS) {
    if (achieved[def.id] !== undefined) continue;
    if (meetsCriterion(def.unlock!, state)) achieved[def.id] = state.round;
  }
}

/** Simulate one complete run under a strategy with a per-run seed. */
export function simulateRun(
  strategyName: StrategyName,
  seed: number,
  cfg: SimConfig,
): RunRecord {
  const strategy = STRATEGIES[strategyName];
  const rng = mulberry32(seed);
  const state = newRun(cfg.unlockedAtStart, cfg.hardMode ?? false);

  const record: RunRecord = {
    strategy: strategyName,
    seed,
    roundReached: 1,
    rollsTaken: 0,
    totalScore: 0,
    won: false,
    outcome: "gameOver",
    finalDiceTotal: 0,
    finalDiceCounts: {},
    purchases: {},
    trajectory: [],
    unlocksAchieved: {},
    dicePoints: {},
    itemPoints: {},
  };

  let rolls = 0;
  for (;;) {
    state.dice.roll(rng, state.scoringNumbers, state.royalSealSizes);
    resolveRoll(state, rng);
    rolls += 1;
    trackUnlocks(state, record.unlocksAchieved);

    if (state.roll >= roundRollTarget(state)) {
      record.trajectory.push({
        round: state.round,
        scoreAtEnd: Number(state.score),
        roundScore: Number(state.roundScore),
        target: Number(survivalTarget(state.round, state.hardMode)),
      });
      const end = resolveRoundEnd(state);
      if (end.phase === "victory") {
        record.outcome = "victory";
        break;
      }
      if (end.phase === "gameOver") {
        record.outcome = "gameOver";
        break;
      }
      trackUnlocks(state, record.unlocksAchieved); // Foundry dice can satisfy dice-count unlocks
      continue;
    }

    if (shouldOpenShop(state)) {
      let offers = rollShopOffers(state, state.ownedLedger ? 5 : 3, rng);
      // The simple bots always use their free full-store reroll when available.
      if (state.hasDealersBell)
        offers = rollShopOffers(state, state.ownedLedger ? 5 : 3, rng);
      strategy.visit(state, offers, rng);
      trackUnlocks(state, record.unlocksAchieved); // buys can change the grid
    }

    if (rolls >= cfg.maxRollsPerRun) {
      record.outcome = "gameOver";
      break;
    }
  }

  record.roundReached = state.round;
  record.rollsTaken = rolls;
  record.totalScore = Number(state.totalScore); // sim stats are Number (approx past ~9e15)
  record.won = record.outcome === "victory";
  record.finalDiceTotal = state.dice.length;
  record.finalDiceCounts = state.dice.sizeCounts();
  record.purchases = { ...state.purchases };
  record.dicePoints = toNumberPointMap(state.dicePoints);
  record.itemPoints = toNumberPointMap(state.itemPoints);
  return record;
}
