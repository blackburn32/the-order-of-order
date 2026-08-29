// Goal-curve designer for the full ladder (throwaway balancing tooling).
//
// Captures each run's per-trial PEAK score once against trivial goals (so nobody
// is culled and every run reaches the last trial), then designs a goal curve
// analytically from an explicit ABSOLUTE survivor schedule: S[r] = the fraction
// of the ORIGINAL field still alive after rank r. That matches how the balancing
// intent is actually stated ("~85% survive rank 1", "rank 5 is the ~23% win").
//
// Within a rank the cull is split across the three trials by CULL_SHARE below,
// weighted toward the Boss Trial — its modifier is already doing work, and a
// Lesser Trial that kills is one the player never got a shop to prepare for.
//
// Run: npx tsx src/sim/designTargets.ts
//
// Not shipped with the game; delete when balancing is done.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { simulateRun } from "./bot";
import { setCulling } from "./engine";
import { seriesConfig, seriesSeed, SHOPPER_SERIES } from "./series";
import { setTrialGoals, TRIALS_PER_RANK, WIN_RANK, WIN_TRIAL } from "../config";

const RUNS = Number(process.env.RUNS ?? 3000);
// v3 = ranks/trials/gold. The v2 cache measured the ten-round game and cannot be
// reused, so the filename changes with the shape of the run.
const CACHE = `sim-out/trajectories-v3-${RUNS}.json`;

type Peaks = Record<string, number[][]>;

function collect(): Peaks {
  if (existsSync(CACHE)) {
    console.log(`(loaded cached trajectories from ${CACHE})`);
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
  // Unreachable goals + no culling: every run plays every trial to the end of
  // their roll budgets, so `trialScore` is the true capacity of that build at
  // that point on the ladder. A LOW goal would not do — the trial would end on
  // its first scoring roll and every peak would be 1.
  setTrialGoals(new Array(WIN_TRIAL).fill(Number.MAX_SAFE_INTEGER));
  setCulling(false);

  const out: Peaks = {};
  for (const series of SHOPPER_SERIES) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    const runs: number[][] = [];
    for (let i = 0; i < RUNS; i++) {
      const rec = simulateRun(
        series.strategy,
        seriesSeed(DEFAULT_CONFIG.seed, i, series.seedOffset),
        seriesConfig(DEFAULT_CONFIG, series),
      );
      const peaks = new Array(WIN_TRIAL).fill(0);
      for (const p of rec.trajectory) {
        if (p.trial <= WIN_TRIAL) peaks[p.trial - 1] = p.trialScore;
      }
      runs.push(peaks);
    }
    out[series.id] = runs;
  }
  setTrialGoals(null);
  setCulling(true);
  writeFileSync(CACHE, JSON.stringify(out));
  console.log(`(cached trajectories to ${CACHE})`);
  return out;
}

// Round a goal to 2 significant figures. Reconstructed from the mantissa/
// exponent digits so the value is a CLEAN round number (36_000...000), not a
// float-tailed approximation — important once goals reach 1e28+ where doubles
// can't represent the intended integer exactly.
function round2sig(n: number): number {
  if (n < 100) return Math.max(1, Math.ceil(n));
  const exp = Math.floor(Math.log10(n));
  const mant = Math.round(n / Math.pow(10, exp - 1)); // 10..100
  return Number(bigLiteralValue(mant, exp));
}

function bigLiteralValue(mant: number, exp: number): bigint {
  return BigInt(mant) * 10n ** BigInt(Math.max(0, exp - 1));
}

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
// is >= keepFrac. `col` is sorted ascending.
function thresholdForKeep(colAsc: number[], keepFrac: number): number {
  if (!colAsc.length) return 1;
  const cullFrac = Math.min(1, Math.max(0, 1 - keepFrac));
  const idx = Math.min(colAsc.length - 1, Math.floor(cullFrac * colAsc.length));
  return colAsc[idx];
}

const fmt = (n: number) =>
  n >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n));

// How a rank's cull is divided between its three trials. The Lesser Trial is
// nearly free — it follows a Boss Trial with only one shop in between — and the
// Boss Trial carries most of the weight.
const CULL_SHARE = [0.15, 0.3, 0.55];

/**
 * Solve a goal curve from an ABSOLUTE survivor schedule over RANKS.
 * `survive[r-1]` is the fraction of the ORIGINAL field that should still be
 * alive after rank r. Walks the ladder in order, conditioning on the runs still
 * alive, and picks the goal that leaves the intended fraction alive at each
 * trial.
 */
function solveCurve(pool: number[][], survive: number[]): number[] {
  const N = pool.length;
  const T = new Array(WIN_TRIAL).fill(1);
  let alive = pool;

  for (let rank = 1; rank <= WIN_RANK; rank++) {
    const startOfRank = rank === 1 ? 1 : survive[rank - 2];
    const rankCull = startOfRank - survive[rank - 1];

    for (let inRank = 1; inRank <= TRIALS_PER_RANK; inRank++) {
      const trial = (rank - 1) * TRIALS_PER_RANK + inRank;
      // Absolute survivors wanted after this trial: walk down from the rank's
      // starting share by this trial's slice of the rank's cull.
      const consumed = CULL_SHARE.slice(0, inRank).reduce((a, b) => a + b, 0);
      const wantAlive = Math.round((startOfRank - rankCull * consumed) * N);
      const keepOfEntrants = alive.length > 0 ? wantAlive / alive.length : 0;

      const col = alive.map((p) => p[trial - 1]).sort((a, b) => a - b);
      let t = round2sig(thresholdForKeep(col, keepOfEntrants));
      // Monotonic per SLOT, not across the whole ladder. A Lesser Trial has
      // seven rolls where the Boss Trial before it had twenty, so its goal
      // genuinely should be lower — forcing the whole curve upward instead
      // flattens each rank into a plateau and then jumps. What must always rise
      // is the same slot rank over rank: this rank's Lesser Trial is harder than
      // the last one's.
      if (trial > TRIALS_PER_RANK) {
        t = Math.max(T[trial - TRIALS_PER_RANK - 1] + 1, t);
      }
      T[trial - 1] = t;
      alive = alive.filter((p) => p[trial - 1] >= t);
    }
  }
  return T;
}

function report(label: string, pool: number[][], T: number[]): void {
  const N = pool.length;
  console.log(`\n=== ${label} ===`);
  console.log(
    "trial | rank |     goal | entrants | died | die% field | survivors | field alive",
  );
  let alive = pool;
  for (let trial = 1; trial <= WIN_TRIAL; trial++) {
    const rank = Math.ceil(trial / TRIALS_PER_RANK);
    const entrants = alive.length;
    const survivors = alive.filter((p) => p[trial - 1] >= T[trial - 1]);
    const died = entrants - survivors.length;
    console.log(
      `${String(trial).padStart(5)} | ${String(rank).padStart(4)} | ${fmt(T[trial - 1]).padStart(8)} | ` +
        `${String(entrants).padStart(8)} | ${String(died).padStart(4)} | ` +
        `${((died / N) * 100).toFixed(1).padStart(10)}% | ` +
        `${String(survivors.length).padStart(9)} | ${((survivors.length / N) * 100).toFixed(1).padStart(10)}%`,
    );
    alive = survivors;
  }
  console.log(
    `WIN RATE (cleared rank ${WIN_RANK}): ${((alive.length / N) * 100).toFixed(1)}%`,
  );
}

// ---- design intent ---------------------------------------------------------
// Absolute survivors after each RANK (fraction of the whole field):
const SURVIVE = [
  0.97, // rank 1 — a free on-ramp: peaks here are small integers, so any goal
  0.88, // rank 2   that culls at all culls almost everyone. The early ranks
  0.7, //  rank 3   teach the loop; they are not where runs are supposed to end.
  0.47, // rank 4
  0.25, // rank 5 — the win rate
];

const peaks = collect();
const pool = SHOPPER_SERIES.flatMap((series) => peaks[series.id]);

console.log(
  `\nRUNS=${RUNS}/series - ${SHOPPER_SERIES.length} series - pooled field ${pool.length} - seed ${DEFAULT_CONFIG.seed}`,
);
console.log("target survivor schedule (% of field alive after each rank):");
console.log(
  "  " +
    SURVIVE.map((s, i) => `rank${i + 1}=${(s * 100).toFixed(0)}%`).join("  "),
);
console.log(
  `within a rank, cull split Lesser/Greater/Boss = ${CULL_SHARE.map((c) => `${Math.round(c * 100)}%`).join("/")}`,
);

const T = solveCurve(pool, SURVIVE);
report("DESIGNED curve", pool, T);

console.log("\nTRIAL_GOALS (paste into src/config.ts, bigint literals):");
for (let rank = 1; rank <= WIN_RANK; rank++) {
  const slice = T.slice((rank - 1) * TRIALS_PER_RANK, rank * TRIALS_PER_RANK);
  console.log(`  // rank ${rank}`);
  console.log("  " + slice.map(bigLiteral).join(",\n  ") + ",");
}

// Stash under a label so validate.ts can re-run it against REAL culling.
const candidatePath = "sim-out/candidate.json";
const curves = existsSync(candidatePath)
  ? JSON.parse(readFileSync(candidatePath, "utf8"))
  : {};
curves["DESIGNED (5-rank intent)"] = T;
writeFileSync(candidatePath, JSON.stringify(curves, null, 2));
console.log(
  `\n(wrote curve to ${candidatePath} under "DESIGNED (5-rank intent)")`,
);
console.log(
  'validate with real culling:  CURVE="DESIGNED (5-rank intent)" npx tsx src/sim/validate.ts',
);
