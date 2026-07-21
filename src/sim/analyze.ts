// Target-curve analysis harness (throwaway tooling for balancing rounds 2-20).
//
// A run's per-round PEAK score is independent of the survival targets — the
// target only decides when a run stops, not the scores it produces while alive.
// So we simulate once with trivial targets (everyone reaches round 20), capture
// every run's full 20-round peak-score trajectory, then evaluate ANY candidate
// target curve analytically: a run "dies" at the first round R where its peak[R]
// is below T[R]. This lets us design the whole curve front-to-back from the
// empirical conditional distributions without re-simulating per iteration.
//
// Run: npx tsx src/sim/analyze.ts
//
// Not shipped with the game; delete when balancing is done.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from './config';
import { installStorage, seedGlobalRandom } from './localStorageShim';
import { simulateRun, StrategyName } from './bot';
import { setRoundTargets, WIN_ROUND, BASE_TARGET, TARGET_GROWTH } from '../config';

const RUNS = Number(process.env.RUNS ?? 3000);
const STRATS: StrategyName[] = ['random', 'greedy'];
const CACHE = `sim-out/trajectories-${RUNS}.json`;

// ---- collect trajectories once, with trivial targets (cached) --------------

// peak[strategy] = array of runs; each run is number[] indexed by round-1.
type Peaks = Record<StrategyName, number[][]>;

function collect(): Peaks {
  if (existsSync(CACHE)) {
    console.log(`(loaded cached trajectories from ${CACHE})`);
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  }
  seedGlobalRandom(DEFAULT_CONFIG.seed);
  installStorage(DEFAULT_CONFIG.unlockedAtStart);
  setRoundTargets(new Array(WIN_ROUND).fill(1)); // trivial: nobody dies on target

  const out = {} as Peaks;
  for (const name of STRATS) {
    const runs: number[][] = [];
    for (let i = 0; i < RUNS; i++) {
      const rec = simulateRun(name, DEFAULT_CONFIG.seed * 1_000_003 + i + STRATS.indexOf(name) * 7919, DEFAULT_CONFIG);
      const peaks = new Array(WIN_ROUND).fill(0);
      for (const p of rec.trajectory) peaks[p.round - 1] = p.roundScore;
      runs.push(peaks);
    }
    out[name] = runs;
  }
  setRoundTargets(null);
  writeFileSync(CACHE, JSON.stringify(out));
  console.log(`(cached trajectories to ${CACHE})`);
  return out;
}

// Round a target to 2 significant figures for a legible curve.
function round2sig(n: number): number {
  if (n < 100) return Math.ceil(n);
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(q * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

const fmt = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n)));

// ---- evaluate a candidate curve: where do runs die? ------------------------

function histogram(runs: number[][], T: number[]): { hist: number[]; wins: number } {
  const hist = new Array(WIN_ROUND).fill(0); // hist[r-1] = runs that ended on round r
  let wins = 0;
  for (const peaks of runs) {
    let dead = 0;
    for (let r = 1; r <= WIN_ROUND; r++) {
      if (peaks[r - 1] < T[r - 1]) { dead = r; break; }
    }
    if (dead === 0) { wins++; hist[WIN_ROUND - 1]++; }
    else hist[dead - 1]++;
  }
  return { hist, wins };
}

function printHistogram(label: string, peaks: Peaks, T: number[]): void {
  console.log(`\n=== ${label} ===`);
  console.log('T = [' + T.map((t, i) => `${i + 1}:${fmt(t)}`).join('  ') + ']');
  for (const name of STRATS) {
    const { hist, wins } = histogram(peaks[name], T);
    const n = peaks[name].length;
    const bars = hist
      .map((c, i) => (c > 0 ? `r${i + 1}=${c}` : ''))
      .filter(Boolean)
      .join('  ');
    console.log(`  ${name.padEnd(7)} win ${((wins / n) * 100).toFixed(1)}%  | deaths: ${bars}`);
  }
}

// Conditional peak percentiles among runs still alive entering each round under T.
function printConditional(label: string, peaks: Peaks, T: number[]): void {
  console.log(`\n--- conditional peak-score distribution among survivors (${label}) ---`);
  console.log('round |  entrants | die% |    p10 |    p25 |    p50 |    p75 |    p90 | target');
  // pool both strategies for a stable picture
  const pool = [...peaks.random, ...peaks.greedy];
  let alive = pool.filter((p) => p[0] >= T[0]); // survived round 1
  for (let r = 2; r <= WIN_ROUND; r++) {
    const col = alive.map((p) => p[r - 1]).sort((a, b) => a - b);
    const t = T[r - 1];
    const deaths = col.filter((v) => v < t).length;
    const diePct = col.length ? (deaths / col.length) * 100 : 0;
    console.log(
      `${String(r).padStart(5)} | ${String(col.length).padStart(9)} | ${diePct.toFixed(0).padStart(3)}% | ` +
        [0.1, 0.25, 0.5, 0.75, 0.9].map((q) => fmt(quantile(col, q)).padStart(6)).join(' | ') +
        ` | ${fmt(t)}`
    );
    alive = alive.filter((p) => p[r - 1] >= t);
  }
}

// Build a target curve from a desired per-round attrition schedule (fraction of
// ENTRANTS to kill at each round), read off the empirical conditional dist.
// `round` applies 2-sig-fig rounding and re-conditions on the rounded value so
// the reported survival matches the curve we'd actually ship.
function buildCurve(pool: number[][], kill: number[], round1Target: number, round = true): number[] {
  const T = new Array(WIN_ROUND).fill(1);
  T[0] = round1Target;
  let alive = pool.filter((p) => p[0] >= T[0]);
  for (let r = 2; r <= WIN_ROUND; r++) {
    const col = alive.map((p) => p[r - 1]).sort((a, b) => a - b);
    const f = kill[r - 1] ?? 0;
    let t = Math.max(T[r - 2] + 1, Math.ceil(quantile(col, f))); // f-quantile kills fraction f
    if (round) t = Math.max(T[r - 2] + 1, round2sig(t));
    T[r - 1] = t;
    alive = alive.filter((p) => p[r - 1] >= t);
  }
  return T;
}

function schedule(startKill: number, endKill: number): number[] {
  const k = new Array(WIN_ROUND).fill(0);
  for (let r = 2; r <= WIN_ROUND; r++) {
    const frac = (r - 2) / (WIN_ROUND - 2); // 0 at r2 -> 1 at r20
    k[r - 1] = startKill + (endKill - startKill) * frac;
  }
  return k;
}

// ---- main ------------------------------------------------------------------

const peaks = collect();
const pool = [...peaks.random, ...peaks.greedy];

// The shipping formula curve, for reference.
const currentT = Array.from({ length: WIN_ROUND }, (_, i) => Math.ceil(BASE_TARGET * Math.pow(TARGET_GROWTH, i)));
console.log(`\nRUNS=${RUNS}/strategy · seed ${DEFAULT_CONFIG.seed} · current formula BASE=${BASE_TARGET} GROWTH=${TARGET_GROWTH}`);
printHistogram('CURRENT formula curve', peaks, currentT);

// Round 1 stays at 5 (out of scope). Difficulty levels via a ramping per-round
// kill fraction (gentle early -> steep late = escalating wall).
//
// SOFTEARLY: near-free rounds 2-3 (so nearly every round-1 survivor reaches
// round 3), slightly easier than GENTLE through round 9, then converges back to
// GENTLE from round 10 on. Explicit low kills for r2-r9 override the GENTLE tail.
function softEarly(): number[] {
  const k = schedule(0.04, 0.09); // GENTLE ramp; r10..r20 kept as-is
  const early: Record<number, number> = {
    2: 0.010, 3: 0.015, 4: 0.025, 5: 0.032, 6: 0.04, 7: 0.046, 8: 0.052, 9: 0.058
  };
  for (const [r, v] of Object.entries(early)) k[Number(r) - 1] = v;
  return k;
}

const CANDIDATES: [string, number[]][] = [
  ['SOFTEARLY (soft to r10, GENTLE after)', softEarly()],
  ['GENTLE  (~25% bot win)', schedule(0.04, 0.09)],
  ['MEDIUM  (~12% bot win)', schedule(0.06, 0.14)],
  ['HARD    (~5% bot win)', schedule(0.09, 0.20)]
];

const curves: Record<string, number[]> = {};
for (const [label, kill] of CANDIDATES) {
  const T = buildCurve(pool, kill, 5);
  curves[label] = T;
  printHistogram(label, peaks, T);
}

// Detailed conditional table + final numbers for the recommended curve.
const rec = curves['SOFTEARLY (soft to r10, GENTLE after)'];
printConditional('SOFTEARLY recommendation', peaks, rec);
console.log('\nRECOMMENDED (SOFTEARLY) targets, ready to paste as an override array:');
console.log('[' + rec.map((t) => t).join(', ') + ']');
writeFileSync('sim-out/candidate.json', JSON.stringify(curves, null, 2));
console.log('(wrote all candidate curves to sim-out/candidate.json — validate.ts reads MEDIUM)');
for (const [label, T] of Object.entries(curves)) {
  console.log(`\n${label}:\n  ` + T.map((t, i) => `r${i + 1}=${fmt(t)}`).join('  '));
}
