// Central tuning knobs for The Order of Order.
//
// The canvas is responsive and resizes to fill the page in either
// orientation — scenes lay themselves out from `scene.scale.width/height`,
// there is no fixed design resolution.

export const ROLLS_PER_ROUND = 20;
export const SHOP_ROLLS = [5, 15];

// Clearing this many rounds wins the game.
export const WIN_ROUND = 10;

// Round survival targets for the 10-round game, hand-authored per round (index =
// round-1). Designed against the balance simulation (src/sim) to a deliberate
// attrition curve rather than a single geometric ratio, because shopping
// creates a highly skewed score distribution that diverges across builds.
//
// Attrition intent (measured on the pooled naive-bot field; a thinking player
// does better):
//   • Rounds 1-3  — gentle on-ramp; ~60% of the field survives to round 4.
//   • Rounds 4-9  — steady wall; ~5% of the whole field is culled at each step.
//   • Round 10    — final wall; culls ~8% of the field, landing a ~22% bot win.
// Deaths land on every round (no single difficulty spike). See
// src/sim/designTargets.ts to redesign the curve and src/sim/validate.ts to
// re-test it against the real survival gate.
export const ROUND_TARGETS: bigint[] = [
  3n,
  19n,
  62n,
  110n,
  200n,
  420n,
  920n,
  2_400n,
  7_400n,
  33_000n,
];

// Legacy geometric-growth constants, kept as the fallback for any round beyond
// the authored table (rounds 1..WIN_ROUND are covered by ROUND_TARGETS above).
export const BASE_TARGET = 5;
export const TARGET_GROWTH = 1.85;

// Optional per-round override table for the survival targets (index = round-1).
// The balance simulation sets this to trial alternate difficulty curves without
// editing ROUND_TARGETS; a null/undefined entry (or a null table) falls back to
// the authored table. The shipping game never sets it.
let ROUND_TARGET_OVERRIDES: (number | null | undefined)[] | null = null;
export function setRoundTargets(
  targets: (number | null | undefined)[] | null,
): void {
  ROUND_TARGET_OVERRIDES = targets;
}

// "Extra number" unlocks 2, then 3, then 4, then stops appearing.
export const MAX_EXTRA_NUMBERS = 3;

export const HALL_SIZE = 10;

// Hard Mode difficulty knobs (unlocked after the first win). Tuned against the
// balance simulation (src/sim/hardMode.ts) so that only ~10% of the pooled
// naive-bot field survives to round 10, versus ~26% on normal. Re-run the sweep
// (`npx tsx src/sim/hardMode.ts`) whenever the item roster changes — new items
// shift the survival curve and this multiplier drifts off the 10% target.
//   • HARD_TARGET_MULT scales every round's survival target (the wall). Because
//     raw dice output is absolute, a higher wall is genuinely harder.
//   • HARD_PRICE_MULT is an *additional* shop-price bump on top of the (already
//     target-scaled) price, so items are relatively pricier than on normal.
export const HARD_TARGET_MULT = 2.25;
export const HARD_PRICE_MULT = 1.25;

// Sim-only runtime overrides for the two Hard Mode multipliers, so the tuning
// script (src/sim/hardMode.ts) can sweep values without editing the shipped
// constants. null = use the shipped constant. The live game never sets these.
let HARD_TARGET_MULT_OVERRIDE: number | null = null;
let HARD_PRICE_MULT_OVERRIDE: number | null = null;
export function setHardMultipliers(target: number | null, price: number | null): void {
  HARD_TARGET_MULT_OVERRIDE = target;
  HARD_PRICE_MULT_OVERRIDE = price;
}
export function hardPriceMult(): number {
  return HARD_PRICE_MULT_OVERRIDE ?? HARD_PRICE_MULT;
}

export function roundTarget(round: number): bigint {
  const override = ROUND_TARGET_OVERRIDES?.[round - 1];
  if (override != null) return BigInt(override);
  const authored = ROUND_TARGETS[round - 1];
  if (authored != null) return authored;
  return BigInt(Math.ceil(BASE_TARGET * Math.pow(TARGET_GROWTH, round - 1)));
}

/** The effective survival target for a round: the base curve on normal, scaled
 *  by HARD_TARGET_MULT on Hard Mode. Uses per-mille math so the fractional
 *  multiplier applies exactly to the bigint target (truncates, like floor). */
export function survivalTarget(round: number, hard: boolean): bigint {
  const base = roundTarget(round);
  if (!hard) return base;
  const mult = HARD_TARGET_MULT_OVERRIDE ?? HARD_TARGET_MULT;
  return (base * BigInt(Math.round(mult * 1000))) / 1000n;
}
