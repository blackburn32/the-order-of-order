// The radius dice: three dice whose top face reaches out to the dice around
// them on the grid. They are what makes the order of the grid worth arranging
// by hand (see DicePool.move): where one stands decides which dice it touches.
//
//   The Halo   (d8)  — the scoring dice in its reach score ×4.
//   Grace      (d6)  — the dice in its reach that missed, itself included, roll
//                      once more.
//   The Censer (d12) — the dice in its reach that have a top-face special are
//                      turned to their top face, so the special goes off.
//
// Like A New Voice's dice, a radius die is known by the card that added it (its
// `source`), not by a flag of its own: a copy another card makes of one is that
// card's plain die. Its rule survives shrinking and growing, as a windfall does
// — it fires on whatever its top face now is.
//
// Reach is measured on the grid as the player sees it. Dice are laid out in
// rows of `cols` from the top left (see ui/windowedGrid), one cell apart, and
// a die's body fills most of its cell. A radius die's circle is centred on it
// and reaches two cells out — through the centres of the dice two away — and
// every die whose body the circle touches at all is in reach: the 5×5 block
// around the die, less its four far corners.
//
// Everything here works on a plain `Die[]` in grid order, so the pool's per-die
// roll and any test harness share one definition. A bucketed grid (thousands of
// dice) has no positions, and its radius dice roll as plain dice.

import type { Die, DieSides } from "./Dice";
import { faceRange } from "./Dice";

export type RadiusKind = "halo" | "grace" | "censer";

export interface RadiusDieDef {
  kind: RadiusKind;
  /** The card that adds the die, which is also how the die is recognised. */
  source: string;
  /** The size it is bought at. */
  sides: DieSides;
  name: string;
  /** The circle's colour on the grid, and the die's shade. */
  color: number;
}

export const RADIUS_DICE: Record<RadiusKind, RadiusDieDef> = {
  halo: {
    kind: "halo",
    source: "the_halo",
    sides: 8,
    name: "The Halo",
    color: 0x7fe3f0,
  },
  grace: {
    kind: "grace",
    source: "the_grace",
    sides: 6,
    name: "Grace",
    color: 0xf28cc0,
  },
  censer: {
    kind: "censer",
    source: "the_censer",
    sides: 12,
    name: "The Censer",
    color: 0xb48cff,
  },
};

export const RADIUS_KINDS: RadiusKind[] = ["halo", "grace", "censer"];

/** The Halo's factor on each scoring die in its reach, per Halo. */
export const HALO_FACTOR = 4;

/** How far a radius die reaches, in grid cells from its centre. */
export const RADIUS_CELLS = 2;

/** Half a die body's width, as a fraction of its cell (a die is drawn at about
 *  0.83 of its cell — see ui/windowedGrid's scale). */
export const DIE_HALF_CELL = 0.415;

const KIND_BY_SOURCE = new Map<string, RadiusKind>(
  RADIUS_KINDS.map((kind) => [RADIUS_DICE[kind].source, kind]),
);

export function radiusKindOf(die: { source: string }): RadiusKind | null {
  return KIND_BY_SOURCE.get(die.source) ?? null;
}

/** Columns the grid lays `n` dice out in, for a frame of the given aspect
 *  (width / height). The one formula the grid's layout and the radius dice
 *  both read, so the dice a circle is drawn around are the dice it reaches. */
export function gridColumnsFor(n: number, aspect: number): number {
  const dice = Math.max(1, n);
  const a = Math.max(1e-3, aspect);
  return Math.min(dice, Math.max(1, Math.ceil(Math.sqrt(dice * a))));
}

/** Whether a die body centred `dx`, `dy` cells away is touched by a circle of
 *  RADIUS_CELLS. */
function touched(dx: number, dy: number): boolean {
  const nx = Math.max(0, Math.abs(dx) - DIE_HALF_CELL);
  const ny = Math.max(0, Math.abs(dy) - DIE_HALF_CELL);
  return nx * nx + ny * ny <= RADIUS_CELLS * RADIUS_CELLS;
}

/** The (dx, dy) cell offsets a circle reaches, itself excluded. */
export const RADIUS_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const reach = Math.ceil(RADIUS_CELLS + DIE_HALF_CELL);
  const out: [number, number][] = [];
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++)
      if ((dx !== 0 || dy !== 0) && touched(dx, dy)) out.push([dx, dy]);
  return out;
})();

/** The grid indices a radius die at `index` reaches, itself excluded, in a grid
 *  of `n` dice laid out `cols` wide. */
export function radiusNeighbours(
  index: number,
  n: number,
  cols: number,
): number[] {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const out: number[] = [];
  for (const [dx, dy] of RADIUS_OFFSETS) {
    const c = col + dx;
    const r = row + dy;
    if (c < 0 || c >= cols || r < 0) continue;
    const j = r * cols + c;
    if (j < n) out.push(j);
  }
  return out.sort((a, b) => a - b);
}

/** One radius die going off. */
export interface RadiusFiring {
  index: number;
  kind: RadiusKind;
  /** The dice in its reach (itself excluded), live ones only. */
  reach: number[];
  /** For a die a Censer turned up: the Censer that did it. */
  by?: number;
}

/** What the radius dice did on one roll, for scoring and for the grid. */
export interface RadiusReport {
  cols: number;
  /** In the order they went off: Censers first, then Grace, then Halos. */
  fired: RadiusFiring[];
  /** Dice a Censer turned to their top face, with the face they showed. */
  stirred: { index: number; from: number }[];
  /** Dice Grace rolled again, with the face they first showed. */
  rerolled: { index: number; from: number }[];
  /** Grid index -> how many firing Halos reach it. */
  halo: Map<number, number>;
}

export interface RadiusRules {
  /** Whether a die scores as it stands (the pool's own scoring test). */
  scores: (die: Die) => boolean;
  /** Whether a die carries a special that goes off on its top face beyond
   *  being a radius die (a windfall, a sealed size). */
  topSpecial: (die: Die) => boolean;
  /** Roll one die again, under the run's face rules. */
  reroll: (die: Die) => void;
}

/** A die's highest face, as its loading allows. */
function topFace(die: Die): number {
  return faceRange(die.sides, die.loaded)[1];
}

/** Whether a radius die is showing the face that sets it off. A loaded die
 *  never shows its top face, so a loaded radius die never fires. */
export function radiusFires(die: Die): boolean {
  return !die.loaded && die.value === die.sides;
}

/** Whether any die in `dice` is a radius die (the cheap check that lets a grid
 *  without one skip the pass entirely). */
export function hasRadiusDice(dice: readonly Die[]): boolean {
  for (const d of dice) if (KIND_BY_SOURCE.has(d.source)) return true;
  return false;
}

/**
 * Resolve the radius dice on a grid whose dice have just rolled, mutating the
 * faces the Censer and Grace change. `live` is the first live index: the dice
 * before it are the grid's inert head, which nothing reaches and which never
 * fire. Returns null when no radius die went off.
 *
 * The order is fixed so a roll is replayable: every Censer showing its top face
 * goes off, and each die it turns up that is itself a Censer goes off in turn;
 * then every Grace showing its top face rolls the dice in its reach that missed,
 * once each however many Graces reach them; then every Halo showing its top
 * face (a Grace may have just rolled it there) marks the dice it reaches. A die
 * Grace rolls onto a Censer's or a Grace's top face does not set it off: each
 * of those has already had its turn.
 */
export function resolveRadius(
  dice: Die[],
  cols: number,
  live: number,
  rules: RadiusRules,
): RadiusReport | null {
  const n = dice.length;
  if (n === 0 || !hasRadiusDice(dice)) return null;
  const fired: RadiusFiring[] = [];
  const stirred: { index: number; from: number }[] = [];
  const rerolled: { index: number; from: number }[] = [];
  const halo = new Map<number, number>();
  const reach = (i: number) =>
    radiusNeighbours(i, n, cols).filter((j) => j >= live);
  const kinds = dice.map((d) => radiusKindOf(d));

  // The Censer, spreading from censer to censer.
  const queue: { index: number; by?: number }[] = [];
  const queued = new Set<number>();
  for (let i = live; i < n; i++)
    if (kinds[i] === "censer" && radiusFires(dice[i])) {
      queue.push({ index: i });
      queued.add(i);
    }
  while (queue.length > 0) {
    const { index, by } = queue.shift()!;
    const r = reach(index);
    fired.push({
      index,
      kind: "censer",
      reach: r,
      ...(by !== undefined ? { by } : {}),
    });
    for (const j of r) {
      const d = dice[j];
      const kind = kinds[j];
      if (d.loaded || (kind === null && !rules.topSpecial(d))) continue;
      const top = topFace(d);
      if (d.value !== top) {
        stirred.push({ index: j, from: d.value });
        d.value = top;
      }
      if (kind === "censer" && !queued.has(j)) {
        queued.add(j);
        queue.push({ index: j, by: index });
      }
    }
  }
  const stirredBy = new Map<number, number>();
  for (const f of fired)
    if (f.kind === "censer")
      for (const j of f.reach)
        if (!stirredBy.has(j) && stirred.some((s) => s.index === j))
          stirredBy.set(j, f.index);

  // Grace: every die in reach that missed, itself included, rolls once more.
  // A Halo or Censer showing its top face has not missed — it is going off.
  const missed = new Set<number>();
  for (let i = live; i < n; i++) {
    if (kinds[i] !== "grace" || !radiusFires(dice[i])) continue;
    const r = reach(i);
    fired.push({
      index: i,
      kind: "grace",
      reach: r,
      ...(stirredBy.has(i) ? { by: stirredBy.get(i) } : {}),
    });
    for (const j of [i, ...r]) {
      const d = dice[j];
      const kind = kinds[j];
      if ((kind === "halo" || kind === "censer") && radiusFires(d)) continue;
      if (!rules.scores(d)) missed.add(j);
    }
  }
  for (const j of [...missed].sort((a, b) => a - b)) {
    rerolled.push({ index: j, from: dice[j].value });
    rules.reroll(dice[j]);
  }

  // The Halo.
  for (let i = live; i < n; i++) {
    if (kinds[i] !== "halo" || !radiusFires(dice[i])) continue;
    const r = reach(i);
    fired.push({
      index: i,
      kind: "halo",
      reach: r,
      ...(stirredBy.has(i) ? { by: stirredBy.get(i) } : {}),
    });
    for (const j of r) halo.set(j, (halo.get(j) ?? 0) + 1);
  }

  if (fired.length === 0) return null;
  return { cols, fired, stirred, rerolled, halo };
}
