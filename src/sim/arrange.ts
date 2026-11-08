// How the headless player stands its radius dice (systems/RadiusDice) on the
// grid — what a player does by hand with the drag-to-rearrange tool.
//
// A radius die is worth what it reaches, so the rule is a greedy one a player
// could follow by eye:
//
//   1. Each Censer takes the open cell that reaches the most dice, and the dice
//      whose specials a Censer sets off (windfalls, sealed sizes, the other
//      radius dice) are gathered into the cells around it, nearest first.
//   2. Each Halo, then each Grace, takes the open cell that reaches the most
//      dice — next to a Censer if one has room for it, since a Censer that
//      turns a Halo up has made it fire.
//   3. Every other die keeps its order in the cells left over.
//
// The inert head an affliction strikes is not modelled: it is a handful of
// dice at the front, and the best cells are in the middle.

import type { DicePool } from "../systems/DicePool";
import type { Die } from "../systems/Dice";
import { radiusKindOf, radiusNeighbours } from "../systems/RadiusDice";

/** Whether a Censer would set this die off. */
function censerTarget(die: Die, sealed: readonly number[]): boolean {
  return (
    !die.loaded &&
    (die.maxFaceBonus > 0 ||
      sealed.includes(die.sides) ||
      radiusKindOf(die) !== null)
  );
}

/**
 * Rearrange `pool` so its radius dice reach as much as they can. A no-op on a
 * grid with no radius dice, or one that cannot be rearranged (a bucketed grid,
 * or one die). `sealed` is the run's Royal Seal sizes.
 */
export function arrangeRadiusDice(
  pool: DicePool,
  sealed: readonly number[] = [],
): void {
  if (!pool.reorderable) return;
  const n = pool.length;
  const dice: Die[] = [];
  let any = false;
  for (let i = 0; i < n; i++) {
    const die = pool.dieAt(i)!;
    dice.push(die);
    if (radiusKindOf(die)) any = true;
  }
  if (!any) return;

  const cols = pool.radiusCols;
  const reach = Array.from({ length: n }, (_, slot) =>
    radiusNeighbours(slot, n, cols),
  );
  const rows = Math.ceil(n / cols);
  const centre = { col: (cols - 1) / 2, row: (rows - 1) / 2 };
  const off = (slot: number) =>
    Math.hypot(
      (slot % cols) - centre.col,
      Math.floor(slot / cols) - centre.row,
    );

  const order = new Array<number>(n).fill(-1); // slot -> die index
  const placed = new Set<number>();
  const put = (slot: number, die: number) => {
    order[slot] = die;
    placed.add(die);
  };
  const open = (slot: number) => order[slot] === -1;
  /** The open cell reaching the most cells, nearest the middle on a tie,
   *  preferring `near` cells when any are open. */
  const bestSlot = (near?: ReadonlySet<number>): number => {
    let best = -1;
    let bestKey = -Infinity;
    for (let slot = 0; slot < n; slot++) {
      if (!open(slot)) continue;
      const key =
        (near?.has(slot) ? 1000 : 0) + reach[slot].length - off(slot) * 1e-3;
      if (key > bestKey) {
        bestKey = key;
        best = slot;
      }
    }
    return best;
  };

  const ofKind = (kind: string) =>
    dice.flatMap((d, i) => (radiusKindOf(d) === kind ? [i] : []));
  const censerReach = new Set<number>();

  for (const censer of ofKind("censer")) {
    const slot = bestSlot(censerReach);
    put(slot, censer);
    for (const j of reach[slot]) censerReach.add(j);
    // Gather the dice it sets off around it, nearest cells first. Radius dice
    // are left for step 2, which puts them in reach on its own terms.
    const around = reach[slot]
      .filter(open)
      .sort(
        (a, b) =>
          Math.hypot(
            (a % cols) - (slot % cols),
            Math.floor(a / cols) - Math.floor(slot / cols),
          ) -
          Math.hypot(
            (b % cols) - (slot % cols),
            Math.floor(b / cols) - Math.floor(slot / cols),
          ),
      );
    const specials = dice.flatMap((d, i) =>
      !placed.has(i) && radiusKindOf(d) === null && censerTarget(d, sealed)
        ? [i]
        : [],
    );
    for (let k = 0; k < Math.min(around.length, specials.length); k++)
      put(around[k], specials[k]);
  }
  for (const kind of ["halo", "grace"]) {
    for (const die of ofKind(kind)) {
      if (placed.has(die)) continue;
      put(bestSlot(censerReach), die);
    }
  }

  // Everyone else, in the order they stood.
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (placed.has(i)) continue;
    while (!open(next)) next++;
    put(next, i);
  }
  pool.arrange(order);
}
