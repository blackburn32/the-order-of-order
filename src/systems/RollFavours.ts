// The roll favours: Absolution, Benediction and Doxology.
//
// Every other card is read by the scorer or the engine at its moment. These are
// spent by the player instead, from the score panel, on a roll they have just
// seen: Absolution strikes the roll and makes it again, Benediction multiplies
// what it scored. Each copy is one use a trial, so the counts here are a
// trial's allowance, and the engine resets what has been spent when the ladder
// moves (see engine.resolveTrialEnd).

import type { RunState } from "../state/RunState";
import { goalFor } from "./Boss";
import { isMirrorTrial } from "../config";
import { addItemValue } from "./ItemValue";

/** Absolution and Benediction each sell three copies: three uses a trial. */
export const ABSOLUTION_MAX_COPIES = 3;
export const BENEDICTION_MAX_COPIES = 3;
/** Doxology doubles Benediction's factor per copy, ×2 to ×64 over five. */
export const DOXOLOGY_MAX_COPIES = 5;

/** Rerolls left this trial. */
export function rerollsLeft(state: RunState): number {
  return Math.max(0, state.absolution - state.rerollsUsed);
}

/** Blessings left this trial. */
export function blessingsLeft(state: RunState): number {
  return Math.max(0, state.benediction - state.blessingsUsed);
}

/** What a blessing multiplies a roll by with `doxology` copies of Doxology. */
export function blessingFactorFor(doxology: number): bigint {
  return 2n ** BigInt(1 + doxology);
}

/** What a blessing multiplies a roll by for this run. */
export function blessingFactor(state: RunState): bigint {
  return blessingFactorFor(state.doxology);
}

/**
 * The key a roll's dice are drawn under. Named by where the roll sits in the
 * run, as every stream is (see systems/Rng), and by how many rerolls this trial
 * has spent: a reroll restores the run to before the roll, so without the count
 * it would draw the very dice it was bought to replace. A trial that spends none
 * keeps the key it always had.
 */
export function rollStreamKey(state: RunState): string {
  const key = `${state.trial}:${state.roll}`;
  return state.rerollsUsed > 0 ? `${key}:reroll${state.rerollsUsed}` : key;
}

/**
 * A copy of the run the caller can put back later, sharing no mutable structure
 * with it. Taken before a roll is made, so a reroll can return the whole run —
 * score, gold, grid, growth, everything the roll touched — to where it stood.
 */
export function snapshotRun(state: RunState): RunState {
  const { dice, rival, ...rest } = state;
  const copy = structuredClone(rest) as Omit<RunState, "dice" | "rival">;
  return {
    ...copy,
    dice: dice.clone(),
    rival: rival
      ? {
          ...structuredClone({ ...rival, dice: undefined }),
          dice: rival.dice.clone(),
        }
      : null,
  };
}

/**
 * Put a snapshot back on the live run, in place — every scene and the registry
 * hold this same object. What has been spent on favours this trial is kept: a
 * reroll is not undone by the roll it replaces.
 */
export function restoreRun(state: RunState, snapshot: RunState): void {
  const { rerollsUsed, blessingsUsed } = state;
  Object.assign(state, snapshotRun(snapshot));
  state.rerollsUsed = rerollsUsed;
  state.blessingsUsed = blessingsUsed;
}

/**
 * Bless the roll just made: its points count `blessingFactor` times over. The
 * roll's own points are already banked, so what is added is the rest, and the
 * trial's clear is latched again in case the blessing carried it past its goal.
 * Returns the points added.
 */
export function blessRoll(state: RunState, points: bigint): bigint {
  if (points <= 0n || blessingsLeft(state) <= 0) return 0n;
  const factor = blessingFactor(state);
  const added = points * (factor - 1n);
  state.blessingsUsed += 1;
  state.score += added;
  state.totalScore += added;
  if (state.score > state.trialScore) state.trialScore = state.score;
  if (!isMirrorTrial(state.trial) && state.score >= goalFor(state))
    state.trialCleared = true;
  // A blessing's ×2 is Benediction's own; everything Doxology raised it past
  // that is Doxology's.
  const own = points;
  state.itemPoints.benediction = (state.itemPoints.benediction ?? 0n) + own;
  if (added > own)
    state.itemPoints.doxology =
      (state.itemPoints.doxology ?? 0n) + (added - own);
  return added;
}

/** Count a reroll spent: the roll it struck is restored by the caller. */
export function spendReroll(state: RunState): boolean {
  if (rerollsLeft(state) <= 0) return false;
  state.rerollsUsed += 1;
  addItemValue(state, "absolution", 1);
  return true;
}
