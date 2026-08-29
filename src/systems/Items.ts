import { MAX_EXTRA_NUMBERS, WIN_RANK, rankOf } from "../config";
import { RunState } from "../state/RunState";
import {
  AFFLICTIONS,
  afflict,
  afflictionsFor,
  blocksGrowth,
  blocksGrowthPermanently,
  type AfflictionId,
} from "./Afflictions";
import { goalFor } from "./Boss";
import { DIE_LADDER, DieOpts, DieSides } from "./Dice";
import type { DicePool } from "./DicePool";
import { grantGold, RELIQUARY_BONUS_PERCENT } from "./Gold";
import {
  DOWNBEAT_INTERVAL,
  DOWNBEAT_MULT,
  FLAT_MULTIPLIERS,
  HAIR_TRIGGER_MULT,
  JACKPOT_DICE,
  JACKPOT_POINTS,
  OUROBOROS_BONUS,
} from "./Scoring";
import { trialRollTarget } from "./Trial";

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
  | "rain_check"
  | "downbeat"
  | "crunch_time"
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
  | "brick_mold"
  | "chip_mold"
  | "spike_mold"
  | "tithe_bowl"
  | "lucky_coin"
  | "counting_house"
  | "prospector"
  | "reliquary"
  | "pawnbroker"
  // Cursed cards. Each pays for a real boon with a standing drawback, written
  // as an affliction (see systems/Afflictions) rather than in gold alone.
  | "blood_price"
  | "ouroboros"
  | "famished_idol"
  | "the_bloat"
  | "iron_debt"
  | "paupers_vow"
  | "sealed_doors"
  | "devils_bargain"
  | "leaden_dice"
  | "locust_idol"
  | "gamblers_curse"
  | "the_reckoning"
  | "hair_trigger"
  | "long_night"
  | "tollkeeper";

export type Rarity = "common" | "uncommon" | "rare";
export type PriceBand = "free" | "low" | "standard" | "strong" | "build";
export type StackPricing = "none" | "linear" | "explosive";

/** The build archetype an item belongs to. Purely descriptive — nothing in the
 *  live game branches on a theme. It exists so the balance simulation can run
 *  bots that buy toward a coherent build instead of by price alone, which is
 *  what makes its win-rate numbers resemble how the game is actually played.
 *  See ITEM_THEMES below. */
export type ItemTheme =
  | "swarm" // grow the grid
  | "multiplier" // compound the run multiplier
  | "precision" // make each die score more often
  | "economy" // generate and stretch gold
  | "tempo"; // more rolls, and safety nets

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
  | "hasCrunchTime"
  | "hasCouponBook"
  | "hasDealersBell"
  | "hasShoppingCart"
  | "hasProspector"
  | "hasReliquary"
  | "hasPawnbroker"
  // The boon half of a cursed card. Its drawback is an affliction, never a flag
  // — so a boss can inflict the drawback without granting the boon with it.
  | "hasBloodPrice"
  | "hasOuroboros"
  | "hasFamishedIdol"
  | "hasBloat"
  | "hasSealedDoors"
  | "hasGamblersCurse"
  | "hasReckoning"
  | "hasHairTrigger";

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
  | "rainCheck"
  | "downbeat"
  | "prism"
  | "lastCall"
  | "brickMold"
  | "chipMold"
  | "spikeMold"
  | "titheBowl"
  | "luckyCoin"
  | "countingHouse";

/**
 * A persistent-unlock condition on an item. Items without one are available
 * from the start; those with one only enter the shop pool once the player has
 * met the criterion (checked against the live run — see `meetsCriterion` and
 * SaveData.evaluateAndUnlock). Add new kinds here as new unlocks are designed.
 */
export type UnlockCriterion =
  | { kind: "diceInGrid"; count: number } // more than `count` dice in the grid at once
  | { kind: "winGame" } // clear the final rank
  | { kind: "reachRank"; rank: number } // reach at least this rank
  | { kind: "scoreInRound"; points: number } // score at least this many points in one trial
  | { kind: "diceOfSize"; sides: DieSides; count: number } // hold `count`+ dice of this size at once
  | { kind: "scoreStreak"; count: number } // score on `count` rolls in a row (one run)
  | { kind: "sameFaceCount"; count: number } // show one face on `count`+ dice in a single roll
  | { kind: "clutchClear" } // cross the goal on a trial's final roll
  | { kind: "scoreVsTarget"; factor: number } // reach `factor`× the current trial's goal
  | { kind: "clearBosses"; count: number } // clear `count` Boss Trials in one run
  | { kind: "goldHeld"; amount: number } // hold `amount` gold at once
  | { kind: "rollsLeftOnClear"; count: number }; // clear a trial with `count` rolls to spare

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
  | { kind: "bonusRollsProportional"; fraction: number; min: number } // add max(min, ⌊fraction·roll budget⌋) rolls, this trial only
  | { kind: "bonusRollPerRound"; count?: number }
  | { kind: "setFlag"; flag: RunFlag }
  | { kind: "incCounter"; counter: RunCounter }
  | { kind: "addGold"; amount: number }
  /** Inflict a standing drawback for the rest of the run. The curse half of
   *  every cursed card, and the one effect that makes a purchase worse. */
  | { kind: "afflict"; id: AfflictionId };

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
const bonusRollsProportional = (fraction: number, min: number): Effect => ({
  kind: "bonusRollsProportional",
  fraction,
  min,
});
const bonusRollPerRound = (count = 1): Effect => ({
  kind: "bonusRollPerRound",
  count,
});
const setFlag = (flag: RunFlag): Effect => ({ kind: "setFlag", flag });
const addGold = (amount: number): Effect => ({ kind: "addGold", amount });
const afflictWith = (id: AfflictionId): Effect => ({ kind: "afflict", id });
const incCounter = (counter: RunCounter): Effect => ({
  kind: "incCounter",
  counter,
});

export interface ItemDef {
  id: ShopItemId;
  name: string;
  /** Gold price tier. The concrete cost is resolved by the shop from the band,
   *  the copies already owned, and that visit's market adjustment. */
  priceBand: PriceBand;
  /** Repeat-purchase surcharge. Unique/free items use `none`. */
  stackPricing?: StackPricing;
  rarity: Rarity;
  /** Card text — a function when it depends on run state (e.g. Extra Number). */
  desc: string | ((state: RunState) => string);
  needsTarget?: boolean; // player must pick a die (shrink, twin, loaded_die, wild_face)
  /** The pick only names a die SIZE — every die of it is an equally good way of
   *  saying which one. The shop shows one die per size held for these, rather
   *  than the whole grid; an item without it targets one specific die. */
  targetsSize?: boolean;
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
  /** A cursed item: strong, but paid for with a standing drawback rather than
   *  gold alone. Purely a presentation flag — nothing in the rules branches on
   *  it, the drawback lives in the item's own effects — but every card surface
   *  marks it, so a card that will cost the run something is never mistaken for
   *  an ordinary one (see ui/itemCard's cursed treatment). */
  cursed?: boolean;
  effects: Effect[];
}

/** Flat "starter" items add a fixed amount that becomes noise once the grid is
 *  large, so the shop stops offering them past this many dice — a struggling
 *  player with a small grid still sees them (shop hygiene, not a hard removal).
 *  Two Bricks is exempt: it's the guaranteed free fallback in rollShopOffers. */
const STARTER_GRID_CAP = 75;
const smallGrid = (s: RunState) => s.dice.length < STARTER_GRID_CAP;

/** Face marks for card copy. Each switches the face of everything that follows
 *  it until the next mark; they are control characters, so nothing a card
 *  actually prints can collide with them. A Phaser Text is one face all the way
 *  through, so marked copy is wrapped and set by ui/richCopy instead. */
export const MARK_STRUCK = "\u0011";
export const MARK_STRONG = "\u0012";
export const MARK_PLAIN = "\u0013";

/** The figure a card gives now, then the one it would give with another copy —
 *  so "what does one more of these buy me?" is answered on the card itself.
 *
 *  The figure you have now is struck through and the one another copy buys
 *  follows it in bold. No arrow between them: the strike already says which of
 *  the two is the old value, and the arrow only crowded the line. */
export function upgrade(
  current: string | number,
  next: string | number,
): string {
  return `${MARK_STRUCK}${current}${MARK_PLAIN} ${MARK_STRONG}${next}${MARK_PLAIN}`;
}

/**
 * Card text for a stacking passive. `owned` reads the run's copy count, `value`
 * turns a copy count into the figure the card advertises, and `line` prints it
 * (given the figure and whether the value it is selling is plural). With nothing
 * owned the card reads as a plain sentence; from the first copy on, the figure
 * becomes the old value struck through followed by the new one in bold.
 */
function stacking(
  owned: (s: RunState) => number,
  value: (copies: number, s: RunState) => string | number,
  line: (figure: string, plural: boolean) => string,
): (s: RunState) => string {
  return (s) => {
    const copies = owned(s);
    const next = value(copies + 1, s);
    return line(
      copies > 0 ? upgrade(value(copies, s), next) : String(next),
      String(next) !== "1",
    );
  };
}

/** How many dice an `addDiceProportional` effect adds right now — the one
 *  definition behind both the effect and the card that advertises it. */
export function proportionalCount(
  state: RunState,
  fraction: number,
  min: number,
): number {
  return Math.max(min, Math.floor(state.dice.length * fraction));
}

/** Extra Dice scales with the grid so it never becomes a rounding error. */
const EXTRA_DICE_FRACTION = 0.25;
const EXTRA_DICE_MIN = 5;

/** Overtime buys a quarter of the trial's own roll budget rather than a flat
 *  two — which was a seventh of a Lesser Trial and a twentieth of a Greater
 *  one — and never less than the two it used to give. */
const OVERTIME_FRACTION = 0.25;
const OVERTIME_MIN = 2;
export function overtimeRolls(state: RunState): number {
  return Math.max(
    OVERTIME_MIN,
    Math.floor(trialRollTarget(state) * OVERTIME_FRACTION),
  );
}

// --- Cursed card copy -------------------------------------------------------
//
// A cursed card states two things it must never get wrong: what it pays, and
// what it costs. Both are read back from the tables that actually enforce them —
// the scoring multipliers from FLAT_MULTIPLIERS, the drawbacks from AFFLICTIONS
// — so a tuning change moves the card text with it.

/** A flat multiplier as its card prints it (`×4`), by the item that sells it. */
function flatMult(item: ShopItemId): string {
  const def = FLAT_MULTIPLIERS.find((m) => m.item === item);
  return def ? `×${def.mult}` : "×1";
}

/** A drawback's chance as its card prints it (`10%`). */
function pct(fraction = 0): string {
  return `${Math.round(fraction * 100)}%`;
}

/** A goal multiplier as the card prints the rise (`25%`). */
function goalRise(multMilli = 1_000): string {
  return `${Math.round((multMilli - 1_000) / 10)}%`;
}

/** What The Long Night buys, and what Devil's Bargain lends. */
const LONG_NIGHT_BONUS_ROLLS = 5;
const DEVILS_BARGAIN_GOLD = 20;
/** What Ouroboros pays for a die the grid pays one for. */
const OUROBOROS_DIE_POINTS = 1n + OUROBOROS_BONUS;

/** Shopping Cart's across-the-board discount. Declared here with the card that
 *  promises it; the shop's pricing reads it back (see systems/Shop). */
export const SHOPPING_CART_DISCOUNT_PERCENT = 25;

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
    name: "Two cents",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Add two d2 to your grid.",
    available: smallGrid,
    effects: [addDice(2, 2)],
  },
  {
    id: "spike",
    name: "Two spikes",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: "Add two d4 to your grid.",
    available: smallGrid,
    effects: [addDice(4, 2)],
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
    id: "centurion",
    name: "Centurion",
    priceBand: "strong",
    stackPricing: "linear",
    rarity: "rare",
    desc: "Add a d100. Its highest face always scores and quadruples all points that roll.",
    effects: [addDice(100, 1, { maxFaceBonus: true })],
  },
  {
    id: "pocket_change",
    name: "Pocket Change",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: stacking(
      (s) => s.pocketChange,
      (copies) => 2 * copies,
      (points) => `Gain ${points} points on every roll.`,
    ),
    available: smallGrid,
    effects: [incCounter("pocketChange")],
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
    id: "grindstone",
    name: "Grindstone",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Choose a die size — every die of that size shrinks two steps.",
    needsTarget: true,
    targetsSize: true,
    available: (s) => s.dice.shrinkableCount() > 0,
    effects: [shrinkSize(2)],
  },
  {
    id: "whetstone",
    name: "Whetstone",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    // Each copy rolls its own 10% chance, so the figure is the per-roll rate
    // rather than the odds of exactly one shrink.
    desc: stacking(
      (s) => s.whetstone,
      (copies) => `${10 * copies}%`,
      (chance) =>
        `Each roll, a ${chance} chance to shrink a random die one size.`,
    ),
    effects: [incCounter("whetstone")],
  },
  {
    id: "twin",
    name: "Twins",
    priceBand: "strong",
    stackPricing: "explosive",
    rarity: "common",
    desc: "Choose a die size — every die of that size is duplicated.",
    needsTarget: true,
    targetsSize: true,
    effects: [twinSize()],
  },
  {
    id: "overtime",
    name: "Overtime",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: (s) => `Add ${overtimeRolls(s)} rolls to the next trial.`,
    effects: [bonusRollsProportional(OVERTIME_FRACTION, OVERTIME_MIN)],
  },
  {
    id: "metronome",
    name: "Metronome",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: stacking(
      (s) => s.bonusRollsPerRound,
      (copies) => copies,
      (rolls, plural) =>
        `Add ${rolls} permanent roll${plural ? "s" : ""} to every trial.`,
    ),
    effects: [bonusRollPerRound()],
  },
  // Overtime rents rolls for one trial and Metronome buys them outright; Rain
  // Check earns them, by clearing with room to spare. It pays nothing to a
  // build that needs every roll it is given, which is the point: it rewards
  // overkill instead of adding to it.
  {
    id: "rain_check",
    name: "Rain Check",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: stacking(
      (s) => s.rainCheck,
      (copies) => copies,
      (rolls, plural) =>
        `When you clear a trial, carry up to ${rolls} unused roll${plural ? "s" : ""} into the next one.`,
    ),
    unlock: { kind: "rollsLeftOnClear", count: 8 },
    effects: [incCounter("rainCheck")],
  },
  {
    id: "downbeat",
    name: "Downbeat",
    priceBand: "strong",
    stackPricing: "explosive",
    rarity: "uncommon",
    desc: stacking(
      (s) => s.downbeat,
      (copies) => `×${DOWNBEAT_MULT ** BigInt(copies)}`,
      (factor) =>
        `Every ${DOWNBEAT_INTERVAL}th roll of a trial multiplies points by ${factor}.`,
    ),
    unlock: { kind: "scoreStreak", count: 20 },
    effects: [incCounter("downbeat")],
  },
  {
    id: "extra_dice",
    name: "Extra Dice",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    // Quoted against the grid the player is holding, because "a quarter of your
    // grid" is the rule, not the answer to "is this worth five gold right now?".
    desc: (s) =>
      `Add ${proportionalCount(s, EXTRA_DICE_FRACTION, EXTRA_DICE_MIN)} d6 to your grid`,
    effects: [addDiceProportional(6, EXTRA_DICE_FRACTION, EXTRA_DICE_MIN)],
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
    id: "mult3",
    name: "Multiply Dice ×3",
    priceBand: "build",
    stackPricing: "explosive",
    rarity: "rare",
    desc: "Triple every die in your grid.",
    effects: [multiplyDice(3)],
  },
  {
    id: "loaded_die",
    name: "Loaded Die",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: "Choose a die size — every die of that size never rolls its two highest faces, now and later.",
    needsTarget: true,
    targetsSize: true,
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
    desc: "Shops offer 5 loose cards, and booster packs reveal 5 choices.",
    effects: [setFlag("ownedLedger")],
  },
  {
    id: "extra_point",
    name: "Extra Point",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "rare",
    // A scoring die always pays at least its own point, so the figure this
    // replaces is worth printing even on the first copy.
    desc: (s) =>
      `Each scoring die grants ${upgrade(1 + s.extraPoints, 2 + s.extraPoints)} points.`,
    effects: [extraPoint()],
  },
  {
    id: "extra_number",
    name: "Decree",
    priceBand: "strong",
    stackPricing: "linear",
    rarity: "rare",
    desc: (s) =>
      `The Order decrees that dice showing ${2 + s.extraNumberCount} also score.`,
    available: (s) => s.extraNumberCount < MAX_EXTRA_NUMBERS,
    effects: [extraNumber()],
  },
  {
    id: "amplifier",
    name: "Amplifier",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    // "points earned from rolls" was every point the game pays: there is no
    // other kind, and the qualifier only invited the question.
    desc: "Double every point you earn.",
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
    desc: "Choose a die size — every die of that size scores on every face, now and later.",
    needsTarget: true,
    targetsSize: true,
    effects: [wildSize()],
  },
  // Interest itself is taught by the tutorial's Interest step, on the trial
  // results receipt (see systems/Tutorial and TrialResultsScene), so this card
  // lands on a rule the player has already been shown.
  {
    id: "vault",
    name: "Vault",
    priceBand: "standard",
    rarity: "rare",
    unique: true,
    desc: "Interest pays up to 10 gold per trial instead of 5.",
    effects: [setFlag("hasVault")],
  },
  // A few flat points per written 7 was a rounding error beside any grid worth
  // having. As a ×7 on the whole roll it is the largest single multiplier in
  // the game, and it asks a real price: only dice of seven faces or more can
  // show a 7, so it pulls directly against shrinking the grid down to d1s.
  {
    id: "lucky_seven",
    name: "Lucky Seven",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    desc: "If any rolled value contains a 7, multiply all points earned that roll by 7.",
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
  // The molds all pour the same way (see MOLDS below); what separates them is
  // the size they pour. A d2 scores on half its faces where a d6 scores on a
  // sixth, so the smaller the mold, the dearer and rarer it is.
  {
    id: "chip_mold",
    name: "Chip Mold",
    priceBand: "strong",
    stackPricing: "linear",
    rarity: "rare",
    desc: stacking(
      (s) => s.chipMold,
      (copies) => copies,
      (count) => `Add ${count} d2 to your grid after every roll.`,
    ),
    effects: [incCounter("chipMold")],
  },
  {
    id: "spike_mold",
    name: "Spike Mold",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: stacking(
      (s) => s.spikeMold,
      (copies) => copies,
      (count) => `Add ${count} d4 to your grid after every roll.`,
    ),
    effects: [incCounter("spikeMold")],
  },
  {
    id: "brick_mold",
    name: "Brick Mold",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: stacking(
      (s) => s.brickMold,
      (copies) => copies,
      (count) => `Add ${count} d6 to your grid after every roll.`,
    ),
    effects: [incCounter("brickMold")],
  },
  // The seal pays the face rather than a flat point, so sealing a d100 is worth
  // sealing a d100 for — under the old rule the largest die on the board and a
  // d2 were sealed to exactly the same effect.
  {
    id: "royal_seal",
    name: "Royal Seal",
    priceBand: "strong",
    rarity: "rare",
    needsTarget: true,
    targetsSize: true,
    desc: "Choose a die size. Its maximum face scores its own value, now and on future dice of that size.",
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
    desc: "The first two and final two rolls of every trial earn double points.",
    effects: [setFlag("hasHourglass")],
  },
  {
    id: "insurance_policy",
    name: "Insurance Policy",
    priceBand: "strong",
    rarity: "rare",
    unique: true,
    desc: "If a trial ends at 75% of its goal, clear it anyway and destroy this item.",
    effects: [setFlag("hasInsurancePolicy")],
  },
  // --- Cursed cards --------------------------------------------------------
  //
  // Each is a real boon sold for a standing drawback instead of gold alone. The
  // two halves are deliberately separate: the boon is a flag (or a plain effect)
  // and the drawback is an `afflict`, so the same drawback can later be handed
  // to a boss without the boon following it (see systems/Afflictions).
  //
  // All are unique. A curse folds only once, but a second copy would stack the
  // boon on top of a drawback already paid for, which is not a decision worth
  // offering.
  {
    id: "crunch_time",
    name: "Crunch Time",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    cursed: true,
    desc: `Every point you earn is multiplied by ${flatMult("crunch_time")}, but every trial grants ${-AFFLICTIONS.crunchTime.rollDelta!} fewer rolls.`,
    unlock: { kind: "winGame" },
    effects: [setFlag("hasCrunchTime"), afflictWith("crunchTime")],
  },
  // Breakage bills the player for success rather than failure, which is what
  // keeps it from fading on a late-game grid: the more a build scores, the more
  // of it burns. Two sources of it stack into one likelier break (see the
  // dieBreakChance fold), so Blood Price and Ouroboros together are a build.
  {
    id: "blood_price",
    name: "Blood Price",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    cursed: true,
    desc: `Every point you earn is multiplied by ${flatMult("blood_price")}, but each die that scores has a ${pct(AFFLICTIONS.bloodPrice.dieBreakChance)} chance to shatter.`,
    unlock: { kind: "reachRank", rank: 3 },
    effects: [setFlag("hasBloodPrice"), afflictWith("bloodPrice")],
  },
  {
    id: "ouroboros",
    name: "Ouroboros",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    cursed: true,
    desc: `Every die that scores pays ${OUROBOROS_DIE_POINTS} points instead of 1, but each one has a ${pct(AFFLICTIONS.ouroboros.dieBreakChance)} chance to shatter.`,
    unlock: { kind: "winGame" },
    effects: [setFlag("hasOuroboros"), afflictWith("ouroboros")],
  },
  {
    id: "famished_idol",
    name: "Famished Idol",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    cursed: true,
    desc: `Every point you earn is multiplied by ${flatMult("famished_idol")}, but your grid can never hold more than ${AFFLICTIONS.famishedIdol.gridCap} dice.`,
    unlock: { kind: "scoreVsTarget", factor: 2 },
    effects: [setFlag("hasFamishedIdol"), afflictWith("famishedIdol")],
  },
  {
    id: "the_bloat",
    name: "The Bloat",
    priceBand: "build",
    rarity: "uncommon",
    unique: true,
    cursed: true,
    desc: `Every point you earn is multiplied by ${flatMult("the_bloat")}, but every die in your grid grows one size at the start of each trial.`,
    effects: [setFlag("hasBloat"), afflictWith("bloat")],
  },
  // The economy curses. Each takes a different part of the shop away — its
  // income, its banking, its breadth — so a run can only afford one of them.
  {
    id: "iron_debt",
    name: "Iron Debt",
    priceBand: "strong",
    rarity: "rare",
    unique: true,
    cursed: true,
    // Buys the whole precision build in one card, then takes away the shop that
    // would have sold it: what the run holds when it signs is what it rides.
    desc: (s) =>
      `The Order decrees that dice showing ${2 + s.extraNumberCount} and ${3 + s.extraNumberCount} also score, but a cleared trial pays nothing but its interest.`,
    available: (s) => s.extraNumberCount <= MAX_EXTRA_NUMBERS - 2,
    unlock: { kind: "goldHeld", amount: 25 },
    effects: [extraNumber(), extraNumber(), afflictWith("ironDebt")],
  },
  {
    id: "paupers_vow",
    name: "Pauper's Vow",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    cursed: true,
    desc: (s) =>
      `Each scoring die grants ${upgrade(1 + s.extraPoints, 4 + s.extraPoints)} points, but you lose all gold above ${AFFLICTIONS.paupersVow.goldCeiling} when a trial ends.`,
    effects: [
      extraPoint(),
      extraPoint(),
      extraPoint(),
      afflictWith("paupersVow"),
    ],
  },
  {
    id: "sealed_doors",
    name: "Sealed Doors",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    cursed: true,
    // Trades quantity for quality, and carries a constraint the copy does not
    // spell out: a second application does nothing for a one-time card, so this
    // wants a stacking build and quietly punishes a shelf of unique flags.
    desc: `Every item you buy takes effect twice, but you may buy only ${AFFLICTIONS.sealedDoors.purchaseLimit} item in each shop.`,
    unlock: { kind: "goldHeld", amount: 40 },
    effects: [setFlag("hasSealedDoors"), afflictWith("sealedDoors")],
  },
  {
    id: "devils_bargain",
    name: "Devil's Bargain",
    priceBand: "low",
    rarity: "common",
    unique: true,
    cursed: true,
    // A loan: the only curse on the roster that gets worse the longer the run
    // lives, since the goal it raises is the one thing that grows all game.
    desc: `Gain ${DEVILS_BARGAIN_GOLD} gold now. Every trial's goal is ${goalRise(AFFLICTIONS.devilsBargain.goalMultMilli)} higher for the rest of the run.`,
    effects: [addGold(DEVILS_BARGAIN_GOLD), afflictWith("devilsBargain")],
  },
  {
    id: "tollkeeper",
    name: "Tollkeeper",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    cursed: true,
    // Turns gold into a per-roll resource, which is what makes Tithe Bowl and
    // Lucky Coin fuel rather than filler.
    desc: (s) =>
      `Each scoring die grants ${upgrade(1 + s.extraPoints, 5 + s.extraPoints)} points, but every roll costs ${AFFLICTIONS.tollkeeper.rollGoldCost} gold — a roll you cannot pay for scores nothing.`,
    unlock: { kind: "reachRank", rank: 2 },
    effects: [
      extraPoint(),
      extraPoint(),
      extraPoint(),
      extraPoint(),
      afflictWith("tollkeeper"),
    ],
  },
  // The rules curses: permanent versions of hostile rules the Boss Trials only
  // ever impose for one trial.
  {
    id: "leaden_dice",
    name: "Leaden Dice",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    cursed: true,
    // Reads harmless and is not: loading the whole grid helps 1s land, and in
    // the same stroke kills Windfall, Royal Seal and most of Lucky Seven.
    desc: (s) =>
      `Each scoring die grants ${upgrade(1 + s.extraPoints, 4 + s.extraPoints)} points, but every die is loaded — now and later — and never rolls its two highest faces.`,
    unlock: { kind: "winGame" },
    effects: [
      extraPoint(),
      extraPoint(),
      extraPoint(),
      afflictWith("leadenDice"),
    ],
  },
  {
    id: "locust_idol",
    name: "Locust Idol",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    cursed: true,
    // A timing card rather than a power card. One last enormous pour, after
    // which the grid is frozen and every growth card in the shop is dead space —
    // so buying it early is a trap and buying it late is the play.
    desc: "Multiply every die in your grid by 5. Nothing will ever add a die to your grid again.",
    unlock: { kind: "diceInGrid", count: 1000 },
    effects: [multiplyDice(5), afflictWith("locustIdol")],
  },
  {
    id: "gamblers_curse",
    name: "Gambler's Curse",
    priceBand: "build",
    rarity: "uncommon",
    unique: true,
    cursed: true,
    desc: `Every point you earn is multiplied by ${flatMult("gamblers_curse")}, but each roll has a ${pct(AFFLICTIONS.gamblersCurse.dudRollChance)} chance to score nothing at all.`,
    effects: [setFlag("hasGamblersCurse"), afflictWith("gamblersCurse")],
  },
  // The structural curses, which reshape a trial rather than a rule.
  {
    id: "the_reckoning",
    name: "The Reckoning",
    priceBand: "standard",
    rarity: "common",
    unique: true,
    cursed: true,
    // The honest arithmetic trade, and the one cursed card worth buying early:
    // the multiplier compounds with everything else the run owns, and the goal
    // it doubles does not.
    desc: `Every point you earn is multiplied by ${flatMult("the_reckoning")}, but every trial's goal is doubled.`,
    effects: [setFlag("hasReckoning"), afflictWith("reckoning")],
  },
  {
    id: "hair_trigger",
    name: "Hair Trigger",
    priceBand: "strong",
    rarity: "rare",
    unique: true,
    cursed: true,
    // Rebuilds the trial around its opening roll: Foundry fires before it, the
    // molds never get going, and Metronome buys rolls worth half as much.
    desc: `The first roll of every trial earns ${HAIR_TRIGGER_MULT}× points, but on every roll after it ${pct(AFFLICTIONS.hairTrigger.lateRollDeadFraction)} of your dice score nothing.`,
    unlock: { kind: "clutchClear" },
    effects: [setFlag("hasHairTrigger"), afflictWith("hairTrigger")],
  },
  {
    id: "long_night",
    name: "The Long Night",
    priceBand: "strong",
    rarity: "uncommon",
    unique: true,
    cursed: true,
    // The mirror of Crunch Time: that card sells rolls for points, this one buys
    // them with boss pain.
    desc: `Every trial grants ${LONG_NIGHT_BONUS_ROLLS} more rolls, but every Boss Trial rolls ${AFFLICTIONS.longNight.bossModifierCount} modifiers instead of one.`,
    unlock: { kind: "clearBosses", count: 3 },
    effects: [
      bonusRollPerRound(LONG_NIGHT_BONUS_ROLLS),
      afflictWith("longNight"),
    ],
  },
  {
    id: "coupon_book",
    name: "Coupon Book",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    desc: "One random item in every shop becomes free.",
    effects: [setFlag("hasCouponBook")],
  },
  {
    id: "dealers_bell",
    name: "Dealer's Bell",
    priceBand: "standard",
    rarity: "rare",
    unique: true,
    desc: "Your first reroll in the shop is free.",
    effects: [setFlag("hasDealersBell")],
  },
  {
    id: "shopping_cart",
    name: "Shopping Cart",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    desc: `Every item in the shop costs ${SHOPPING_CART_DISCOUNT_PERCENT}% less gold.`,
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
  // Every repeatable card below quotes what it pays now against what a further
  // copy would pay (see `stacking`), since the whole decision at the counter is
  // whether the next copy is worth its rising price.
  {
    id: "dividend",
    name: "Dividend",
    priceBand: "build",
    stackPricing: "linear",
    rarity: "common",
    desc: stacking(
      (s) => s.dividend,
      (copies) => copies,
      (points) =>
        `On every roll, gain ${points} points for every 3 dice you own.`,
    ),
    unlock: { kind: "reachRank", rank: 2 },
    effects: [incCounter("dividend")],
  },
  {
    id: "momentum",
    name: "Momentum",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "common",
    desc: stacking(
      (s) => s.momentum,
      // The sign travels with the figure rather than sitting in the sentence:
      // an upgrade prints two figures, and a "+" outside them belongs to
      // neither (see `upgrade`).
      (copies) => `+${2 * copies}`,
      (points) =>
        `Each consecutive roll that scores adds ${points} to points earned; a scoreless roll resets it to 0.`,
    ),
    unlock: { kind: "scoreStreak", count: 12 },
    effects: [incCounter("momentum")],
  },
  {
    id: "keen_edge",
    name: "Keen Edge",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "common",
    // A scoring d1 pays its own point plus two per copy.
    desc: stacking(
      (s) => s.keenEdge,
      (copies) => 1 + 2 * copies,
      (points) => `Each d1 scores ${points} points when it scores.`,
    ),
    unlock: { kind: "diceOfSize", sides: 1, count: 10 },
    available: (s) => s.dice.countOfSize(1) > 0,
    effects: [incCounter("keenEdge")],
  },
  // Five more of the smallest die stopped being felt the moment the grid ran to
  // hundreds. Doubling that size instead keeps the card's promise proportional
  // to the grid it is poured into, which is what its explosive price assumes.
  {
    id: "foundry",
    name: "Foundry",
    priceBand: "strong",
    stackPricing: "explosive",
    rarity: "uncommon",
    desc: stacking(
      (s) => s.foundry,
      (copies) => 2 ** copies,
      (factor) =>
        `At the start of each trial, multiply the number of your smallest dice by ${factor}.`,
    ),
    unlock: { kind: "diceInGrid", count: 29 },
    effects: [incCounter("foundry")],
  },
  // Matching faces was Snake Eyes' rule with a higher threshold. Jackpot now
  // pays for the SIZE of a scoring roll instead: nothing at all until five dice
  // land, then a flat purse for every five that do.
  {
    id: "jackpot",
    name: "Jackpot",
    priceBand: "build",
    stackPricing: "linear",
    rarity: "uncommon",
    desc: stacking(
      (s) => s.jackpot,
      (copies) => JACKPOT_POINTS * copies,
      (points) =>
        `When ${JACKPOT_DICE} or more dice score, gain ${points} points for every ${JACKPOT_DICE} that scored.`,
    ),
    unlock: { kind: "sameFaceCount", count: 6 },
    effects: [incCounter("jackpot")],
  },
  {
    id: "last_call",
    name: "Last Call",
    priceBand: "build",
    stackPricing: "explosive",
    rarity: "uncommon",
    desc: stacking(
      (s) => s.lastCall,
      (copies) => `×${4 ** copies}`,
      (factor) =>
        `Points earned on the final roll of each trial are multiplied by ${factor}.`,
    ),
    unlock: { kind: "clutchClear" },
    effects: [incCounter("lastCall")],
  },
  {
    id: "genesis",
    name: "Genesis",
    priceBand: "build",
    stackPricing: "explosive",
    rarity: "rare",
    desc: stacking(
      (s) => s.genesis,
      // As with Momentum, the sign is part of the figure it signs.
      (copies) => `+${20 * copies}`,
      (cap) =>
        `Whenever a die scores, add a copy of that die to the grid (max ${cap} dice per roll).`,
    ),
    unlock: { kind: "reachRank", rank: 4 },
    effects: [incCounter("genesis")],
  },
  {
    id: "reserve",
    name: "Reserve",
    priceBand: "strong",
    stackPricing: "linear",
    rarity: "rare",
    desc: stacking(
      (s) => s.reserve,
      (copies) => copies,
      (gold) =>
        `Each roll left in hand when a trial clears pays ${gold} extra gold.`,
    ),
    unlock: { kind: "scoreVsTarget", factor: 2 },
    effects: [incCounter("reserve")],
  },
  {
    id: "prism",
    name: "Prism",
    priceBand: "build",
    stackPricing: "explosive",
    rarity: "rare",
    desc: stacking(
      (s) => s.prism,
      (copies) => `×${3 ** copies}`,
      (factor) => `Every point you earn is multiplied by ${factor}.`,
    ),
    unlock: { kind: "winGame" },
    effects: [incCounter("prism")],
  },
  // --- Gold items ----------------------------------------------------------
  // These pay in gold rather than points. They do nothing for the trial in
  // front of you and everything for the shop after it, which is the trade the
  // whole economy is built on.
  // An early-game card by construction: it pays for the rolls that score
  // nothing, and a large grid has none. Held to the same small-grid shelf as
  // the other starter items rather than sold to a player it cannot help.
  {
    id: "tithe_bowl",
    name: "Tithe Bowl",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    desc: stacking(
      (s) => s.titheBowl,
      (copies) => copies,
      (gold) => `Gain ${gold} gold on every roll that scores nothing.`,
    ),
    available: smallGrid,
    effects: [incCounter("titheBowl")],
  },
  {
    id: "lucky_coin",
    name: "Lucky Coin",
    priceBand: "low",
    stackPricing: "linear",
    rarity: "common",
    // As with Whetstone, each copy rolls its own chance; the figure is the
    // per-roll rate.
    desc: stacking(
      (s) => s.luckyCoin,
      (copies) => `${10 * copies}%`,
      (chance) => `Each roll, a ${chance} chance to turn up 1 gold.`,
    ),
    effects: [incCounter("luckyCoin")],
  },
  {
    id: "counting_house",
    name: "Counting House",
    priceBand: "standard",
    stackPricing: "linear",
    rarity: "common",
    desc: stacking(
      (s) => s.countingHouse,
      (copies) => copies,
      (gold) => `Gain ${gold} extra gold every time you clear a trial.`,
    ),
    effects: [incCounter("countingHouse")],
  },
  {
    id: "prospector",
    name: "Prospector",
    priceBand: "standard",
    rarity: "uncommon",
    unique: true,
    desc: "Clearing a trial pays 1 gold for every 25 dice you hold, up to 5.",
    unlock: { kind: "goldHeld", amount: 25 },
    effects: [setFlag("hasProspector")],
  },
  // Three gold on the three Boss Trials of a run was a fixed sum in a purse
  // that grows all run. A share of every clear instead scales with the economy
  // the player has built, and rewards buying it early.
  {
    id: "reliquary",
    name: "Reliquary",
    priceBand: "strong",
    rarity: "rare",
    unique: true,
    desc: `Every trial you clear pays ${RELIQUARY_BONUS_PERCENT}% more gold.`,
    unlock: { kind: "clearBosses", count: 3 },
    effects: [setFlag("hasReliquary")],
  },
  {
    id: "pawnbroker",
    name: "Pawnbroker",
    priceBand: "build",
    rarity: "rare",
    unique: true,
    desc: "Every item in the shop costs 2 less gold.",
    unlock: { kind: "goldHeld", amount: 40 },
    effects: [setFlag("hasPawnbroker")],
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
    case "reachRank":
      return `Locked — reach rank ${c.rank}`;
    case "scoreInRound":
      return `Locked — score ${c.points} in a single trial`;
    case "diceOfSize":
      return `Locked — hold ${c.count} d${c.sides} at once`;
    case "scoreStreak":
      return `Locked — score on ${c.count} rolls in a row`;
    case "sameFaceCount":
      return `Locked — show the same number on ${c.count} dice in one roll`;
    case "clutchClear":
      return "Locked — clear a trial on its final roll";
    case "scoreVsTarget":
      return `Locked — reach ${c.factor}× a trial's goal`;
    case "clearBosses":
      return `Locked — clear ${c.count} Boss Trials in one run`;
    case "goldHeld":
      return `Locked — hold ${c.amount} gold at once`;
    case "rollsLeftOnClear":
      return `Locked — clear a trial with ${c.count} rolls to spare`;
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
    case "reachRank":
      return `Reached rank ${c.rank}`;
    case "scoreInRound":
      return `Scored ${c.points} in a single trial`;
    case "diceOfSize":
      return `Held ${c.count} d${c.sides} at once`;
    case "scoreStreak":
      return `Scored on ${c.count} rolls in a row`;
    case "sameFaceCount":
      return `Showed the same number on ${c.count} dice in one roll`;
    case "clutchClear":
      return "Cleared a trial on its final roll";
    case "scoreVsTarget":
      return `Reached ${c.factor}× a trial's goal`;
    case "clearBosses":
      return `Cleared ${c.count} Boss Trials in one run`;
    case "goldHeld":
      return `Held ${c.amount} gold at once`;
    case "rollsLeftOnClear":
      return `Cleared a trial with ${c.count} rolls to spare`;
  }
}

/** Whether the current run satisfies an unlock criterion. `trialScore` is the
 *  peak points reached within the current trial (see RunState). */
export function meetsCriterion(c: UnlockCriterion, state: RunState): boolean {
  switch (c.kind) {
    case "diceInGrid":
      return state.dice.length > c.count;
    case "winGame":
      return rankOf(state.trial) >= WIN_RANK;
    case "reachRank":
      return rankOf(state.trial) >= c.rank;
    case "scoreInRound":
      return state.trialScore >= BigInt(c.points);
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
      return state.score >= BigInt(c.factor) * goalFor(state);
    case "clearBosses":
      return state.bossesCleared >= c.count;
    case "goldHeld":
      return state.peakGold >= c.amount;
    case "rollsLeftOnClear":
      // Read off the run's best clear rather than the live trial: a clear
      // resets the roll counter before unlocks are next evaluated.
      return state.peakRollsLeftOnClear >= c.count;
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
  // A permanently growth-blocking affliction (Locust Idol) means exactly what it
  // says: no effect may put dice on the grid, ever again. Refusing here rather
  // than silently doing nothing aborts the sale, so the player is never charged
  // for a card that could not act.
  //
  // Read off the PERMANENT afflictions, matching the pool Shop.availableIds
  // builds from. This is the purchase path and nothing else, and a purchase is
  // made between trials — so a boss that blocks growth for the trial ahead
  // (The Drought) does not reach back and void a card bought before it. The
  // Drought is enforced where it acts instead: the roll loop's growth passives
  // and applyTrialStart, both of which read the live `blocksGrowth`.
  if (GROWTH_EFFECTS.has(effect.kind) && blocksGrowthPermanently(state))
    return false;

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
      const count = proportionalCount(state, effect.fraction, effect.min);
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
    case "bonusRollsProportional":
      // Bought between trials, so the budget this reads is the one it extends.
      state.bonusRollsThisRound += Math.max(
        effect.min,
        Math.floor(trialRollTarget(state) * effect.fraction),
      );
      return true;
    case "bonusRollPerRound":
      state.bonusRollsPerRound += effect.count ?? 1;
      return true;
    case "addGold":
      grantGold(state, effect.amount);
      return true;
    case "afflict": {
      afflict(state, effect.id);
      // An affliction that loads the grid is carried out through the same
      // persistent size aura Loaded Die uses, so dice added later inherit it.
      // That makes it a drawback for a PERMANENT source; a trial-scoped version
      // would need its own field, read at roll time rather than applied here.
      if (AFFLICTIONS[effect.id].loadsAllDice) {
        for (const sides of DIE_LADDER) {
          if (sides <= 1) continue;
          if (!state.loadedSizes.includes(sides)) state.loadedSizes.push(sides);
          state.dice.loadAllOfSize(sides);
        }
      }
      return true;
    }
    case "setFlag":
      state[effect.flag] = true;
      return true;
    case "incCounter":
      state[effect.counter] += 1;
      return true;
  }
}

/** The effect kinds that put dice on the grid, and so are refused outright while
 *  growth is blocked. The passives that grow the grid on their own (Genesis, the
 *  molds, Foundry, Double the Fun) are stopped where they fire instead — in the
 *  roll loop and in applyTrialStart — since owning them is not the moment they
 *  act. */
const GROWTH_EFFECTS = new Set<Effect["kind"]>([
  "addDice",
  "addDiceProportional",
  "multiplyDice",
  "twinSize",
]);

/** Whether a card would put dice on the grid, either at once or by paying out
 *  over the run. Read by the shop, which stops offering these once a permanent
 *  affliction has frozen the grid — a card that can do nothing at all is worse
 *  than a bad card. */
export function itemGrowsGrid(def: ItemDef): boolean {
  return def.effects.some(
    (effect) =>
      GROWTH_EFFECTS.has(effect.kind) ||
      (effect.kind === "incCounter" && GROWTH_COUNTERS.has(effect.counter)) ||
      (effect.kind === "setFlag" && effect.flag === "hasDoubleTheFun"),
  );
}

/** The standing drawback a card inflicts, read off the effects that actually
 *  inflict it rather than from a second table that could drift from them. Null
 *  for the ordinary cards, which inflict nothing. A cursed card's face is
 *  stamped with this affliction's seal (see ui/itemCard). */
export function afflictionOf(def: ItemDef): AfflictionId | null {
  for (const effect of def.effects)
    if (effect.kind === "afflict") return effect.id;
  return null;
}

const GROWTH_COUNTERS = new Set<RunCounter>([
  "chipMold",
  "spikeMold",
  "brickMold",
  "foundry",
  "genesis",
]);

/** The molds, which each pour dice of one size into the grid after every roll,
 *  one per copy owned. A new mold is a row here and a card above — nothing else
 *  in the roll loop knows how many kinds there are. */
export const MOLDS: {
  id: ShopItemId;
  counter: RunCounter;
  sides: DieSides;
}[] = [
  { id: "chip_mold", counter: "chipMold", sides: 2 },
  { id: "spike_mold", counter: "spikeMold", sides: 4 },
  { id: "brick_mold", counter: "brickMold", sides: 6 },
];

/** How many dice the molds will pour on a roll, without pouring them (the
 *  Drought's "dice denied" cue). */
export function moldDiceCount(state: RunState): number {
  return MOLDS.reduce((n, mold) => n + state[mold.counter], 0);
}

/** Pour every owned mold into the grid, newest dice carrying the mold's own item
 *  id as their source. Returns what each mold added, so the scene can label the
 *  new dice with the card that made them.
 *
 *  `pool` defaults to the run's own grid; the final Boss Trial passes the mirror
 *  rival's, so the same molds pour into both sides of the duel. */
export function applyMolds(
  state: RunState,
  pool: DicePool = state.dice,
): { id: ShopItemId; count: number }[] {
  const poured: { id: ShopItemId; count: number }[] = [];
  for (const mold of MOLDS) {
    const count = state[mold.counter];
    if (count <= 0) continue;
    pool.addDice(mold.sides, count, withSizeAuras(state, mold.sides), mold.id);
    poured.push({ id: mold.id, count });
  }
  return poured;
}

/**
 * Apply the trial-start passives (Foundry dice) to the run and return the number
 * of dice added, so the caller can decide whether to re-lay the grid. Called
 * once as each trial begins (see engine.resolveTrialEnd). Pocket Change and
 * Dividend are not here — they pay out every roll, so they live in scoreRoll.
 */
export function applyTrialStart(state: RunState): number {
  const before = state.dice.length;
  const afflictions = afflictionsFor(state);
  // The Bloat walks the whole grid UP the ladder — the inverse of Refinement,
  // and the reason it fights every build that spent the run shrinking. Applied
  // before Foundry, so Foundry doubles the size the grid actually starts on.
  if (afflictions.dieGrowthPerTrial > 0)
    state.dice.growAll(afflictions.dieGrowthPerTrial);
  // The Drought shuts off every source of new dice for its Boss Trial, Foundry
  // included — otherwise a Foundry build would walk straight through it. Locust
  // Idol says the same thing for the rest of the run.
  if (!blocksGrowth(state) && state.foundry > 0) {
    // Foundry: double the smallest size on the grid, once per copy owned. A flat
    // handful of dice was noise past the first few trials; a doubling stays worth
    // the explosive price the card is sold at.
    state.dice.foundryDouble(state.foundry);
  }
  enforceGridCap(state);
  return state.dice.length - before;
}

/** Cull the grid back to whatever ceiling is in force (Famished Idol's hundred).
 *  Returns how many dice were culled. Called wherever the grid can have grown:
 *  as a trial starts, and after every roll's growth passives. `pool` defaults to
 *  the run's own grid; the mirror duel passes the rival's, so one ceiling holds
 *  both sides. */
export function enforceGridCap(
  state: RunState,
  pool: DicePool = state.dice,
): number {
  const cap = afflictionsFor(state).gridCap;
  if (!Number.isFinite(cap) || pool.length <= cap) return 0;
  return pool.cull(cap);
}

/**
 * Which build archetype each item serves. A total Record rather than an
 * optional field on ItemDef: adding an id to ShopItemId without theming it is a
 * compile error, so the balance simulation's themed bots can never silently
 * drift out of step with the roster. Items may belong to more than one theme,
 * and a few genuinely belong to none.
 */
export const ITEM_THEMES: Record<ShopItemId, ItemTheme[]> = {
  extra_die: ["swarm"],
  extra_dice: ["swarm"],
  chip: ["swarm", "precision"],
  spike: ["swarm", "precision"],
  twin: ["swarm"],
  mult2: ["swarm"],
  mult3: ["swarm"],
  brick_mold: ["swarm"],
  chip_mold: ["swarm", "precision"],
  spike_mold: ["swarm", "precision"],
  foundry: ["swarm"],
  genesis: ["swarm"],
  double_the_fun: ["swarm"],
  refinement: ["swarm", "precision"],

  amplifier: ["multiplier"],
  prism: ["multiplier"],
  last_call: ["multiplier"],
  parade: ["multiplier"],
  menagerie: ["multiplier"],
  uniform: ["multiplier"],
  hourglass: ["multiplier", "tempo"],
  rollplayer: ["multiplier", "precision"],
  centurion: ["multiplier", "precision"],

  shrink: ["precision"],
  whetstone: ["precision"],
  grindstone: ["precision"],
  loaded_die: ["precision"],
  wild_face: ["precision"],
  royal_seal: ["precision"],
  extra_number: ["precision"],
  extra_point: ["precision"],
  keen_edge: ["precision"],
  snake_eyes: ["precision"],
  jackpot: ["precision"],
  lucky_seven: ["precision"],
  pocket_change: ["precision"],
  dividend: ["precision"],
  momentum: ["precision"],

  tithe_bowl: ["economy"],
  lucky_coin: ["economy"],
  counting_house: ["economy"],
  prospector: ["economy"],
  reliquary: ["economy"],
  pawnbroker: ["economy"],
  vault: ["economy"],
  reserve: ["economy", "tempo"],
  coupon_book: ["economy"],
  shopping_cart: ["economy"],
  ledger: ["economy"],
  dealers_bell: ["economy"],

  blood_price: ["multiplier"],
  ouroboros: ["precision", "swarm"],
  famished_idol: ["multiplier", "precision"],
  the_bloat: ["multiplier"],
  iron_debt: ["precision"],
  paupers_vow: ["precision", "economy"],
  sealed_doors: ["economy"],
  devils_bargain: ["economy"],
  leaden_dice: ["precision"],
  locust_idol: ["swarm"],
  gamblers_curse: ["multiplier"],
  the_reckoning: ["multiplier"],
  hair_trigger: ["multiplier", "tempo"],
  long_night: ["tempo"],
  tollkeeper: ["precision", "economy"],

  overtime: ["tempo"],
  metronome: ["tempo"],
  insurance_policy: ["tempo"],
  rain_check: ["tempo"],
  downbeat: ["tempo", "multiplier"],
  crunch_time: ["tempo", "multiplier"],
};

/** Every item that serves `theme`, in roster order. */
export function itemsInTheme(theme: ItemTheme): ShopItemId[] {
  return ITEMS.filter((it) => ITEM_THEMES[it.id].includes(theme)).map(
    (it) => it.id,
  );
}
