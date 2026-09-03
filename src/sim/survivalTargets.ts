import { TRIALS_PER_RANK } from "../config";

/** Fraction of the original coherent smart field intended to survive each
 * rank. Trial 1's single-d6 variance sets the practical rank-1 ceiling; the
 * final duel decides how much of the rank-10 cohort actually wins. */
export const SMART_RANK_SURVIVAL = [
  0.65, 0.62, 0.57, 0.49, 0.42, 0.36, 0.26, 0.18, 0.09, 0.09,
] as const;

/** Trial 1's discrete single-d6 outcome cannot follow the normal within-rank
 * interpolation. Trials 2 and 3 now take two smaller, explicit steps instead
 * of inheriting trial 1's survival target and collapsing back to goal 1. */
const OPENING_TRIAL_SURVIVAL = [0.72, 0.67, 0.65] as const;

/** Put most of a rank's intended cull on its Boss Trial. */
export const CULL_SHARE = [0.15, 0.3, 0.55] as const;

/** Absolute share of the original smart field intended to remain after this
 * trial. This is a design target, not a live rule. */
export function targetSurvivalAfterTrial(trial: number): number {
  const rank = Math.ceil(trial / TRIALS_PER_RANK);
  const slot = (trial - 1) % TRIALS_PER_RANK;
  if (rank === 1) return OPENING_TRIAL_SURVIVAL[slot];
  const start = SMART_RANK_SURVIVAL[rank - 2];
  const end = SMART_RANK_SURVIVAL[rank - 1];
  let consumed = 0;
  for (let i = 0; i <= slot; i++) consumed += CULL_SHARE[i];
  return start - (start - end) * consumed;
}

/** Conditional share of a trial's expected entrants that the survival schedule
 * asks to clear it. */
export function targetTrialClearRate(trial: number): number {
  const entrants = trial === 1 ? 1 : targetSurvivalAfterTrial(trial - 1);
  return Math.min(1, targetSurvivalAfterTrial(trial) / entrants);
}
