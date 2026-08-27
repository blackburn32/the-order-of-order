// Boss Trial modifiers.
//
// The third trial of every rank is a Boss Trial: it rolls one hostile modifier
// that makes its goal harder to reach, and rewards the player with a better
// shop if they clear it anyway. Each modifier is a small guarded branch in code
// that already exists (the scorer, the roll loop, the goal lookup) rather than a
// subsystem of its own — the table below is the whole design.
//
// IMPORTANT: modifiers that touch scoring must behave identically in both
// scorers — `ScoringHistogram.scoreRollHistogram` (the live path) and
// `Scoring.scoreRoll` (the reference implementation). `npx tsx
// src/sim/compareScoring.ts` fails loudly if they drift.

import { isBossTrial, trialGoal, trialInRank } from "../config";
import type { RunState } from "../state/RunState";

export type BossModifierId =
  | "famine"
  | "drought"
  | "eclipse"
  | "silence"
  | "hunger"
  | "warden"
  | "toll"
  | "hoard";

/** Scoring bonuses a modifier can switch off for the duration of its trial. */
export type SuppressibleBonus =
  | "extraPoint" // Extra Point's per-scoring-die bonus
  | "keenEdge" // Keen Edge's d1 bonus
  | "patterns" // Snake Eyes, Jackpot, Lucky Seven
  | "extraNumber"; // the 2/3/4 scoring numbers, leaving only 1

export interface BossModifier {
  id: BossModifierId;
  name: string;
  /** One line, shown on the announcement banner and the GOAL badge tooltip. */
  desc: string;
  /** Compact all-caps rule used by the in-trial ribbon. */
  shortDesc: string;
  /** Added to the trial's roll budget (negative shortens it). */
  rollDelta?: number;
  /** Per-mille multiplier on the trial's goal (1_400 = +40%). */
  goalMultMilli?: number;
  /** Per-mille multiplier on the gold paid for clearing (2_000 = double). */
  goldMultMilli?: number;
  /** No dice are added this trial — Genesis, Double the Fun, Brick Mold and
   *  Foundry all produce nothing. */
  blocksGrowth?: boolean;
  suppress?: SuppressibleBonus[];
  /** The compounded run multiplier is halved (floored at 1). */
  halveMultiplier?: boolean;
  /** This fraction of the grid scores nothing. Applied to the roll AGGREGATE,
   *  never to individual dice, so it behaves the same in bucket mode where
   *  individual dice do not exist. */
  deadDiceFraction?: number;
}

export const BOSS_MODIFIERS: BossModifier[] = [
  {
    id: "famine",
    name: "The Famine",
    desc: "Extra Point and Keen Edge grant nothing.",
    shortDesc: "BONUSES SEALED",
    suppress: ["extraPoint", "keenEdge"],
  },
  {
    id: "drought",
    name: "The Drought",
    desc: "No dice are added this trial.",
    shortDesc: "NO DICE ADDED",
    blocksGrowth: true,
  },
  {
    id: "eclipse",
    name: "The Eclipse",
    desc: "Your roll multiplier is halved.",
    shortDesc: "MULTIPLIER HALVED",
    halveMultiplier: true,
  },
  {
    id: "silence",
    name: "The Silence",
    desc: "Only 1s score — the numbers you unlocked are silenced.",
    shortDesc: "UNLOCKED NUMBERS SILENCED",
    suppress: ["extraNumber"],
  },
  {
    id: "hunger",
    name: "The Hunger",
    desc: "Five fewer rolls.",
    shortDesc: "5 FEWER ROLLS",
    rollDelta: -5,
  },
  {
    id: "warden",
    name: "The Warden",
    desc: "Snake Eyes, Jackpot and Lucky Seven grant nothing.",
    shortDesc: "PATTERNS SEALED",
    suppress: ["patterns"],
  },
  {
    id: "toll",
    name: "The Toll",
    desc: "A tenth of your dice score nothing.",
    shortDesc: "10% OF DICE INERT",
    deadDiceFraction: 0.1,
  },
  {
    id: "hoard",
    name: "The Hoard",
    desc: "The goal is 40% higher, but clearing it pays double gold.",
    shortDesc: "+40% GOAL · ×2 GOLD",
    goalMultMilli: 1_400,
    goldMultMilli: 2_000,
  },
];

const BY_ID = new Map<BossModifierId, BossModifier>(
  BOSS_MODIFIERS.map((b) => [b.id, b]),
);

export function bossById(id: BossModifierId | null): BossModifier | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** The modifier in force right now, or null outside a Boss Trial. */
export function activeBoss(state: RunState): BossModifier | null {
  return isBossTrial(state.trial) ? bossById(state.bossModifier) : null;
}

/** The modifier assigned to the current rank, including while the player is
 * still approaching its Boss Trial. Overview/shop screens use this preview;
 * gameplay must use `activeBoss`, which guards against applying it early. */
export function rankBoss(state: RunState): BossModifier | null {
  return bossById(state.bossModifier);
}

/** Pick the modifier for a Boss Trial, never repeating the one just faced so
 *  back-to-back ranks feel different. */
export function rollBossModifier(
  rng: () => number = Math.random,
  exclude: BossModifierId | null = null,
): BossModifierId {
  const pool = BOSS_MODIFIERS.filter((b) => b.id !== exclude);
  return pool[Math.floor(rng() * pool.length)].id;
}

// ---- Query helpers used by the engine and the scorers ----------------------

export function bossSuppresses(
  state: RunState,
  bonus: SuppressibleBonus,
): boolean {
  return activeBoss(state)?.suppress?.includes(bonus) ?? false;
}

export function bossBlocksGrowth(state: RunState): boolean {
  return activeBoss(state)?.blocksGrowth ?? false;
}

export function bossRollDelta(state: RunState): number {
  return activeBoss(state)?.rollDelta ?? 0;
}

export function bossRollDeltaFor(id: BossModifierId | null): number {
  return bossById(id)?.rollDelta ?? 0;
}

export function bossHalvesMultiplier(state: RunState): boolean {
  return activeBoss(state)?.halveMultiplier ?? false;
}

export function bossDeadDiceFraction(state: RunState): number {
  return activeBoss(state)?.deadDiceFraction ?? 0;
}

/** Scale a die count down by the active modifier's dead-dice fraction. The one
 *  place that rounding is decided, so both scorers agree exactly. */
export function applyDeadDice(state: RunState, count: number): number {
  const fraction = bossDeadDiceFraction(state);
  if (fraction <= 0 || count <= 0) return count;
  return Math.max(0, count - Math.floor(count * fraction));
}

/** Every face count, scaled by the dead-dice fraction. Returns the original map
 *  untouched when no modifier is dead-dicing, so the common path allocates
 *  nothing. */
export function applyDeadDiceCounts(
  state: RunState,
  counts: Map<number, number>,
): Map<number, number> {
  if (bossDeadDiceFraction(state) <= 0) return counts;
  const scaled = new Map<number, number>();
  for (const [value, count] of counts) {
    scaled.set(value, applyDeadDice(state, count));
  }
  return scaled;
}

// ---- Suppression views -----------------------------------------------------
//
// A suppressing modifier neuters a run field for the length of its trial. Both
// scorers read these accessors instead of the raw field, so a suppression is
// written once and applies identically in the per-die reference implementation
// and the live histogram path — no chance of the two drifting.

/** The faces that score this roll. The Silence cuts this back to 1s only. */
export function scoringNumbersFor(state: RunState): number[] {
  return bossSuppresses(state, "extraNumber")
    ? ONLY_ONES
    : state.scoringNumbers;
}
const ONLY_ONES = [1];

export function extraPointsFor(state: RunState): number {
  return bossSuppresses(state, "extraPoint") ? 0 : state.extraPoints;
}

export function keenEdgeFor(state: RunState): number {
  return bossSuppresses(state, "keenEdge") ? 0 : state.keenEdge;
}

export function snakeEyesFor(state: RunState): boolean {
  return state.hasSnakeEyes && !bossSuppresses(state, "patterns");
}

export function jackpotFor(state: RunState): number {
  return bossSuppresses(state, "patterns") ? 0 : state.jackpot;
}

export function luckySevenFor(state: RunState): boolean {
  return state.hasLuckySeven && !bossSuppresses(state, "patterns");
}

/** The Eclipse halves the compounded run multiplier, never below ×1. */
export function applyBossMultiplier(state: RunState, mult: bigint): bigint {
  if (!bossHalvesMultiplier(state)) return mult;
  const halved = mult / 2n;
  return halved < 1n ? 1n : halved;
}

/** The score this trial must reach, including any boss modifier that raises it.
 *  Everything that gates on "did they clear it" must go through here, not
 *  `trialGoal`, or The Hoard silently does nothing. */
export function goalFor(state: RunState): bigint {
  return goalForTrial(state.trial, state.bossModifier);
}

/** Preview a trial goal without moving RunState. The rank's modifier changes
 * only the Boss Trial, even though it is known from the Lesser Trial onward. */
export function goalForTrial(
  trial: number,
  bossModifier: BossModifierId | null,
): bigint {
  const base = trialGoal(trial);
  const boss = isBossTrial(trial) ? bossById(bossModifier) : null;
  if (!boss?.goalMultMilli) return base;
  return (base * BigInt(boss.goalMultMilli)) / 1000n;
}

/** Per-mille gold multiplier for clearing this trial (The Hoard pays double). */
export function bossGoldMultMilli(state: RunState): number {
  return activeBoss(state)?.goldMultMilli ?? 1_000;
}

/** Keep one previewable modifier for all three trials in a rank. A fresh one is
 * rolled on the Lesser Trial that opens a rank; advancing within the rank keeps
 * the assignment. The defensive null branch also repairs older/dev-created
 * states which entered the middle of a rank without an assignment. */
export function bossForRank(
  trial: number,
  rng: () => number = Math.random,
  previous: BossModifierId | null = null,
): BossModifierId {
  if (trialInRank(trial) === 1 || previous === null) {
    return rollBossModifier(rng, previous);
  }
  return previous;
}
