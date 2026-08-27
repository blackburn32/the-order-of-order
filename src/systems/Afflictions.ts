// Standing debuffs — one vocabulary for every penalty in the game.
//
// A debuff is never written into the rule that suffers it. Instead a SOURCE
// names an AFFLICTION, and every rule that can be penalised reads the folded
// total back through the accessors at the bottom of this file. Two kinds of
// source exist today — a cursed card the player bought (permanent, listed on
// `RunState.afflictions`) and the Boss Trial they are standing in
// (`RunState.bossModifiers`, in force only on a Boss Trial) — and adding a
// third means adding ids to one array, not touching any rule.
//
// That indirection is the whole point. The Hoard raising a goal and The
// Reckoning doubling one are the same field arriving from two places, so a boss
// can be handed a cursed card's drawback, or a card a boss's, without either
// side learning the other exists.
//
// Sources FOLD rather than overwrite: break chances add, goal multipliers
// compound, two caps take the tighter of the pair. Each field below states its
// own combining rule, and `fold` is the only place they are carried out.

import { isBossTrial } from "../config";
import type { RunState } from "../state/RunState";

/** Scoring bonuses an affliction can switch off while it is in force. */
export type SuppressibleBonus =
  | "extraPoint" // Extra Point's per-scoring-die bonus
  | "keenEdge" // Keen Edge's d1 bonus
  | "patterns" // Snake Eyes, Jackpot, Lucky Seven
  | "extraNumber"; // the 2/3/4 scoring numbers, leaving only 1

/**
 * One bundle of penalties. Every field is optional; an absent field means this
 * source has nothing to say about that rule, which is what lets bundles fold
 * without any source needing to know what the others carry.
 */
export interface Affliction {
  /** Rolls added to every trial's budget — negative takes them away. SUMMED. */
  rollDelta?: number;
  /** Per-mille multiplier on every trial's goal (2_000 doubles it). COMPOUNDED. */
  goalMultMilli?: number;
  /** Per-mille multiplier on the gold a cleared trial pays (0 pays none of it).
   *  COMPOUNDED. Interest is earned on the bank rather than on the trial, and
   *  is not part of the payout this scales. */
  clearGoldMultMilli?: number;
  /** Gold above this is lost when a trial ends. TIGHTEST (min) wins. */
  goldCeiling?: number;
  /** Dice above this many are culled before each roll. TIGHTEST (min) wins. */
  gridCap?: number;
  /** Purchases allowed per shop visit. TIGHTEST (min) wins. */
  purchaseLimit?: number;
  /** Gold every roll costs; a roll that cannot be paid for scores nothing. SUMMED. */
  rollGoldCost?: number;
  /** Chance, per die that scores, that it shatters and leaves the grid. SUMMED —
   *  two sources of breakage are one likelier break, not two rolls of it. */
  dieBreakChance?: number;
  /** Rungs every die climbs UP the ladder at the start of each trial — the
   *  inverse of Refinement. SUMMED. */
  dieGrowthPerTrial?: number;
  /** Chance that a roll scores nothing whatsoever. SUMMED. */
  dudRollChance?: number;
  /** This fraction of the grid scores nothing on every roll of a trial AFTER its
   *  first. SUMMED. Kept apart from `deadDiceFraction` rather than folded into
   *  it because the two answer different questions — one is about the grid, the
   *  other about which roll of the trial this is — and `deadDiceFraction()` is
   *  where they meet. */
  lateRollDeadFraction?: number;
  /** Modifiers a Boss Trial rolls instead of one. LOOSEST (max) wins. */
  bossModifierCount?: number;
  /** This fraction of the grid scores nothing. SUMMED, then capped. */
  deadDiceFraction?: number;
  /** Nothing adds dice to the grid: Genesis, the molds, Foundry, Double the Fun
   *  and Twins all pour nothing. ANY source is enough. */
  blocksGrowth?: boolean;
  /** Every die is loaded — it never rolls its two highest faces, now or later.
   *  ANY source is enough. */
  loadsAllDice?: boolean;
  /** The compounded run multiplier is halved, floored at ×1. ANY source. */
  halveMultiplier?: boolean;
  /** Scoring bonuses switched off for as long as this is in force. UNIONED. */
  suppress?: SuppressibleBonus[];
}

/**
 * Every affliction the game can inflict, by id. The eight boss ids sit in this
 * table alongside the curses because a Boss Trial and a cursed card penalise the
 * player in exactly the same currency: `BOSS_MODIFIERS` keeps only a boss's
 * naming and presentation, and reads its mechanics from here.
 */
export type AfflictionId =
  // Boss Trial modifiers (see systems/Boss for their names and copy).
  | "famine"
  | "drought"
  | "eclipse"
  | "silence"
  | "hunger"
  | "warden"
  | "toll"
  | "hoard"
  // Cursed cards (see the cursed block in systems/Items).
  | "crunchTime"
  | "bloodPrice"
  | "ouroboros"
  | "famishedIdol"
  | "bloat"
  | "ironDebt"
  | "paupersVow"
  | "sealedDoors"
  | "devilsBargain"
  | "leadenDice"
  | "locustIdol"
  | "gamblersCurse"
  | "reckoning"
  | "hairTrigger"
  | "longNight"
  | "tollkeeper";

/** Crunch Time's roll cost, named because its card quotes it. Flat rather than
 *  proportional so the card can state its price in one number — which means it
 *  bites hardest on the short Lesser Trial and lightest on the long Boss Trial,
 *  the shape a curse wants: felt where the trial is already tight. */
export const CRUNCH_TIME_ROLL_COST = 3;
/** Famished Idol's ceiling on the grid. */
export const FAMISHED_IDOL_GRID_CAP = 100;
/** What Pauper's Vow lets the player carry out of a trial. */
export const PAUPERS_VOW_GOLD_CEILING = 7;
/** The Long Night's count of Boss Trial modifiers. */
export const LONG_NIGHT_BOSS_MODIFIERS = 2;

export const AFFLICTIONS: Record<AfflictionId, Affliction> = {
  // --- Boss Trial modifiers ------------------------------------------------
  famine: { suppress: ["extraPoint", "keenEdge"] },
  drought: { blocksGrowth: true },
  eclipse: { halveMultiplier: true },
  silence: { suppress: ["extraNumber"] },
  hunger: { rollDelta: -5 },
  warden: { suppress: ["patterns"] },
  toll: { deadDiceFraction: 0.1 },
  hoard: { goalMultMilli: 1_400 },

  // --- Cursed cards --------------------------------------------------------
  crunchTime: { rollDelta: -CRUNCH_TIME_ROLL_COST },
  bloodPrice: { dieBreakChance: 0.1 },
  ouroboros: { dieBreakChance: 0.5 },
  famishedIdol: { gridCap: FAMISHED_IDOL_GRID_CAP },
  bloat: { dieGrowthPerTrial: 1 },
  ironDebt: { clearGoldMultMilli: 0 },
  paupersVow: { goldCeiling: PAUPERS_VOW_GOLD_CEILING },
  sealedDoors: { purchaseLimit: 1 },
  devilsBargain: { goalMultMilli: 1_250 },
  leadenDice: { loadsAllDice: true },
  locustIdol: { blocksGrowth: true },
  gamblersCurse: { dudRollChance: 0.1 },
  reckoning: { goalMultMilli: 2_000 },
  hairTrigger: { lateRollDeadFraction: 0.5 },
  longNight: { bossModifierCount: LONG_NIGHT_BOSS_MODIFIERS },
  tollkeeper: { rollGoldCost: 1 },
};

/** A folded view: every field resolved, so a reader never writes `?? 0` and
 *  never has to know how many sources contributed. An uncapped cap is Infinity
 *  rather than a sentinel, so `Math.min` against it just works. */
export interface ActiveAfflictions {
  rollDelta: number;
  goalMultMilli: number;
  clearGoldMultMilli: number;
  goldCeiling: number;
  gridCap: number;
  purchaseLimit: number;
  rollGoldCost: number;
  dieBreakChance: number;
  dieGrowthPerTrial: number;
  dudRollChance: number;
  lateRollDeadFraction: number;
  bossModifierCount: number;
  deadDiceFraction: number;
  blocksGrowth: boolean;
  loadsAllDice: boolean;
  halveMultiplier: boolean;
  suppress: SuppressibleBonus[];
}

/** Nothing in force. Also the identity the fold starts from. */
export const NO_AFFLICTIONS: ActiveAfflictions = {
  rollDelta: 0,
  goalMultMilli: 1_000,
  clearGoldMultMilli: 1_000,
  goldCeiling: Infinity,
  gridCap: Infinity,
  purchaseLimit: Infinity,
  rollGoldCost: 0,
  dieBreakChance: 0,
  dieGrowthPerTrial: 0,
  dudRollChance: 0,
  lateRollDeadFraction: 0,
  bossModifierCount: 1,
  deadDiceFraction: 0,
  blocksGrowth: false,
  loadsAllDice: false,
  halveMultiplier: false,
  suppress: [],
};

/** Stacked breakage and dud rolls approach certainty without reaching it, and a
 *  grid that scores nothing at all is a soft-locked run rather than a hard
 *  trial — so the three chance fields are ceilinged after folding. */
const DEAD_DICE_CEILING = 0.9;

/** The single implementation of every combining rule declared on `Affliction`.
 *  A new field is added here and nowhere else. */
export function fold(ids: readonly AfflictionId[]): ActiveAfflictions {
  if (ids.length === 0) return NO_AFFLICTIONS;
  const out: ActiveAfflictions = { ...NO_AFFLICTIONS, suppress: [] };
  const compound = (current: number, next: number) =>
    Math.floor((current * next) / 1_000);
  for (const id of ids) {
    const a = AFFLICTIONS[id];
    if (!a) continue;
    if (a.rollDelta) out.rollDelta += a.rollDelta;
    if (a.goalMultMilli !== undefined)
      out.goalMultMilli = compound(out.goalMultMilli, a.goalMultMilli);
    if (a.clearGoldMultMilli !== undefined)
      out.clearGoldMultMilli = compound(
        out.clearGoldMultMilli,
        a.clearGoldMultMilli,
      );
    if (a.goldCeiling !== undefined)
      out.goldCeiling = Math.min(out.goldCeiling, a.goldCeiling);
    if (a.gridCap !== undefined) out.gridCap = Math.min(out.gridCap, a.gridCap);
    if (a.purchaseLimit !== undefined)
      out.purchaseLimit = Math.min(out.purchaseLimit, a.purchaseLimit);
    if (a.rollGoldCost) out.rollGoldCost += a.rollGoldCost;
    if (a.dieBreakChance) out.dieBreakChance += a.dieBreakChance;
    if (a.dieGrowthPerTrial) out.dieGrowthPerTrial += a.dieGrowthPerTrial;
    if (a.dudRollChance) out.dudRollChance += a.dudRollChance;
    if (a.lateRollDeadFraction)
      out.lateRollDeadFraction += a.lateRollDeadFraction;
    if (a.bossModifierCount !== undefined)
      out.bossModifierCount = Math.max(
        out.bossModifierCount,
        a.bossModifierCount,
      );
    if (a.deadDiceFraction) out.deadDiceFraction += a.deadDiceFraction;
    if (a.blocksGrowth) out.blocksGrowth = true;
    if (a.loadsAllDice) out.loadsAllDice = true;
    if (a.halveMultiplier) out.halveMultiplier = true;
    if (a.suppress)
      for (const bonus of a.suppress)
        if (!out.suppress.includes(bonus)) out.suppress.push(bonus);
  }
  out.dieBreakChance = Math.min(1, out.dieBreakChance);
  out.dudRollChance = Math.min(1, out.dudRollChance);
  out.deadDiceFraction = Math.min(DEAD_DICE_CEILING, out.deadDiceFraction);
  out.lateRollDeadFraction = Math.min(
    DEAD_DICE_CEILING,
    out.lateRollDeadFraction,
  );
  return out;
}

/**
 * Everything afflicting the run right now: the cursed cards it carries, plus the
 * modifiers of the Boss Trial it is standing in. A boss modifier is known from
 * the Lesser Trial onward (it is previewable) but only bites on the Boss Trial
 * itself, which is the one thing this knows that `fold` does not.
 */
export function afflictionsFor(state: RunState): ActiveAfflictions {
  return afflictionsForTrial(state, state.trial);
}

/** The same, for any trial on the ladder rather than the live one — what a rule
 *  needs to preview a goal or a roll budget the player has not reached yet. */
export function afflictionsForTrial(
  state: RunState,
  trial: number,
): ActiveAfflictions {
  const boss = isBossTrial(trial) ? state.bossModifiers : [];
  if (state.afflictions.length === 0 && boss.length === 0)
    return NO_AFFLICTIONS;
  return fold(
    boss.length === 0 ? state.afflictions : [...state.afflictions, ...boss],
  );
}

/** The run's permanent afflictions alone, with no regard for where on the ladder
 *  it stands. Used where a rule is previewed for a trial other than the live one
 *  (a goal shown before it is reached). */
export function permanentAfflictions(state: RunState): ActiveAfflictions {
  return fold(state.afflictions);
}

/** Inflict an affliction for the rest of the run. Idempotent: a second source of
 *  the same id would fold twice and quietly double the curse. */
export function afflict(state: RunState, id: AfflictionId): void {
  if (!state.afflictions.includes(id)) state.afflictions.push(id);
}

// ---- Query helpers ---------------------------------------------------------
//
// Every rule that can be penalised reads one of these rather than a run field,
// so a debuff written once here applies identically in the live game, the
// reference scorer and the balance simulation.

export function suppresses(state: RunState, bonus: SuppressibleBonus): boolean {
  return afflictionsFor(state).suppress.includes(bonus);
}

export function blocksGrowth(state: RunState): boolean {
  return afflictionsFor(state).blocksGrowth;
}

/**
 * The fraction of the grid scoring nothing on the roll about to be scored. The
 * standing fraction (The Toll) plus, on every roll of a trial after its first,
 * the late-roll fraction (Hair Trigger) — which is why this reads `state.roll`
 * rather than being a plain field lookup.
 *
 * Dead dice are the one lever that reduces points without touching the run
 * multiplier, so a penalty expressed here stays exact in the per-item
 * attribution: it lowers the modifiers themselves rather than the factor they
 * are later multiplied by.
 */
export function deadDiceFraction(state: RunState): number {
  const a = afflictionsFor(state);
  const late = state.roll > 0 ? a.lateRollDeadFraction : 0;
  return Math.min(DEAD_DICE_CEILING, a.deadDiceFraction + late);
}

/** Scale a die count down by the dead-dice fraction in force. The one place that
 *  rounding is decided, so both scorers agree exactly. */
export function applyDeadDice(state: RunState, count: number): number {
  const fraction = deadDiceFraction(state);
  if (fraction <= 0 || count <= 0) return count;
  return Math.max(0, count - Math.floor(count * fraction));
}

/** Every face count, scaled by the dead-dice fraction. Returns the original map
 *  untouched when nothing is dead-dicing, so the common path allocates nothing. */
export function applyDeadDiceCounts(
  state: RunState,
  counts: Map<number, number>,
): Map<number, number> {
  if (deadDiceFraction(state) <= 0) return counts;
  const scaled = new Map<number, number>();
  for (const [value, count] of counts)
    scaled.set(value, applyDeadDice(state, count));
  return scaled;
}

// ---- Suppression views -----------------------------------------------------
//
// A suppressing affliction neuters a run field for as long as it is in force.
// Both scorers read these accessors instead of the raw field, so a suppression
// is written once and applies identically in the per-die reference
// implementation and the live histogram path — no chance of the two drifting.

const ONLY_ONES = [1];

/** The faces that score this roll. The Silence cuts this back to 1s only. */
export function scoringNumbersFor(state: RunState): number[] {
  return suppresses(state, "extraNumber") ? ONLY_ONES : state.scoringNumbers;
}

export function extraPointsFor(state: RunState): number {
  return suppresses(state, "extraPoint") ? 0 : state.extraPoints;
}

export function keenEdgeFor(state: RunState): number {
  return suppresses(state, "keenEdge") ? 0 : state.keenEdge;
}

export function snakeEyesFor(state: RunState): boolean {
  return state.hasSnakeEyes && !suppresses(state, "patterns");
}

export function jackpotFor(state: RunState): number {
  return suppresses(state, "patterns") ? 0 : state.jackpot;
}

export function luckySevenFor(state: RunState): boolean {
  return state.hasLuckySeven && !suppresses(state, "patterns");
}

/** The Eclipse halves the compounded run multiplier, never below ×1. */
export function applyMultiplierPenalty(state: RunState, mult: bigint): bigint {
  if (!afflictionsFor(state).halveMultiplier) return mult;
  const halved = mult / 2n;
  return halved < 1n ? 1n : halved;
}
