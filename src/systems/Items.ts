import { MAX_EXTRA_NUMBERS, survivalTarget, WIN_ROUND } from "../config";
import { RunState } from "../state/RunState";
import { DieOpts, DieSides } from "./Dice";

export type ShopItemId =
  | "extra_die"
  | "extra_dice"
  | "extra_point"
  | "extra_number"
  | "mult2"
  | "mult3"
  | "shrink"
  | "rollplayer"
  | "spike"
  | "chip"
  | "pocket_change"
  | "whetstone"
  | "twin"
  | "overtime"
  | "metronome"
  | "grindstone"
  | "loaded_die"
  | "snake_eyes"
  | "ledger"
  | "amplifier"
  | "refinement"
  | "wild_face"
  | "centurion"
  | "vault"
  | "double_the_fun"
  | "dividend"
  | "momentum"
  | "keen_edge"
  | "foundry"
  | "jackpot"
  | "last_call"
  | "genesis"
  | "reserve"
  | "prism"
  | "lucky_seven"
  | "royal_seal"
  | "parade"
  | "menagerie"
  | "uniform"
  | "hourglass"
  | "insurance_policy"
  | "coupon_book"
  | "dealers_bell"
  | "shopping_cart"
  | "brick_mold";

export type Rarity = "common" | "uncommon" | "rare";
export type PriceBand = "free" | "low" | "standard" | "strong" | "build";
export type StackPricing = "none" | "linear" | "explosive";

/** Boolean run flags an item can switch on (Snake Eyes, Ledger, etc.). */
type RunFlag =
  | "ownedLedger"
  | "hasSnakeEyes"
  | "hasAmplifier"
  | "hasVault"
  | "hasDoubleTheFun"
  | "hasLuckySeven"
  | "hasParade"
  | "hasMenagerie"
  | "hasUniform"
  | "hasHourglass"
  | "hasInsurancePolicy"
  | "hasCouponBook"
  | "hasDealersBell"
  | "hasShoppingCart";

/** Integer run counters a repeatable item bumps on each purchase — its effect
 *  compounds with the count (see the stacking passives on RunState). */
type RunCounter =
  | "pocketChange"
  | "whetstone"
  | "dividend"
  | "momentum"
  | "keenEdge"
  | "foundry"
  | "jackpot"
  | "genesis"
  | "reserve"
  | "prism"
  | "lastCall"
  | "brickMold";

/**
 * A persistent-unlock condition on an item. Items without one are available
 * from the start; those with one only enter the shop pool once the player has
 * met the criterion (checked against the live run — see `meetsCriterion` and
 * SaveData.evaluateAndUnlock). Add new kinds here as new unlocks are designed.
 */
export type UnlockCriterion =
  | { kind: "diceInGrid"; count: number } // more than `count` dice in the grid at once
  | { kind: "winGame" } // clear the final round
  | { kind: "reachRound"; round: number } // reach at least this round
  | { kind: "scoreInRound"; points: number } // score at least this many points in one round
  | { kind: "diceOfSize"; sides: DieSides; count: number } // hold `count`+ dice of this size at once
  | { kind: "scoreStreak"; count: number } // score on `count` rolls in a row (one run)
  | { kind: "sameFaceCount"; count: number } // show one face on `count`+ dice in a single roll
  | { kind: "clutchClear" } // cross the target on a round's final roll
  | { kind: "scoreVsTarget"; factor: number }; // reach `factor`× the current round's target

/**
 * The mutations an item can apply to the run. Items are composed from these
 * instead of each getting a bespoke branch — `applyEffect` is the one place
 * that knows how to carry each kind out.
 */
export type Effect =
  | { kind: "addDice"; sides: DieSides; count: number; opts?: DieOpts }
  | {
      kind: "addDiceProportional";
      sides: DieSides;
      fraction: number;
      min: number;
      opts?: DieOpts;
    } // add max(min, ⌊fraction·grid⌋) dice
  | { kind: "addPoints"; amount: number }
  | { kind: "extraPoint" }
  | { kind: "extraNumber" }
  | { kind: "multiplyDice"; factor: number }
  | { kind: "shrinkTarget"; steps?: number } // shrink the chosen die(s) `steps` rungs — ctx.index or ctx.indices
  | { kind: "shrinkAll"; steps?: number } // shrink every die `steps` rungs
  | { kind: "shrinkSize"; steps?: number } // shrink every die of the chosen die's size `steps` rungs
  | { kind: "twinSize" } // duplicate every die of the chosen die's size
  | { kind: "loadSize" } // load every die of the chosen die's size (now + future)
  | { kind: "wildSize" } // make every die of the chosen die's size wild (now + future)
  | { kind: "sealSize" } // make the chosen size's maximum face score (now + future)
  | { kind: "bonusRollThisRound" }
  | { kind: "bonusRollPerRound" }
  | { kind: "setFlag"; flag: RunFlag }
  | { kind: "incCounter"; counter: RunCounter };

/** Which die/dice a target-consuming effect should act on. `index` is a single
 *  chosen die (shrink, twin, loaded, wild); `indices` are the multi-pick dice
 *  (grindstone). */
export interface EffectContext {
  index?: number;
  indices?: number[];
  /** The buying item's id, stamped onto any dice this effect creates so their
   *  rolling points can be attributed back to it. */
  source?: string;
}

// Effect constructors — small, so item definitions read as declarative lists.
const addDice = (sides: DieSides, count = 1, opts?: DieOpts): Effect => ({
  kind: "addDice",
  sides,
  count,
  opts,
});
const addDiceProportional = (
  sides: DieSides,
  fraction: number,
  min: number,
  opts?: DieOpts,
): Effect => ({ kind: "addDiceProportional", sides, fraction, min, opts });
const extraPoint = (): Effect => ({ kind: "extraPoint" });
const extraNumber = (): Effect => ({ kind: "extraNumber" });
const multiplyDice = (factor: number): Effect => ({
  kind: "multiplyDice",
  factor,
});
const shrinkTarget = (steps?: number): Effect => ({
  kind: "shrinkTarget",
  steps,
});
const shrinkAll = (steps?: number): Effect => ({ kind: "shrinkAll", steps });
const shrinkSize = (steps?: number): Effect => ({ kind: "shrinkSize", steps });
const twinSize = (): Effect => ({ kind: "twinSize" });
const loadSize = (): Effect => ({ kind: "loadSize" });
const wildSize = (): Effect => ({ kind: "wildSize" });
const sealSize = (): Effect => ({ kind: "sealSize" });
const bonusRollThisRound = (): Effect => ({ kind: "bonusRollThisRound" });
const bonusRollPerRound = (): Effect => ({ kind: "bonusRollPerRound" });
const setFlag = (flag: RunFlag): Effect => ({ kind: "setFlag", flag });
const incCounter = (counter: RunCounter): Effect => ({
  kind: "incCounter",
  counter,
});

export interface ItemDef {
  id: ShopItemId;
  name: string;
  /** Target-relative price tier. The concrete point cost is resolved by the
   *  shop from the current round, checkpoint, and copies already owned. */
  priceBand: PriceBand;
  /** Repeat-purchase surcharge. Unique/free items use `none`. */
  stackPricing?: StackPricing;
  rarity: Rarity;
  /** Card text — a function when it depends on run state (e.g. Extra Number). */
  desc: string | ((state: RunState) => string);
  needsTarget?: boolean; // player must pick a die (shrink, twin, loaded_die, wild_face)
  targetCount?: number; // >1 for multi-pick items (grindstone)
  /** Single-time item: a second copy would do nothing (boolean-flag items like
   *  Snake Eyes). Once purchased it's recorded in `state.ownedUnique` and no
   *  longer offered. */
  unique?: boolean;
  /** When present, the item only appears in the shop while this holds. */
  available?: (state: RunState) => boolean;
  /** When present, the item is hidden from the shop until the player has met
   *  this persistent-unlock condition (see `meetsCriterion`). */
  unlock?: UnlockCriterion;
  effects: Effect[];
}

/** Flat "starter" items add a fixed amount that becomes noise once the grid is
 *  large, so the shop stops offering them past this many dice — a struggling
 *  player with a small grid still sees them (shop hygiene, not a hard removal).
 *  Two Bricks is exempt: it's the guaranteed free fallback in rollShopOffers. */
const STARTER_GRID_CAP = 75;
const smallGrid = (s: RunState) => s.dice.length < STARTER_GRID_CAP;

/** Every item, in rough rarity/cost order. This array is the single source of
 *  truth: the shop's offer pool, the dev panel's grant list, and each item's
 *  effects all derive from it. */
export const ITEMS: ItemDef[] = [
  {
    id: "extra_die",
    name: "Two Bricks",
    priceBand: "free",
    rarity: "common",
    desc: "Add two d6 to your grid.",
    effects: [addDice(6, 2)],
  },
  {
    id: "chip",
    name: "Chips",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Add two d2 to your grid.",
    available: smallGrid,
    effects: [addDice(2, 2)],
  },
  {
    id: "pocket_change",
    name: "Pocket Change",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: "Gain 2 points on every roll.",
    available: smallGrid,
    effects: [incCounter("pocketChange")],
  },
  {
    id: "spike",
    name: "Spikes",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: "Add two d4 to your grid.",
    available: smallGrid,
    effects: [addDice(4, 2)],
  },
  {
    id: "shrink",
    name: "Shrink Die",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: "Shrink a die of your choice two steps.",
    needsTarget: true,
    available: (s) => s.dice.shrinkableCount() > 0 && smallGrid(s),
    effects: [shrinkTarget(2)],
  },
  {
    id: "whetstone",
    name: "Whetstone",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: "Each roll, a 10% chance to shrink a random die one step.",
    effects: [incCounter("whetstone")],
  },
  {
    id: "twin",
    name: "Twins",
    priceBand: "strong",
    stackPricing: "explosive",
    rarity: "common",
    desc: "Choose a die — duplicate every die of its size.",
    needsTarget: true,
    effects: [twinSize()],
  },
  {
    id: "overtime",
    name: "Overtime",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: "Add two rolls to this round only.",
    effects: [bonusRollThisRound(), bonusRollThisRound()],
  },
  {
    id: "extra_dice",
    name: "Extra Dice",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Add d6 equal to a quarter of your grid (at least 5).",
    effects: [addDiceProportional(6, 0.25, 5)],
  },
  {
    id: "rollplayer",
    name: "Rollplayer",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Add a d20. Its highest face always scores and doubles all points that roll.",
    effects: [addDice(20, 1, { maxFaceBonus: true })],
  },
  {
    id: "mult2",
    name: "Multiply Dice ×2",
    priceBand: "strong",
    stackPricing: "explosive",
    rarity: "uncommon",
    desc: "Duplicate every die in your grid.",
    effects: [multiplyDice(2)],
  },
  {
    id: "metronome",
    name: "Metronome",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Add one permanent roll to every round.",
    effects: [bonusRollPerRound()],
  },
  {
    id: "grindstone",
    name: "Grindstone",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Choose a die — shrink every die of its size two steps.",
    needsTarget: true,
    available: (s) => s.dice.shrinkableCount() > 0,
    effects: [shrinkSize(2)],
  },
  {
    id: "loaded_die",
    name: "Loaded Die",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Choose a die — every die of its size never rolls its two highest faces, now and later.",
    needsTarget: true,
    available: (s) => s.dice.loadableCount() > 0,
    effects: [loadSize()],
  },
  {
    id: "snake_eyes",
    name: "Snake Eyes",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    desc: "When 2+ dice show the same number, score that number × the dice showing it.",
    effects: [setFlag("hasSnakeEyes")],
  },
  {
    id: "ledger",
    name: "Ledger",
    priceBand: "standard",
    rarity: "uncommon",
    unique: true,
    desc: "The shop offers 5 cards from now on.",
    effects: [setFlag("ownedLedger")],
  },
  {
    id: "extra_point",
    name: "Extra Point",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "rare",
    desc: "Each scoring die grants +1 more point.",
    effects: [extraPoint()],
  },
  {
    id: "mult3",
    name: "Multiply Dice ×3",
    priceBand: "build",
    stackPricing: "explosive",
    rarity: "rare",
    desc: "Triple every die in your grid.",
    effects: [multiplyDice(3)],
  },
  {
    id: "extra_number",
    name: "Extra Number",
    priceBand: "strong",
    stackPricing: "linear",
    rarity: "rare",
    desc: (s) => `Dice showing ${2 + s.extraNumberCount} also score.`,
    available: (s) => s.extraNumberCount < MAX_EXTRA_NUMBERS,
    effects: [extraNumber()],
  },
  {
    id: "amplifier",
    name: "Amplifier",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    desc: "Double all points earned from rolls.",
    effects: [setFlag("hasAmplifier")],
  },
  {
    id: "refinement",
    name: "Refinement",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "rare",
    desc: "Shrink every die in your grid two steps.",
    available: (s) => s.dice.shrinkableCount() > 0,
    effects: [shrinkAll(2)],
  },
  {
    id: "wild_face",
    name: "Wild Face",
    priceBand: "strong",
    stackPricing: "linear",
    rarity: "rare",
    desc: "Choose a die — every die of its size scores on every face, now and later.",
    needsTarget: true,
    effects: [wildSize()],
  },
  {
    id: "centurion",
    name: "Centurion",
    priceBand: "strong",
    stackPricing: "linear",
    rarity: "rare",
    desc: "Add a d100. Its highest face always scores and quadruples all points that roll.",
    effects: [addDice(100, 1, { maxFaceBonus: true })],
  },
  {
    id: "vault",
    name: "Vault",
    priceBand: "standard",
    rarity: "rare",
    unique: true,
    desc: "Keep 33% of your points (rounded down) when a round clears.",
    effects: [setFlag("hasVault")],
  },
  {
    id: "lucky_seven",
    name: "Lucky Seven",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    desc: "Gain 7 points for every digit 7 in the rolled values (77 gains 14).",
    effects: [setFlag("hasLuckySeven")],
  },
  {
    id: "parade",
    name: "Parade",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    desc: "If a roll contains a 1, 2, and 3, double all points earned that roll.",
    effects: [setFlag("hasParade")],
  },
  {
    id: "menagerie",
    name: "Menagerie",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    desc: "If at least three different die sizes score, double all points earned that roll.",
    effects: [setFlag("hasMenagerie")],
  },
  {
    id: "brick_mold",
    name: "Brick Mold",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Add one d6 to your grid after every roll.",
    effects: [incCounter("brickMold")],
  },
  {
    id: "royal_seal",
    name: "Royal Seal",
    priceBand: "strong",
    rarity: "rare",
    needsTarget: true,
    desc: "Choose a die size. Its maximum face scores, now and on future dice of that size.",
    available: (s) =>
      Object.keys(s.dice.sizeCounts()).some(
        (side) => !s.royalSealSizes.includes(Number(side) as DieSides),
      ),
    effects: [sealSize()],
  },
  {
    id: "uniform",
    name: "Uniform",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    desc: "If every die in your grid has the same size, triple all points earned.",
    effects: [setFlag("hasUniform")],
  },
  {
    id: "hourglass",
    name: "Hourglass",
    priceBand: "strong",
    rarity: "rare",
    unique: true,
    desc: "The first two and final two rolls of every round earn double points.",
    effects: [setFlag("hasHourglass")],
  },
  {
    id: "insurance_policy",
    name: "Insurance Policy",
    priceBand: "strong",
    rarity: "rare",
    unique: true,
    desc: "If a round ends at 75% of its target, clear it anyway and destroy this item.",
    effects: [setFlag("hasInsurancePolicy")],
  },
  {
    id: "coupon_book",
    name: "Coupon Book",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    desc: "One random non-free item in every shop becomes free.",
    effects: [setFlag("hasCouponBook")],
  },
  {
    id: "dealers_bell",
    name: "Dealer's Bell",
    priceBand: "standard",
    rarity: "rare",
    unique: true,
    desc: "Once per shop, reroll the entire store.",
    effects: [setFlag("hasDealersBell")],
  },
  {
    id: "shopping_cart",
    name: "Shopping Cart",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    desc: "Purchase one extra item from the store each visit.",
    effects: [setFlag("hasShoppingCart")],
  },
  {
    id: "double_the_fun",
    name: "Double the Fun",
    priceBand: "build",
    rarity: "uncommon",
    unique: true,
    desc: "Whenever any die rolls a 5 or 6, add another copy of that die to your grid.",
    unlock: { kind: "diceInGrid", count: 1000 },
    effects: [setFlag("hasDoubleTheFun")],
  },
  // --- Unlockable stacking passives ---------------------------------------
  {
    id: "dividend",
    name: "Dividend",
    priceBand: "build",
    stackPricing: "linear",
    rarity: "common",
    desc: "On every roll, gain 1 point for every 3 dice you own.",
    unlock: { kind: "reachRound", round: 6 },
    effects: [incCounter("dividend")],
  },
  {
    id: "momentum",
    name: "Momentum",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "common",
    desc: "Each consecutive roll that scores adds +2 to points earned; a scoreless roll resets it to 0.",
    unlock: { kind: "scoreStreak", count: 12 },
    effects: [incCounter("momentum")],
  },
  {
    id: "keen_edge",
    name: "Keen Edge",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "common",
    desc: "Each d1 scores +2 bonus when it scores (a d1 is worth 3).",
    unlock: { kind: "diceOfSize", sides: 1, count: 10 },
    available: (s) => s.dice.countOfSize(1) > 0,
    effects: [incCounter("keenEdge")],
  },
  {
    id: "foundry",
    name: "Foundry",
    priceBand: "strong",
    stackPricing: "explosive",
    rarity: "uncommon",
    desc: "At the start of each round, add 5 copies of your smallest die.",
    unlock: { kind: "diceInGrid", count: 29 },
    effects: [incCounter("foundry")],
  },
  {
    id: "jackpot",
    name: "Jackpot",
    priceBand: "build",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "When 3+ dice show the same face, score that face × the number of dice showing it (each face separately).",
    unlock: { kind: "sameFaceCount", count: 6 },
    effects: [incCounter("jackpot")],
  },
  {
    id: "last_call",
    name: "Last Call",
    priceBand: "build",
    stackPricing: "explosive",
    rarity: "uncommon",
    desc: "Points earned on the final roll of each round are quadrupled.",
    unlock: { kind: "clutchClear" },
    effects: [incCounter("lastCall")],
  },
  {
    id: "genesis",
    name: "Genesis",
    priceBand: "build",
    stackPricing: "explosive",
    rarity: "rare",
    desc: "Whenever a die scores, add a copy of that die to the grid (max +20 dice per roll).",
    unlock: { kind: "reachRound", round: 10 },
    effects: [incCounter("genesis")],
  },
  {
    id: "reserve",
    name: "Reserve",
    priceBand: "strong",
    stackPricing: "linear",
    rarity: "rare",
    desc: "Keep 75% of your points (rounded down) when a round clears.",
    unlock: { kind: "scoreVsTarget", factor: 2 },
    effects: [incCounter("reserve")],
  },
  {
    id: "prism",
    name: "Prism",
    priceBand: "build",
    stackPricing: "explosive",
    rarity: "rare",
    desc: "Triple all points earned from rolls (multiplies with Amplifier).",
    unlock: { kind: "winGame" },
    effects: [incCounter("prism")],
  },
];

/** Human-readable hint for a locked item's unlock condition (shown in the
 *  Items gallery under a still-locked card). */
export function describeCriterion(c: UnlockCriterion): string {
  switch (c.kind) {
    case "diceInGrid":
      return `Locked — hold over ${c.count} dice in one run`;
    case "winGame":
      return "Locked — win a run";
    case "reachRound":
      return `Locked — reach round ${c.round}`;
    case "scoreInRound":
      return `Locked — score ${c.points} in a single round`;
    case "diceOfSize":
      return `Locked — hold ${c.count} d${c.sides} at once`;
    case "scoreStreak":
      return `Locked — score on ${c.count} rolls in a row`;
    case "sameFaceCount":
      return `Locked — show the same number on ${c.count} dice in one roll`;
    case "clutchClear":
      return "Locked — clear a round on its final roll";
    case "scoreVsTarget":
      return `Locked — reach ${c.factor}× the round's target score`;
  }
}

/** Past-tense description of the deed that just satisfied an unlock criterion,
 *  shown on the "New item unlocked" banner so the player knows what earned it.
 *  Where `describeCriterion` frames the condition as a still-locked goal, this
 *  frames it as an accomplishment. */
export function describeUnlockAction(c: UnlockCriterion): string {
  switch (c.kind) {
    case "diceInGrid":
      return `Held over ${c.count} dice in one run`;
    case "winGame":
      return "Won a run";
    case "reachRound":
      return `Reached round ${c.round}`;
    case "scoreInRound":
      return `Scored ${c.points} in a single round`;
    case "diceOfSize":
      return `Held ${c.count} d${c.sides} at once`;
    case "scoreStreak":
      return `Scored on ${c.count} rolls in a row`;
    case "sameFaceCount":
      return `Showed the same number on ${c.count} dice in one roll`;
    case "clutchClear":
      return "Cleared a round on its final roll";
    case "scoreVsTarget":
      return `Reached ${c.factor}× the round's target score`;
  }
}

/** Whether the current run satisfies an unlock criterion. `roundScore` is the
 *  peak points reached within the current round (see RunState). */
export function meetsCriterion(c: UnlockCriterion, state: RunState): boolean {
  switch (c.kind) {
    case "diceInGrid":
      return state.dice.length > c.count;
    case "winGame":
      return state.round >= WIN_ROUND;
    case "reachRound":
      return state.round >= c.round;
    case "scoreInRound":
      return state.roundScore >= BigInt(c.points);
    case "diceOfSize":
      return state.dice.countOfSize(c.sides) >= c.count;
    case "scoreStreak":
      return state.scoreStreak >= c.count;
    case "sameFaceCount":
      // Most dice showing one face on the last roll (0 before any roll).
      return state.dice.maxSameFace() >= c.count;
    case "clutchClear":
      return state.clutchClear;
    case "scoreVsTarget":
      return (
        state.score >=
        BigInt(c.factor) * survivalTarget(state.round, state.hardMode)
      );
  }
}

/** Fold the run's persistent size auras into the options for a die about to be
 *  added, so dice created after a Loaded Die / Wild Face purchase inherit the
 *  property (dice copied by growth passives already carry the flags). */
function withSizeAuras(
  state: RunState,
  sides: DieSides,
  opts: DieOpts = {},
): DieOpts {
  return {
    ...opts,
    loaded: opts.loaded || state.loadedSizes.includes(sides),
    wildFace: opts.wildFace || state.wildSizes.includes(sides),
  };
}

/** The size of the die the player targeted (for the size-wide effects), or
 *  undefined if the index is invalid. */
function targetSize(state: RunState, ctx: EffectContext): DieSides | undefined {
  if (ctx.index === undefined) return undefined;
  return state.dice.dieAt(ctx.index)?.sides;
}

/**
 * Apply one effect to the run. Returns false if the effect couldn't be carried
 * out (e.g. a target die that can't shrink) — the caller aborts the purchase.
 */
export function applyEffect(
  state: RunState,
  effect: Effect,
  ctx: EffectContext,
): boolean {
  switch (effect.kind) {
    case "addDice":
      state.dice.addDice(
        effect.sides,
        effect.count,
        withSizeAuras(state, effect.sides, effect.opts),
        ctx.source,
      );
      return true;
    case "addDiceProportional": {
      // Scale the add with the grid so it keeps pace late game; never below `min`.
      const count = Math.max(
        effect.min,
        Math.floor(state.dice.length * effect.fraction),
      );
      state.dice.addDice(
        effect.sides,
        count,
        withSizeAuras(state, effect.sides, effect.opts),
        ctx.source,
      );
      return true;
    }
    case "addPoints":
      state.score += BigInt(effect.amount);
      return true;
    case "extraPoint":
      state.extraPoints += 1;
      return true;
    case "extraNumber":
      if (state.extraNumberCount >= MAX_EXTRA_NUMBERS) return false;
      state.extraNumberCount += 1;
      state.scoringNumbers.push(1 + state.extraNumberCount);
      return true;
    case "multiplyDice":
      state.dice.multiply(effect.factor, ctx.source ?? "starter");
      return true;
    case "shrinkTarget": {
      const indices =
        ctx.indices ?? (ctx.index !== undefined ? [ctx.index] : []);
      if (indices.length === 0) return false;
      const steps = effect.steps ?? 1;
      // Each target must shrink at least once; extra steps stop at the ladder floor.
      for (const i of indices) if (!state.dice.shrinkAt(i, steps)) return false;
      return true;
    }
    case "shrinkAll":
      state.dice.shrinkAll(effect.steps ?? 1);
      return true;
    case "shrinkSize": {
      const sides = targetSize(state, ctx);
      if (sides === undefined) return false;
      return state.dice.shrinkAllOfSize(sides, effect.steps ?? 1) > 0;
    }
    case "twinSize": {
      const sides = targetSize(state, ctx);
      if (sides === undefined) return false;
      return state.dice.twinAllOfSize(sides, ctx.source ?? "starter") > 0;
    }
    case "loadSize": {
      const sides = targetSize(state, ctx);
      if (sides === undefined || sides <= 1) return false;
      if (!state.loadedSizes.includes(sides)) state.loadedSizes.push(sides);
      return state.dice.loadAllOfSize(sides) > 0;
    }
    case "wildSize": {
      const sides = targetSize(state, ctx);
      if (sides === undefined) return false;
      if (!state.wildSizes.includes(sides)) state.wildSizes.push(sides);
      return state.dice.wildAllOfSize(sides) > 0;
    }
    case "sealSize": {
      const sides = targetSize(state, ctx);
      if (sides === undefined || state.royalSealSizes.includes(sides))
        return false;
      state.royalSealSizes.push(sides);
      return true;
    }
    case "bonusRollThisRound":
      state.bonusRollsThisRound += 1;
      return true;
    case "bonusRollPerRound":
      state.bonusRollsPerRound += 1;
      return true;
    case "setFlag":
      state[effect.flag] = true;
      return true;
    case "incCounter":
      state[effect.counter] += 1;
      return true;
  }
}

/**
 * Apply the round-start passives (Foundry dice) to the run and return the number
 * of dice added, so the caller can decide whether to re-lay the grid. Called
 * once as each round begins (see GameScene.afterRoll). Pocket Change and
 * Dividend are not here — they pay out every roll, so they live in scoreRoll.
 */
export function applyRoundStart(state: RunState): number {
  // Foundry: add copies of the smallest die per copy owned, scaled to the grid
  // (5% of it, at least 5) so the payout keeps pace late game instead of a flat
  // 5. The pool no-ops when Foundry isn't owned or the grid is empty.
  if (state.foundry <= 0) return 0;
  const perCopy = Math.max(5, Math.floor(state.dice.length * 0.05));
  return state.dice.foundry(perCopy * state.foundry);
}
