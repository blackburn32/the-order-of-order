// Pure, engine-agnostic trial-loop logic shared by the real game (GameScene)
// and the headless balance bot (src/sim/bot.ts). Everything here mutates a plain
// `RunState` and returns a description of what happened — no Phaser, no timers,
// no audio, no rendering. GameScene wraps these with animation/audio; the bot
// drives them in a tight loop. Keeping the rules here (rather than inline in
// GameScene) is what stops the simulation from drifting from the live game.

import { WIN_TRIAL, isBossTrial } from "../config";
import { RunState } from "../state/RunState";
import { afflictionsFor, blocksGrowth } from "../systems/Afflictions";
import { bossesForRank, goalFor } from "../systems/Boss";
import {
  applyGoldCeiling,
  EMPTY_BREAKDOWN,
  GoldBreakdown,
  grantGold,
  rollGoldBreakdown,
  trialPayout,
  unusedRolls,
} from "../systems/Gold";
import {
  applyMolds,
  applyTrialStart,
  enforceGridCap,
  type ShopItemId,
} from "../systems/Items";
import { accumulatePoints } from "../systems/ItemPoints";
import { deniedRoll, RollResult } from "../systems/Scoring";
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
  /** Gold a ceiling affliction took back as the trial ended (Pauper's Vow). */
  goldForfeited: number;
  rollGold: { titheBowl: number; luckyCoin: number; total: number };
  totalGoldEarned: number;
  // Net change in grid size from applyTrialStart on advance (0 otherwise):
  // Foundry's dice, less anything a grid-cap affliction culled.
  diceAdded: number;
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
  spawnedBySource: {
    genesis: number;
    molds: { id: ShopItemId; count: number }[];
  };
  shrunk: number[];
  goldGained: number;
  /** Dice destroyed by a breakage affliction after this roll scored. */
  broken: number;
  /** Dice culled by a grid-cap affliction after this roll's growth. */
  culled: number;
  /** The affliction that took this roll, if one did. */
  denied: "tollkeeper" | "gamblersCurse" | null;
} {
  const finalRoll = state.roll + 1 >= trialRollTarget(state);
  const scoreBefore = state.score;
  const afflictions = afflictionsFor(state);

  // Two afflictions can take a roll away before its dice are ever read. The toll
  // is charged first and only bites when the purse is empty, so a run that keeps
  // its gold up never feels it; the gamble is pure variance and always can.
  let denied: "tollkeeper" | "gamblersCurse" | null = null;
  if (afflictions.rollGoldCost > 0) {
    if (state.gold >= afflictions.rollGoldCost)
      state.gold -= afflictions.rollGoldCost;
    else denied = "tollkeeper";
  }
  if (
    denied === null &&
    afflictions.dudRollChance > 0 &&
    rng() < afflictions.dudRollChance
  ) {
    denied = "gamblersCurse";
  }

  // Score from the pool's cached roll aggregate — O(distinct faces) in either
  // storage mode. Attribution reads the pool's per-source tallies (below).
  const result =
    denied === "tollkeeper"
      ? deniedRoll(state, "tollkeeper", "Toll unpaid")
      : denied === "gamblersCurse"
        ? deniedRoll(state, "gamblersCurse", "Gambler's Curse")
        : scoreRollHistogram(state, state.dice.agg(), { finalRoll });
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
  const growthBlocked = blocksGrowth(state);
  const doubleTheFunCount =
    state.hasDoubleTheFun && !growthBlocked ? state.dice.doubleTheFun() : 0;
  const genesisCount =
    state.genesis > 0 && !growthBlocked
      ? state.dice.genesis(20 * state.genesis)
      : 0;
  const molds = growthBlocked ? [] : applyMolds(state);
  const moldCount = molds.reduce((n, mold) => n + mold.count, 0);
  const spawnedCount = doubleTheFunCount + genesisCount + moldCount;

  // Breakage bills the dice that scored, and is charged AFTER the growth
  // passives so a die that scored still spawns its copy before it shatters —
  // which is the whole of the Ouroboros/Genesis engine. A denied roll scored
  // nothing, so nothing shatters on it.
  const broken =
    denied === null && afflictions.dieBreakChance > 0
      ? state.dice.breakScoring(
          breakCount(
            state.dice.agg().scoringCount,
            afflictions.dieBreakChance,
            rng,
          ),
        )
      : 0;
  // Whatever the grid grew to this roll, the cap has the last word.
  const culled = enforceGridCap(state);

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
      molds,
    },
    shrunk,
    goldGained,
    broken,
    culled,
    denied,
  };
}

/**
 * How many of a roll's scoring dice a breakage affliction takes. Rolled die by
 * die while the count is small enough for the variance to be felt, and settled
 * by expectation above that — a grid of a million dice cannot afford a million
 * rng calls, and at that size the binomial has collapsed onto its mean anyway.
 */
function breakCount(
  scoring: number,
  chance: number,
  rng: () => number,
): number {
  if (scoring <= 0 || chance <= 0) return 0;
  if (scoring <= INDIVIDUAL_BREAK_ROLLS) {
    let broken = 0;
    for (let i = 0; i < scoring; i++) if (rng() < chance) broken += 1;
    return broken;
  }
  const expected = scoring * chance;
  const whole = Math.floor(expected);
  return whole + (rng() < expected - whole ? 1 : 0);
}

const INDIVIDUAL_BREAK_ROLLS = 64;

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
      goldForfeited: 0,
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
  // Rolls still in hand as this trial ends. Read before anything advances the
  // ladder, since the budget it counts against belongs to the trial just played.
  // A trial survived on Insurance was not cleared, so it neither carries rolls
  // forward nor counts toward Rain Check's unlock.
  const rollsLeft = cleared ? unusedRolls(state) : 0;
  if (rollsLeft > state.peakRollsLeftOnClear)
    state.peakRollsLeftOnClear = rollsLeft;
  // Rain Check banks up to one of those rolls per copy owned; they arrive in
  // the next trial exactly as Overtime's do, and expire with it just the same.
  const carriedRolls = Math.min(state.rainCheck, rollsLeft);

  const bossCleared = cleared && isBossTrial(state.trial);
  const goldBreakdown =
    cleared || !cullingEnabled ? trialPayout(state) : EMPTY_BREAKDOWN;
  grantGold(state, goldBreakdown.total);
  // The purse is skimmed once the trial's own pay is in it, so what a ceiling
  // affliction leaves behind is exactly what the player walks into the shop with.
  const goldForfeited = applyGoldCeiling(state);
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
      goldForfeited,
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
  state.bonusRollsThisRound = carriedRolls;
  // Score is progress toward one trial's goal and nothing else — it always
  // starts a trial at zero. Gold is what carries across.
  state.score = 0n;
  state.trialScore = 0n;
  state.trialRollGold = { titheBowl: 0, luckyCoin: 0 };
  state.bossModifiers = bossesForRank(
    state,
    state.trial,
    rng,
    state.bossModifiers,
  );
  const diceAdded = applyTrialStart(state);
  return {
    phase: "advanced",
    completedTrial,
    completedScore,
    completedGoal: goal,
    goldEarned: goldBreakdown.total,
    goldBreakdown,
    goldForfeited,
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
  state.bossModifiers = bossesForRank(state, state.trial, rng);
}

/** Continue a won run into endless without ending or recording it. This
 * unlatches the finish line and advances past it; the run is finalized only
 * when the player later fails or abandons it. */
export function continueEndless(
  state: RunState,
  rng: () => number = Math.random,
): void {
  // The won trial was cleared, so Rain Check's carry follows the run into
  // endless rather than being dropped at the finish line. Counted before the
  // ladder moves, while the budget still belongs to the trial just won.
  const carriedRolls = Math.min(state.rainCheck, unusedRolls(state));
  state.endless = true;
  state.trial += 1;
  state.roll = 0;
  state.trialCleared = false;
  state.bonusRollsThisRound = carriedRolls;
  state.score = 0n;
  state.trialScore = 0n;
  state.trialRollGold = { titheBowl: 0, luckyCoin: 0 };
  state.bossModifiers = bossesForRank(
    state,
    state.trial,
    rng,
    state.bossModifiers,
  );
  applyTrialStart(state);
}
