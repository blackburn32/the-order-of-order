// Fixed-point tuner for the goal curve, against REAL culling.
//
// designTargets.ts designs a curve from one non-culling pass. That pass is
// systematically optimistic about difficulty and pessimistic about income: with
// no clears, no trial pays for rolls left in hand and no Boss Trial pays its
// bonus, so the builds it measures are poorer than the builds a real run has.
// Its curve therefore lands far too easy — the first pass measured a 23% design
// win rate and a 65% real one.
//
// This closes the loop. Each iteration simulates the whole field under the
// current curve with culling ON, then re-picks every goal as the quantile of
// the peak scores of the runs that ACTUALLY ENTERED that trial. Survivors are
// richer, so the next curve is harder, so fewer survive — it converges in a
// handful of passes.
//
// Run: npx tsx src/sim/tuneCurve.ts
//      RUNS=400 ITERATIONS=8 npx tsx src/sim/tuneCurve.ts
//
// Not shipped with the game; delete when balancing is done.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTrialGoals, TRIALS_PER_RANK, WIN_RANK, WIN_TRIAL } from "../config";
import { DEFAULT_CONFIG } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { simulateRun } from "./bot";
import { seriesConfig, seriesSeed, SHOPPER_SERIES } from "./series";

const RUNS = Number(process.env.RUNS ?? 400);
const ITERATIONS = Number(process.env.ITERATIONS ?? 10);

// The same intent designTargets.ts states: absolute survivors after each rank,
// with a rank's cull weighted toward its Boss Trial.
const SURVIVE = [
  0.97, // rank 1 — a free on-ramp: peaks here are small integers, so any goal
  0.88, // rank 2   that culls at all culls almost everyone. The early ranks
  0.7, //  rank 3   teach the loop; they are not where runs are supposed to end.
  0.47, // rank 4
  0.25, // rank 5 — the win rate
];
const CULL_SHARE = [0.15, 0.3, 0.55];

/** Absolute fraction of the original field that should still be alive after
 *  each trial, derived from the per-rank schedule. */
function wantAliveAfter(): number[] {
  const out: number[] = [];
  for (let rank = 1; rank <= WIN_RANK; rank++) {
    const start = rank === 1 ? 1 : SURVIVE[rank - 2];
    const cull = start - SURVIVE[rank - 1];
    let consumed = 0;
    for (let inRank = 0; inRank < TRIALS_PER_RANK; inRank++) {
      consumed += CULL_SHARE[inRank];
      out.push(start - cull * consumed);
    }
  }
  return out;
}

function round2sig(n: number): number {
  if (n < 100) return Math.max(1, Math.ceil(n));
  const exp = Math.floor(Math.log10(n));
  const mant = Math.round(n / Math.pow(10, exp - 1));
  return Number(BigInt(mant) * 10n ** BigInt(Math.max(0, exp - 1)));
}

function bigLiteral(n: number): string {
  return round2sig(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "_")
    .concat("n");
}

/** Simulate the whole field under `curve`. Returns, for each trial, the peak
 *  scores of every run that entered it, plus the overall win count. */
function measure(curve: number[]): {
  peaks: number[][];
  wins: number;
  runs: number;
} {
  setTrialGoals(curve);
  const peaks: number[][] = Array.from({ length: WIN_TRIAL }, () => []);
  let wins = 0;
  let runs = 0;
  for (const series of SHOPPER_SERIES) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    for (let i = 0; i < RUNS; i++) {
      const rec = simulateRun(
        series.strategy,
        seriesSeed(DEFAULT_CONFIG.seed, i, series.seedOffset),
        seriesConfig(DEFAULT_CONFIG, series),
      );
      runs += 1;
      if (rec.won) wins += 1;
      for (const p of rec.trajectory) {
        if (p.trial <= WIN_TRIAL) peaks[p.trial - 1].push(p.trialScore);
      }
    }
  }
  return { peaks, wins, runs };
}

/** The goal that leaves `keepFrac` of a trial's entrants alive. */
function goalForKeep(peaksAsc: number[], keepFrac: number): number {
  if (!peaksAsc.length) return 1;
  const cull = Math.min(1, Math.max(0, 1 - keepFrac));
  const idx = Math.min(peaksAsc.length - 1, Math.floor(cull * peaksAsc.length));
  return Math.max(1, peaksAsc[idx]);
}

const want = wantAliveAfter();
let curve = new Array(WIN_TRIAL).fill(1);

console.log(
  `Tuning against real culling - ${RUNS} runs/series x ${SHOPPER_SERIES.length} series, ${ITERATIONS} iterations`,
);
console.log(
  "target win rate: " + (SURVIVE[WIN_RANK - 1] * 100).toFixed(0) + "%\n",
);

for (let iter = 1; iter <= ITERATIONS; iter++) {
  const { peaks, wins, runs } = measure(curve);
  const next = new Array(WIN_TRIAL).fill(1);

  for (let trial = 1; trial <= WIN_TRIAL; trial++) {
    const entrants = peaks[trial - 1].length;
    if (entrants === 0) {
      // Nobody reaches this deep yet; leave it where it is rather than
      // collapsing it to 1 and undoing the previous pass's work.
      next[trial - 1] = curve[trial - 1];
      continue;
    }
    const keep = Math.min(1, (want[trial - 1] * runs) / entrants);
    const asc = peaks[trial - 1].slice().sort((a, b) => a - b);
    let goal = round2sig(goalForKeep(asc, keep));
    // Monotonic per slot, not across the ladder — see designTargets.ts.
    if (trial > TRIALS_PER_RANK) {
      goal = Math.max(next[trial - TRIALS_PER_RANK - 1] + 1, goal);
    }
    next[trial - 1] = goal;
  }

  // Within a rank the goal must also rise, since the roll budget does.
  for (let trial = 2; trial <= WIN_TRIAL; trial++) {
    if ((trial - 1) % TRIALS_PER_RANK === 0) continue; // first of a rank
    next[trial - 1] = Math.max(next[trial - 1], next[trial - 2] + 1);
  }

  const winRate = runs ? wins / runs : 0;
  console.log(
    `iter ${String(iter).padStart(2)}  win ${(winRate * 100).toFixed(1).padStart(5)}%  curve [${curve.join(", ")}]`,
  );
  curve = next;
}

setTrialGoals(curve);
const final = measure(curve);
console.log(
  `\nfinal    win ${((final.wins / final.runs) * 100).toFixed(1)}%  curve [${curve.join(", ")}]`,
);

console.log("\nper-trial attrition under this curve:");
console.log("trial | rank |     goal | entrants | died | die% field");
for (let trial = 1; trial <= WIN_TRIAL; trial++) {
  const entrants = final.peaks[trial - 1].length;
  const survivors =
    trial === WIN_TRIAL ? final.wins : (final.peaks[trial]?.length ?? 0);
  const died = entrants - survivors;
  console.log(
    `${String(trial).padStart(5)} | ${String(Math.ceil(trial / TRIALS_PER_RANK)).padStart(4)} | ` +
      `${curve[trial - 1].toLocaleString().padStart(8)} | ${String(entrants).padStart(8)} | ` +
      `${String(died).padStart(4)} | ${((died / final.runs) * 100).toFixed(1).padStart(9)}%`,
  );
}

console.log("\nTRIAL_GOALS (paste into src/config.ts):");
for (let rank = 1; rank <= WIN_RANK; rank++) {
  const slice = curve.slice(
    (rank - 1) * TRIALS_PER_RANK,
    rank * TRIALS_PER_RANK,
  );
  console.log(`  // rank ${rank}`);
  console.log("  " + slice.map(bigLiteral).join(",\n  ") + ",");
}

setTrialGoals(null);
const candidatePath = "sim-out/candidate.json";
const curves = existsSync(candidatePath)
  ? JSON.parse(readFileSync(candidatePath, "utf8"))
  : {};
curves["TUNED (real culling)"] = curve;
writeFileSync(candidatePath, JSON.stringify(curves, null, 2));
console.log(
  '\n(wrote curve to sim-out/candidate.json under "TUNED (real culling)")',
);
console.log(
  'confirm with:  CURVE="TUNED (real culling)" npx tsx src/sim/validate.ts',
);
