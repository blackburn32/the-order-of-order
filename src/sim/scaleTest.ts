/**
 * How high can we push dice counts on the bucket path? Times a full resolveRoll
 * (roll + score + attribution + Double-the-Fun + Genesis growth) at grids held at
 * a fixed size, from ten thousand up to ten billion dice, and reports per-roll
 * time plus the numeric ceiling (where a plain `number` dice count or score would
 * overflow). This is the "how far is safe" companion to compareScoring.ts.
 *
 *   npx tsx src/sim/scaleTest.ts
 */
import { DieSides, DIE_LADDER } from "../systems/Dice";
import { DicePool, setBucketThreshold } from "../systems/DicePool";
import { newRun, RunState } from "../state/RunState";
import { resolveRoll } from "./engine";

setBucketThreshold(1); // force bucket mode at any size

/** A representative big grid of exactly `n` dice: spread across the ladder with
 *  some special dice, built directly as a bucketed pool (never materialising N
 *  Die objects). */
function bigPool(n: number): DicePool {
  const dice = DicePool.fromDice([]);
  const per = Math.floor(n / (DIE_LADDER.length + 2));
  for (const sides of DIE_LADDER) dice.addDice(sides as DieSides, per);
  dice.addDice(20, per, { maxFaceBonus: true });
  dice.addDice(8, n - per * (DIE_LADDER.length + 1), { wildFace: true });
  return dice;
}

function bigState(n: number): RunState {
  const s = newRun();
  Object.assign(s, {
    scoringNumbers: [1, 2, 3],
    hasSnakeEyes: true,
    jackpot: 2,
    keenEdge: 2,
    extraPoints: 1,
    dividend: 1,
    momentum: 1,
    prism: 1,
    hasAmplifier: true,
    hasDoubleTheFun: true,
    genesis: 3,
  });
  s.dice = bigPool(n);
  return s;
}

function timeRoll(n: number): { ms: number; peak: number } {
  const s = bigState(n);
  // Warm up + measure a few rolls, rebuilding the grid back to n each time so
  // every measured roll happens at the same size (growth would otherwise inflate
  // it). Rebuilding a bucketed pool is O(buckets), the same order as the reset it
  // replaces, so it doesn't distort the roll+resolve figure being measured.
  let peak = s.dice.length;
  s.dice.roll(Math.random, s.scoringNumbers, s.royalSealSizes);
  resolveRoll(s);
  s.dice = bigPool(n);
  const iters = n >= 1e8 ? 3 : 8;
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    s.dice.roll(Math.random, s.scoringNumbers, s.royalSealSizes);
    resolveRoll(s);
    peak = Math.max(peak, s.dice.length);
    s.dice = bigPool(n);
  }
  return { ms: (performance.now() - t0) / iters, peak };
}

console.log("\n=== Bucket-path scaling: full resolveRoll per roll ===\n");
console.log(
  "dice".padStart(16),
  "roll+resolve ms".padStart(18),
  "score (round1 roll)".padStart(22),
);
for (const n of [1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10]) {
  const s = bigState(n);
  s.dice.roll(Math.random, s.scoringNumbers, s.royalSealSizes);
  const before = s.score;
  resolveRoll(s);
  const scored = s.score - before;
  const { ms } = timeRoll(n);
  console.log(
    String(n.toExponential(0)).padStart(16),
    ms.toFixed(3).padStart(18),
    String(scored).padStart(22),
  );
}

console.log("\nNumeric ceilings with plain `number`:");
console.log(
  `  Number.MAX_SAFE_INTEGER = ${Number.MAX_SAFE_INTEGER.toExponential(3)} (~9.0e15) — exact integers up to here`,
);
console.log(
  "  A dice count stays an exact integer until ~9.0e15; past that, +1 rounds off.",
);
console.log(
  "  Scores blow past 9.0e15 fast once multipliers compound — that is what BigInt fixes.",
);
