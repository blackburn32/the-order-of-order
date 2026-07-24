export type DieSides = 1 | 2 | 4 | 6 | 8 | 10 | 20 | 100;

export const DIE_LADDER: DieSides[] = [1, 2, 4, 6, 8, 10, 20, 100];

/** Resolve the persistent multiplier carried by a max-face die. Item
 *  definitions may still pass `true` for convenience; it is converted to the
 *  card's multiplier when the die is created and then survives shrinking and
 *  copying unchanged. */
export function windfallFactor(
  bonus: number | boolean | undefined,
  initialSides: number,
): number {
  if (typeof bonus === "number") return bonus;
  if (!bonus) return 0;
  return initialSides === 100 ? 4 : 2;
}

export interface Die {
  sides: DieSides;
  // 0 for an ordinary die, otherwise the run multiplier applied when this die's
  // current highest face rolls (Rollplayer ×2, Centurion ×4).
  maxFaceBonus: number;
  loaded: boolean; // never rolls its top two faces
  wildFace: boolean; // scores on every face, not just scoringNumbers
  value: number;
  // The item id that provided this die ('starter' for the run's initial die), so
  // its rolling points can be attributed back to that item over its lifespan. A
  // copy is credited to the item that spawned it (mult, Genesis, Foundry, Twin,
  // Double the Fun), not the die it was copied from.
  source: string;
}

export interface DieOpts {
  maxFaceBonus?: boolean | number;
  loaded?: boolean;
  wildFace?: boolean;
}

/** New dice spawn showing their max face rather than blank. `source` is the item
 *  id that granted the die ('starter' for the run's initial die). */
export function makeDie(
  sides: DieSides,
  opts: DieOpts = {},
  source = "starter",
): Die {
  return {
    sides,
    maxFaceBonus: windfallFactor(opts.maxFaceBonus, sides),
    loaded: opts.loaded ?? false,
    wildFace: opts.wildFace ?? false,
    value: sides,
    source,
  };
}

export function rollDie(die: Die, rng: () => number = Math.random): number {
  // Loaded dice never show their top two faces (floored at a single face so a
  // loaded d2 always rolls 1).
  const faces = die.loaded ? Math.max(1, die.sides - 2) : die.sides;
  die.value = 1 + Math.floor(rng() * faces);
  return die.value;
}

export function rollAll(dice: Die[], rng: () => number = Math.random): void {
  for (const die of dice) rollDie(die, rng);
}

export function canShrink(die: Die): boolean {
  return die.sides > 1;
}

export function canLoad(die: Die): boolean {
  return die.sides > 1 && !die.loaded;
}

/** Step a die one rung down the ladder (d100 -> d20 -> ... -> d1). */
export function shrinkDie(die: Die): boolean {
  const i = DIE_LADDER.indexOf(die.sides);
  if (i <= 0) return false;
  die.sides = DIE_LADDER[i - 1];
  die.value = die.sides;
  return true;
}

/** Copy a die. `source` credits the copy to the item that spawned it; when
 *  omitted the copy keeps the original die's source. */
export function cloneDie(die: Die, source?: string): Die {
  return {
    sides: die.sides,
    maxFaceBonus: die.maxFaceBonus,
    loaded: die.loaded,
    wildFace: die.wildFace,
    value: die.sides,
    source: source ?? die.source,
  };
}

/** Compact human summary of a dice grid, e.g. "4×d6, 2×d4, 1×d20". */
export function summarizeDice(dice: { sides: number }[]): string {
  const counts = new Map<number, number>();
  for (const d of dice) counts.set(d.sides, (counts.get(d.sides) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([sides, n]) => `${n}×d${sides}`)
    .join(", ");
}
