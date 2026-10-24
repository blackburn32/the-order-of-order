// Reworks of the cards that compounded outside the strategy trees.
//
// The engine-gated goal curve only gates on an engine if nothing else outgrows
// it. Measured against that curve with no engine, today's field reaches the duel
// on stacking multipliers — Vespers, The Toll and Clarity, each ×N per copy —
// and on the two dice-doubling cards. The reworks below turn those into fixed
// factors (tier 2 in systems/ItemTrees):
//   The Inner Circle  a fixed pour of the most common size, not a doubling
//   The Curious       copies only a d6 or larger that rolls its highest face
//   stacking ×N       two copies at most
//   First Light       retired (Hair Trigger), as the trees already propose
//   grid multipliers  The Gathering, The Great Gathering and Like Minds were
//                     cursed: free, and every goal from then on grew by the
//                     share the grid just grew. The curse read as noise on the
//                     card, so they are sold plainly again, rarer and a little
//                     dearer instead (systems/Items); the curse survives only
//                     as a sim switch, for comparison
//
// They are the game's rules. The switch below exists only so a simulation can
// measure the cards as they were sold before, for a baseline.

import type { RunState } from "../state/RunState";
import type { ShopItemId } from "./Items";

let enabled = true;

/** Sim-only. Turns the card reworks off for a baseline, or back on. */
export function setCardReworksForSimulation(on: boolean): void {
  enabled = on;
}

export function cardReworksEnabled(): boolean {
  return enabled;
}

// Sim-only sweep for tuning The Curious as The Gathering's engine: the chance
// that a qualifying die is copied. The card's own is every time.
let curiousChance = 1;

/** Sim-only. The Curious' copy chance for a die that qualifies; null restores
 *  every time. Read only while the reworks are on. */
export function setCuriousCopyChanceForSimulation(chance: number | null): void {
  curiousChance = chance ?? 1;
}

/** The chance a reworked Curious copies a qualifying die; 1 unless swept. */
export function curiousCopyChance(): number {
  return enabled ? curiousChance : 1;
}

/** The grid multipliers a sim can curse (see the switch below). */
export const REWORK_GRID_CURSES: ReadonlySet<ShopItemId> = new Set([
  "mult2",
  "mult3",
  "twin",
]);

// How hard the grid curse bites, as the power the grid's growth is raised to
// before it multiplies the goals: 1 grows goals exactly as much as the grid
// (parity), log2(1.6) grows them ×1.6 for every doubling.
/** The goal growth the grid curse charged per doubling of the grid when it was
 *  live: a little under parity. A sweep that turns the curse on without naming
 *  a strength gets this. */
export const GRID_CURSE_GOAL_PER_DOUBLING = 1.6;
let gridCurseExponent = Math.log2(GRID_CURSE_GOAL_PER_DOUBLING);
let gridCursed = false;

/** Sim-only. Curses the grid multipliers again, charging this goal growth for
 *  doubling the grid — 2 is parity. 0 or null leaves them uncursed, as the live
 *  game sells them. */
export function setGridCurseGoalPerDoublingForSimulation(
  goalPerDoubling: number | null,
): void {
  gridCursed = goalPerDoubling !== null && goalPerDoubling !== 0;
  gridCurseExponent = Math.log2(
    gridCursed ? goalPerDoubling! : GRID_CURSE_GOAL_PER_DOUBLING,
  );
}

/** Whether this card carries the reworks' grid curse. */
export function isGridCurse(id: string): boolean {
  return enabled && gridCursed && REWORK_GRID_CURSES.has(id as ShopItemId);
}

/** What a grid curse multiplies every goal by for growing the grid `growth`×. */
export function gridCurseGoalFactor(growth: number): number {
  return growth ** gridCurseExponent;
}

/** Dice The Inner Circle pours per copy at each trial start, when reworked. */
export const INNER_CIRCLE_POUR = 10;

/** The most copies a reworked stacking multiplier sells. */
export const REWORK_STACK_CAPS: Partial<Record<ShopItemId, number>> = {
  last_call: 2,
  downbeat: 2,
  prism: 2,
};

/** Cards the reworks take out of the game: kept defined, so a run saved holding
 *  one still loads and plays it, but never sold, shown in the collection or
 *  announced as unlocked. */
export const REWORK_RETIRED: ReadonlySet<ShopItemId> = new Set([
  "hair_trigger",
]);

/** Whether this card is retired from the game. */
export function isRetired(id: ShopItemId): boolean {
  return enabled && REWORK_RETIRED.has(id);
}

/** Whether the reworks keep this card off the shelf: it is retired, or the run
 *  owns its cap. */
export function keptOffShelfByReworks(
  state: RunState,
  id: ShopItemId,
): boolean {
  if (!enabled) return false;
  if (isRetired(id)) return true;
  const cap = REWORK_STACK_CAPS[id];
  return cap !== undefined && (state.purchases[id] ?? 0) >= cap;
}
