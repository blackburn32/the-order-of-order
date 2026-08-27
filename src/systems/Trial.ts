// The shape of a single trial: how many rolls it grants.
//
// Lives here rather than in the engine because both the scorers (Hourglass
// needs to know which rolls are the first and last two) and the gold payout
// (unused rolls) need it, and neither can import the engine without a cycle.

import { rollsForTrial } from "../config";
import type { RunState } from "../state/RunState";
import { afflictionsForTrial } from "./Afflictions";

/** This trial's roll budget: its base length, plus Metronome's permanent bonus
 *  and Overtime's this-trial-only bonus, minus whatever every affliction in
 *  force takes off it (The Hunger's five, Crunch Time's three) or adds to it
 *  (The Long Night's five).
 *  Never drops below 1 — an affliction that shortens a trial must not erase it. */
export function trialRollTarget(s: RunState): number {
  return trialRollTargetFor(s, s.trial);
}

/** Preview the roll budget for any trial in the current rank. Overtime belongs
 * only to the active trial; permanent Metronome and the rank boss are visible
 * ahead of time. */
export function trialRollTargetFor(s: RunState, trial: number): number {
  return Math.max(
    1,
    rollsForTrial(trial) +
      s.bonusRollsPerRound +
      (trial === s.trial ? s.bonusRollsThisRound : 0) +
      afflictionsForTrial(s, trial).rollDelta,
  );
}
