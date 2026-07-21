// Central tuning knobs for The Order of Order.
//
// The canvas is responsive and resizes to fill the page in either
// orientation — scenes lay themselves out from `scene.scale.width/height`,
// there is no fixed design resolution.

export const ROLLS_PER_ROUND = 20;
export const SHOP_ROLLS = [5, 15];

// Clearing this many rounds wins the game.
export const WIN_ROUND = 20;

// Round survival targets, hand-authored per round (index = round-1). Tuned via
// the balance simulation (src/sim) so runs end across the whole game instead of
// piling up at "cleared round 2 = guaranteed win": the score economy grows
// ~8-10x/round early and ~2x/round late, so the targets track that shape rather
// than a single geometric ratio.
//
// Shape ("soft-early"): a gentle on-ramp — rounds 2-3 barely cull, so nearly
// every run that survives round 1 reaches round 3 — easing up through round 9,
// then converging to the steeper mid/late difficulty from round 10 on.
// Naive-bot win rate ~19% (a thinking player wins more); deaths land on every
// round. See src/sim/analyze.ts to redesign and src/sim/validate.ts to re-test.
export const ROUND_TARGETS: number[] = [
  5, 6, 38, 270, 1_500, 5_000, 12_000, 30_000, 77_000, 210_000,
  430_000, 770_000, 1_300_000, 2_200_000, 4_000_000, 7_000_000,
  12_000_000, 22_000_000, 38_000_000, 71_000_000
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
export function setRoundTargets(targets: (number | null | undefined)[] | null): void {
  ROUND_TARGET_OVERRIDES = targets;
}

// "Extra number" unlocks 2, then 3, then stops appearing.
export const MAX_EXTRA_NUMBERS = 2;

export const HALL_SIZE = 10;

export function roundTarget(round: number): number {
  const override = ROUND_TARGET_OVERRIDES?.[round - 1];
  if (override != null) return override;
  const authored = ROUND_TARGETS[round - 1];
  if (authored != null) return authored;
  return Math.ceil(BASE_TARGET * Math.pow(TARGET_GROWTH, round - 1));
}
