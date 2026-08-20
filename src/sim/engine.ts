// Pure, engine-agnostic trial-loop logic shared by the real game (GameScene)
// and the headless balance bot (src/sim/bot.ts). Everything here mutates a plain
// `RunState` and returns a description of what happened — no Phaser, no timers,
// no audio, no rendering. GameScene wraps these with animation/audio; the bot
// drives them in a tight loop. Keeping the rules here (rather than inline in
// GameScene) is what stops the simulation from drifting from the live game.

import { WIN_TRIAL, isBossTrial } from "../config";
import { RunState } from "../state/RunState";
import { bossBlocksGrowth, bossForRank, goalFor } from "../systems/Boss";
import {
  EMPTY_BREAKDOWN,
  GoldBreakdown,
  grantGold,
  rollGoldBreakdown,
  trialPayout,
} from "../systems/Gold";
import { applyTrialStart } from "../systems/Items";
import { accumulatePoints } from "../systems/ItemPoints";
import { RollResult } from "../systems/Scoring";
import { scoreRollHistogram } from "../systems/ScoringHistogram";
import { trialRollTarget } from "../systems/Trial";

// Re-exported so GameScene and the bot keep a single import site for the
// trial loop; the definition lives in systems/Trial to stay importable from the
// scorers without a cycle.
export { trialRollTarget };

/** True when the trial is over — either its goal has been met (`trialCleared`,
 *  latched by resolveRoll) or its rolls have run out. The caller should then run
 *  `resolveTrialEnd`. */
export function trialComplete(state: RunState): boolean {
  return state.trialCleared || state.roll >= trialRollTarget(state);
}

/** True when the trial ended by meeting its goal with rolls still in hand.
 *  Those unused rolls are paid out as gold. */
export function clearedEarly(state: RunState): boolean {
  return state.trialCleared && state.roll < trialRollTarget(state);
}

// Sim-only escape hatch for the goal-curve designer (src/sim/designTargets.ts).
//
// To design a curve you need to know how much a build COULD score in each
// trial, which means every run has to play all 15 trials to the end of their
// roll budgets. That cannot be measured with a low goal — the trial would end
// on its first scoring roll, and the "peak" would be 1 — nor with a high one,
// since every run would then die on trial 1. So the designer sets an
// unreachable goal AND switches culling off: trials burn all their rolls, the
// ladder advances regardless, and the peaks are real.
//
// The shipping game never touches this. `resolveTrialEnd` is the only reader.
let cullingEnabled = true;

/** Sim-only. `false` makes a failed trial advance instead of ending the run. */
export function setCulling(enabled: boolean): void {
  cullingEnabled = enabled;
}

export interface TrialEndOutcome {
  phase: "victory" | "gameOver" | "advanced";
  completedTrial: number;
  completedScore: bigint;
  completedGoal: bigint;
  goldEarned: number;
  goldBreakdown: GoldBreakdown;
  rollGold: { titheBowl: number; luckyCoin: number; total: number };
  totalGoldEarned: number;
  diceAdded: number; // Foundry dice added by applyTrialStart on advance (0 otherwise)
  insuranceUsed: boolean;
  bossCleared: boolean;
}

/**
 * Resolve a single roll's scoring and grid growth against dice that have
 * already been rolled (the caller rolls them via `state.dice.roll(rng, nums)` —
 * in GameScene that's tied to the tumble animation, in the bot it's a seeded
 * RNG). Mutates `state`: advances `roll`, banks `score`/`totalScore`, tracks
 * `trialScore` and `clutchClear`, grants any mid-trial gold, and grows the grid
 * with any Genesis / Double-the-Fun dice. Returns the scoring `result` (for the
 * caller to visualize), `spawnedCount` (how many dice grew in), `goldGained`,
 * and the grid indices of any dice Whetstone `shrunk` (only populated below the
 * bucket threshold, where individual dice can be flashed). `rng` drives
 * Whetstone and Lucky Coin; GameScene lets it default to Math.random.
 */
export function resolveRoll(
  state: RunState,
  rng: () => number = Math.random,
): {
  result: RollResult;
  spawnedCount: number;
  spawnedBySource: { genesis: number; brickMold: number };
  shrunk: number[];
  goldGained: number;
} {
  const finalRoll = state.roll + 1 >= trialRollTarget(state);
  const scoreBefore = state.score;
  // Score from the pool's cached roll aggregate — O(distinct faces) in either
  // storage mode. Attribution reads the pool's per-source tallies (below).
  const result = scoreRollHistogram(state, state.dice.agg(), { finalRoll });
  accumulatePoints(state, result, finalRoll);
  state.roll += 1;
  state.score += result.points;
  state.totalScore += result.points;

  // Track the trial's peak score (for score-in-a-trial unlock criteria).
  if (state.score > state.trialScore) state.trialScore = state.score;

  // Mid-trial gold: Tithe Bowl pays for a scoreless roll, Lucky Coin gambles.
  const rollReceipt = rollGoldBreakdown(state, result.points > 0n, rng);
  const goldGained = rollReceipt.total;
  state.trialRollGold.titheBowl += rollReceipt.titheBowl;
  state.trialRollGold.luckyCoin += rollReceipt.luckyCoin;
  grantGold(state, goldGained);

  // Last Call unlock: this roll crossed the trial's goal as its final roll.
  const goal = goalFor(state);
  if (finalRoll && scoreBefore < goal && state.score >= goal) {
    state.clutchClear = true;
  }

  // Reaching the goal ends the trial here — the remaining rolls are forfeit,
  // but they are paid out as gold. Latched on state so nothing later can take
  // the clear back.
  if (state.score >= goal) state.trialCleared = true;

  // Grid-growing passives, applied after scoring so the new copies don't score
  // the roll they were born on. The pool computes these from the cached roll and
  // grows in place — O(buckets) once bucketed, so Double the Fun doubling into
  // the millions no longer walks (or reallocates) a giant array. The Drought
  // switches all of it off for its trial.
  const growthBlocked = bossBlocksGrowth(state);
  const doubleTheFunCount =
    state.hasDoubleTheFun && !growthBlocked ? state.dice.doubleTheFun() : 0;
  const genesisCount =
    state.genesis > 0 && !growthBlocked
      ? state.dice.genesis(20 * state.genesis)
      : 0;
  const brickMoldCount = growthBlocked ? 0 : state.brickMold;
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
  const spawnedCount = doubleTheFunCount + genesisCount + brickMoldCount;

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
    goldGained,
  };
}

/**
 * Resolve the end of a trial once it is complete — its goal met or its rolls
 * exhausted (call only when `trialComplete(state)`). Returns whether the run
 * won, lost, or advanced. On `advanced` it mutates `state`: pays out the gold,
 * increments the trial, resets the roll counter, the score, the cleared latch
 * and this-trial bonus, rolls the next boss modifier if the new trial is a Boss
 * Trial, and runs the trial-start passives (Foundry dice).
 * `victory`/`gameOver` leave the ladder untouched so the caller can record and
 * present the ending — but the gold payout still happens on a victory, so a
 * player continuing into endless keeps what they earned.
 */
export function resolveTrialEnd(
  state: RunState,
  rng: () => number = Math.random,
): TrialEndOutcome {
  const completedTrial = state.trial;
  const completedScore = state.score;
  const goal = goalFor(state);
  const rollGoldReceipt = {
    ...state.trialRollGold,
    total: state.trialRollGold.titheBowl + state.trialRollGold.luckyCoin,
  };
  const cleared = state.trialCleared || state.score >= goal;
  const insuranceUsed =
    !cleared && state.hasInsurancePolicy && state.score * 4n >= goal * 3n;
  if (!cleared && !insuranceUsed && cullingEnabled) {
    return {
      phase: "gameOver",
      completedTrial,
      completedScore,
      completedGoal: goal,
      goldEarned: 0,
      goldBreakdown: EMPTY_BREAKDOWN,
      rollGold: rollGoldReceipt,
      totalGoldEarned: rollGoldReceipt.total,
      diceAdded: 0,
      insuranceUsed: false,
      bossCleared: false,
    };
  }

  if (insuranceUsed) {
    state.hasInsurancePolicy = false;
    state.ownedUnique = state.ownedUnique.filter(
      (id) => id !== "insurance_policy",
    );
    delete state.purchases.insurance_policy;
  }

  // A trial survived on Insurance was not cleared: it pays no gold and does not
  // count as beating the boss. With culling off (the designer's pass) a failed
  // trial is paid as though cleared, so the shops it feeds still resemble a
  // real run's income rather than starving the build being measured.
  const bossCleared = cleared && isBossTrial(state.trial);
  const goldBreakdown =
    cleared || !cullingEnabled ? trialPayout(state) : EMPTY_BREAKDOWN;
  grantGold(state, goldBreakdown.total);
  if (bossCleared) {
    state.bossesCleared += 1;
    state.boonNextShop = true;
  }

  if (state.trial >= WIN_TRIAL && !state.endless) {
    return {
      phase: "victory",
      completedTrial,
      completedScore,
      completedGoal: goal,
      goldEarned: goldBreakdown.total,
      goldBreakdown,
      rollGold: rollGoldReceipt,
      totalGoldEarned: goldBreakdown.total + rollGoldReceipt.total,
      diceAdded: 0,
      insuranceUsed,
      bossCleared,
    };
  }

  state.trial += 1;
  state.roll = 0;
  state.trialCleared = false;
  state.bonusRollsThisRound = 0;
  // Score is progress toward one trial's goal and nothing else — it always
  // starts a trial at zero. Gold is what carries across.
  state.score = 0n;
  state.trialScore = 0n;
  state.trialRollGold = { titheBowl: 0, luckyCoin: 0 };
  state.bossModifier = bossForRank(state.trial, rng, state.bossModifier);
  const diceAdded = applyTrialStart(state);
  return {
    phase: "advanced",
    completedTrial,
    completedScore,
    completedGoal: goal,
    goldEarned: goldBreakdown.total,
    goldBreakdown,
    rollGold: rollGoldReceipt,
    totalGoldEarned: goldBreakdown.total + rollGoldReceipt.total,
    diceAdded,
    insuranceUsed,
    bossCleared,
  };
}

/** Start the ladder: roll a boss modifier if trial 1 somehow is one, and run
 *  the trial-start passives. Called once when a run begins. */
export function beginRun(
  state: RunState,
  rng: () => number = Math.random,
): void {
  state.bossModifier = bossForRank(state.trial, rng, null);
}

/** Continue a won run into endless without ending or recording it. This
 * unlatches the finish line and advances past it; the run is finalized only
 * when the player later fails or abandons it. */
export function continueEndless(
  state: RunState,
  rng: () => number = Math.random,
): void {
  state.endless = true;
  state.trial += 1;
  state.roll = 0;
  state.trialCleared = false;
  state.bonusRollsThisRound = 0;
  state.score = 0n;
  state.trialScore = 0n;
  state.trialRollGold = { titheBowl: 0, luckyCoin: 0 };
  state.bossModifier = bossForRank(state.trial, rng, state.bossModifier);
  applyTrialStart(state);
}
