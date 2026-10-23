// Goal tiers — the four goals every trial asks, and the rank a run ends on.
//
// A trial is played to its last roll. Bronze is the goal that has to be met to
// survive it; silver, gold and legendary are climbed for gold, each one paying
// more than the last as the trial clears. When a run ends in victory, its total
// score is read against a fifth ladder of the same four names to give the run
// its rank; a run that fails is not ranked. The goals themselves live in config (`trialTierGoals`,
// `runRankThresholds`); this is what the game does with them.

import {
  GOAL_TIERS,
  isMirrorTrial,
  runRankThresholds,
  type GoalTier,
  type TierGoals,
} from "../config";
import type { RunState } from "../state/RunState";
import { tierGoalsFor } from "./Boss";

export const TIER_NAMES: Record<GoalTier, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  legendary: "Legendary",
};

/** Each tier's colour wherever it is named: the HUD, the receipt, the end
 *  screens. Strings, as Phaser text styles take them. */
export const TIER_CSS: Record<GoalTier, string> = {
  bronze: "#cd8a4b",
  silver: "#cfd6df",
  gold: "#e6c65a",
  legendary: "#b77be0",
};

export function tierCss(index: number): string {
  return index < 0 ? "#8c7a55" : TIER_CSS[GOAL_TIERS[index]];
}

/** Extra gold a cleared trial pays for the highest tier it met, by tier index
 *  (bronze pays nothing above the trial's ordinary payout). */
export const TIER_GOLD = [0, 2, 4, 6] as const;

/** The highest tier `score` meets on `goals`: 0 bronze … 3 legendary, or -1 for
 *  none. */
export function tierOf(score: bigint, goals: TierGoals): number {
  let tier = -1;
  for (let i = 0; i < goals.length; i++) if (score >= goals[i]) tier = i;
  return tier;
}

/** The highest tier the live trial has met so far. The duel has no tiers. */
export function tierReached(state: RunState): number {
  if (isMirrorTrial(state.trial)) return -1;
  return tierOf(state.score, tierGoalsFor(state));
}

/** The next goal the live trial is climbing toward, or null once legendary is
 *  met (or on the duel). */
export function nextTier(
  state: RunState,
): { tier: GoalTier; index: number; goal: bigint } | null {
  if (isMirrorTrial(state.trial)) return null;
  const goals = tierGoalsFor(state);
  const index = tierOf(state.score, goals) + 1;
  if (index >= goals.length) return null;
  return { tier: GOAL_TIERS[index], index, goal: goals[index] };
}

export function tierName(index: number): string {
  return index < 0 ? "Unranked" : TIER_NAMES[GOAL_TIERS[index]];
}

/** The rank a run ends on: -1 for a run that failed, which is not ranked,
 *  and for a win (`won`) its total score read against the run ranks, 0 bronze
 *  (every win) … 3 legendary. A win carried into endless and lost there is
 *  still a win, ranked by everything it scored. */
export function runRank(totalScore: bigint, won: boolean): number {
  if (!won) return -1;
  return Math.max(0, tierOf(totalScore, runRankThresholds()));
}
