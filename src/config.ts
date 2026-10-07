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
 *  goal, not a gentler version of the same thing. The Greater and Boss Trials
 *  share a budget of ten: a longer trial mostly hands a strong build more rolls
 *  to compound over, which is what let the old 14 / 18 cadence be cleared on
 *  its opening roll. */
export const ROLLS_PER_TRIAL = [7, 10, 10] as const;
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
 * player's own grid, and a long race is decided long before it ends: two
 * identical engines compounding side by side settle into their gap early and
 * then simply widen it. Ten rolls keeps the lead inside the range a single roll
 * can overturn, so the last trial of a run stays live to its last throw. It is
 * the same ten every Boss Trial grants, but it is fixed separately because
 * nothing may move it (below).
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
// The goals are MEASURED, not derived from a formula, and fitted to a survival
// curve: the share of runs still alive at the end of each rank. The curve is
// pinned at four checkpoints — about 70% of runs get through rank 1, 40%
// through rank 3, 20% through rank 6 (just before the defectors), and 5% win
// at rank 10 — so a casual player sees a good part of the ladder and the
// finish stays a hard ceiling. Between checkpoints survival falls by the same
// factor every rank, and a rank's losses lean on its Boss Trial.
//
// `npm run goals:tune` (src/sim/goalTune.ts) fits the table against a grid of
// 43 bot strategies — every shopping bot, at three curse appetites — over
// hundreds of seeds with real culling. Trial by trial, it plays every run that
// reaches the trial against an unreachable goal to see what each could score
// there, and sets the goal at the score the wanted share of them reach,
// rounded to three significant figures. The last goal is fitted to the win
// rate itself, since the duel decides who reaching it wins.
//
// Rank 1 is authored, not fitted: 1, 2 and 3 points. The opening's difficulty
// is the lone starting d6, which by itself ends nearly 30% of runs in trial 1,
// so rank 1 lands a little under its 70% checkpoint (about 63%) and the later
// ranks are fitted from whoever it leaves alive.
//
// A goal is never lower than the trial before it in its own rank, nor than the
// same slot a rank down. A rank opens on a seven-roll Lesser Trial, so it can
// still ask less than the ten-roll Boss Trial that closed the rank before it.
//
// To retune: move the checkpoints (`CHECKPOINTS="1=0.7,3=0.4,6=0.2,10=0.05"`),
// rerun the fit, paste the printed table here, and grade it on held-out seeds
// with `goals:validate`. See src/sim/README.md, "Fitting a survival curve".

/** The share of runs meant to be alive after each checkpoint rank (rank 10's is
 *  the win rate) — the record of how MEASURED_GOALS was fitted, not an input to
 *  anything at runtime. */
export const SURVIVAL_CHECKPOINTS = {
  1: 0.7,
  3: 0.4,
  6: 0.2,
  10: 0.05,
} as const;

/**
 * The goal for every trial of the ladder (index = trial - 1), as decimal
 * strings so a retuned table whose late goals pass Number's exact integer range
 * pastes in unchanged. Lesser / Greater / Boss across each row. The final
 * entry is the duel's, which has no goal at all (see isMirrorTrial); it is
 * still a real number because the endless ladder walks out from it.
 */
// prettier-ignore
const MEASURED_GOALS: readonly string[] = [
  "1", "2", "3",                              // rank 1
  "5", "25", "47",                            // rank 2
  "42", "96", "181",                          // rank 3
  "125", "329", "616",                        // rank 4
  "588", "1370", "2540",                      // rank 5
  "2650", "6960", "15300",                    // rank 6
  "8310", "13000", "19900",                   // rank 7
  "24000", "58500", "134000",                 // rank 8
  "159000", "315000", "716000",               // rank 9
  "822000", "9100000", "100100000",           // rank 10
];

export const TRIAL_GOALS: bigint[] = MEASURED_GOALS.map((g) => BigInt(g));

// ---- The previous curve, kept for the engine experiment ----------------------
//
// Before the measured table, winning was gated on an ENGINE (a strategy tree's
// tier-3 card): the goal PER ROLL grew by a fixed factor every trial — ×1.6
// through rank 3, ×2.2 through rank 6, ×2.4 to the duel — placed below a
// finished engine's growth and above everything else. src/sim/catechismExperiment.ts
// still sweeps those rates through `engineGateGoals`; nothing ships them.

/** Rank 1's goals under the engine-gated curve. */
const OPENING_GOALS = [1, 2, 3] as const;

/** Growth of the goal per roll, per trial, in each act after rank 1. */
export const GOAL_GROWTH_PER_TRIAL = {
  /** Ranks 2-3. */
  opening: 1.6,
  /** Ranks 4-6, the build deadline. */
  middle: 2.2,
  /** Ranks 7-10. */
  late: 2.4,
} as const;

/**
 * The engine-gated goal for every trial of the ladder (index = trial - 1), for
 * experiments that compare against it.
 *
 * Only multiplication and ceil touch the floats, both exactly specified by
 * IEEE 754, so every device derives the same table (unlike Math.pow — see the
 * endless ladder below).
 */
export function engineGateGoals(
  middle: number = GOAL_GROWTH_PER_TRIAL.middle,
  late: number = GOAL_GROWTH_PER_TRIAL.late,
): number[] {
  const goals: number[] = [...OPENING_GOALS];
  let perRoll = goals[goals.length - 1] / rollsForTrial(goals.length);
  for (let trial = goals.length + 1; trial <= WIN_TRIAL; trial++) {
    const rank = rankOf(trial);
    perRoll *=
      rank <= 3 ? GOAL_GROWTH_PER_TRIAL.opening : rank <= 6 ? middle : late;
    goals.push(Math.max(1, Math.ceil(perRoll * rollsForTrial(trial))));
  }
  return goals;
}

// Endless growth past WIN_TRIAL. A flat geometric ratio can be outrun forever,
// because builds themselves grow geometrically (3^prism, 4^lastCall compound
// every roll). So the growth RATE itself grows: each trial past the win is
// multiplied by ENDLESS_BASE raised to a power that climbs with distance. That
// guarantees the goal eventually outpaces any build and the run ends.
//
//   goal(t) = goal(t-1) × ENDLESS_BASE^(1 + (t - 1 - WIN_TRIAL) × ENDLESS_ACCEL)
//
// The base is about the ladder's own late growth carried forward (the measured
// goals grow roughly ×2.5-×4 a trial through ranks 7-10), so endless opens at
// about the rate the run was already climbing rather than handing the player
// three easy trials as a reward for finishing.
//
// Base and acceleration are held as exact integer quantities rather than as the
// floats they read as, because this multiplier has to come out bit-for-bit
// identical on every engine the game runs on. A run is replayed from its seed,
// and `Math.pow` is only implementation-APPROXIMATED by the spec: two devices
// may disagree about it, and a goal that differs by one is a trial that cleared
// on one device and failed on the other. See `endlessMultiplierMilli`.
const ENDLESS_BASE_NUM = 5n;
const ENDLESS_BASE_DEN = 2n;
/** The reciprocal of ENDLESS_ACCEL: the exponent climbs by 1/this per trial. */
const ENDLESS_ACCEL_DEN = 20;

export const ENDLESS_BASE = Number(ENDLESS_BASE_NUM) / Number(ENDLESS_BASE_DEN); // 2.5
export const ENDLESS_ACCEL = 1 / ENDLESS_ACCEL_DEN; // 0.05

// Optional per-trial override table for the goals (index = trial - 1). The
// balance simulation sets this to trial alternate difficulty curves without
// editing TRIAL_GOALS; a null/undefined entry (or a null table) falls back to
// the authored table. The shipping game never sets it.
let TRIAL_GOAL_OVERRIDES: (number | bigint | null | undefined)[] | null = null;
export function setTrialGoals(
  goals: (number | bigint | null | undefined)[] | null,
): void {
  TRIAL_GOAL_OVERRIDES = goals;
  ENDLESS_CACHE.length = 0;
}

// Endless goals are computed by walking out from the last authored trial, so
// they are memoized rather than recomputed on every HUD update.
const ENDLESS_CACHE: bigint[] = [];

/** Fixed-point scale for the irrational root below. Thirty digits is far more
 *  than a per-mille answer needs; it costs nothing and keeps the one truncation
 *  in this file thirty orders of magnitude away from any rounding boundary. */
const ROOT_SCALE_DIGITS = 30n;
const ROOT_SCALE = 10n ** ROOT_SCALE_DIGITS;

/** floor(x ** (1/n)) by Newton's method on integers — no floats to disagree
 *  about, and it converges in a handful of steps at any scale used here. */
function integerRoot(x: bigint, n: bigint): bigint {
  if (x < 2n) return x;
  let guess = 1n << (BigInt(x.toString(2).length) / n + 1n);
  for (;;) {
    const next = ((n - 1n) * guess + x / guess ** (n - 1n)) / n;
    if (next >= guess) break;
    guess = next;
  }
  while (guess ** n > x) guess -= 1n;
  while ((guess + 1n) ** n <= x) guess += 1n;
  return guess;
}

/** ENDLESS_BASE ** (1 / ENDLESS_ACCEL_DEN), scaled by ROOT_SCALE. The only
 *  irrational quantity in the ladder, so the only one that has to be truncated
 *  rather than computed exactly. Derived once, and lazily: a run that never
 *  reaches endless never pays for it. */
let accelRoot: bigint | null = null;
function endlessAccelRoot(): bigint {
  if (accelRoot === null) {
    const d = BigInt(ENDLESS_ACCEL_DEN);
    // Wanted: R with (R / SCALE) ** d === base, so R === (base * SCALE ** d) ** (1/d).
    accelRoot = integerRoot(
      (ENDLESS_BASE_NUM * ROOT_SCALE ** d) / ENDLESS_BASE_DEN,
      d,
    );
  }
  return accelRoot;
}

/**
 * The growth multiplier for the `step`-th endless trial (0 being the first past
 * WIN_TRIAL), as a per-mille integer — what `ENDLESS_BASE ** (1 + step / 20)`
 * used to be computed as in floating point.
 *
 * The exponent is split into a whole part and a fractional one. With
 * `m = d + step`, `q = floor(m / d)` and `s = m mod d`:
 *
 *     base ** (m / d) === (num / den) ** q  ×  root ** s
 *
 * The left factor is exact bigint arithmetic; the right is at most `d - 1`
 * multiplications of the scaled root. So the whole multiplier is a single
 * rounding of a single exact rational, and identical everywhere.
 */
function endlessMultiplierMilli(step: number): bigint {
  const d = ENDLESS_ACCEL_DEN;
  const m = d + step;
  const q = BigInt(Math.floor(m / d));
  const s = BigInt(m % d);
  const numerator = ENDLESS_BASE_NUM ** q * endlessAccelRoot() ** s * 1000n;
  const denominator = ENDLESS_BASE_DEN ** q * ROOT_SCALE ** s;
  // Round half up, matching the Math.round this replaced.
  return (2n * numerator + denominator) / (2n * denominator);
}

function endlessGoal(trial: number): bigint {
  let value =
    ENDLESS_CACHE[ENDLESS_CACHE.length - 1] ?? authoredGoal(WIN_TRIAL);
  for (let t = WIN_TRIAL + ENDLESS_CACHE.length + 1; t <= trial; t++) {
    // Per-mille integer math so the fractional growth applies exactly to the
    // bigint goal (truncates, like floor).
    value = (value * endlessMultiplierMilli(t - 1 - WIN_TRIAL)) / 1000n;
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
