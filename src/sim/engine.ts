// Pure, engine-agnostic trial-loop logic shared by the real game (GameScene)
// and the headless balance bot (src/sim/bot.ts). Everything here mutates a plain
// `RunState` and returns a description of what happened — no Phaser, no timers,
// no audio, no rendering. GameScene wraps these with animation/audio; the bot
// drives them in a tight loop. Keeping the rules here (rather than inline in
// GameScene) is what stops the simulation from drifting from the live game.

import { WIN_TRIAL, isBossTrial, isMirrorTrial } from "../config";
import { RunState } from "../state/RunState";
import {
  afflictionsFor,
  blocksGrowth,
  inertDiceCount,
  scoringNumbersFor,
  type ActiveAfflictions,
  type AfflictionId,
} from "../systems/Afflictions";
import { bossesForRank, goalFor } from "../systems/Boss";
import type { DicePool } from "../systems/DicePool";
import { createRival, playerLeadsDuel, rollRival } from "../systems/Rival";
import {
  applyGoldCeiling,
  EMPTY_BREAKDOWN,
  GoldBreakdown,
  grantGold,
  rollGoldBreakdown,
  spendGold,
  trialPayout,
  type TrialPayoutTuning,
  unusedRolls,
} from "../systems/Gold";
import {
  applyMolds,
  applyTrialStart,
  enforceGridCap,
  type ShopItemId,
} from "../systems/Items";
import { accumulatePoints } from "../systems/ItemPoints";
import { recordRollSample, seedRollHistory } from "../systems/RunHistory";
import { deniedRoll, RollResult } from "../systems/Scoring";
import { scoreRollHistogram } from "../systems/ScoringHistogram";
import { trialRollTarget } from "../systems/Trial";
import { addItemValue } from "../systems/ItemValue";

// Re-exported so GameScene and the bot keep a single import site for the
// trial loop; the definition lives in systems/Trial to stay importable from the
// scorers without a cycle.
export { trialRollTarget };

/**
 * Roll a grid for the run it belongs to.
 *
 * The only door onto `DicePool.roll` that the game and the sim use, because
 * three of its four arguments are the run restated and one of them — the inert
 * tail an affliction has taken off the end of the grid — is not something a
 * caller can be expected to remember. Forgetting it would quietly hand those
 * dice their points back while the grid went on drawing a cross through them.
 */
export function rollPool(
  state: RunState,
  pool: DicePool,
  rng: () => number = Math.random,
): void {
  pool.roll(
    rng,
    scoringNumbersFor(state),
    state.royalSealSizes,
    inertDiceCount(state, pool.length),
  );
}

/** True when the trial is over — either its goal has been met (`trialCleared`,
 *  latched by resolveRoll) or its rolls have run out. The caller should then run
 *  `resolveTrialEnd`. */
export function trialComplete(state: RunState): boolean {
  const playsOut = fullBudgetAllTrials || state.trial === fullBudgetTrial;
  return (
    (state.trialCleared && !playsOut) || state.roll >= trialRollTarget(state)
  );
}

/** True when the trial ended by meeting its goal with rolls still in hand.
 *  Those unused rolls are paid out as gold. */
export function clearedEarly(state: RunState): boolean {
  return state.trialCleared && state.roll < trialRollTarget(state);
}

// Sim-only escape hatch for the goal-curve designer (src/sim/designTargets.ts).
//
// To design a curve you need to know how much a build COULD score in each
// trial, which means every run has to play every trial to the end of their
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

// Sim-only escape hatch for the roll-pacing tuner (src/sim/pacingCurve.ts).
//
// A trial normally ends the instant its goal is met, which censors the one
// measurement pacing is designed from: how much a build WOULD have scored had it
// kept rolling. Under a curve that is too easy every trial ends on roll one and
// every capacity reading is "just above the goal" — the distribution the tuner
// samples is the curve it is trying to replace.
//
// So the tuner names ONE trial to play its rolls out. That trial's clear is
// still latched by `resolveRoll` the moment the goal is crossed, so culling,
// the ladder and the boss tallies are unchanged; only the roll counter runs on.
// It is one trial rather than all of them because the grid grows per roll and
// never resets between trials — playing every trial to its budget would hand the
// deep trials a grid no real run could have arrived with, and the tuner would
// then design the whole back half of the ladder against a fiction.
let fullBudgetTrial: number | null = null;

/** Sim-only. Names the one trial that plays out its whole roll budget even after
 *  its goal is met, so capacity can be read past the goal. */
export function setFullBudgetTrial(trial: number | null): void {
  fullBudgetTrial = trial;
}

// The same switch thrown for every trial at once, for a human rather than a
// tuner: the dev panel's "play out every trial" toggle (see dev/DevPanel.ts).
// It answers by hand the question the tuner answers in bulk — what does a trial
// score when it is played to the end of its budget instead of stopping at the
// goal — which is the only way to see, while playing, how much of the budget a
// goal is actually asking for.
//
// It carries the distortion named above and one more: a trial played out has no
// rolls left over, so it earns no unused-roll gold, no Reserve bonus and no Rain
// Check carry. A run under this toggle is therefore POORER than a real one at
// the same point on the ladder. It is a measuring instrument, not a way to play.
let fullBudgetAllTrials = false;

/** Dev/sim-only. Every trial plays its whole roll budget out, goal or no goal.
 *  Excluded from production builds by its only caller, the dev panel. */
export function setFullBudgetAllTrials(enabled: boolean): void {
  fullBudgetAllTrials = enabled;
}

export function fullBudgetAllTrialsEnabled(): boolean {
  return fullBudgetAllTrials;
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
 * already been rolled (the caller rolls them via `rollPool` —
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
  /** Dice that defected to the Order of Disorder after failing to score. */
  defected: number;
  /** Dice culled by a grid-cap affliction after this roll's growth. */
  culled: number;
  /** The affliction that took this roll, if one did. */
  denied: "tollkeeper" | "gamblersCurse" | null;
  /** Points the mirror rival scored on its matching roll (0 outside the duel). */
  rivalPoints: bigint;
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
      spendGold(state, afflictions.rollGoldCost);
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
  const rolled = state.dice.agg();
  // Every die that came up 1, denied or not: an affliction takes a roll's
  // points, not its dice, and the tally is of what the table showed.
  state.onesRolled += rolled.valueCounts.get(1) ?? 0;
  const result =
    denied === "tollkeeper"
      ? deniedRoll(state, "tollkeeper", "Toll unpaid")
      : denied === "gamblersCurse"
        ? deniedRoll(state, "gamblersCurse", "Gambler's Curse")
        : scoreRollHistogram(state, rolled, { finalRoll });
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
  addItemValue(state, "tithe_bowl", rollReceipt.titheBowl);
  addItemValue(state, "lucky_coin", rollReceipt.luckyCoin);
  grantGold(state, goldGained);

  // Last Call unlock: this roll crossed the trial's goal as its final roll.
  const goal = goalFor(state);
  const duel = isMirrorTrial(state.trial);
  if (!duel && finalRoll && scoreBefore < goal && state.score >= goal) {
    state.clutchClear = true;
  }

  // Reaching the goal ends the trial here — the remaining rolls are forfeit,
  // but they are paid out as gold. Latched on state so nothing later can take
  // the clear back. The duel has no goal to cross: it is decided by which side
  // is ahead when the rolls run out, so it must never end early.
  if (!duel && state.score >= goal) state.trialCleared = true;

  const passives = applyGridPassives(
    state,
    state.dice,
    afflictions,
    denied !== null,
    rng,
  );
  state.defectors += passives.defected;

  // The rival takes its matching roll last, so the grid it grows from is the one
  // the player's own rules just produced for its mirror. Everything the player's
  // roll suffered, this roll suffers too.
  let rivalPoints = 0n;
  if (duel && state.rival) {
    rollRival(state, state.rival, rng);
    const rivalResult = scoreRollHistogram(state, state.rival.dice.agg(), {
      finalRoll,
    });
    rivalPoints = rivalResult.points;
    state.rival.score += rivalPoints;
    state.rival.roll += 1;
    applyGridPassives(state, state.rival.dice, afflictions, false, rng);
  }

  // The run's timeline, taken last so the sample carries the grid the player is
  // actually left looking at — everything this roll grew, shattered or culled.
  recordRollSample(state);

  return {
    result,
    spawnedCount: passives.spawnedCount,
    spawnedBySource: passives.spawnedBySource,
    shrunk: passives.shrunk,
    goldGained,
    broken: passives.broken,
    defected: passives.defected,
    culled: passives.culled,
    denied,
    rivalPoints,
  };
}

/**
 * Everything that happens to a grid after a roll has been scored: the growth
 * passives, the two destruction afflictions, the grid cap, and Whetstone.
 *
 * Split out of `resolveRoll` because the mirror duel runs it twice — once over
 * the player's grid and once over the rival's — and a passive that grew only one
 * of them would pull the two apart on the first roll of a Genesis build. Sharing
 * the body is what makes "an identical grid" a fact about the code rather than a
 * promise about two implementations.
 */
export function applyGridPassives(
  state: RunState,
  pool: DicePool,
  afflictions: ActiveAfflictions,
  denied: boolean,
  rng: () => number,
): {
  spawnedCount: number;
  spawnedBySource: {
    genesis: number;
    molds: { id: ShopItemId; count: number }[];
  };
  shrunk: number[];
  broken: number;
  defected: number;
  culled: number;
} {
  // Read the roll's own tallies before anything destroys dice, so breakage and
  // defection bill the same roll rather than the grid the other one left behind.
  const agg = pool.agg();
  const scoringCount = agg.scoringCount;
  // The dice that failed are the LIVE dice that failed. An inert die produced no
  // outcome either way, so it is neither a success breakage can tax nor a
  // failure the Order of Disorder can point at.
  const nonScoringCount = agg.total - agg.inertCount - agg.scoringCount;

  // Grid-growing passives, applied after scoring so the new copies don't score
  // the roll they were born on. The pool computes these from the cached roll and
  // grows in place — O(buckets) once bucketed, so Double the Fun doubling into
  // the millions no longer walks (or reallocates) a giant array. The Drought
  // switches all of it off for its trial.
  const growthBlocked = blocksGrowth(state);
  const doubleTheFunCount =
    state.hasDoubleTheFun && !growthBlocked ? pool.doubleTheFun() : 0;
  const genesisCount =
    state.genesis > 0 && !growthBlocked ? pool.genesis(20 * state.genesis) : 0;
  const molds = growthBlocked ? [] : applyMolds(state, pool);
  const moldCount = molds.reduce((n, mold) => n + mold.count, 0);
  const spawnedCount = doubleTheFunCount + genesisCount + moldCount;

  // Breakage bills the dice that scored, and is charged AFTER the growth
  // passives so a die that scored still spawns its copy before it shatters —
  // which is the whole of the Ouroboros/Genesis engine. A denied roll scored
  // nothing, so nothing shatters on it.
  const broken =
    !denied && afflictions.dieBreakChance > 0
      ? pool.breakScoring(
          breakCount(scoringCount, afflictions.dieBreakChance, rng),
        )
      : 0;

  // Defection bills the other half of the same roll: the dice that came up with
  // nothing are the ones the Order of Disorder can talk to. A denied roll is not
  // a failure the traitors can point at, so nothing defects on it either.
  const defected =
    !denied && afflictions.defectChance > 0
      ? pool.breakNonScoring(
          breakCount(nonScoringCount, afflictions.defectChance, rng),
        )
      : 0;

  // Whatever the grid grew to this roll, the cap has the last word.
  const culled = enforceGridCap(state, pool);

  // Whetstone: each copy owned has a 10% chance this roll to shrink one random
  // die a step. Applied after scoring so it only helps future rolls. Below the
  // bucket threshold the shrunk grid index comes back so the scene can flash it.
  const shrunk: number[] = [];
  let whetstoneShrinks = 0;
  for (let c = 0; c < state.whetstone; c++) {
    if (rng() >= 0.1) continue;
    const idx = pool.whetstoneShrink(rng);
    if (idx === null) break;
    whetstoneShrinks += 1;
    if (idx >= 0) shrunk.push(idx);
  }

  // The rival mirrors these passives during the duel, but its copies are not
  // payoff the player's item returned. Count only the player's own pool.
  if (pool === state.dice) {
    addItemValue(state, "double_the_fun", doubleTheFunCount);
    addItemValue(state, "genesis", genesisCount);
    for (const mold of molds) addItemValue(state, mold.id, mold.count);
    addItemValue(state, "whetstone", whetstoneShrinks);
  }

  return {
    spawnedCount,
    spawnedBySource: { genesis: genesisCount, molds },
    shrunk,
    broken,
    defected,
    culled,
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
  payoutTuning: TrialPayoutTuning = {},
): TrialEndOutcome {
  const completedTrial = state.trial;
  const completedScore = state.score;
  const goal = goalFor(state);
  const rollGoldReceipt = {
    ...state.trialRollGold,
    total: state.trialRollGold.titheBowl + state.trialRollGold.luckyCoin,
  };
  // The duel is not scored against a goal at all — it is won by being ahead of
  // the Order of Disorder when the rolls run out, and a tie is not ahead.
  const duel = isMirrorTrial(completedTrial);
  const cleared = duel
    ? playerLeadsDuel(state)
    : state.trialCleared || state.score >= goal;
  // Insurance buys a trial that came within 75% of its goal. The duel has no
  // goal to come within, and nothing in the policy covers being outrolled by
  // yourself, so the last trial is the one it cannot save.
  const insuranceUsed =
    !duel &&
    !cleared &&
    state.hasInsurancePolicy &&
    state.score * 4n >= goal * 3n;
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
    cleared || !cullingEnabled
      ? trialPayout(state, payoutTuning)
      : EMPTY_BREAKDOWN;
  recordClearItemValue(state, goldBreakdown, payoutTuning);
  addItemValue(state, "rain_check", carriedRolls);
  if (insuranceUsed) addItemValue(state, "insurance_policy", 1);
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
  recordPermanentRollValue(state);
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
  prepareDuel(state);
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

/**
 * Stand the Order of Disorder up opposite the player, if the trial about to be
 * played is the duel. Called as the ladder lands on a trial rather than as the
 * trial opens, so the mirror is taken of the grid the player finished shopping
 * with — the same grid the Trial Overview shows them.
 *
 * Idempotent: a mirror already standing is left alone, so a state restored onto
 * the duel keeps the rival it was saved with rather than starting the fight over.
 */
export function prepareDuel(state: RunState): void {
  if (!isMirrorTrial(state.trial)) {
    state.rival = null;
    return;
  }
  if (!state.rival) state.rival = createRival(state);
}

/** Start the ladder: roll a boss modifier if trial 1 somehow is one, and run
 *  the trial-start passives. Called once when a run begins. */
export function beginRun(
  state: RunState,
  rng: () => number = Math.random,
): void {
  state.bossModifiers = bossesForRank(state, state.trial, rng);
  prepareDuel(state);
  // The origin of the run's curves: no points yet, and the starter grid.
  seedRollHistory(state);
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
  addItemValue(state, "rain_check", carriedRolls);
  liftStoryDebuffs(state);
  state.endless = true;
  state.trial += 1;
  recordPermanentRollValue(state);
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
  prepareDuel(state);
}

/** Permanent tempo cards pay once for the next trial when purchased, then once
 * again each time the ladder advances. */
function recordPermanentRollValue(state: RunState): void {
  addItemValue(state, "metronome", state.purchases.metronome ?? 0);
  if (state.purchases.long_night) addItemValue(state, "long_night", 5);
}

/** Source-level portions of a clear payout. These are the concrete gold each
 * economy card unlocked; ordinary base payout and boss gold belong to no item. */
function recordClearItemValue(
  state: RunState,
  breakdown: GoldBreakdown,
  tuning: TrialPayoutTuning,
): void {
  if (breakdown.total <= 0) return;
  // Marginal re-evaluation preserves every boss/curse multiplier and rounding
  // rule. It also gives each item its full synergistic payoff, which is the
  // useful ROI question the Codex is answering.
  const without = (overrides: Partial<RunState>) =>
    trialPayout({ ...state, ...overrides }, tuning).total;
  if (state.reserve > 0)
    addItemValue(state, "reserve", breakdown.total - without({ reserve: 0 }));
  if (state.deepPockets > 0)
    addItemValue(
      state,
      "deep_pockets",
      breakdown.total - without({ deepPockets: 0 }),
    );
  if (state.countingHouse > 0)
    addItemValue(
      state,
      "counting_house",
      breakdown.total - without({ countingHouse: 0 }),
    );
  if (state.hasProspector)
    addItemValue(
      state,
      "prospector",
      breakdown.total - without({ hasProspector: false }),
    );
  if (state.hasVault)
    addItemValue(
      state,
      "vault",
      breakdown.total - without({ hasVault: false }),
    );
  if (state.hasReliquary)
    addItemValue(
      state,
      "reliquary",
      breakdown.total - without({ hasReliquary: false }),
    );
}

/**
 * Release the two drawbacks the story imposed — the King's tribute and the
 * Betrayal. Both were the price of a realm that no longer exists by the time
 * endless begins: the Crown has yielded and the Order of Disorder is dissolved,
 * so neither writ still runs. Every curse the player CHOSE to buy stays, because
 * they were paid for with a boon that also stays.
 */
function liftStoryDebuffs(state: RunState): void {
  const lifted = new Set<AfflictionId>(["betrayal"]);
  if (state.kingsDemand) lifted.add(state.kingsDemand);
  state.afflictions = state.afflictions.filter((id) => !lifted.has(id));
  state.kingsDemand = null;
  state.rival = null;
}
