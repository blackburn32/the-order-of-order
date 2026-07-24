// Per-item point attribution: turns each roll's `RollResult` into points credited
// to the item that earned them, accumulated on `RunState` across the run. Shared
// by the live game (via the engine's resolveRoll), the headless sim, and the UI
// so every surface tells the same story. The invariant it maintains is
// `sum(dicePoints) + sum(itemPoints) === totalScore` for the run.

import { RunState } from "../state/RunState";
import { RollResult } from "./Scoring";
import { ITEMS, ShopItemId } from "./Items";

/** Sentinel source for the run's initial die, which no item provided. */
export const STARTER_SOURCE = "starter";

/** Scoring-modifier id -> the item that owns it. The base `scoring` modifier is
 *  attributed per-die by source instead (see accumulatePoints), and `windfall`
 *  is a multiplier credited through the amplification split (see WINDFALL_ITEM),
 *  so neither appears here. */
const MODIFIER_ITEM: Record<string, ShopItemId> = {
  extraPoint: "extra_point",
  keenEdge: "keen_edge",
  snakeEyes: "snake_eyes",
  jackpot: "jackpot",
  momentum: "momentum",
  pocketChange: "pocket_change",
  dividend: "dividend",
  luckySeven: "lucky_seven",
};

/** Persistent multiplier -> the item whose top-face effect carries it. This is
 *  deliberately independent of current die size so shrinking a Centurion keeps
 *  it a ×4 Centurion rather than turning it into a Rollplayer. */
const WINDFALL_ITEM: Record<number, ShopItemId> = {
  2: "rollplayer",
  4: "centurion",
};

const NAME_BY_ID = new Map<string, string>(ITEMS.map((it) => [it.id, it.name]));

/** Human label for a point-source key (item id or the starter sentinel). */
export function sourceLabel(source: string): string {
  if (source === STARTER_SOURCE) return "Starter die";
  return NAME_BY_ID.get(source) ?? source;
}

function add(map: Record<string, bigint>, key: string, amount: bigint): void {
  if (amount === 0n) return;
  map[key] = (map[key] ?? 0n) + amount;
}

/** Convert a bigint attribution map to Number at a display/persistence boundary
 *  (Hall entries, leaderboard metadata, sim records). Per-item values past ~9e15
 *  lose low-order precision, which is invisible in an abbreviated breakdown. */
export function toNumberPointMap(
  m: Record<string, bigint>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(m)) out[k] = Number(m[k]);
  return out;
}

/**
 * Fold one roll's scoring into the run's per-item tallies. Must be called after
 * the pool has been rolled (so its per-source tallies reflect this roll) and
 * before the grid grows. The base `scoring` and `windfall` modifiers are
 * credited from the pool's per-source aggregates rather than per-die indices, so
 * this works identically whether the grid is stored per-die or bucketed. Mutates
 * `state.dicePoints` and `state.itemPoints`.
 */
export function accumulatePoints(
  state: RunState,
  result: RollResult,
  finalRoll: boolean,
): void {
  const scoringBySource = state.dice.scoringBySource();
  let subtotal = 0n;
  for (const mod of result.modifiers) {
    subtotal += mod.points; // Windfall carries points 0 (a multiplier, credited below)
    if (mod.id === "scoring") {
      // Base rolling points: exactly 1 per scoring die, credited to its source.
      for (const [source, count] of scoringBySource)
        add(state.dicePoints, source, BigInt(count));
    } else {
      const id = MODIFIER_ITEM[mod.id];
      if (id) add(state.itemPoints, id, mod.points);
    }
  }

  // Run multiplier (Amplifier x2, Prism x3^n, Last Call x4^n on the final roll,
  // and Windfall's Rollplayer/Centurion top-face factors): the amplification it
  // adds over the raw subtotal is split across the active multiplier items in
  // proportion to their own factor - 1. All-bigint, so the per-item shares sum to
  // the roll's amplification exactly (bar one unit of integer-division truncation).
  const amplification = subtotal * (result.multiplier - 1n);
  if (amplification <= 0n) return;
  const weights: [ShopItemId, bigint][] = [];
  if (state.hasAmplifier) weights.push(["amplifier", 2n - 1n]);
  if (state.prism > 0) weights.push(["prism", 3n ** BigInt(state.prism) - 1n]);
  if (finalRoll && state.lastCall > 0)
    weights.push(["last_call", 4n ** BigInt(state.lastCall) - 1n]);
  if (
    state.hasParade &&
    state.dice.agg().valueCounts.has(1) &&
    state.dice.agg().valueCounts.has(2) &&
    state.dice.agg().valueCounts.has(3)
  )
    weights.push(["parade", 1n]);
  if (state.hasMenagerie && state.dice.agg().scoringSizes.size >= 3)
    weights.push(["menagerie", 1n]);
  if (
    state.hasUniform &&
    state.dice.agg().total > 0 &&
    state.dice.agg().allSizes.size === 1
  )
    weights.push(["uniform", 2n]);
  if (state.hasHourglass) {
    const hourglass = result.modifiers.find((m) => m.id === "hourglass");
    if (hourglass) weights.push(["hourglass", 1n]);
  }
  // Each distinct card effect that hit its current top face contributes
  // factor - 1, credited independently of the die's post-shrink size.
  for (const [persistentFactor, factor] of state.dice.windfallTriggers()) {
    const id = WINDFALL_ITEM[persistentFactor];
    if (id) weights.push([id, factor - 1n]);
  }
  const total = weights.reduce((s, [, w]) => s + w, 0n);
  if (total <= 0n) return;
  for (const [id, w] of weights)
    add(state.itemPoints, id, (amplification * w) / total);
}

export interface PointEntry {
  id: string; // item id or the starter sentinel
  label: string; // display name
  dice: number; // base rolling points from dice this source provided
  bonus: number; // bonus + multiplier points attributed to this item
  points: number; // dice + bonus
}

/** Merge the two tallies into a single per-item list, sorted by total points
 *  descending. Used by the sim report and the in-game analysis panel. */
export function combinePointsByItem(
  dicePoints: Record<string, number> = {},
  itemPoints: Record<string, number> = {},
): PointEntry[] {
  const ids = new Set<string>([
    ...Object.keys(dicePoints),
    ...Object.keys(itemPoints),
  ]);
  const entries: PointEntry[] = [];
  for (const id of ids) {
    const dice = dicePoints[id] ?? 0;
    const bonus = itemPoints[id] ?? 0;
    entries.push({
      id,
      label: sourceLabel(id),
      dice,
      bonus,
      points: dice + bonus,
    });
  }
  entries.sort((a, b) => b.points - a.points);
  return entries;
}
