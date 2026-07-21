// Pure, engine-agnostic round-loop logic shared by the real game (GameScene)
// and the headless balance bot (src/sim/bot.ts). Everything here mutates a plain
// `RunState` and returns a description of what happened — no Phaser, no timers,
// no audio, no rendering. GameScene wraps these with animation/audio; the bot
// drives them in a tight loop. Keeping the rules here (rather than inline in
// GameScene) is what stops the simulation from drifting from the live game.

import { ROLLS_PER_ROUND, SHOP_ROLLS, WIN_ROUND, roundTarget } from '../config';
import { RunState } from '../state/RunState';
import { cloneDie, Die } from '../systems/Dice';
import { applyRoundStart } from '../systems/Items';
import { RollResult, scoreRoll } from '../systems/Scoring';

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
}

/**
 * Resolve a single roll's scoring and grid growth against dice that have
 * already been rolled (the caller rolls them — in GameScene that's tied to the
 * tumble animation, in the bot it's `rollAll` with a seeded RNG). Mutates
 * `state`: advances `roll`, banks `score`/`totalScore`, tracks `roundScore` and
 * `clutchClear`, and appends any Genesis / Double-the-Fun dice to `state.dice`.
 * Returns the scoring `result` (for the caller to visualize) and the `spawned`
 * dice (so the caller knows to re-lay its grid).
 */
export function resolveRoll(state: RunState): { result: RollResult; spawned: Die[] } {
  const finalRoll = state.roll + 1 >= roundRollTarget(state);
  const scoreBefore = state.score;
  const result = scoreRoll(state, { finalRoll });
  state.roll += 1;
  state.score += result.points;
  state.totalScore += result.points;

  // Track the round's peak score (for score-in-a-round unlock criteria).
  state.roundScore = Math.max(state.roundScore, state.score);

  // Last Call unlock: this roll crossed the round's target as its final roll.
  if (finalRoll && scoreBefore < roundTarget(state.round) && state.score >= roundTarget(state.round)) {
    state.clutchClear = true;
  }

  // Grid-growing passives, applied after scoring so the new copies don't score
  // the roll they were born on. Built fully before appending, and appended with
  // a loop rather than `push(...spawned)` — a spread of a very large array (dice
  // can grow into the hundreds of thousands with Double the Fun) overflows the
  // call stack.
  const spawned: Die[] = [];
  // Double the Fun: every die showing a 6 spawns a copy of itself.
  if (state.hasDoubleTheFun) {
    for (const d of state.dice) if (d.value === 6) spawned.push(cloneDie(d));
  }
  // Genesis: each scoring die spawns a copy, capped at +10 per copy owned.
  if (state.genesis > 0) {
    const scored = result.modifiers.find((m) => m.id === 'scoring')?.dice ?? [];
    const cap = 10 * state.genesis;
    for (const i of scored.slice(0, cap)) spawned.push(cloneDie(state.dice[i]));
  }
  for (const d of spawned) state.dice.push(d);

  return { result, spawned };
}

/**
 * Resolve the end of a round once its rolls are exhausted (call only when
 * `state.roll >= roundRollTarget(state)`). Returns whether the run won, lost, or
 * advanced. On `advanced` it mutates `state`: increments the round, resets the
 * roll counter and this-round bonus, carries over a fraction of the cleared
 * score (Vault 20% + Reserve 50%/copy, capped at all of it), and runs the
 * round-start passives (Dividend income, Foundry dice). `victory`/`gameOver`
 * leave `state` untouched so the caller can record and present the ending.
 */
export function resolveRoundEnd(state: RunState): RoundEndOutcome {
  const target = roundTarget(state.round);
  if (state.score < target) return { phase: 'gameOver', diceAdded: 0 };
  if (state.round >= WIN_ROUND) return { phase: 'victory', diceAdded: 0 };

  state.round += 1;
  state.roll = 0;
  state.bonusRollsThisRound = 0;
  // Carry over a fraction of the cleared score: Vault 20% + Reserve 50% per
  // copy, added together and capped at keeping all of it.
  const keep = Math.min(1, (state.hasVault ? 0.2 : 0) + 0.5 * state.reserve);
  state.score = Math.floor(state.score * keep);
  const diceAdded = applyRoundStart(state);
  state.roundScore = state.score;
  return { phase: 'advanced', diceAdded };
}
