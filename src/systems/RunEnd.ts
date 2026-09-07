import { WIN_TRIAL, rankOf, trialInRank } from "../config";
import type { RunState } from "../state/RunState";
import { globalScoresEnabled, queuePendingSubmission } from "./GlobalScores";
import { recordRunEnd } from "./SaveData";
import { clearActiveRun } from "./ActiveRunPersistence";

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
  // Remove the resumable checkpoint before any non-idempotent Hall or
  // leaderboard side effect. A crash cannot replay a finalized run.
  clearActiveRun();
  const { personalBest } = recordRunEnd(state, won);
  const submissionQueued = personalBest && globalScoresEnabled();

  if (submissionQueued) {
    // Only the run's Hall key and what the prompt displays. The analysis the
    // submission carries is read back out of the Hall entry `recordRunEnd` just
    // wrote, rather than copied here — for a long run that is another 300 KB of
    // localStorage for something already stored a few lines above.
    queuePendingSubmission({
      startedAt: state.startedAt,
      score: state.totalScore,
      rank: rankOf(state.trial),
      trial: trialInRank(state.trial),
      won,
      endless: state.endless,
    });
  }

  return { personalBest, submissionQueued };
}
