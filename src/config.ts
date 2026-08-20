// Central tuning knobs for The Order of Order.
//
// The canvas is responsive and resizes to fill the page in either
// orientation — scenes lay themselves out from `scene.scale.width/height`,
// there is no fixed design resolution.

// ---- Progression shape -----------------------------------------------------
//
// A run is a ladder of TRIALS grouped into RANKS. Each rank is three trials —
// the Lesser Trial, the Greater Trial, and the Boss Trial — with a shop between
// every one of them. Clearing a rank's Boss Trial raises the rank and returns
// the player to a Lesser Trial with all three goals raised.
//
// `RunState.trial` is a single 1-based counter that runs straight through the
// whole ladder (1..15 for ranks 1-5, then 16+ in endless). Rank and
// trial-within-rank are derived from it rather than stored, so every consumer
// that just wants "how far did they get" — the Hall, the leaderboard, unlock
// criteria, the sim's trajectories — keeps working off one number.

export const TRIALS_PER_RANK = 3;

/** Clearing this rank's Boss Trial wins the game. Past it the run only
 *  continues if the player chose to go endless. */
export const WIN_RANK = 5;
export const WIN_TRIAL = WIN_RANK * TRIALS_PER_RANK; // 15

/** Rolls granted by each trial in a rank, indexed by `trialInRank() - 1`. The
 *  Lesser Trial is deliberately the shortest: it is a sprint against a small
 *  goal, not a gentler version of the same thing. */
export const ROLLS_PER_TRIAL = [7, 15, 20] as const;

/**
 * Dice a run opens with.
 *
 * A single d6 makes the opening trials meaningfully risky: it has a 28% chance
 * to miss every scoring face across the Lesser Trial's seven rolls. That early
 * variance is intentional rather than protected against.
 */
export const STARTING_DICE = 1;

export const TRIAL_NAMES = [
  "Lesser Trial",
  "Greater Trial",
  "Boss Trial",
] as const;

/** 1-based rank containing `trial`. */
export function rankOf(trial: number): number {
  return Math.floor((trial - 1) / TRIALS_PER_RANK) + 1;
}

/** 1-based position of `trial` within its rank (1 = Lesser, 3 = Boss). */
export function trialInRank(trial: number): number {
  return ((trial - 1) % TRIALS_PER_RANK) + 1;
}

export function isBossTrial(trial: number): boolean {
  return trialInRank(trial) === TRIALS_PER_RANK;
}

export function trialName(trial: number): string {
  return TRIAL_NAMES[trialInRank(trial) - 1];
}

/** Base rolls for a trial, before Metronome/Overtime and any boss modifier. */
export function rollsForTrial(trial: number): number {
  return ROLLS_PER_TRIAL[trialInRank(trial) - 1];
}

// ---- Goal curve ------------------------------------------------------------
//
// Score goals for the 15 trials of the 5-rank game (index = trial - 1),
// hand-authored against the balance simulation (src/sim) to a deliberate
// attrition curve rather than a single geometric ratio, because shopping
// creates a highly skewed score distribution that diverges across builds.
//
// Attrition intent (measured on the pooled bot field; a thinking player does
// better) — fraction of the whole field still alive after each rank:
//   rank 1 — 97%   a free on-ramp
//   rank 2 — 88%
//   rank 3 — 70%
//   rank 4 — 47%
//   rank 5 — 25%   the win rate
// Early goals remain small integers, but the single starting die deliberately
// allows bad luck to end some runs in the first rank.
// Within a rank most of the cull lands on the Boss Trial, whose modifier is
// already doing work.
//
// The curve SAWTOOTHS, and that is deliberate: a rank opens with a seven-roll
// Lesser Trial and closes with a twenty-roll Boss Trial, so the Lesser Trial of
// rank 3 asks for less than the Boss Trial of rank 2. What always rises is the
// same slot generally rises from one rank to the next.
//
// See src/sim/designTargets.ts to redesign the curve and src/sim/validate.ts to
// re-test it against the real survival gate.
export const TRIAL_GOALS: bigint[] = [
  // rank 1
  1n,
  3n,
  5n,
  // rank 2
  2n,
  7n,
  10n,
  // rank 3
  48n,
  100n,
  580n,
  // rank 4
  590n,
  1_000n,
  5_600n,
  // rank 5
  4_000n,
  10_000n,
  50_000n,
];

// Endless growth past WIN_TRIAL. A flat geometric ratio can be outrun forever,
// because builds themselves grow geometrically (3^prism, 4^lastCall compound
// every roll). So the growth RATE itself grows: each trial past the win is
// multiplied by ENDLESS_BASE raised to a power that climbs with distance. That
// guarantees the goal eventually outpaces any build and the run ends.
//
//   goal(t) = goal(t-1) × ENDLESS_BASE^(1 + (t - 1 - WIN_TRIAL) × ENDLESS_ACCEL)
export const ENDLESS_BASE = 2.1;
export const ENDLESS_ACCEL = 0.05;

// Optional per-trial override table for the goals (index = trial - 1). The
// balance simulation sets this to trial alternate difficulty curves without
// editing TRIAL_GOALS; a null/undefined entry (or a null table) falls back to
// the authored table. The shipping game never sets it.
let TRIAL_GOAL_OVERRIDES: (number | null | undefined)[] | null = null;
export function setTrialGoals(
  goals: (number | null | undefined)[] | null,
): void {
  TRIAL_GOAL_OVERRIDES = goals;
  ENDLESS_CACHE.length = 0;
}

// Endless goals are computed by walking out from the last authored trial, so
// they are memoized rather than recomputed on every HUD update.
const ENDLESS_CACHE: bigint[] = [];

function endlessGoal(trial: number): bigint {
  let value =
    ENDLESS_CACHE[ENDLESS_CACHE.length - 1] ?? authoredGoal(WIN_TRIAL);
  for (let t = WIN_TRIAL + ENDLESS_CACHE.length + 1; t <= trial; t++) {
    const exponent = 1 + (t - 1 - WIN_TRIAL) * ENDLESS_ACCEL;
    // Per-mille integer math so the fractional growth applies exactly to the
    // bigint goal (truncates, like floor).
    const mult = BigInt(Math.round(Math.pow(ENDLESS_BASE, exponent) * 1000));
    value = (value * mult) / 1000n;
    ENDLESS_CACHE.push(value);
  }
  return ENDLESS_CACHE[trial - WIN_TRIAL - 1];
}

function authoredGoal(trial: number): bigint {
  const override = TRIAL_GOAL_OVERRIDES?.[trial - 1];
  if (override != null) return BigInt(override);
  return TRIAL_GOALS[trial - 1] ?? TRIAL_GOALS[TRIAL_GOALS.length - 1];
}

/** The score a trial must reach to be cleared. Boss modifiers that raise the
 *  goal (The Hoard) are applied by the caller via `Boss.goalFor`, not here, so
 *  this stays a pure function of the ladder position. */
export function trialGoal(trial: number): bigint {
  if (trial <= WIN_TRIAL) return authoredGoal(trial);
  const override = TRIAL_GOAL_OVERRIDES?.[trial - 1];
  if (override != null) return BigInt(override);
  return endlessGoal(trial);
}

// ---- Shop ------------------------------------------------------------------

export interface RarityWeights {
  common: number;
  uncommon: number;
  rare: number;
}

/** How often each rarity tier is offered. Kept here (rather than in Shop.ts)
 *  so both weight tables sit side by side and can be tuned together. */
export const RARITY_WEIGHTS: RarityWeights = {
  common: 60,
  uncommon: 30,
  rare: 10,
};

/** The boosted odds a shop uses after the player clears a Boss Trial — the
 *  reward for beating the boss is better cards, not just more gold. */
export const BOON_RARITY_WEIGHTS: RarityWeights = {
  common: 25,
  uncommon: 45,
  rare: 30,
};

// ---- Misc ------------------------------------------------------------------

// "Extra number" unlocks 2, then 3, then 4, then stops appearing.
export const MAX_EXTRA_NUMBERS = 3;

export const HALL_SIZE = 10;
