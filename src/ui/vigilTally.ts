import type { DiceStack } from "../systems/DicePool";
import { scoresKey, type VigilGroup } from "../systems/GrowthEngines";

/** How many times a die carrying `scores` has scored under The Vigil. */
export function vigilScored(scores: readonly number[]): number {
  return scores.reduce((sum, count) => sum + count, 0);
}

/** log10 of the growth `scores` carries: each score at p% grows the die's
 *  points by (100+p)/100. Kept as a logarithm because a long vigil runs past
 *  what a float can hold. */
export function vigilGrowthLog10(scores: readonly number[]): number {
  let log = 0;
  scores.forEach((count, percent) => {
    if (count > 0) log += count * Math.log10(1 + percent / 100);
  });
  return log;
}

/** A growth factor for a tooltip: "×1.48" up to a thousand, then "×2.3e5". */
export function formatVigilGrowth(log10: number): string {
  if (log10 < 3) {
    return `×${parseFloat((10 ** log10).toFixed(2))}`;
  }
  const exponent = Math.floor(log10);
  let mantissa = parseFloat((10 ** (log10 - exponent)).toFixed(1));
  let shown = exponent;
  if (mantissa >= 10) {
    mantissa /= 10;
    shown += 1;
  }
  return `×${mantissa}e${shown}`;
}

/** The Vigil's tallies among `stacks` that `match` keeps, one group per
 *  distinct tally — stacks of one kind that came from different cards still
 *  merge when they have scored alike. Dice with no tally are left out. */
export function vigilGroups(
  stacks: Iterable<DiceStack>,
  match: (stack: DiceStack) => boolean = () => true,
): VigilGroup[] {
  const groups = new Map<string, VigilGroup>();
  for (const stack of stacks) {
    const key = scoresKey(stack.scores);
    if (!key || stack.count <= 0 || !match(stack)) continue;
    const group = groups.get(key);
    if (group) group.count += stack.count;
    else groups.set(key, { scores: [...stack.scores!], count: stack.count });
  }
  return [...groups.values()];
}
