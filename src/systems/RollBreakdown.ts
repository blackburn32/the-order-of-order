// A scored roll, told the way the player is meant to read it: the dice that
// scored, the points other effects added, and one multiplier over the lot.
//
//   (dice + bonuses) × multiplier = the roll's points
//
// The scorer already knows all of this — `RollResult.modifiers` carries each
// additive source and each factor, and `growthShares` what every growth engine
// added on top — but it lists them as a flat breakdown, and the old floats priced
// a multiplier as the points it added, which hid that a multiplier is the thing
// that scales everything else. This regroups the same numbers without scoring
// anything a second time: each card's step is its factor, and each growth
// engine's step is the ratio of the points before it to the points after.
//
// Bonuses and multiplier steps are both played smallest first, so a count
// builds toward its biggest contributor. Multiplication does not care about
// order, so the steps' running values are recomputed as exact fractions in the
// new order and the last one still lands exactly on `points ÷ (dice + bonuses)`.
// The Eclipse is the exception: it cuts rather than adds, and always comes last.
//
// Pure, so the sim can check the arithmetic (src/sim/itemCheck.ts).

import type { RollResult } from "./Scoring";
import { formatScore } from "../ui/formatScore";

/** An exact multiplier: `num / den`. A multiplier of cards alone is a whole
 *  number, but growth engines make it fractional, and past a few dozen rolls of
 *  growth a float would no longer name the points it produced. */
export interface Multiplier {
  num: bigint;
  den: bigint;
}

export interface BreakdownBonus {
  id: string;
  name: string;
  points: bigint;
}

/** One card or engine raising (or, for The Eclipse, cutting) the multiplier. */
export interface MultiplierStep {
  id: string;
  name: string;
  /** This step's own factor as printed: "×3", "×1.21", "÷2". */
  factor: string;
  /** The multiplier once this step has applied. */
  after: Multiplier;
}

export interface RollBreakdown {
  /** Points the dice themselves scored: one per scoring die. */
  dice: bigint;
  /** Every other source of points, smallest first. */
  bonuses: BreakdownBonus[];
  /** dice + bonuses: what the multiplier multiplies. */
  subtotal: bigint;
  /** Every factor on the multiplier, smallest first, any penalty last. */
  steps: MultiplierStep[];
  /** The multiplier over the whole roll. `subtotal × multiplier = points`,
   *  up to the growth engines' integer rounding. */
  multiplier: Multiplier;
  points: bigint;
}

export const ONE: Multiplier = { num: 1n, den: 1n };

/** Regroup a scored roll. Null for a roll that scored nothing. */
export function rollBreakdown(
  result: RollResult,
  penaltyName = "The Eclipse",
): RollBreakdown | null {
  if (result.points <= 0n) return null;

  let dice = 0n;
  const bonuses: BreakdownBonus[] = [];
  for (const mod of result.modifiers) {
    if (mod.mult !== undefined || mod.points <= 0n) continue;
    if (mod.id === "scoring") dice += mod.points;
    else bonuses.push({ id: mod.id, name: mod.name, points: mod.points });
  }
  const subtotal = dice + bonuses.reduce((sum, b) => sum + b.points, 0n);
  if (subtotal <= 0n) return null;
  // Stable, so equal bonuses keep the scorer's order.
  bonuses.sort((a, b) =>
    a.points < b.points ? -1 : a.points > b.points ? 1 : 0,
  );

  // Each factor as an exact fraction, before ordering.
  const factors: {
    id: string;
    name: string;
    factor: string;
    by: Multiplier;
  }[] = [];
  let cards = 1n;
  for (const mod of result.modifiers) {
    if (mod.mult === undefined || mod.mult <= 1n) continue;
    cards *= mod.mult;
    factors.push({
      id: mod.id,
      name: mod.name,
      factor: `×${formatScore(mod.mult)}`,
      by: { num: mod.mult, den: 1n },
    });
  }
  let points = subtotal * result.multiplier;
  for (const share of result.growthShares ?? []) {
    if (share.total <= 0n) continue;
    const before = points;
    points += share.total;
    factors.push({
      id: share.id,
      name: share.name,
      factor: `×${formatMultiplier({ num: points, den: before })}`,
      by: { num: points, den: before },
    });
  }
  factors.sort((a, b) => {
    const left = a.by.num * b.by.den;
    const right = b.by.num * a.by.den;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  // The Eclipse halves the product of the cards (never below ×1): the one step
  // that lowers the multiplier, played after everything that raised it.
  if (result.multiplier !== cards) {
    factors.push({
      id: "penalty",
      name: penaltyName,
      factor:
        result.multiplier === (cards / 2n > 1n ? cards / 2n : 1n)
          ? "÷2"
          : `→ ×${formatScore(result.multiplier)}`,
      by: { num: result.multiplier, den: cards },
    });
  }

  const steps: MultiplierStep[] = [];
  let running = ONE;
  for (const { by, ...step } of factors) {
    running = reduce({ num: running.num * by.num, den: running.den * by.den });
    steps.push({ ...step, after: running });
  }

  return {
    dice,
    bonuses,
    subtotal,
    steps,
    multiplier: reduce({ num: result.points, den: subtotal }),
    points: result.points,
  };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reduce(m: Multiplier): Multiplier {
  const g = gcd(m.num, m.den);
  return g > 1n ? { num: m.num / g, den: m.den / g } : m;
}

/** A multiplier in hundredths, rounded down: the resolution it is printed at. */
export function multiplierHundredths(m: Multiplier): bigint {
  return (m.num * 100n) / m.den;
}

/** A multiplier as printed, without its ×: whole when it is whole ("12"),
 *  otherwise to two places with trailing zeros dropped ("1.21", "7.5"). Large
 *  ones take the score's own formatting, commas then scientific. */
export function formatMultiplier(m: Multiplier): string {
  return formatHundredths(multiplierHundredths(m), m.num % m.den !== 0n);
}

/** Hundredths as printed. `fractional` says whether the value the count is
 *  heading for has a fraction: a count toward ×12 should not pass through
 *  "×7.43" on its way. */
export function formatHundredths(
  hundredths: bigint,
  fractional: boolean,
): string {
  const whole = hundredths / 100n;
  if (!fractional || whole >= 1000n) return formatScore(whole);
  const cents = String(hundredths % 100n)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return cents ? `${formatScore(whole)}.${cents}` : formatScore(whole);
}
