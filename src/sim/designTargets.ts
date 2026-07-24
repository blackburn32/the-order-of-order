// Target-curve designer for the 10-round game (throwaway balancing tooling).
//
// Like analyze.ts, it captures each run's per-round PEAK score once (trivial
// targets, so nobody is culled) and then designs a target curve analytically.
// The difference: instead of a per-round KILL fraction, this takes an explicit
// ABSOLUTE survivor schedule S[r] = fraction of the ORIGINAL population still
// alive after round r, and solves sequentially for the target that leaves that
// many alive. That matches the balancing intent, which is stated in absolute
// terms ("~60% survive rounds 1-3", "8% cut at the final round").
//
// Run: npx tsx src/sim/designTargets.ts
//
// Not shipped with the game; delete when balancing is done.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { simulateRun } from "./bot";
import { seriesSeed, SHOPPER_SERIES } from "./series";
import { setRoundTargets, WIN_ROUND } from "../config";

const RUNS = Number(process.env.RUNS ?? 3000);
// v2 = one-purchase shopping + Random/Greedy × base/all unlock pools.
const CACHE = `sim-out/trajectories-v2-${RUNS}.json`;

type Peaks = Record<string, number[][]>;

function collect(): Peaks {
  if (existsSync(CACHE)) {
    console.log(`(loaded cached trajectories from ${CACHE})`);
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
  setRoundTargets(new Array(WIN_ROUND).fill(1)); // trivial: nobody dies on target

  const out: Peaks = {};
  for (const series of SHOPPER_SERIES) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    const runs: number[][] = [];
    for (let i = 0; i < RUNS; i++) {
      const rec = simulateRun(
        series.strategy,
        seriesSeed(DEFAULT_CONFIG.seed, i, series.seedOffset),
        DEFAULT_CONFIG,
      );
      const peaks = new Array(WIN_ROUND).fill(0);
      for (const p of rec.trajectory) peaks[p.round - 1] = p.roundScore;
      runs.push(peaks);
    }
    out[series.id] = runs;
  }
  setRoundTargets(null);
  writeFileSync(CACHE, JSON.stringify(out));
  console.log(`(cached trajectories to ${CACHE})`);
  return out;
}

// Round a target to 2 significant figures. Reconstructed from the mantissa/
// exponent digits so the value is a CLEAN round number (36_000…000), not a
// float-tailed approximation — important now that targets reach 1e28+ where
// doubles can't represent the intended integer exactly.
function round2sig(n: number): number {
  if (n < 100) return Math.max(1, Math.ceil(n));
  const exp = Math.floor(Math.log10(n));
  const mant = Math.round(n / Math.pow(10, exp - 1)); // 10..100
  return Number(bigLiteralValue(mant, exp));
}

// The exact 2-sig-fig integer (as a bigint) for mantissa `mant` (10..100) and
// order-of-magnitude `exp`, e.g. mant=36 exp=28 -> 36 * 10^27.
function bigLiteralValue(mant: number, exp: number): bigint {
  return BigInt(mant) * 10n ** BigInt(Math.max(0, exp - 1));
}

// Clean, underscore-grouped bigint literal for a 2-sig-fig target value.
function bigLiteral(n: number): string {
  let v: bigint;
  if (n < 100) v = BigInt(Math.max(1, Math.ceil(n)));
  else {
    const exp = Math.floor(Math.log10(n));
    v = bigLiteralValue(Math.round(n / Math.pow(10, exp - 1)), exp);
  }
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_") + "n";
}

// Largest peak-score threshold T such that the fraction of `col` with peak >= T
// is >= keepFrac. `col` is sorted ascending. We want to KEEP keepFrac of the
// column, i.e. cull (1-keepFrac) from the bottom, so T is the (1-keepFrac)
// quantile of the column.
function thresholdForKeep(colAsc: number[], keepFrac: number): number {
  if (!colAsc.length) return 1;
  const cullFrac = Math.min(1, Math.max(0, 1 - keepFrac));
  const idx = Math.min(colAsc.length - 1, Math.floor(cullFrac * colAsc.length));
  return colAsc[idx];
}

const fmt = (n: number) =>
  n >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n));

// Solve a target curve from an ABSOLUTE survivor schedule. survive[r-1] is the
// fraction of the ORIGINAL population that should still be alive AFTER round r.
// We walk the rounds in order, each time conditioning on the runs still alive
// and picking the target that leaves the desired absolute fraction alive.
function solveCurve(pool: number[][], survive: number[]): number[] {
  const N = pool.length;
  const T = new Array(WIN_ROUND).fill(1);
  let alive = pool;
  let prevSurvivors = N;
  for (let r = 1; r <= WIN_ROUND; r++) {
    const wantAlive = Math.round(survive[r - 1] * N); // absolute survivors after round r
    const keepOfEntrants = prevSurvivors > 0 ? wantAlive / prevSurvivors : 0;
    const col = alive.map((p) => p[r - 1]).sort((a, b) => a - b);
    let t = thresholdForKeep(col, keepOfEntrants);
    t = round2sig(t);
    if (r > 1) t = Math.max(T[r - 2] + 1, t); // keep the curve strictly increasing
    T[r - 1] = t;
    alive = alive.filter((p) => p[r - 1] >= t);
    prevSurvivors = alive.length;
  }
  return T;
}

// Evaluate a concrete curve on the pool: per-round deaths + win rate, in both
// absolute (share of the whole field) and conditional (share of entrants) terms.
function report(label: string, pool: number[][], T: number[]): void {
  const N = pool.length;
  console.log(`\n=== ${label} ===`);
  console.log("curve = [" + T.join(", ") + "]");
  console.log(
    "round |   target |  entrants | died | die% field | die% entrants | survivors | field alive",
  );
  let alive = pool;
  for (let r = 1; r <= WIN_ROUND; r++) {
    const entrants = alive.length;
    const survivors = alive.filter((p) => p[r - 1] >= T[r - 1]);
    const died = entrants - survivors.length;
    console.log(
      `${String(r).padStart(5)} | ${fmt(T[r - 1]).padStart(8)} | ${String(entrants).padStart(9)} | ` +
        `${String(died).padStart(4)} | ${((died / N) * 100).toFixed(1).padStart(10)}% | ` +
        `${((died / Math.max(1, entrants)) * 100).toFixed(1).padStart(12)}% | ` +
        `${String(survivors.length).padStart(9)} | ${((survivors.length / N) * 100).toFixed(1).padStart(10)}%`,
    );
    alive = survivors;
  }
  console.log(
    `WIN RATE (reached round ${WIN_ROUND} and cleared it): ${((alive.length / N) * 100).toFixed(1)}%`,
  );
}

// ---- design intent ---------------------------------------------------------
// Absolute survivors after each round (fraction of the whole field):
//   r1-3 : gentle on-ramp down to ~60% alive entering round 4
//   r4-9 : ~5 percentage points of the field culled at each step
//   r10  : final wall culls ~8% of the field
const SURVIVE = [
  0.87, // r1
  0.73, // r2
  0.6, // r3  -> ~60% survive rounds 1-3
  0.55, // r4  -5%
  0.5, // r5  -5%
  0.45, // r6  -5%
  0.4, // r7  -5%
  0.35, // r8  -5%
  0.3, // r9  -5%
  0.22, // r10 -8% final wall  -> ~22% win rate
];

const peaks = collect();
const pool = SHOPPER_SERIES.flatMap((series) => peaks[series.id]);

console.log(
  `\nRUNS=${RUNS}/series · ${SHOPPER_SERIES.length} buying series · pooled field ${pool.length} · seed ${DEFAULT_CONFIG.seed}`,
);
console.log("target survivor schedule (% of field alive after each round):");
console.log(
  "  " + SURVIVE.map((s, i) => `r${i + 1}=${(s * 100).toFixed(0)}%`).join("  "),
);

const T = solveCurve(pool, SURVIVE);
report("DESIGNED curve", pool, T);

console.log("\nROUND_TARGETS (paste into src/config.ts, bigint literals):");
console.log("[" + T.map((t) => bigLiteral(t)).join(", ") + "]");

// Stash under a label so validate.ts can re-run it against REAL culling.
const candidatePath = "sim-out/candidate.json";
const curves = existsSync(candidatePath)
  ? JSON.parse(readFileSync(candidatePath, "utf8"))
  : {};
curves["DESIGNED (10-round intent)"] = T;
writeFileSync(candidatePath, JSON.stringify(curves, null, 2));
console.log(
  `\n(wrote curve to ${candidatePath} under "DESIGNED (10-round intent)")`,
);
console.log(
  'validate with real culling:  CURVE="DESIGNED (10-round intent)" npx tsx src/sim/validate.ts',
);
