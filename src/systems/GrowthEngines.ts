// The strategy trees' tier-3 engines (systems/ItemTrees): the cards that grow a
// run's points for every roll they are fed, and the boosts that raise them.
//
// Six of them grow the whole roll and share one shape. After each roll an engine
// reads what it feeds on — a grid that scored whole, two multipliers landing,
// the purse, the dice showing 50 or higher, the faces only one die shows, the
// faces that burned — and counts the roll at the percent that earned: a fixed
// rate for the first two, up to a cap for the rest. Every later roll's points
// then grow once for each counted roll, at the percent it was counted at.
//
// The seventh, The Vigil, grows each die rather than the roll: a die carries a
// count of the times it has scored, and a roll's points grow by the mean growth
// of the dice that scored it.
//
// Counts rather than a stored factor, so growth stays one exact integer division
// however long a run goes, and a replayed run grows exactly as the original did.
// A count records the percent a roll earned rather than the boosts owned when it
// did: a boost raises the growth of rolls still to come, never of rolls already
// counted, and the engine's own share is recovered as the same counts with every
// percent held to the card's own figure — which is how the boost is credited.

import type { RunState } from "../state/RunState";
import type { RollRules } from "./DicePool";
import type { ShopItemId } from "./Items";

/** The run's rules that change a roll itself (The Scales, Ballast, The Anvil),
 *  for every door onto `DicePool.roll`. */
export function rollRulesFor(state: RunState): RollRules {
  return {
    scales: state.hasScales,
    ballastSizes: state.ballastSizes,
    anvil: state.hasAnvil,
  };
}

export type GrowthEngineId =
  "catechism" | "resonance" | "endowment" | "weight" | "plainsong" | "pyre";

/** The id growth is reported under when it is The Vigil's. */
export const VIGIL_GROWTH_ID = "vigil";

/** An engine's growth per qualifying roll, or its cap, in whole percent. */
export const ENGINE_GROWTH_PERCENT = 10;
/** What each copy of an engine's boost adds, and how many copies a run may own. */
export const BOOST_GROWTH_PERCENT = 2;
export const BOOST_MAX_COPIES = 3;

/** The rates the capped engines read their inputs at. */
export interface GrowthTuning {
  /** The Endowment: gold held per 1%. */
  endowmentGoldPerPercent: number;
  /** The Weight of Ages: dice showing `weightFace` or higher per 1%. */
  weightDicePerPercent: number;
  weightFace: number;
  /** Plainsong: unrepeated faces that pay nothing before the 1% ones. */
  plainsongFreeFaces: number;
  /** The Pyre: burned or shattered faces per 1%. */
  pyreFacesPerPercent: number;
  /** The Vigil: the most dice a grid may hold while it grows. */
  vigilGridLimit: number;
  /** The Resonant Hall: the cards that must multiply a roll for it to count. */
  resonanceMultipliers: number;
}

export const GROWTH_TUNING: Readonly<GrowthTuning> = {
  // Measured in the engine experiment (RUNS=2000, trees ×3, reworks on): the
  // figures that brought each engine nearest the tuning bar.
  endowmentGoldPerPercent: 10,
  weightDicePerPercent: 3,
  weightFace: 50,
  plainsongFreeFaces: 0,
  pyreFacesPerPercent: 20,
  vigilGridLimit: 12,
  resonanceMultipliers: 3,
};

// Sim-only escape hatches for sizing the engines (src/sim/catechismExperiment.ts).
// The cards' printed figures never move.
let tuning: GrowthTuning = { ...GROWTH_TUNING };
const percentOverride: Partial<Record<GrowthEngineId | "vigil", number>> = {};

/** Sim-only. The capped engines' input rates; null restores the cards' own. */
export function setGrowthTuningForSimulation(
  next: Partial<GrowthTuning> | null,
): void {
  tuning = { ...GROWTH_TUNING, ...(next ?? {}) };
}

/** The input rates in force. */
export function growthTuning(): Readonly<GrowthTuning> {
  return tuning;
}

/** Sim-only. An engine's growth (or cap) before its boost, in whole percent;
 *  null restores the card's own. */
export function setEngineGrowthPercentForSimulation(
  id: GrowthEngineId | "vigil",
  percent: number | null,
): void {
  if (percent === null) delete percentOverride[id];
  else percentOverride[id] = percent;
}

/** An engine's growth (or cap) with `boosts` copies of its boost. */
export function engineGrowthPercent(
  id: GrowthEngineId | "vigil",
  boosts: number,
): number {
  return (
    (percentOverride[id] ?? ENGINE_GROWTH_PERCENT) +
    BOOST_GROWTH_PERCENT * boosts
  );
}

/** A growth percent as the factor the cards print: 10 → "1.1", 12 → "1.12",
 *  1 → "1.01". The cards speak of multiplying the multiplier rather than of
 *  percents, because a percent read as "+10% on this roll" hides that the
 *  growth is permanent and compounds. */
export function growthFactorText(percent: number): string {
  const hundredths = 100 + percent;
  const whole = Math.floor(hundredths / 100);
  const fraction = String(hundredths % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export interface GrowthEngineDef {
  id: GrowthEngineId;
  /** The engine card, credited with the growth its own figure earns... */
  item: ShopItemId;
  /** ...and its boost, credited with the rest. */
  boost: ShopItemId;
  name: string;
  owns(state: RunState): boolean;
  boosts(state: RunState): number;
}

export const GROWTH_ENGINES: readonly GrowthEngineDef[] = [
  {
    id: "catechism",
    item: "the_catechism",
    boost: "litany",
    name: "The Catechism",
    owns: (s) => s.hasCatechism,
    boosts: (s) => s.litany,
  },
  {
    id: "resonance",
    item: "the_resonant_hall",
    boost: "harmonics",
    name: "The Resonant Hall",
    owns: (s) => s.hasResonantHall,
    boosts: (s) => s.harmonics,
  },
  {
    id: "endowment",
    item: "the_endowment",
    boost: "compound_interest",
    name: "The Endowment",
    owns: (s) => s.hasEndowment,
    boosts: (s) => s.compoundInterest,
  },
  {
    id: "weight",
    item: "the_weight_of_ages",
    boost: "gravity_well",
    name: "The Weight of Ages",
    owns: (s) => s.hasWeightOfAges,
    boosts: (s) => s.gravityWell,
  },
  {
    id: "plainsong",
    item: "plainsong",
    boost: "descant",
    name: "Plainsong",
    owns: (s) => s.hasPlainsong,
    boosts: (s) => s.descant,
  },
  {
    id: "pyre",
    item: "the_pyre",
    boost: "everflame",
    name: "The Pyre",
    owns: (s) => s.hasPyre,
    boosts: (s) => s.everflame,
  },
];

// ---- reading a roll ----------------------------------------------------------

/** How many faces exactly one live die shows. */
export function unrepeatedFaces(valueCounts: Map<number, number>): number {
  let faces = 0;
  for (const count of valueCounts.values()) if (count === 1) faces += 1;
  return faces;
}

/** How many live dice show `face` or higher. */
export function diceShowingAtLeast(
  valueCounts: Map<number, number>,
  face: number,
): number {
  let dice = 0;
  for (const [value, count] of valueCounts) if (value >= face) dice += count;
  return dice;
}

/** How many cards multiplied a roll: every entry of its breakdown that carries
 *  a factor above ×1. */
export function multipliersLanded(
  modifiers: readonly { mult?: bigint }[],
): number {
  return modifiers.filter((mod) => mod.mult !== undefined && mod.mult > 1n)
    .length;
}

/** What the engines read off one of the player's own rolls. */
export interface GrowthReading {
  everyLiveDieScored: boolean;
  multipliers: number;
  valueCounts: Map<number, number>;
}

export interface GrowthEarned {
  id: GrowthEngineId;
  percent: number;
}

/** The percent each owned engine earned on this roll; 0 is a roll it did not
 *  grow on. Read off a roll no affliction took. */
export function growthEarned(
  state: RunState,
  reading: GrowthReading,
): GrowthEarned[] {
  const earned: GrowthEarned[] = [];
  for (const def of GROWTH_ENGINES) {
    if (!def.owns(state)) continue;
    const cap = engineGrowthPercent(def.id, def.boosts(state));
    let percent = 0;
    switch (def.id) {
      case "catechism":
        percent = reading.everyLiveDieScored ? cap : 0;
        break;
      case "resonance":
        percent = reading.multipliers >= tuning.resonanceMultipliers ? cap : 0;
        break;
      case "endowment":
        percent = Math.floor(state.gold / tuning.endowmentGoldPerPercent);
        break;
      case "weight":
        percent = Math.floor(
          diceShowingAtLeast(reading.valueCounts, tuning.weightFace) /
            tuning.weightDicePerPercent,
        );
        break;
      case "plainsong":
        // Antiphon counts every lone face twice.
        percent =
          unrepeatedFaces(reading.valueCounts) * (state.hasAntiphon ? 2 : 1) -
          tuning.plainsongFreeFaces;
        break;
      case "pyre":
        percent = Math.floor(state.pyreFaces / tuning.pyreFacesPerPercent);
        break;
    }
    earned.push({ id: def.id, percent: Math.max(0, Math.min(cap, percent)) });
  }
  return earned;
}

/** Count a roll for every engine that earned on it. The Pyre's faces are spent
 *  by the roll whether or not they reached a whole percent: the card pays for
 *  what burned since the last roll — all of it, or half under Embers, which
 *  keeps the other half in the fire for the next. */
export function countGrowth(
  state: RunState,
  earned: readonly GrowthEarned[],
): void {
  for (const { id, percent } of earned) {
    if (id === "pyre")
      state.pyreFaces = state.hasEmbers ? Math.floor(state.pyreFaces / 2) : 0;
    if (percent <= 0) continue;
    const counts = (state.growthRollsAt[id] ??= []);
    while (counts.length <= percent) counts.push(0);
    counts[percent] += 1;
  }
}

/** The run's counts for one engine, as a plain percent → rolls table. */
export function growthCounts(
  state: RunState,
  id: GrowthEngineId,
): readonly number[] {
  return state.growthRollsAt[id] ?? [];
}

// ---- The Vigil -----------------------------------------------------------------

/** Dice that scored this roll with the same score counts. `scores[p]` is how
 *  many times such a die has scored while The Vigil grew it p%. */
export interface VigilGroup {
  scores: readonly number[];
  count: number;
}

/** Whether The Vigil grows a grid of this size. */
export function vigilActive(state: RunState, gridSize: number): boolean {
  return state.hasVigil && gridSize <= tuning.vigilGridLimit;
}

/** The percent a die's score is counted at right now. */
export function vigilPercent(state: RunState): number {
  return engineGrowthPercent("vigil", state.discipline);
}

/** `scores` with `times` more at `percent`, trailing zeros trimmed so equal
 *  counts always compare (and bucket) equal. */
export function addScores(
  scores: readonly number[] | undefined,
  percent: number,
  times: number,
): number[] {
  const next = [...(scores ?? [])];
  while (next.length <= percent) next.push(0);
  next[percent] += times;
  return next;
}

/** File `count` scoring dice carrying `scores` under their group; dice with no
 *  scores are left out, being worth ×1. */
export function groupScores(
  groups: Map<string, VigilGroup>,
  scores: readonly number[] | undefined,
  count: number,
): void {
  const key = scoresKey(scores);
  if (!key || count <= 0) return;
  const group = groups.get(key);
  if (group) group.count += count;
  else groups.set(key, { scores: [...scores!], count });
}

/** A stable key for a die's score counts; empty for a die that has none. */
export function scoresKey(scores: readonly number[] | undefined): string {
  if (!scores) return "";
  let end = scores.length;
  while (end > 0 && scores[end - 1] === 0) end -= 1;
  return scores.slice(0, end).join(",");
}

// ---- growing a roll ------------------------------------------------------------

type Ratio = [bigint, bigint];

/** Π(100+p)^n / 100^Σn over a percent → count table, each percent held to at
 *  most `cap`. */
function countsRatio(counts: readonly number[], cap: number): Ratio {
  let num = 1n;
  let rolls = 0;
  counts.forEach((count, percent) => {
    if (count <= 0) return;
    num *= BigInt(100 + Math.min(percent, cap)) ** BigInt(count);
    rolls += count;
  });
  return [num, 100n ** BigInt(rolls)];
}

/** The mean growth of the dice that scored a roll: each die's own counts, the
 *  dice with none at ×1. */
function vigilRatio(
  groups: readonly VigilGroup[],
  scoring: number,
  cap: number,
): Ratio {
  const parts = groups.map((group) => {
    const [num, den] = countsRatio(group.scores, cap);
    return { num, den, count: group.count };
  });
  const grouped = parts.reduce((sum, part) => sum + part.count, 0);
  const dice = Math.max(scoring, grouped);
  if (dice <= 0) return [1n, 1n];
  const den = parts.reduce(
    (max, part) => (part.den > max ? part.den : max),
    1n,
  );
  let num = BigInt(dice - grouped) * den;
  for (const part of parts)
    num += BigInt(part.count) * part.num * (den / part.den);
  return [num, BigInt(dice) * den];
}

/** One engine's part of a roll's growth. */
export interface GrowthShare {
  id: string;
  name: string;
  item: ShopItemId;
  boost: ShopItemId;
  /** Points the engine added, boost included... */
  total: bigint;
  /** ...and the part its own figure earns. */
  own: bigint;
}

/** What a roll's scoring dice tell The Vigil. */
export interface VigilReading {
  groups: readonly VigilGroup[];
  /** The dice that scored, with or without counts. */
  scoring: number;
  /** The grid's size, inert dice included. */
  total: number;
}

/**
 * A roll's points after every growth engine the run owns, with each engine's
 * share. The engines apply in turn — The Vigil first, then the rest — and each
 * is credited with the points it added on top of those before it, so the shares
 * sum exactly to the growth however the integer divisions fall.
 *
 * Applied after the run multiplier, and so after the Eclipse halves it: growth
 * is not a multiplier card but something the run has earned, and nothing that
 * penalises multipliers reaches it.
 */
export function growRoll(
  state: RunState,
  multiplied: bigint,
  vigil: VigilReading,
): { points: bigint; shares: GrowthShare[] } {
  const shares: GrowthShare[] = [];
  if (multiplied <= 0n) return { points: multiplied, shares };
  const steps: {
    id: string;
    name: string;
    item: ShopItemId;
    boost: ShopItemId;
    full: Ratio;
    own: Ratio;
  }[] = [];
  if (vigilActive(state, vigil.total) && vigil.groups.length > 0) {
    const cap = engineGrowthPercent("vigil", 0);
    steps.push({
      id: VIGIL_GROWTH_ID,
      name: "The Vigil",
      item: "the_vigil",
      boost: "discipline",
      full: vigilRatio(vigil.groups, vigil.scoring, Infinity),
      own: vigilRatio(vigil.groups, vigil.scoring, cap),
    });
  }
  for (const def of GROWTH_ENGINES) {
    if (!def.owns(state)) continue;
    const counts = growthCounts(state, def.id);
    if (!counts.some((count) => count > 0)) continue;
    steps.push({
      id: def.id,
      name: def.name,
      item: def.item,
      boost: def.boost,
      full: countsRatio(counts, Infinity),
      own: countsRatio(counts, engineGrowthPercent(def.id, 0)),
    });
  }

  let num = 1n;
  let den = 1n;
  let points = multiplied;
  for (const step of steps) {
    const full = (multiplied * num * step.full[0]) / (den * step.full[1]);
    const own = (multiplied * num * step.own[0]) / (den * step.own[1]);
    shares.push({
      id: step.id,
      name: step.name,
      item: step.item,
      boost: step.boost,
      total: full - points,
      own: own - points,
    });
    num *= step.full[0];
    den *= step.full[1];
    points = full;
  }
  return { points, shares };
}
