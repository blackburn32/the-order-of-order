export type DieSides = 1 | 2 | 4 | 6 | 8 | 10 | 20 | 100;

export const DIE_LADDER: DieSides[] = [1, 2, 4, 6, 8, 10, 20, 100];

export interface Die {
  sides: DieSides;
  rollplayer: boolean;
  value: number;
}

/** New dice spawn showing their max face rather than blank. */
export function makeDie(sides: DieSides, rollplayer = false): Die {
  return { sides, rollplayer, value: sides };
}

export function rollDie(die: Die, rng: () => number = Math.random): number {
  die.value = 1 + Math.floor(rng() * die.sides);
  return die.value;
}

export function rollAll(dice: Die[], rng: () => number = Math.random): void {
  for (const die of dice) rollDie(die, rng);
}

export function canShrink(die: Die): boolean {
  return die.sides > 1;
}

/** Step a die one rung down the ladder (d100 -> d20 -> ... -> d1). */
export function shrinkDie(die: Die): boolean {
  const i = DIE_LADDER.indexOf(die.sides);
  if (i <= 0) return false;
  die.sides = DIE_LADDER[i - 1];
  die.value = die.sides;
  return true;
}

export function cloneDie(die: Die): Die {
  return { sides: die.sides, rollplayer: die.rollplayer, value: die.sides };
}

/** Compact human summary of a dice grid, e.g. "4×d6, 2×d4, 1×d20". */
export function summarizeDice(dice: { sides: number }[]): string {
  const counts = new Map<number, number>();
  for (const d of dice) counts.set(d.sides, (counts.get(d.sides) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([sides, n]) => `${n}×d${sides}`)
    .join(', ');
}
