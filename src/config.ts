// Central tuning knobs for The Order of Order.
//
// The canvas is responsive and resizes to fill the page in either
// orientation — scenes lay themselves out from `scene.scale.width/height`,
// there is no fixed design resolution.

export const ROLLS_PER_ROUND = 20;
export const SHOP_ROLLS = [5, 15];

// Round survival target: ceil(BASE * GROWTH^(round-1)) -> 5, 10, 18, 32, 59, ...
export const BASE_TARGET = 5;
export const TARGET_GROWTH = 1.85;

// "Extra number" unlocks 2,3,4,5,6 then stops appearing.
export const MAX_EXTRA_NUMBERS = 5;

export const HALL_SIZE = 10;

export function roundTarget(round: number): number {
  return Math.ceil(BASE_TARGET * Math.pow(TARGET_GROWTH, round - 1));
}
