// What a build is worth, measured rather than asserted.
//
// The nine original strategies shop by price and theme: `byCostAscending`,
// `byCostDescending`, "is this card in my theme". None of them ever asks the one
// question a good player asks every visit — what does this card do to my score?
// — and none of them chooses which die to point a card at, so Twin lands on a
// random die where a player would put it on their biggest. A field that cannot
// target its own dice sets a goal curve that a player who can will one-roll.
//
// This module is the missing question, asked the only way that cannot drift from
// the rules: buy the card on a throwaway copy of the run, play the next trial's
// whole roll budget out on it, and read the score. Everything the game does —
// growth passives, molds, afflictions, boss modifiers, Whetstone, the real
// scorer — is in the answer because the answer is produced by the real code.
//
// Two things make that affordable. Capacity is measured in log10, so builds
// three orders of magnitude apart still compare as numbers; and every candidate
// is rolled against the SAME seeds as the baseline it is compared to (common
// random numbers), which cancels most of the variance and lets three samples
// stand in for thirty.

import { canLoad, canShrink, type Die } from "../systems/Dice";
import type { DicePool } from "../systems/DicePool";
import { goalFor } from "../systems/Boss";
import { trialPayout } from "../systems/Gold";
import { applyOffer, type ShopOffer } from "../systems/Shop";
import type { RunState } from "../state/RunState";
import { cloneRunState } from "./cloneRun";
import {
  resolveRoll,
  resolveTrialEnd,
  rollPool,
  trialComplete,
  trialRollTarget,
} from "./engine";
import { mulberry32 } from "./localStorageShim";

/**
 * log10 of a score, via its decimal string.
 *
 * Scores are bigint precisely because they outrun `Number`, so `Number(v)`
 * reaches Infinity on a late endless build and every comparison past that point
 * becomes a tie. The digit count carries the exponent and the leading digits
 * carry the mantissa, which is all a ratio ever needed.
 */
export function log10Big(value: bigint): number {
  if (value <= 0n) return 0;
  const digits = value.toString();
  const head = digits.slice(0, 15);
  return digits.length - head.length + Math.log10(Number(head));
}

export interface CapacityOptions {
  /** Roll-outs to average. Three is usually enough BECAUSE of the shared seeds
   *  below; without them it would not be close. */
  samples: number;
  /** Base seed. Two capacity measurements sharing a seed share their dice. */
  seed: number;
  /** Rolls to play, defaulting to the rest of the state's current trial. */
  horizon?: number;
  /**
   * Let the roll-out cross a trial boundary: when the goal is met, resolve the
   * trial the way the game does — pay it out, advance the ladder, and keep
   * rolling into the next trial with what is left of the horizon.
   *
   * Off, a horizon longer than one trial is a single trial played far past its
   * goal, which is a fine measure of raw scoring and a terrible one of income:
   * interest, a Boss Trial's bonus, Counting House and Deep Pockets are all paid
   * WHEN A TRIAL ENDS, so a roll-out that never ends one prices every income
   * card at exactly zero however long it runs.
   */
  crossTrials?: boolean;
  /**
   * What a roll-out is scored by.
   *
   * `"score"` reports the log10 of the best trial it played — how much this
   * build multiplies, which is the quantity a goal is designed against and what
   * `benchmark.ts` reads.
   *
   * `"ladder"` reports how far up the LADDER it got instead: trials cleared,
   * plus part of one for how close it came on the trial that stopped it. The
   * difference only shows late, and there it is the difference between a
   * measurement and none. A compounding build one-rolls its goals, so the score
   * it posts is one roll of its grid however large the grid is — and a card that
   * adds a die, a mold, or a flat bonus moves log10 of a 1e14 score by nothing
   * at all. The same card is worth a whole trial of depth once a goal outruns
   * the build, which is what actually ends runs. Implies `crossTrials`; there is
   * no ladder to walk without it.
   */
  objective?: "score" | "ladder";
}

export interface Capacity {
  /** Mean of whatever the objective measures: log10 of the best trial score
   *  played, or — under `"ladder"` — trials of the goal ladder walked. */
  logPoints: number;
  /** Mean gold the horizon earns, including the payout the trial would have
   *  made had it ended on the roll its goal was crossed. */
  gold: number;
  /** Share of roll-outs that reached the trial's goal at all. */
  clearRate: number;
  /** Mean roll the goal was first crossed on, over the roll-outs that crossed
   *  it. This is the pacing number: 1.0 means the goal is decoration. */
  meanClearRoll: number;
  /** Share of ALL roll-outs that met the goal on the opening roll. The number
   *  the complaint "I clear the round in a single roll" is made of. */
  oneRollShare: number;
  /** Every roll-out's log10 score, ascending — for quantiles. */
  logSamples: number[];
}

/**
 * Play `state`'s current trial to the end of its roll budget, `samples` times,
 * and report what it reached.
 *
 * By default the trial is never resolved and the ladder never advances: this
 * measures one trial's capacity from one state, which is exactly the quantity a
 * goal is set against, and it is how `benchmark.ts` reads a build. Under
 * `crossTrials` the horizon plays on into the trials after it instead, and the
 * number reported is the best single trial it contained. Nothing here reads or
 * writes the caller's state either way — every roll-out happens on its own
 * clone.
 */
export function measureCapacity(
  state: RunState,
  opts: CapacityOptions,
): Capacity {
  const budget = opts.horizon ?? trialRollTarget(state) - state.roll;
  const rolls = Math.max(0, budget);
  const ladder = opts.objective === "ladder";
  const crossing = opts.crossTrials || ladder;
  const logSamples: number[] = [];
  let goldTotal = 0;
  let cleared = 0;
  let clearRollTotal = 0;
  let oneRoll = 0;

  for (let i = 0; i < opts.samples; i++) {
    // The seed depends on the sample index and NOTHING about the candidate, so
    // a baseline and every card weighed against it see identical dice.
    const rng = mulberry32(opts.seed + i * 7_907);
    const trial = cloneRunState(state);
    const goldBefore = trial.goldEarned;
    const firstTrial = trial.trial;
    let clearedOn = 0;
    // The best single trial the horizon contained. Without crossing there is
    // only ever one, and this is its score.
    let peakLog = 0;
    let trialsCleared = 0;
    for (let r = 0; r < rolls; r++) {
      rollPool(trial, trial.dice, rng);
      resolveRoll(trial, rng);
      if (clearedOn === 0 && trial.trial === firstTrial && trial.trialCleared)
        clearedOn = trial.roll;
      if (crossing && trialComplete(trial)) {
        peakLog = Math.max(peakLog, log10Big(trial.score));
        // A trial the build could not clear ends the horizon rather than the
        // run: the caller is measuring a hypothesis, not playing it. Victory
        // ends it for the same reason — there is no further trial to measure.
        const outcome = resolveTrialEnd(trial, rng);
        if (outcome.phase !== "advanced") {
          if (outcome.phase === "victory") trialsCleared += 1;
          break;
        }
        trialsCleared += 1;
      }
    }
    logSamples.push(
      ladder
        ? trialsCleared + goalProgress(trial)
        : Math.max(peakLog, log10Big(trial.score)),
    );

    // The gold this trial would have paid. A trial that met its goal ends on the
    // roll it met it, so the payout is taken against THAT roll count — otherwise
    // playing the budget out would report every clear as having no rolls to
    // spare, and quietly value Reserve and Deep Pockets at zero.
    //
    // A crossing roll-out has no need of the estimate: every trial it finished
    // was paid out by the engine, on the roll it actually ended on.
    if (clearedOn > 0) {
      cleared += 1;
      clearRollTotal += clearedOn;
      if (clearedOn === 1) oneRoll += 1;
      if (!crossing) {
        trial.roll = clearedOn;
        goldTotal += trialPayout(trial).total;
      }
    }
    goldTotal += trial.goldEarned - goldBefore;
  }

  logSamples.sort((a, b) => a - b);
  const n = Math.max(1, opts.samples);
  return {
    logPoints: logSamples.reduce((sum, v) => sum + v, 0) / n,
    gold: goldTotal / n,
    clearRate: cleared / n,
    meanClearRoll: cleared > 0 ? clearRollTotal / cleared : 0,
    oneRollShare: oneRoll / n,
    logSamples,
  };
}

/**
 * How much of the trial in hand a build has done, as a fraction of one trial.
 *
 * A run that stops two trials up the ladder from another is two better, and this
 * is what separates the two that stopped in the same place: how close the one
 * that stopped got. Without it the ladder objective is an integer, and an
 * integer that a single card rarely moves is not a gradient — every card on the
 * shelf would tie.
 *
 * A decade short of the goal is half a trial's credit, two decades is none. The
 * scale is arbitrary in the way a unit is arbitrary: nothing reads this except
 * a comparison between two roll-outs measured the same way.
 */
const PROGRESS_DECADES = 2;

function goalProgress(state: RunState): number {
  const goal = log10Big(goalFor(state));
  if (goal <= 0) return 1;
  const short = goal - log10Big(state.score);
  if (short <= 0) return 1;
  return Math.max(0, 1 - short / PROGRESS_DECADES);
}

/** A quantile of a sorted sample list, by linear interpolation. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---- targeting -------------------------------------------------------------

/**
 * A die's identity for targeting purposes — the same four properties
 * `DicePool.groups()` keys on, and deliberately not its source or its grid
 * index. An index cannot cross between a run and its clone (see cloneRun.ts);
 * this key can, which is what lets a target be chosen on a hypothesis and then
 * applied to the real grid.
 */
export function groupKeyOf(die: Die): string {
  return `${die.sides}|${die.maxFaceBonus}|${die.loaded ? 1 : 0}|${die.wildFace ? 1 : 0}`;
}

/** Resolve a group key back to a live grid index in the given pool. */
export function resolveGroupIndex(pool: DicePool, key: string): number | null {
  for (const group of pool.groups()) {
    if (groupKeyOf(group.die) === key) return group.firstIndex;
  }
  return null;
}

/** How many distinct die groups a single card is weighed against. The grid holds
 *  at most eight sizes, so this only bites on a grid carrying several flag
 *  combinations of the same size. */
const MAX_TARGET_CANDIDATES = 5;

/**
 * Every die group this offer could legally be pointed at, or null when the card
 * needs a target and the grid has none — the same "cannot buy this" answer
 * `chooseTargets` gives, arrived at the same way.
 *
 * A card with no target returns a single keyless choice, so callers can treat
 * targeted and untargeted cards identically.
 */
export function targetChoices(
  state: RunState,
  offer: ShopOffer,
): { key: string | null }[] | null {
  if (!offer.needsTarget) return [{ key: null }];

  const groups = state.dice.groups();
  let eligible: typeof groups;
  switch (offer.id) {
    case "shrink":
    case "grindstone":
      eligible = groups.filter((g) => canShrink(g.die));
      break;
    case "loaded_die":
      eligible = groups.filter((g) => canLoad(g.die));
      break;
    case "royal_seal":
      eligible = groups.filter(
        (g) => !state.royalSealSizes.includes(g.die.sides),
      );
      break;
    default:
      eligible = groups;
      break;
  }
  if (eligible.length === 0) return null;

  // Both ends of the ladder are interesting and the middle rarely is: the
  // biggest die is what Twin and Wild Face want, the smallest is what Shrink is
  // usually walking toward. Sorting by size and keeping both ends is how the
  // candidate list stays short without quietly excluding the right answer.
  const bySize = [...eligible].sort((a, b) => b.die.sides - a.die.sides);
  const kept =
    bySize.length <= MAX_TARGET_CANDIDATES
      ? bySize
      : [
          ...bySize.slice(0, MAX_TARGET_CANDIDATES - 1),
          bySize[bySize.length - 1],
        ];
  return kept.map((g) => ({ key: groupKeyOf(g.die) }));
}

// ---- appraisal -------------------------------------------------------------

export interface Appraisal {
  offer: ShopOffer;
  /** The die group the card should be pointed at, or null for an untargeted
   *  card. Resolve it to an index against the live grid with
   *  `resolveGroupIndex` — never carry an index out of an appraisal. */
  targetKey: string | null;
  /** log10 points the card adds over the horizon, against the shared baseline. */
  pointsGain: number;
  /** Gold the card adds over the same horizon, price NOT deducted (the price is
   *  accounted for once, by dividing through it — see `efficiency`). */
  goldGain: number;
}

/**
 * Weigh one card, in every legal target, against a baseline already measured
 * from the same state and the same seeds.
 *
 * The card is applied at zero cost. Its price is not ignored — it is accounted
 * for exactly once, when the caller divides the appraised value by it, rather
 * than a second time inside the measurement as forgone interest.
 *
 * Returns null when the card cannot be bought at all (no legal target, or an
 * effect that refuses).
 */
export function appraiseOffer(
  state: RunState,
  offer: ShopOffer,
  baseline: Capacity,
  opts: CapacityOptions,
): Appraisal | null {
  const choices = targetChoices(state, offer);
  if (!choices) return null;

  let best: Appraisal | null = null;
  for (const choice of choices) {
    const hypothetical = cloneRunState(state);
    const index =
      choice.key === null
        ? undefined
        : (resolveGroupIndex(hypothetical.dice, choice.key) ?? undefined);
    if (choice.key !== null && index === undefined) continue;
    if (!applyOffer(hypothetical, { ...offer, cost: 0 }, index)) continue;

    const after = measureCapacity(hypothetical, opts);
    const appraisal: Appraisal = {
      offer,
      targetKey: choice.key,
      pointsGain: after.logPoints - baseline.logPoints,
      goldGain: after.gold - baseline.gold,
    };
    if (!best || appraisal.pointsGain > best.pointsGain) best = appraisal;
  }
  return best;
}

/**
 * What a gold is worth, in the same log-points units a card is appraised in.
 *
 * Self-calibrating rather than authored: a gold is worth whatever the best card
 * on this table converts it into, discounted because a gold kept is a gold spent
 * in some later shop, on some later table, that may be worse than this one. The
 * alternative — a hand-set exchange rate — would be a balance decision smuggled
 * into a measuring tool, and would go stale the moment prices moved.
 */
const FUTURE_GOLD_DISCOUNT = 0.6;

export function goldExchangeRate(appraisals: readonly Appraisal[]): number {
  let best = 0;
  for (const a of appraisals) {
    if (a.offer.cost <= 0) continue;
    best = Math.max(best, a.pointsGain / a.offer.cost);
  }
  return best * FUTURE_GOLD_DISCOUNT;
}

/** An appraisal's total worth in log-points, gold included. */
export function appraisedValue(a: Appraisal, goldRate: number): number {
  return a.pointsGain + goldRate * a.goldGain;
}

/** Worth per gold — the number a shopper ranks a table by. A free card is ranked
 *  by its worth alone, above every card that costs anything. */
export function efficiency(a: Appraisal, goldRate: number): number {
  const value = appraisedValue(a, goldRate);
  if (a.offer.cost <= 0) return value > 0 ? Infinity : value;
  return value / a.offer.cost;
}
