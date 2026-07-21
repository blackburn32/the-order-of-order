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
// than a single geometric ratio. This is the "GENTLE" curve — deaths spread
// evenly across rounds 2-20 with a naive-bot win rate ~18% (a thinking player
// wins more). See src/sim/analyze.ts to redesign and src/sim/validate.ts to
// re-test alternate curves.
export const ROUND_TARGETS: number[] = [
  5, 10, 67, 450, 2_200, 6_400, 15_000, 37_000, 95_000, 250_000,
  480_000, 850_000, 1_400_000, 2_400_000, 4_300_000, 7_600_000,
  13_000_000, 24_000_000, 42_000_000, 77_000_000
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
