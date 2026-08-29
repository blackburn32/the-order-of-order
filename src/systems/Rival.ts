// The Order of Disorder — the opponent of the final Boss Trial.
//
// The rival is the player, exactly. It opens the duel holding a copy of the
// player's grid, die for die, and every roll it takes is scored by the same
// scorer, with the same build, the same scoring numbers, the same afflictions
// and the same growth passives. It is handed no advantage and given no
// handicap, so the duel is a fair coin: the last thing the Order faces is
// itself, and the only question the trial asks is which way the dice fall.
//
// That fairness is a property of construction rather than of tuning. Nothing in
// this file decides how well the rival does; it only routes the player's own
// rules over a second pool of dice. If the win rate ever drifts off 50%, the
// bug is a rule being applied to one side and not the other — not a number here
// that wants changing.

import type { RunState } from "../state/RunState";
import { scoringNumbersFor } from "./Afflictions";
import { DicePool } from "./DicePool";

export interface RivalState {
  /** The mirror grid. A copy of the player's as the duel opened, grown and
   *  billed by the same passives ever since. */
  dice: DicePool;
  score: bigint;
  roll: number;
}

/** Open the duel: the rival takes the grid the player walks in with. */
export function createRival(state: RunState): RivalState {
  return {
    dice: DicePool.fromStacks(state.dice.summarize()),
    score: 0n,
    roll: 0,
  };
}

/** Roll the rival's grid, with the player's own scoring rules. The caller scores
 *  and grows it — this only puts faces on the dice. */
export function rollRival(
  state: RunState,
  rival: RivalState,
  rng: () => number = Math.random,
): void {
  rival.dice.roll(rng, scoringNumbersFor(state), state.royalSealSizes);
}

/** True when the player is ahead of the rival. A tie is not a lead: the trial
 *  is cleared by outscoring the Order of Disorder, not by matching it. */
export function playerLeadsDuel(state: RunState): boolean {
  if (!state.rival) return true;
  return state.score > state.rival.score;
}

/** The rival's score, or zero before the duel has opened. */
export function rivalScore(state: RunState): bigint {
  return state.rival?.score ?? 0n;
}
