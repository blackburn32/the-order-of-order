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
// whole ladder (1..30 for ranks 1-10, then 31+ in endless). Rank and
// trial-within-rank are derived from it rather than stored, so every consumer
// that just wants "how far did they get" — the Hall, the leaderboard, unlock
// criteria, the sim's trajectories — keeps working off one number.
//
// The ladder is told in four acts, each pinned to a Boss Trial that ends in a
// story sequence (see systems/Endings): the King's messenger at rank 3, the
// Betrayal at rank 6, the summons at rank 9, and the duel against the Order of
// Disorder at rank 10. The acts fall every three ranks, so the story arrives on
// a fixed beat rather than whenever the ladder happens to allow it. Only the
// last of them is the finish line; the first two hand the player a standing
// drawback and send them on, and the third only sets the table for the duel.

export const TRIALS_PER_RANK = 3;

/** Clearing this rank's Boss Trial wins the game. Past it the run only
 *  continues if the player chose to go endless. */
export const WIN_RANK = 10;
export const WIN_TRIAL = WIN_RANK * TRIALS_PER_RANK; // 30

/** Rolls granted by each trial in a rank, indexed by `trialInRank() - 1`. The
 *  Lesser Trial is deliberately the shortest: it is a sprint against a small
 *  goal, not a gentler version of the same thing. */
export const ROLLS_PER_TRIAL = [7, 14, 18] as const;
export type TrialRollCadence = readonly [number, number, number];

// Simulation-only override for duration experiments. Shipping code never sets
// this; keeping the hook beside the goal override lets balance tools compare
// cadences while every real roll-budget consumer still uses one shared rule.
let SIM_ROLLS_PER_TRIAL: TrialRollCadence | null = null;

export function setTrialRollCadenceForSimulation(
  cadence: TrialRollCadence | null,
): void {
  SIM_ROLLS_PER_TRIAL = cadence;
}

/**
 * The duel's roll budget, fixed.
 *
 * The final Boss Trial is not a score to reach but a race against a copy of the
 * player's own grid, and a race that runs eighteen rolls is decided long before it
 * ends: two identical engines compounding side by side settle into their gap
 * early and then simply widen it. Ten rolls keeps the lead inside the range a
 * single roll can overturn, so the last trial of a run stays live to its last
 * throw.
 *
 * It is a flat count rather than a base, and `Trial.trialRollTargetFor` returns
 * it without consulting anything else: Metronome, Overtime, Rain Check and every
 * affliction that moves a roll budget are all ignored here. That is deliberate.
 * The duel is the one trial whose fairness is a property of construction (see
 * systems/Rival), and rolls are the one resource the mirror cannot copy — a
 * player walking in with five bought rolls would be handed five rolls the Order
 * of Disorder never gets.
 */
export const MIRROR_TRIAL_ROLLS = 10;

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

/** The final Boss Trial, which is not a goal at all but a duel against an exact
 *  copy of the player's own grid (see systems/Rival). Everything that gates on
 *  "did they clear it" has to ask this first, because on this trial the answer
 *  is a comparison rather than a threshold. */
export function isMirrorTrial(trial: number): boolean {
  return trial === WIN_TRIAL;
}

export function trialName(trial: number): string {
  return TRIAL_NAMES[trialInRank(trial) - 1];
}

/** Base rolls for a trial, before Metronome/Overtime and any boss modifier. */
export function rollsForTrial(trial: number): number {
  return (SIM_ROLLS_PER_TRIAL ?? ROLLS_PER_TRIAL)[trialInRank(trial) - 1];
}

// ---- Goal curve ------------------------------------------------------------
//
// Score goals for every trial of the ladder (index = trial - 1), designed
// against the balance simulation (src/sim/smartSurvivalCurve.ts) rather than by a
// single geometric ratio, because shopping creates a wildly skewed score
// distribution that diverges across builds.
//
// The tuner designs each goal from UNCENSORED capacity: it replays the field one
// trial at a time with that trial playing its whole roll budget out, so what it
// samples is what each build COULD have scored rather than what the previous
// goal let it stop at. The goal is then the quantile that lands on an explicit
// absolute survival schedule. Front to back, so each rank is designed against
// the shops the ranks before it could actually afford.
//
// Attrition intent on the coherent, fully unlocked smart field — weak/base-pool
// builds remain in the report, but do not set the goals:
//   rank 1 — ~65%  the first three trials now form a real onboarding ramp
//   rank 2 — ~62%  the learning runway continues to climb
//   rank 3 — ~57%  the King's messenger
//   rank 6 — ~36%  the Betrayal
//   rank 9 — ~9%   the summons; these builds enter the final rank
// The final duel then decides how many of that cohort actually win.
//
// The curve SAWTOOTHS, and that is deliberate: a rank opens with a seven-roll
// Lesser Trial and closes with an eighteen-roll Boss Trial, so the Lesser Trial of
// rank 3 asks for less than the Boss Trial of rank 2. What rises from rank to
// rank is each slot against the same slot.
//
// Trial 1 remains the smallest score the rules can express. From there the
// opening rises every trial: onboarding still has a gentler slope than the late
// ladder, but no clear after the first is handed out at the minimum goal.
//
// See src/sim/smartSurvivalCurve.ts to redesign this schedule and
// src/sim/validate.ts to re-test it against the real survival gate.
//
// Ranks 4 through 8 were designed against the APPRAISING bot — the one strategy
// that measures what it buys and aims the cards that need a die (sim/expert.ts)
// — because the price-and-theme field the earlier curve came from left them 10
// to 14 points slacker than the survival schedule intends for anyone playing
// well: it walked into rank 5 with 60% of its runs alive against a target of
// 49%, and into rank 8 with 36% against 26%.
//
//   FIELD=expert RUNS=200 node node_modules/tsx/dist/cli.mjs src/sim/smartSurvivalCurve.ts
//
// Ranks 1 to 3 keep the goals they had. The expert was only a few points loose
// there, the opening's real difficulty is trial 1's single d6 rather than any
// number in this table, and the designed alternative asked five times as much on
// trial 3 — which nearly doubled rank-1 deaths for builds that shop by price,
// i.e. for a person still learning what the cards do.
//
// Ranks 9 and 10 keep the SHAPE they had, scaled by the factor rank 8 moved
// (x44). By then the design pass was setting goals from 15 to 35 surviving runs,
// where the quantile it takes is barely more than one lucky run's ceiling — it
// proposed raising the last trial a millionfold — and the live endgame was
// already landing on target for the expert anyway. Measure while the sample is
// thick; continue by formula once it is not.
const AUTHORED_GOALS: bigint[] = [
  // rank 1 — a short onboarding ramp
  1n,
  2n,
  3n,
  // rank 2
  5n,
  12n,
  30n,
  // rank 3 — closes on the King's messenger
  60n,
  120n,
  280n,
  // rank 4 — from here the curve is the appraising bot's
  800n,
  4_100n,
  11_000n,
  // rank 5
  9_300n,
  53_000n,
  110_000n,
  // rank 6 — closes on the Betrayal
  89_000n,
  200_000n,
  580_000n,
  // rank 7
  160_000n,
  2_500_000n,
  41_000_000n,
  // rank 8
  50_000_000n,
  100_000_000n,
  4_000_000_000n,
  // rank 9 — closes on the summons; the live shape, scaled by rank 8's move
  6_700_000_000n,
  80_000_000_000n,
  1_700_000_000_000n,
  // rank 10 — the last rank; its Boss Trial is the duel, which has no goal at
  // all (see isMirrorTrial). The entry is still a real number because the
  // endless ladder walks out from it.
  890_000_000_000n,
  1_300_000_000_000n,
  760_000_000_000_000n,
];

// The authored table covers the whole ladder, so the formula below is only
// reached if WIN_RANK is raised past it. Both numbers are read straight off the
// measured curve so that an eleventh rank would continue the shape rather than
// restart it:
//
//   RANK_RATIO — how much a rank's Boss Trial asks over the last one's. The
//     the late smart-field curve grows sharply as it selects its final cohort.
//   SLOT_SHARE — each trial's goal as a fraction of its OWN rank's Boss Trial.
//     The last measured rank is approximately 0.004 / 0.047 / 1.
//
// Taking the shares off the rank's own boss is what preserves the sawtooth: a
// rank opens on a seven-roll Lesser Trial asking for an eighth of what its
// eighteen-roll Boss Trial will, so the Lesser Trial of rank 8 asks less than the
// Boss Trial of rank 7.
const RANK_RATIO = 447n;
const SLOT_SHARE_MILLI = [4n, 46n, 1_000n] as const;

/** The authored ranks, extended by formula if WIN_RANK ever outruns them. */
function buildGoals(): bigint[] {
  const goals = [...AUTHORED_GOALS];
  const authoredRanks = AUTHORED_GOALS.length / TRIALS_PER_RANK;
  let boss = AUTHORED_GOALS[AUTHORED_GOALS.length - 1];
  for (let rank = authoredRanks + 1; rank <= WIN_RANK; rank++) {
    boss *= RANK_RATIO;
    for (const share of SLOT_SHARE_MILLI) {
      goals.push((boss * share) / 1_000n);
    }
  }
  return goals;
}

export const TRIAL_GOALS: bigint[] = buildGoals();

// Endless growth past WIN_TRIAL. A flat geometric ratio can be outrun forever,
// because builds themselves grow geometrically (3^prism, 4^lastCall compound
// every roll). So the growth RATE itself grows: each trial past the win is
// multiplied by ENDLESS_BASE raised to a power that climbs with distance. That
// guarantees the goal eventually outpaces any build and the run ends.
//
//   goal(t) = goal(t-1) × ENDLESS_BASE^(1 + (t - 1 - WIN_TRIAL) × ENDLESS_ACCEL)
//
// The base is the ladder's own growth carried forward: the tuned curve grows
// 15.5x per rank, which is 2.5x per trial, so endless opens at the rate the run
// was already climbing rather than handing the player three easy trials as a
// reward for finishing.
export const ENDLESS_BASE = 2.5;
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

/** How heavily a cursed card is drawn against an ordinary card in the same
 * rarity tier. Rarity chooses the tier; this chooses the card within it. */
export const CURSE_DRAW_WEIGHT = 0.4;

/** A curse is an event, not a shelf theme. This cap applies independently to
 * each shop row and booster reveal. */
export const MAX_CURSES_PER_OFFER_SET = 1;

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
