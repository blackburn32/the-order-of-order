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
import { CHARACTERS, sizeWeights } from "../systems/Characters";
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
  feedPyre,
  MULTITUDE_PAIR_CHANCE,
  offeringBurnChanceFor,
  offeringGoldFor,
  riseFromTheAshes,
  type ShopItemId,
} from "../systems/Items";
import { accumulatePoints, sourceLabel } from "../systems/ItemPoints";
import type { DiceChange } from "../systems/RollBreakdown";
import { recordRollSample, seedRollHistory } from "../systems/RunHistory";
import { deniedRoll, RollResult } from "../systems/Scoring";
import {
  countGrowth,
  growthEarned,
  multipliersLanded,
  rollRulesFor,
  vigilActive,
  vigilPercent,
} from "../systems/GrowthEngines";
import {
  contributingFaces,
  everyLiveDieScored,
  scoreRollHistogram,
} from "../systems/ScoringHistogram";
import { trialRollTarget } from "../systems/Trial";
import { addItemValue } from "../systems/ItemValue";
import { cardReworksEnabled, curiousCopyChance } from "../systems/CardReworks";
import {
  blessingsLeft,
  blessRoll,
  rerollsLeft,
  restoreRun,
  rollStreamKey,
  snapshotRun,
  spendReroll,
} from "../systems/RollFavours";

// Re-exported so GameScene and the bot keep a single import site for the
// trial loop; the definition lives in systems/Trial to stay importable from the
// scorers without a cycle.
export { trialRollTarget };

/** Rules folded once for a roll and shared by rolling, scoring, and passives. */
export interface RollContext {
  afflictions: ActiveAfflictions;
}

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
): RollContext {
  if (pool === state.dice) openTrial(state);
  const afflictions = afflictionsFor(state);
  pool.roll(
    rng,
    scoringNumbersFor(state, afflictions),
    state.royalSealSizes,
    inertDiceCount(state, pool.length, afflictions),
    rollRulesFor(state),
  );
  return { afflictions };
}

/** True when the trial is over: its rolls have run out. Every trial is played
 *  to its last roll — meeting bronze (`trialCleared`, latched by resolveRoll)
 *  only means the run survives it, and the rolls after are spent climbing the
 *  upper tiers (see systems/GoalTiers). The caller should then run
 *  `resolveTrialEnd`. */
export function trialComplete(state: RunState): boolean {
  return state.roll >= trialRollTarget(state);
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

// Sim-only hooks from when a trial ended the moment its goal was met. The
// pacing tuners (pacingCurve, pacingSweep, pacingFeasibility,
// smartSurvivalCurve) named one trial to play its whole budget so capacity
// could be read past the goal, and the dev panel could do the same for every
// trial. Every trial now plays out by rule, so both are no-ops, kept so those
// older tools still build and run.

/** Sim-only, and now a no-op: every trial plays out its whole roll budget. */
export function setFullBudgetTrial(trial: number | null): void {
  void trial;
}

/** Dev/sim-only, and now a no-op: every trial plays out its whole roll budget. */
export function setFullBudgetAllTrials(enabled: boolean): void {
  void enabled;
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
  rollGold: {
    titheBowl: number;
    luckyCoin: number;
    offering: number;
    total: number;
  };
  totalGoldEarned: number;
  insuranceUsed: boolean;
  bossCleared: boolean;
}

export interface ResolveRollOptions {
  /** Context returned by the matching `rollPool` call. */
  context?: RollContext;
  /** Live play records the analysis timeline; headless roll-outs do not need it. */
  recordHistory?: boolean;
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
  opts: ResolveRollOptions = {},
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
  /** Every way the player's grid gained or lost dice this roll, gains first,
   *  for the callout's dice row (see ui/rollBreakdown). */
  diceChanges: DiceChange[];
  /** Dice the player's cards would have added this roll but the grid's
   *  ceiling had no room for, by card (see DicePool.takeTurnedAway). */
  turnedAway: Map<string, number>;
  /** Points the mirror rival scored on its matching roll (0 outside the duel). */
  rivalPoints: bigint;
} {
  const finalRoll = state.roll + 1 >= trialRollTarget(state);
  const scoreBefore = state.score;
  const afflictions = opts.context?.afflictions ?? afflictionsFor(state);

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
        : scoreRollHistogram(state, rolled, { finalRoll, afflictions });

  // The rival rolls and scores here, against the run exactly as the player's
  // roll just met it: the same roll counter (Hair Trigger, Downbeat, the
  // Hourglass), the same purse (the Gilded Altar, before this roll's gold
  // lands), the same burned faces and growth (before the player's grid burns
  // or breaks), and the same toll or gamble — a roll the player loses, the
  // rival loses too. Only its streaks are its own, since scoring a roll moves
  // them.
  const duel = isMirrorTrial(state.trial);
  let rivalResult: RollResult | null = null;
  let rivalRolled = 0;
  if (duel && state.rival) {
    const rival = state.rival;
    rollRival(state, rival, rng);
    rivalRolled = rival.dice.agg().total;
    const own = {
      scoreStreak: state.scoreStreak,
      momentumStreak: state.momentumStreak,
    };
    state.scoreStreak = rival.scoreStreak;
    state.momentumStreak = rival.momentumStreak;
    rivalResult =
      denied === null
        ? scoreRollHistogram(state, rival.dice.agg(), {
            finalRoll,
            afflictions,
          })
        : deniedRoll(state, denied, "Denied");
    rival.scoreStreak = state.scoreStreak;
    rival.momentumStreak = state.momentumStreak;
    state.scoreStreak = own.scoreStreak;
    state.momentumStreak = own.momentumStreak;
  }
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

  // An Offering pays for what this roll burned or shattered on the player's own
  // grid — its own fire, The Brazier's, and every breakage alike.
  const offeringGold = offeringGoldFor(state, passives.broken);
  if (offeringGold > 0) {
    state.trialRollGold.offering += offeringGold;
    addItemValue(state, "an_offering", offeringGold);
    grantGold(state, offeringGold);
  }

  // What the growth engines earned is read off the player's own roll — after its
  // passives, so The Pyre sees the dice this roll shattered — and neither the
  // duel's mirror nor a roll an affliction took can earn it. The counts move
  // only after the rival has scored, above: both sides of the duel must score
  // this roll at the same growth.
  const earned =
    denied === null
      ? growthEarned(state, {
          everyLiveDieScored: everyLiveDieScored(state, rolled, afflictions),
          multipliers: multipliersLanded(result.modifiers),
          valueCounts: rolled.valueCounts,
        })
      : [];

  // The rival's grid takes the roll's passives after the player's, under the
  // same rules. Everything the player's roll suffered, this roll suffers too.
  let rivalPoints = 0n;
  if (duel && state.rival && rivalResult) {
    rivalPoints = rivalResult.points;
    state.rival.score += rivalPoints;
    state.rival.roll += 1;
    applyGridPassives(
      state,
      state.rival.dice,
      afflictions,
      denied !== null,
      rng,
    );
  }

  countGrowth(state, earned);
  // The Vigil tallies each die that scored on its own grid — the rival's dice
  // carry tallies of their own — and only while each grid is small enough.
  if (denied === null && vigilActive(state, rolled.total))
    state.dice.countScores(vigilPercent(state));
  if (denied === null && duel && state.rival && vigilActive(state, rivalRolled))
    state.rival.dice.countScores(vigilPercent(state));

  // Roland's size storm, last of everything the roll does to the grid.
  //
  // After the scoring, after the growth passives, and after The Vigil — every
  // one of those reads the roll's own tallies, and a grid whose sizes have been
  // redrawn is no longer the grid that took the roll. What it leaves behind is
  // the grid the player is looking at when they reach for the next roll, which
  // is the whole of what the storm is for. The duel's mirror is scrambled with
  // it, from the same stream, so the two grids stay each other's copy.
  applySizeStorm(state, rng);

  // The run's timeline, taken last so the sample carries the grid the player is
  // actually left looking at — everything this roll grew, shattered or culled.
  if (opts.recordHistory !== false) recordRollSample(state);

  return {
    result,
    spawnedCount: passives.spawnedCount,
    spawnedBySource: passives.spawnedBySource,
    shrunk: passives.shrunk,
    goldGained: goldGained + offeringGold,
    broken: passives.broken,
    defected: passives.defected,
    culled: passives.culled,
    denied,
    diceChanges: passives.changes,
    turnedAway: passives.turnedAway,
    rivalPoints,
  };
}

/** What a simulated player remembers of the trial it is playing, for deciding
 *  when to spend a roll favour: the points of every roll it kept. */
export interface FavourMemory {
  trial: number;
  kept: bigint[];
}

export function newFavourMemory(): FavourMemory {
  return { trial: 0, kept: [] };
}

/** The dice and resolve streams for one attempt at a roll, by its stream key
 *  (see RollFavours.rollStreamKey). */
export type RollStreams = (key: string) => {
  dice: () => number;
  resolve: () => number;
};

/**
 * Strike the roll just made? A dud always, and a roll that scored under half
 * of what this trial's kept rolls have averaged — a cold roll in a trial whose
 * grid is warm. The trial's first roll has nothing to be measured against, so
 * only a dud is struck there.
 */
export function wantsReroll(points: bigint, kept: readonly bigint[]): boolean {
  if (points <= 0n) return true;
  if (kept.length === 0) return false;
  const mean = kept.reduce((sum, p) => sum + p, 0n) / BigInt(kept.length);
  return points * 2n < mean;
}

/**
 * Bless the roll just made? A grid usually grows through a trial, so its
 * biggest rolls tend to come last: the blessings are saved for the trial's
 * final rolls — one for each roll still to come that it would otherwise go
 * unspent on — unless a roll doubles the best the trial has kept so far, which
 * is worth taking whenever it comes.
 */
export function wantsBlessing(
  state: RunState,
  points: bigint,
  kept: readonly bigint[],
): boolean {
  const left = blessingsLeft(state);
  if (left <= 0 || points <= 0n) return false;
  // `roll` has already counted this one, so this is the rolls after it.
  const after = trialRollTarget(state) - state.roll;
  if (after < left) return true;
  const best = kept.reduce((top, p) => (p > top ? p : top), 0n);
  return kept.length >= 2 && points >= best * 2n;
}

/**
 * Make one roll the way a player holding the roll favours plays it: roll it,
 * strike it and roll again while `wantsReroll` says so and an Absolution is
 * left, then bless it when `wantsBlessing` says so. The live game asks the
 * player instead (GameScene's score panel); the simulation and the appraiser
 * play through here so both value the favours the way they are used.
 *
 * Without a favour owned this is exactly `rollPool` and `resolveRoll`, under
 * the same stream keys, so a run that never buys one plays as it always did.
 */
export function playRoll(
  state: RunState,
  streams: RollStreams,
  memory: FavourMemory,
  opts: Omit<ResolveRollOptions, "context"> = {},
): ReturnType<typeof resolveRoll> {
  if (memory.trial !== state.trial) {
    memory.trial = state.trial;
    memory.kept = [];
  }
  for (;;) {
    const snapshot = rerollsLeft(state) > 0 ? snapshotRun(state) : null;
    const { dice, resolve } = streams(rollStreamKey(state));
    const context = rollPool(state, state.dice, dice);
    const outcome = resolveRoll(state, resolve, { ...opts, context });
    const points = outcome.result.points;
    if (snapshot && wantsReroll(points, memory.kept)) {
      restoreRun(state, snapshot);
      spendReroll(state);
      continue;
    }
    if (wantsBlessing(state, points, memory.kept)) blessRoll(state, points);
    memory.kept.push(points);
    return outcome;
  }
}

/**
 * Redraw every die's size on both sides of the duel, for a character whose grid
 * never settles (see systems/Characters). A no-op for everyone else, which is
 * every character but Roland.
 *
 * The two pools are drawn from the same `rng` in a fixed order, so a replayed
 * run scrambles them exactly as the run that happened did.
 */
function applySizeStorm(state: RunState, rng: () => number): void {
  const chaos = CHARACTERS[state.character].sizeChaos;
  if (!chaos) return;
  const weights = sizeWeights(chaos);
  state.dice.randomizeSizes(weights, rng, state.loadedSizes, state.wildSizes);
  if (state.rival)
    state.rival.dice.randomizeSizes(
      weights,
      rng,
      state.loadedSizes,
      state.wildSizes,
    );
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
  /** The same counts by cause, gains first, every entry non-zero. */
  changes: DiceChange[];
  /** What the ceiling refused this pass, by the card that wanted the dice. */
  turnedAway: Map<string, number>;
} {
  // Anything refused before this pass (a shop purchase) is not this roll's.
  pool.takeTurnedAway();
  // Read the roll's own tallies before anything destroys dice, so breakage and
  // defection bill the same roll rather than the grid the other one left behind.
  const agg = pool.agg();
  const scoringCount = agg.scoringCount;

  // Grid-growing passives, applied after scoring so the new copies don't score
  // the roll they were born on. The pool computes these from the cached roll and
  // grows in place — O(buckets) once bucketed, so Double the Fun doubling into
  // the millions no longer walks (or reallocates) a giant array. The Drought
  // switches all of it off for its trial.
  const growthBlocked = blocksGrowth(state, afflictions);
  const curious = state.hasDoubleTheFun && !growthBlocked;
  const doubleTheFunCount = curious
    ? pool.doubleTheFun(
        cardReworksEnabled(),
        curiousCopyChance(),
        rng,
        MULTITUDE_PAIR_CHANCE * state.multitude,
      )
    : 0;
  const multitudePairs = curious ? pool.lastPairs : 0;
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

  // What breakage burned feeds The Pyre (the player's own grid only), and From
  // the Ashes returns a share of it as d100s on whichever grid it burned.
  let ashes = 0;
  if (broken > 0) {
    if (pool === state.dice) feedPyre(state, pool.lastBrokenFaces);
    ashes = riseFromTheAshes(state, pool, broken, growthBlocked, rng);
  }

  // The Brazier burns every die that showed a 1, on both sides of the duel; as
  // with breakage, only the player's fire feeds The Pyre. A denied roll showed
  // nothing to burn.
  const burned = state.hasBrazier && !denied ? pool.burnOnes() : 0;
  if (burned > 0) {
    if (pool === state.dice) {
      feedPyre(state, pool.lastBrokenFaces);
      addItemValue(state, "the_brazier", burned);
    }
    ashes += riseFromTheAshes(state, pool, burned, growthBlocked, rng);
  }

  // An Offering sets a small fire of its own: each die larger than a d1 may burn
  // after the roll, on both sides of the duel, feeding The Pyre as The Brazier's
  // fire does.
  const burnChance = denied ? 0 : offeringBurnChanceFor(state);
  const offered =
    burnChance > 0
      ? pool.burnAtRandom(
          breakCount(pool.length - pool.countOfSize(1), burnChance, rng),
          rng,
        )
      : 0;
  if (offered > 0) {
    if (pool === state.dice) feedPyre(state, pool.lastBrokenFaces);
    ashes += riseFromTheAshes(state, pool, offered, growthBlocked, rng);
  }

  // Defection bills the other half of the same roll: the dice that gave it
  // nothing are the ones the Order of Disorder can talk to. A die that scored is
  // safe, and so is one whose face fed the score another way — a pair Consensus
  // paid, a lone face Counterpoint paid. A denied roll is not a failure the
  // traitors can point at, so nothing defects on it either, and the last die on
  // the grid never leaves (see DicePool.breakNonScoring).
  let defected = 0;
  if (!denied && afflictions.defectChance > 0) {
    const spared = contributingFaces(state, agg, afflictions);
    defected = pool.breakNonScoring(
      breakCount(pool.defectableCount(spared), afflictions.defectChance, rng),
      spared,
    );
  }

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
    addItemValue(state, "double_the_fun", doubleTheFunCount - multitudePairs);
    addItemValue(state, "the_multitude", multitudePairs);
    addItemValue(state, "genesis", genesisCount);
    for (const mold of molds) addItemValue(state, mold.id, mold.count);
    addItemValue(state, "whetstone", whetstoneShrinks);
  }

  // Gains first, then losses, each named the way the player knows it: a card
  // by its own name, a loss by what happened to the dice.
  const gained = (id: ShopItemId, delta: number): DiceChange => ({
    id,
    name: sourceLabel(id),
    delta,
  });
  const changes: DiceChange[] = [
    gained("double_the_fun", doubleTheFunCount - multitudePairs),
    gained("the_multitude", multitudePairs),
    gained("genesis", genesisCount),
    ...molds.map((mold) => gained(mold.id, mold.count)),
    gained("from_the_ashes", ashes),
    { id: "shattered", name: "Shattered", delta: -broken },
    { id: "burned", name: "Burned", delta: -(burned + offered) },
    { id: "defected", name: "Defected", delta: -defected },
    { id: "culled", name: "Culled", delta: -culled },
  ].filter((change) => change.delta !== 0);

  return {
    spawnedCount: spawnedCount + ashes,
    spawnedBySource: { genesis: genesisCount, molds },
    shrunk,
    broken: broken + burned + offered,
    defected,
    culled,
    changes,
    turnedAway: pool.takeTurnedAway(),
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
    total:
      state.trialRollGold.titheBowl +
      state.trialRollGold.luckyCoin +
      state.trialRollGold.offering,
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
  if (cleared && !duel && goldBreakdown.tier >= 0)
    state.tierCounts[goldBreakdown.tier] += 1;
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
      insuranceUsed,
      bossCleared,
    };
  }

  state.trial += 1;
  recordPermanentRollValue(state);
  state.roll = 0;
  state.trialCleared = false;
  state.bonusRollsThisRound = carriedRolls;
  state.rerollsUsed = 0;
  state.blessingsUsed = 0;
  // Score is progress toward one trial's goal and nothing else — it always
  // starts a trial at zero. Gold is what carries across.
  state.score = 0n;
  state.trialScore = 0n;
  state.trialRollGold = { titheBowl: 0, luckyCoin: 0, offering: 0 };
  state.bossModifiers = bossesForRank(
    state,
    state.trial,
    rng,
    state.bossModifiers,
  );
  state.trialOpenPending = true;
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
  state.rerollsUsed = 0;
  state.blessingsUsed = 0;
  state.score = 0n;
  state.trialScore = 0n;
  state.trialRollGold = { titheBowl: 0, luckyCoin: 0, offering: 0 };
  state.bossModifiers = bossesForRank(
    state,
    state.trial,
    rng,
    state.bossModifiers,
  );
  state.trialOpenPending = true;
  prepareDuel(state);
}

/**
 * Open the trial the ladder last moved onto: run its trial-start passives (see
 * Items.applyTrialStart) once, and return the number of dice they added.
 *
 * Deliberately not part of resolveTrialEnd. The shop sits between a trial's end
 * and the next trial's start, so passives run at the end would miss every card
 * bought there — a first Inner Circle would do nothing until a whole trial
 * later. The Game scene calls this as it opens a trial; rollPool calls it too,
 * so no caller can roll a trial's first grid without it. A no-op once done.
 */
export function openTrial(state: RunState): number {
  if (!state.trialOpenPending) return 0;
  state.trialOpenPending = false;
  const added = applyTrialStart(state);
  // The duel's mirror is re-taken here, over the one the ladder stood up as the
  // last trial ended: that one predates the shop and these passives, and the
  // rival is meant to hold the very grid the player sits down with. Nothing
  // reads the rival before the trial opens, and it cannot have rolled yet.
  if (isMirrorTrial(state.trial)) {
    state.rival = createRival(state);
    // The edge belongs to the player rather than the grid the Order copies.
    // Bank it only when the duel actually opens, after the mirror is taken, so
    // buying it early survives every ordinary trial reset and a resumed duel
    // cannot award it twice.
    if (state.hasEdge) {
      state.score += 1n;
      state.trialScore = state.score;
      state.totalScore += 1n;
      state.itemPoints.the_edge = (state.itemPoints.the_edge ?? 0n) + 1n;
    }
  }
  return added;
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
