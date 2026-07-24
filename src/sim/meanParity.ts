/**
 * Bias check: does bucket-mode rolling have the same *expected* scoring and
 * growth as per-die rolling, for the SAME grid? (Full-run totals can't answer
 * this — once modes diverge in RNG they're different runs.) Here we hold a fixed
 * grid and roll it many times in each mode, then compare the means. They should
 * agree to within a percent or two of sampling error.
 *
 *   npx tsx src/sim/meanParity.ts
 */
import { makeDie, DieSides } from '../systems/Dice';
import { DicePool, setBucketThreshold } from '../systems/DicePool';
import { newRun, RunState } from '../state/RunState';
import { scoreRollHistogram } from '../systems/ScoringHistogram';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec { sides: DieSides; n: number; maxFaceBonus?: boolean; loaded?: boolean; wildFace?: boolean }

function stateWith(specs: Spec[]): RunState {
  const s = newRun();
  Object.assign(s, {
    scoringNumbers: [1, 2, 3], hasSnakeEyes: true, jackpot: 2, keenEdge: 2,
    extraPoints: 1, dividend: 1, momentum: 1, hasDoubleTheFun: true, genesis: 3
  });
  const dice = specs.flatMap((sp) => Array.from({ length: sp.n }, () => makeDie(sp.sides, { maxFaceBonus: sp.maxFaceBonus, loaded: sp.loaded, wildFace: sp.wildFace })));
  s.dice = DicePool.fromDice(dice);
  return s;
}

/** Roll `iters` times from a fresh copy of the grid each time (so growth never
 *  compounds), returning mean points, mean Double-the-Fun spawns, mean Genesis
 *  spawns. `threshold` forces list vs bucket storage. */
function sample(specs: Spec[], iters: number, threshold: number, seed: number) {
  setBucketThreshold(threshold);
  const rng = mulberry32(seed);
  let points = 0, dtf = 0, gen = 0;
  for (let i = 0; i < iters; i++) {
    const s = stateWith(specs);
    s.scoreStreak = 5; // fixed unlock streak for deterministic state
    s.momentumStreak = 5; // fixed Momentum payout streak
    s.dice.roll(rng, s.scoringNumbers, s.royalSealSizes);
    const r = scoreRollHistogram(s, s.dice.agg(), {});
    points += Number(r.points);
    dtf += s.dice.doubleTheFun();
    gen += s.dice.genesis(20 * s.genesis);
  }
  return { points: points / iters, dtf: dtf / iters, gen: gen / iters };
}

const grids: { name: string; specs: Spec[] }[] = [
  { name: 'd6 ×3000', specs: [{ sides: 6, n: 3000 }] },
  { name: 'mixed ×5000', specs: [{ sides: 6, n: 2000 }, { sides: 4, n: 1500 }, { sides: 20, n: 500, maxFaceBonus: true }, { sides: 1, n: 1000 }] },
  { name: 'wild+loaded ×4000', specs: [{ sides: 8, n: 1500, wildFace: true }, { sides: 10, n: 1500, loaded: true }, { sides: 100, n: 1000, maxFaceBonus: true }] }
];

const ITERS = 4000;
console.log(`\n=== Mean parity: per-die vs bucket, ${ITERS} rolls per grid ===\n`);
console.log('grid'.padEnd(20), 'metric'.padEnd(8), 'per-die'.padStart(14), 'bucket'.padStart(14), 'Δ%'.padStart(8));
for (const g of grids) {
  const list = sample(g.specs, ITERS, Number.MAX_SAFE_INTEGER, 42);
  const buck = sample(g.specs, ITERS, 1, 42);
  const row = (metric: string, a: number, b: number) => {
    const d = a === 0 ? 0 : (100 * (b - a)) / a;
    console.log(g.name.padEnd(20), metric.padEnd(8), a.toFixed(1).padStart(14), b.toFixed(1).padStart(14), `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`.padStart(8));
  };
  row('points', list.points, buck.points);
  row('DTF', list.dtf, buck.dtf);
  row('Genesis', list.gen, buck.gen);
}
