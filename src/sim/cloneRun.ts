// A hypothetical copy of a run.
//
// The appraiser (`appraise.ts`) answers "what would this build score if I bought
// that card" by actually buying it and actually rolling — which means it needs a
// run it is allowed to ruin. Everything here exists so that the copy it ruins
// shares no mutable structure with the run the player is really having.
//
// This is deliberately NOT `serializeRunState` + `hydrateRunState`. That pair is
// a save file: it validates every field against the current schema, walks the
// whole roll history, and is called a handful of times per session. The
// appraiser calls this thousands of times per shop, so it copies by hand and
// drops the one field a hypothesis has no use for — the timeline.

import { DicePool } from "../systems/DicePool";
import type { RunState } from "../state/RunState";

function cloneCounts<T extends Record<string, unknown>>(map: T): T {
  return { ...map };
}

/**
 * A run the caller may mutate freely.
 *
 * The grid is rebuilt through the pool's own stack summary, which is the only
 * copy that stays cheap when the grid is in the millions — `summarize()` is
 * O(buckets) there, not O(dice). Below the bucket threshold that round trip
 * re-materialises the dice in stack order, so grid INDICES are not stable
 * across a clone. Nothing may carry an index from a clone back to the original;
 * name a die by its group (see `appraise.groupKey`) instead.
 *
 * `rollHistory` is dropped rather than copied: it is a chart's input, no rule
 * reads it, and a hypothesis that carried hundreds of samples per clone would
 * cost more to copy than to roll.
 */
export function cloneRunState(state: RunState): RunState {
  return {
    ...state,
    bossModifiers: [...state.bossModifiers],
    trialRollGold: { ...state.trialRollGold },
    dice: DicePool.fromStacks(state.dice.summarize()),
    scoringNumbers: [...state.scoringNumbers],
    loadedSizes: [...state.loadedSizes],
    wildSizes: [...state.wildSizes],
    royalSealSizes: [...state.royalSealSizes],
    afflictions: [...state.afflictions],
    endingsSeen: [...state.endingsSeen],
    rival: state.rival
      ? {
          dice: DicePool.fromStacks(state.rival.dice.summarize()),
          score: state.rival.score,
          roll: state.rival.roll,
        }
      : null,
    shopUnlocks: [...state.shopUnlocks],
    ownedUnique: [...state.ownedUnique],
    purchases: cloneCounts(state.purchases),
    dicePoints: cloneCounts(state.dicePoints),
    itemPoints: cloneCounts(state.itemPoints),
    rollHistory: [],
  };
}
