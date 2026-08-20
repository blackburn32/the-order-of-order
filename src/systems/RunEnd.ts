import { WIN_TRIAL, rankOf, trialInRank } from "../config";
import type { RunState } from "../state/RunState";
import { globalScoresEnabled, queuePendingSubmission } from "./GlobalScores";
import { toNumberPointMap } from "./ItemPoints";
import { recordRunEnd } from "./SaveData";

/** A run remains a win after the player carries it into endless mode. */
export function runWasWon(state: RunState): boolean {
  return state.endless || (state.trial >= WIN_TRIAL && state.trialCleared);
}

/**
 * Record a run at the point the player actually stops playing and, for a new
 * personal best, leave a submission for the destination scene to offer.
 */
export function finalizeRun(
  state: RunState,
  won = runWasWon(state),
): {
  personalBest: boolean;
  submissionQueued: boolean;
} {
  const { personalBest } = recordRunEnd(state, won);
  const submissionQueued = personalBest && globalScoresEnabled();

  if (submissionQueued) {
    queuePendingSubmission({
      score: state.totalScore,
      rank: rankOf(state.trial),
      trial: trialInRank(state.trial),
      won,
      endless: state.endless,
      dicePoints: toNumberPointMap(state.dicePoints),
      itemPoints: toNumberPointMap(state.itemPoints),
    });
  }

  return { personalBest, submissionQueued };
}
