// The headless balance bot: drives full runs through the shared engine while a
// pluggable strategy shops. It reuses the game's real economy end to end
// (scoreRollHistogram, applyOffer, applyTrialStart via the engine) so results
// reflect the live rules, and records everything a balance pass needs — where
// runs die, what they bought, how much gold they held, and which unlock criteria
// they hit along the way.

import { newRun, RunState } from "../state/RunState";
import {
  ITEM_THEMES,
  ITEMS,
  ItemDef,
  ItemTheme,
  meetsCriterion,
  ShopItemId,
} from "../systems/Items";
import { toNumberPointMap } from "../systems/ItemPoints";
import { activeBosses, BossModifierId, goalFor } from "../systems/Boss";
import { scoringNumbersFor } from "../systems/Afflictions";
import { GOLD_PER_INTEREST, INTEREST_CAP } from "../systems/Gold";
import {
  applyBoosterChoice,
  applyCouponFreebie,
  applyOffer,
  boosterPrice,
  BoosterOffer,
  canAfford,
  discountOffersForPawnbroker,
  openBooster,
  PRICE_BANDS,
  rerollCost,
  rerollIsFree,
  rerollShopOffers,
  rollBoosterOffers,
  rollShopOffers,
  ShopOffer,
  weightsFor,
} from "../systems/Shop";
import {
  beginRun,
  resolveRoll,
  resolveTrialEnd,
  trialComplete,
} from "./engine";
import { rankOf, trialInRank } from "../config";
import { mulberry32 } from "./localStorageShim";
import { SimConfig } from "./config";

export type StrategyName =
  | "greedy"
  | "thrifty"
  | "swarm"
  | "multiplier"
  | "precision"
  | "economy"
  | "tempo";

/** One trial's result, captured the moment it completes — goal met or rolls run
 *  out — and before the score resets. `trialScore` is the peak reached. */
export interface TrialPoint {
  trial: number; // 1-based position on the whole ladder
  rank: number;
  trialInRank: number;
  boss: BossModifierId | null;
  scoreAtEnd: number;
  trialScore: number;
  goal: number;
  goldAfter: number;
}

export interface RunRecord {
  strategy: StrategyName;
  seed: number;
  trialReached: number; // the trial the run ended on (1-based, whole ladder)
  rankReached: number;
  rollsTaken: number;
  totalScore: number; // cumulative points across the run
  bossesCleared: number;
  goldEarned: number;
  goldSpent: number;
  won: boolean;
  outcome: "victory" | "gameOver";
  finalDiceTotal: number;
  finalDiceCounts: Record<number, number>; // sides -> count
  purchases: Partial<Record<ShopItemId, number>>;
  trajectory: TrialPoint[];
  /** boss modifier -> whether the run met it, and whether it cleared it. */
  bossesFaced: Partial<
    Record<BossModifierId, { faced: number; cleared: number }>
  >;
  /** id -> the trial at which this gated item's unlock criterion was first met
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
      return groups.length ? { index: pick(groups, rng).firstIndex } : null;
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

function attemptBoosterChoice(
  state: RunState,
  offer: ShopOffer,
  rng: () => number,
): boolean {
  const targets = chooseTargets(state, offer, rng);
  if (!targets) return false;
  return applyBoosterChoice(state, offer, targets.index, targets.indices);
}

// ---- strategies ------------------------------------------------------------
//
// The field is meant to resemble how the game is actually played, not to bracket
// it. There is no "never buy" bot any more: with gold split out from score,
// hoarding it forever buys nothing, so a no-buy run measures a game nobody is
// playing. Instead the field is two price-driven shoppers (which bracket how far
// a purse stretches) and five themed shoppers that each chase one build.

export interface Strategy {
  name: StrategyName;
  /** Items this bot prefers, or null for the price-driven bots. */
  theme: ItemTheme | null;
  /** Gold to keep banked rather than spend, to earn interest. */
  goldFloor: number;
  visit(state: RunState, offers: ShopOffer[], rng: () => number): void;
}

/** Cheapest first — maximises the number of cards bought per visit. */
function byCostAscending(offers: ShopOffer[]): ShopOffer[] {
  return [...offers].sort((a, b) => a.cost - b.cost);
}

/** Most expensive first — chases the strongest card the purse can reach. */
function byCostDescending(offers: ShopOffer[]): ShopOffer[] {
  return [...offers].sort((a, b) => b.cost - a.cost);
}

/**
 * Spend down the visit, keeping `floor` gold banked. Buys in the order given,
 * re-checking affordability each time because a purchase changes what is left.
 * Returns the gold spent.
 */
function spendDown(
  state: RunState,
  ordered: ShopOffer[],
  floor: number,
  rng: () => number,
): void {
  for (const offer of ordered) {
    if (state.gold - offer.cost < floor) continue;
    if (attemptBuy(state, offer, rng) && offer.id === "pawnbroker") {
      discountOffersForPawnbroker(ordered);
    }
  }
}

/** A themed bot takes its own cards cheapest-first — more theme cards beats one
 *  big one — then spends what is left on anything affordable. Falling back
 *  matters: a visit with no in-theme card would otherwise sit on its gold and
 *  read as a broken strategy rather than an unlucky shop. */
function themedVisit(theme: ItemTheme, floor: number) {
  return (state: RunState, offers: ShopOffer[], rng: () => number): void => {
    const inTheme = offers.filter((o) => ITEM_THEMES[o.id].includes(theme));
    const rest = offers.filter((o) => !ITEM_THEMES[o.id].includes(theme));
    const hadPawnbroker = state.hasPawnbroker;
    spendDown(state, byCostAscending(inTheme), floor, rng);
    if (!hadPawnbroker && state.hasPawnbroker) {
      discountOffersForPawnbroker(rest);
    }
    spendDown(state, byCostAscending(rest), floor, rng);
  };
}

// Themed bots keep half a full interest bar banked; the economy bot keeps a full
// one (that IS its build); the price-driven bots spend to the last coin.
const HALF_FLOOR = Math.floor((GOLD_PER_INTEREST * INTEREST_CAP) / 2);
const FULL_FLOOR = GOLD_PER_INTEREST * INTEREST_CAP;

function themed(name: StrategyName, theme: ItemTheme, floor: number): Strategy {
  return { name, theme, goldFloor: floor, visit: themedVisit(theme, floor) };
}

export const STRATEGIES: Record<StrategyName, Strategy> = {
  greedy: {
    name: "greedy",
    theme: null,
    goldFloor: 0,
    visit(state, offers, rng) {
      spendDown(state, byCostDescending(offers), 0, rng);
    },
  },
  thrifty: {
    name: "thrifty",
    theme: null,
    goldFloor: 0,
    visit(state, offers, rng) {
      spendDown(state, byCostAscending(offers), 0, rng);
    },
  },
  swarm: themed("swarm", "swarm", HALF_FLOOR),
  multiplier: themed("multiplier", "multiplier", HALF_FLOOR),
  precision: themed("precision", "precision", HALF_FLOOR),
  economy: themed("economy", "economy", FULL_FLOOR),
  tempo: themed("tempo", "tempo", HALF_FLOOR),
};

// ---- run driver ------------------------------------------------------------

const GATED_DEFS: ItemDef[] = ITEMS.filter((it) => it.unlock);

function trackUnlocks(
  state: RunState,
  achieved: Partial<Record<ShopItemId, number>>,
): void {
  for (const def of GATED_DEFS) {
    if (achieved[def.id] !== undefined) continue;
    if (meetsCriterion(def.unlock!, state)) achieved[def.id] = state.trial;
  }
}

/** Shop between trials: draw the offers, reroll while the bot judges it worth
 *  the gold, then let the strategy spend. Returns the gold spent (purchases and
 *  rerolls together) so the record can track where a run's income went. */
function visitShop(
  state: RunState,
  strategy: Strategy,
  rng: () => number,
): number {
  const before = state.gold;
  const cardCount = state.ownedLedger ? 5 : 3;
  const boosted = state.boonNextShop;
  const visitWeights = { ...weightsFor(state) };
  let offers = rollShopOffers(state, cardCount, rng, visitWeights);
  const packs = rollBoosterOffers(state, 2, boosted, rng);
  state.boonNextShop = false;

  // Reroll only while it is free (Dealer's Bell) or while nothing on the table
  // is affordable and the reroll itself is — a bot that rerolled on preference
  // would be measuring its own taste rather than the economy.
  for (let attempt = 0; attempt < MAX_REROLLS_PER_VISIT; attempt++) {
    const free = rerollIsFree(state, attempt);
    const price = free ? 0 : rerollCost(attempt);
    const stuck = offers.every((o) => !canAfford(state, o));
    if (!free && !(stuck && state.gold > price)) break;
    state.gold -= price;
    offers = rerollShopOffers(state, cardCount, rng, visitWeights);
  }

  const hadPawnbroker = state.hasPawnbroker;
  visitBoosters(state, strategy, packs, visitWeights, rng);
  if (!hadPawnbroker && state.hasPawnbroker) {
    discountOffersForPawnbroker(offers);
  }
  if (state.hasCouponBook && !offers.some((offer) => offer.freeByCoupon)) {
    applyCouponFreebie(state, offers, rng);
  }
  strategy.visit(state, offers, rng);
  return before - state.gold;
}

function visitBoosters(
  state: RunState,
  strategy: Strategy,
  packs: BoosterOffer[],
  visitWeights: ReturnType<typeof weightsFor>,
  rng: () => number,
): void {
  const ordered = [...packs].sort((a, b) => {
    if (strategy.theme) {
      const aMatch = a.theme === strategy.theme ? 1 : 0;
      const bMatch = b.theme === strategy.theme ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    const delta = boosterPrice(state, a) - boosterPrice(state, b);
    return strategy.name === "greedy" ? -delta : delta;
  });

  for (const pack of ordered) {
    const price = boosterPrice(state, pack);
    if (state.gold - price < strategy.goldFloor) continue;
    const choices = openBooster(
      state,
      pack,
      state.ownedLedger ? 5 : 3,
      rng,
      visitWeights,
    );
    if (choices.length === 0) continue;
    const preferred = strategy.theme
      ? choices.filter((offer) =>
          ITEM_THEMES[offer.id].includes(strategy.theme!),
        )
      : choices;
    const pool = preferred.length > 0 ? preferred : choices;
    // Once the pack has been paid for every revealed card costs the same
    // (nothing), so even the thrifty shopper takes the strongest band rather
    // than confusing the card's old shop price with a second charge.
    const orderedChoices = [...pool].sort(
      (a, b) => PRICE_BANDS[b.priceBand] - PRICE_BANDS[a.priceBand],
    );
    const choice = orderedChoices.find(
      (offer) => chooseTargets(state, offer, rng) !== null,
    );
    if (!choice) continue;
    state.gold -= price;
    if (attemptBoosterChoice(state, choice, rng)) break;
  }
}

/** Enough to break out of a dead shop, few enough that a rich run cannot simply
 *  shop until the card it wants appears. */
const MAX_REROLLS_PER_VISIT = 3;

/** Simulate one complete run under a strategy with a per-run seed. */
export function simulateRun(
  strategyName: StrategyName,
  seed: number,
  cfg: SimConfig,
): RunRecord {
  const strategy = STRATEGIES[strategyName];
  const rng = mulberry32(seed);
  const state = newRun(cfg.unlockedAtStart);
  beginRun(state, rng);

  const record: RunRecord = {
    strategy: strategyName,
    seed,
    trialReached: 1,
    rankReached: 1,
    rollsTaken: 0,
    totalScore: 0,
    bossesCleared: 0,
    goldEarned: 0,
    goldSpent: 0,
    won: false,
    outcome: "gameOver",
    finalDiceTotal: 0,
    finalDiceCounts: {},
    purchases: {},
    trajectory: [],
    bossesFaced: {},
    unlocksAchieved: {},
    dicePoints: {},
    itemPoints: {},
  };

  let rolls = 0;
  let goldSpent = 0;
  for (;;) {
    state.dice.roll(rng, scoringNumbersFor(state), state.royalSealSizes);
    resolveRoll(state, rng);
    rolls += 1;
    trackUnlocks(state, record.unlocksAchieved);

    if (trialComplete(state)) {
      // A trial can carry more than one modifier (The Long Night): the
      // trajectory row names the first, the tally counts every one faced.
      const bosses = activeBosses(state).map((b) => b.id);
      const boss = bosses[0] ?? null;
      record.trajectory.push({
        trial: state.trial,
        rank: rankOf(state.trial),
        trialInRank: trialInRank(state.trial),
        boss,
        scoreAtEnd: Number(state.score),
        trialScore: Number(state.trialScore),
        goal: Number(goalFor(state)),
        goldAfter: state.gold,
      });

      const end = resolveTrialEnd(state, rng);
      for (const id of bosses) {
        const tally = (record.bossesFaced[id] ??= { faced: 0, cleared: 0 });
        tally.faced += 1;
        if (end.bossCleared) tally.cleared += 1;
      }
      if (end.phase === "victory") {
        record.outcome = "victory";
        break;
      }
      if (end.phase === "gameOver") {
        record.outcome = "gameOver";
        break;
      }

      // Every cleared trial is followed by a shop — the only shop there is.
      goldSpent += visitShop(state, strategy, rng);
      trackUnlocks(state, record.unlocksAchieved); // buys can change the grid
      continue;
    }

    if (rolls >= cfg.maxRollsPerRun) {
      record.outcome = "gameOver";
      break;
    }
  }

  record.trialReached = state.trial;
  record.rankReached = rankOf(state.trial);
  record.rollsTaken = rolls;
  record.totalScore = Number(state.totalScore); // sim stats are Number (approx past ~9e15)
  record.bossesCleared = state.bossesCleared;
  record.goldEarned = state.goldEarned;
  record.goldSpent = goldSpent;
  record.won = record.outcome === "victory";
  record.finalDiceTotal = state.dice.length;
  record.finalDiceCounts = state.dice.sizeCounts();
  record.purchases = { ...state.purchases };
  record.dicePoints = toNumberPointMap(state.dicePoints);
  record.itemPoints = toNumberPointMap(state.itemPoints);
  return record;
}
