// Pure, engine-agnostic round-loop logic shared by the real game (GameScene)
// and the headless balance bot (src/sim/bot.ts). Everything here mutates a plain
// `RunState` and returns a description of what happened — no Phaser, no timers,
// no audio, no rendering. GameScene wraps these with animation/audio; the bot
// drives them in a tight loop. Keeping the rules here (rather than inline in
// GameScene) is what stops the simulation from drifting from the live game.

import { ROLLS_PER_ROUND, SHOP_ROLLS, WIN_ROUND, survivalTarget } from '../config';
import { RunState } from '../state/RunState';
import { applyRoundStart } from '../systems/Items';
import { accumulatePoints } from '../systems/ItemPoints';
import { RollResult } from '../systems/Scoring';
import { scoreRollHistogram } from '../systems/ScoringHistogram';

/** Base round length plus Metronome's permanent bonus and Overtime's
 *  this-round-only bonus (both appended to the end; shop rolls stay pinned). */
export function roundRollTarget(s: RunState): number {
  return ROLLS_PER_ROUND + s.bonusRollsPerRound + s.bonusRollsThisRound;
}

/** True when `state.roll` has landed exactly on a shop checkpoint (rolls 5 & 15). */
export function shouldOpenShop(state: RunState): boolean {
  return SHOP_ROLLS.includes(state.roll);
}

export interface RoundEndOutcome {
  phase: 'victory' | 'gameOver' | 'advanced';
  diceAdded: number; // Foundry dice added by applyRoundStart on advance (0 otherwise)
  insuranceUsed: boolean;
}

/**
 * Resolve a single roll's scoring and grid growth against dice that have
 * already been rolled (the caller rolls them via `state.dice.roll(rng, nums)` —
 * in GameScene that's tied to the tumble animation, in the bot it's a seeded
 * RNG). Mutates `state`: advances `roll`, banks `score`/`totalScore`, tracks
 * `roundScore` and `clutchClear`, and grows the grid with any Genesis /
 * Double-the-Fun dice. Returns the scoring `result` (for the caller to
 * visualize), `spawnedCount` (how many dice grew in), and the grid indices of
 * any dice Whetstone `shrunk` (only populated below the bucket threshold, where
 * individual dice can be flashed). `rng` drives Whetstone; GameScene lets it
 * default to Math.random.
 */
export function resolveRoll(
  state: RunState,
  rng: () => number = Math.random
): {
  result: RollResult;
  spawnedCount: number;
  spawnedBySource: { genesis: number; brickMold: number };
  shrunk: number[];
} {
  const finalRoll = state.roll + 1 >= roundRollTarget(state);
  const scoreBefore = state.score;
  // Score from the pool's cached roll aggregate — O(distinct faces) in either
  // storage mode. Attribution reads the pool's per-source tallies (below).
  const result = scoreRollHistogram(state, state.dice.agg(), { finalRoll });
  accumulatePoints(state, result, finalRoll);
  state.roll += 1;
  state.score += result.points;
  state.totalScore += result.points;

  // Track the round's peak score (for score-in-a-round unlock criteria).
  if (state.score > state.roundScore) state.roundScore = state.score;

  // Last Call unlock: this roll crossed the round's target as its final roll.
  const target = survivalTarget(state.round, state.hardMode);
  if (finalRoll && scoreBefore < target && state.score >= target) {
    state.clutchClear = true;
  }

  // Grid-growing passives, applied after scoring so the new copies don't score
  // the roll they were born on. The pool computes these from the cached roll and
  // grows in place — O(buckets) once bucketed, so Double the Fun doubling into
  // the millions no longer walks (or reallocates) a giant array.
  const doubleTheFunCount = state.hasDoubleTheFun
    ? state.dice.doubleTheFun()
    : 0;
  const genesisCount =
    state.genesis > 0 ? state.dice.genesis(20 * state.genesis) : 0;
  const brickMoldCount = state.brickMold;
  if (brickMoldCount > 0) {
    state.dice.addDice(
      6,
      brickMoldCount,
      {
        loaded: state.loadedSizes.includes(6),
        wildFace: state.wildSizes.includes(6),
      },
      "brick_mold",
    );
  }
  const spawnedCount =
    doubleTheFunCount + genesisCount + brickMoldCount;

  // Whetstone: each copy owned has a 10% chance this roll to shrink one random
  // die a step. Applied after scoring so it only helps future rolls. Below the
  // bucket threshold the shrunk grid index comes back so the scene can flash it.
  const shrunk: number[] = [];
  for (let c = 0; c < state.whetstone; c++) {
    if (rng() >= 0.1) continue;
    const idx = state.dice.whetstoneShrink(rng);
    if (idx === null) break;
    if (idx >= 0) shrunk.push(idx);
  }

  return {
    result,
    spawnedCount,
    spawnedBySource: {
      genesis: genesisCount,
      brickMold: brickMoldCount,
    },
    shrunk,
  };
}

/**
 * Resolve the end of a round once its rolls are exhausted (call only when
 * `state.roll >= roundRollTarget(state)`). Returns whether the run won, lost, or
 * advanced. On `advanced` it mutates `state`: increments the round, resets the
 * roll counter and this-round bonus, carries over a fraction of the cleared
 * score (Vault 33% + Reserve 75%/copy, capped at all of it), and runs the
 * round-start passives (Foundry dice). `victory`/`gameOver` leave `state`
 * untouched so the caller can record and present the ending.
 */
export function resolveRoundEnd(state: RunState): RoundEndOutcome {
  const target = survivalTarget(state.round, state.hardMode);
  const insuranceUsed =
    state.score < target &&
    state.hasInsurancePolicy &&
    state.score * 4n >= target * 3n;
  if (state.score < target && !insuranceUsed)
    return { phase: 'gameOver', diceAdded: 0, insuranceUsed: false };

  if (insuranceUsed) {
    state.hasInsurancePolicy = false;
    state.ownedUnique = state.ownedUnique.filter(
      (id) => id !== "insurance_policy",
    );
    delete state.purchases.insurance_policy;
  }

  if (state.round >= WIN_ROUND)
    return { phase: 'victory', diceAdded: 0, insuranceUsed };

  state.round += 1;
  state.roll = 0;
  state.bonusRollsThisRound = 0;
  // Carry over a fraction of the cleared score: Vault 33% + Reserve 75% per
  // copy, added together and capped at keeping all of it. Expressed in per-mille
  // so the fraction applies exactly to a bigint score (truncates, like floor).
  const keepMilli = Math.min(1000, (state.hasVault ? 330 : 0) + 750 * state.reserve);
  state.score = (state.score * BigInt(keepMilli)) / 1000n;
  const diceAdded = applyRoundStart(state);
  state.roundScore = state.score;
  return { phase: 'advanced', diceAdded, insuranceUsed };
}
