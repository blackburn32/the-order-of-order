// Editable knobs for the balance simulation. Change `unlockedAtStart` to control
// which items appear in the shop pool during a batch (this is the "list of
// unlocked items you can change before the test"); everything else is a default
// the CLI can override via argv.

import { ITEMS, ShopItemId } from "../systems/Items";
import type { RunState } from "../state/RunState";

/** Every item that is gated behind an unlock criterion — i.e. everything that is
 *  NOT available from the start of a fresh save. */
export const GATED_ITEM_IDS: ShopItemId[] = ITEMS.filter((it) => it.unlock).map(
  (it) => it.id,
);

/** Items available from the very first shop of a fresh save (no unlock gate). */
export const BASE_ITEM_IDS: ShopItemId[] = ITEMS.filter((it) => !it.unlock).map(
  (it) => it.id,
);

/** The two meta-progression states compared by the main balance report. */
export const UNLOCK_POOLS = {
  none: [] as ShopItemId[],
  all: [...GATED_ITEM_IDS],
} as const;

export interface SimConfig {
  /**
   * Which gated items count as already-unlocked for the shop pool during the
   * batch. `loadProgress().unlocked` is seeded from this, so `availableIds` in
   * Shop.ts offers exactly these (plus the always-available base items).
   *
   * Default: every gated item (the "all items unlocked" balancing baseline).
   * Edit this to a subset to test a narrower pool, e.g.:
   *   unlockedAtStart: []                         // base items only
   *   unlockedAtStart: ['dividend', 'momentum']   // base + two candidates
   *
   * NOTE: this only affects what the shop *offers*. The unlock-likelihood
   * tracker measures every gated item's criterion regardless of this list, so
   * you always get "how often would a player unlock X" for the full roster.
   */
  unlockedAtStart: ShopItemId[];

  /** Runs per strategy. */
  runs: number;

  /** Base RNG seed; run i of a strategy uses a seed derived from this. */
  seed: number;

  /** Safety cap on total rolls per run, in case a build could loop forever. */
  maxRollsPerRun: number;

  /** How willing the shopper is to accept a cursed card. Zero requires a clear
   * bargain; one accepts anything that is not actively ruinous. */
  curseAppetite?: number;

  /** Simulation-only multiplier on the ordinary unused-roll payout. Reserve's
   * item bonus is deliberately left alone. */
  unusedRollBaseMultiplier?: number;

  /** Simulation-only replacement for the maximum unused rolls that pay gold. */
  unusedRollCap?: number;

  /**
   * Record every trial's per-roll cumulative score into its `TrialPoint`.
   *
   * Only the roll-pacing tuner needs it — it is how "how far into its budget
   * would this build have got" is measured — and it costs a number per roll per
   * trial per run, which a 9,000-run batch does not want to carry.
   */
  traceRolls?: boolean;

  /** End the run once this trial has been resolved, whatever the outcome. The
   *  roll-pacing tuner calibrates one trial at a time and has no use for the
   *  ladder past the trial it is measuring. */
  stopAfterTrial?: number;

  /**
   * Roll-outs the expert strategy averages each shopping hypothesis over (see
   * sim/expert.ts). Higher is steadier and linearly slower; it has no effect on
   * any other strategy, none of which measure anything.
   */
  expertSamples?: number;

  /**
   * Trials of rolls the expert judges each card over, defaulting to
   * `expert.LOOKAHEAD_TRIALS`. Raising it prices slow, compounding cards more
   * generously and costs proportionally more rolls.
   */
  expertHorizonScale?: number;

  /**
   * The expert's three spending knobs, defaulting to the constants in
   * sim/expert.ts. They exist here so `expert:tune` can sweep them over a
   * matched seed stream rather than by editing the module between runs:
   * `expertRelativeFloor` is how far below the visit's best card a card may be
   * and still be bought, `expertPasses` is how often the shelf is re-appraised
   * against the build the last purchase made, and `expertGoldWeight` scales what
   * a gold in hand is judged to be worth.
   */
  expertRelativeFloor?: number;
  expertPasses?: number;
  expertGoldWeight?: number;

  /** Whether the expert's roll-outs cross trial boundaries, defaulting to
   *  `expert.CROSS_TRIAL_ROLLOUTS`. Off measures a build's scoring alone and is
   *  blind to every card that pays at a clear. */
  expertCrossTrials?: boolean;

  /** Cards the expert may weigh together as one purchase, defaulting to
   *  `expert.BUNDLE_SIZE`. One is a card at a time, which cannot see a pair
   *  whose halves are each worth nothing alone. */
  expertBundleSize?: number;

  /** What the expert scores a hypothesis by, defaulting to
   *  `expert.LADDER_OBJECTIVE`: trials of the goal ladder walked (`"ladder"`),
   *  or log10 of the score reached (`"score"`). */
  expertObjective?: "score" | "ladder";

  /**
   * Called as the run enters each trial — after that trial's shop, before its
   * first roll. The state is the LIVE run, not a copy: read it, do not keep it.
   * `benchmark.ts` uses this to measure what each bot walks into a trial with.
   */
  onTrialStart?: (state: RunState) => void;
}

export const DEFAULT_CONFIG: SimConfig = {
  unlockedAtStart: [...GATED_ITEM_IDS],
  runs: 1000,
  seed: 1,
  maxRollsPerRun: 100_000,
};
