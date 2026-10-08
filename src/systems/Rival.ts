// The Order of Disorder — the opponent of the final Boss Trial.
//
// The rival is the player, exactly. It opens the duel holding a copy of the
// player's grid, die for die, and every roll it takes is scored by the same
// scorer, with the same build, the same scoring numbers, the same afflictions
// and the same growth passives, against the run exactly as the player's own
// roll met it. Left there, the duel would be a fair coin.
//
// It is not left there. The player has fought ten ranks to stand here and the
// Order has not, so the rival keeps only RIVAL_SHARE of what each roll scores:
// the duel leans the player's way by a fixed, stated amount, and a build that
// can only match itself (a grid of d1s ties every roll) now wins rather than
// losing every time to the tie rule.
//
// Everything else is a property of construction rather than of tuning. If the
// win rate drifts off what the share alone gives (duelCheck measures it), the
// bug is a rule being applied to one side and not the other — not a number
// here that wants changing.

import type { RunState } from "../state/RunState";
import { inertDiceCount, scoringNumbersFor } from "./Afflictions";
import { DicePool } from "./DicePool";
import { rollRulesFor } from "./GrowthEngines";

/** The share of each roll's points the rival keeps, as a fraction (numerator
 *  over denominator, so bigint scores stay exact). */
export const RIVAL_SHARE = { num: 9n, den: 10n } as const;

let rivalShare: { num: bigint; den: bigint } = RIVAL_SHARE;

/** Sim-only: try another rival share; null restores the shipped one. */
export function setRivalShareForSimulation(
  share: { num: bigint; den: bigint } | null,
): void {
  rivalShare = share ?? RIVAL_SHARE;
}

/** What the rival banks from a roll that scored `points` on its grid. */
export function rivalPointsFor(points: bigint): bigint {
  return (points * rivalShare.num) / rivalShare.den;
}

export interface RivalState {
  /** The mirror grid. A copy of the player's as the duel opened, grown and
   *  billed by the same passives ever since. */
  dice: DicePool;
  score: bigint;
  roll: number;
  /** The rival's own scoring streaks. Scoring a roll advances the run's
   *  streaks (Rhythm pays on them), so the rival keeps a pair of its own:
   *  shared ones would advance twice a roll and hand each side's misses to
   *  the other. */
  scoreStreak: number;
  momentumStreak: number;
}

/** Open the duel: the rival takes the grid the player walks in with — and the
 *  ceiling that grid is held under (see systems/Characters).
 *
 *  The ceiling has to be carried explicitly because the mirror is rebuilt from a
 *  stack summary rather than cloned, and a summary is only what the grid holds,
 *  not what it is allowed to hold. Without it a ceilinged player would spend the
 *  duel watching a copy of their own grid outgrow them — the one trial in the
 *  game whose fairness is a property of construction, broken by the one rule
 *  that never reaches the copy. */
export function createRival(state: RunState): RivalState {
  return {
    dice: DicePool.fromStacks(
      state.dice.summarize(),
      undefined,
      state.dice.ceiling,
    ),
    score: 0n,
    roll: 0,
    scoreStreak: state.scoreStreak,
    momentumStreak: state.momentumStreak,
  };
}

/** Roll the rival's grid, with the player's own scoring rules. The caller scores
 *  and grows it — this only puts faces on the dice. */
export function rollRival(
  state: RunState,
  rival: RivalState,
  rng: () => number = Math.random,
): void {
  // Not `engine.rollPool`, which is where every other caller goes: sim/engine
  // imports this file, so importing it back would close a cycle. The inert tail
  // is measured against the rival's own grid — the two can differ in size once
  // breakage has been at them.
  rival.dice.roll(
    rng,
    scoringNumbersFor(state),
    state.royalSealSizes,
    inertDiceCount(state, rival.dice.length),
    rollRulesFor(state),
  );
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
