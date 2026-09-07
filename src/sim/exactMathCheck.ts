// Executable spec for the engine-independent math in systems/ExactMath.ts, and
// for the two places the game's own arithmetic had to stop using floats.
//
// Run: npm run math:check
//
// What these assertions protect is narrow and load-bearing: a seeded run has to
// replay to the same score on a different device. Every check here is really the
// same question asked of a different function — does this produce a value that
// depends only on IEEE 754, which every engine implements identically, rather
// than on a transcendental, which none of them are obliged to agree about?

import { trialGoal, WIN_TRIAL, ENDLESS_BASE, ENDLESS_ACCEL } from "../config";
import { ln, probit } from "../systems/ExactMath";
import { sampleFaceCounts } from "../systems/ScoringHistogram";
import { mulberry32 } from "./localStorageShim";

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok     ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL   ${message}`);
  }
}

console.log("ExactMath.ln");
{
  let worst = 0;
  for (let i = 1; i < 500_000; i++) {
    const x = i / 500_000;
    const rel =
      Math.abs(ln(x) - Math.log(x)) / Math.max(1e-300, Math.abs(Math.log(x)));
    if (rel > worst) worst = rel;
  }
  check(
    worst < 1e-14,
    `tracks Math.log to ${worst.toExponential(2)} relative across (0, 1)`,
  );
  check(ln(1) === 0 && ln(2) === Math.LN2, "is exact at 1 and 2");
  check(
    Math.abs(ln(5e-324) - Math.log(5e-324)) < 1e-12,
    "handles the smallest subnormal, which has no implicit leading bit",
  );
}

console.log("ExactMath.probit against published normal quantiles");
{
  const quantiles: [number, number][] = [
    [0.5, 0],
    [0.975, 1.959963984540054],
    [0.001, -3.090232306167813],
    [0.99, 2.3263478740408408],
    [1e-8, -5.612001244174789],
    [1e-15, -7.941345326170998],
  ];
  for (const [p, want] of quantiles)
    check(
      Math.abs(probit(p) - want) < 1e-13,
      `probit(${p}) = ${probit(p).toPrecision(16)}`,
    );
  check(probit(0.3) === -probit(0.7), "is symmetric about the median");
}

// The bucketed roll path. Above BUCKET_THRESHOLD the grid is never rolled die by
// die; these samples ARE the roll, so a drift here is a drift in every score.
console.log("sampleFaceCounts still samples the right distribution");
for (const [n, faces] of [
  [5_000, 6],
  [500_000, 6],
  [5_000_000, 20],
] as const) {
  const runs = 4_000;
  const rng = mulberry32(99);
  let sum = 0;
  let squares = 0;
  let misTotalled = 0;
  for (let r = 0; r < runs; r++) {
    const counts = sampleFaceCounts(n, faces, rng);
    if (counts.reduce((a, b) => a + b, 0) !== n) misTotalled += 1;
    sum += counts[0];
    squares += counts[0] * counts[0];
  }
  const mean = sum / runs;
  const sd = Math.sqrt(squares / runs - mean * mean);
  const exactMean = n / faces;
  const exactSd = Math.sqrt(n * (1 / faces) * (1 - 1 / faces));
  check(misTotalled === 0, `n=${n} faces=${faces}: every sample sums to n`);
  check(
    Math.abs(mean - exactMean) < (4 * exactSd) / Math.sqrt(runs),
    `  mean ${mean.toFixed(1)} matches the exact ${exactMean.toFixed(1)}`,
  );
  check(
    Math.abs(sd - exactSd) / exactSd < 0.05,
    `  sd ${sd.toFixed(2)} matches the exact ${exactSd.toFixed(2)}`,
  );
}

console.log("the same stream produces the same roll");
check(
  JSON.stringify(sampleFaceCounts(3_000_000, 12, mulberry32(7))) ===
    JSON.stringify(sampleFaceCounts(3_000_000, 12, mulberry32(7))),
  "sampleFaceCounts is a pure function of its stream",
);

// The endless ladder was walked in floating point until the goals had to be
// reproducible. The integer walk has to agree with it everywhere the float
// version was still trustworthy, or this is a balance change wearing a fix's
// clothes.
console.log("the endless goal ladder is unchanged where the floats were sound");
{
  const upTo = WIN_TRIAL + 500;
  let value = trialGoal(WIN_TRIAL);
  let firstDivergence = -1;
  for (let t = WIN_TRIAL + 1; t <= upTo; t++) {
    const exponent = 1 + (t - 1 - WIN_TRIAL) * ENDLESS_ACCEL;
    value =
      (value * BigInt(Math.round(ENDLESS_BASE ** exponent * 1000))) / 1000n;
    if (trialGoal(t) !== value && firstDivergence < 0) firstDivergence = t;
  }
  check(
    firstDivergence < 0,
    `identical to the old float ladder for all ${upTo - WIN_TRIAL} endless trials checked`,
  );
  check(
    trialGoal(WIN_TRIAL + 1) > trialGoal(WIN_TRIAL),
    "and still climbs past the finish line",
  );
}

console.log(
  failures === 0
    ? "\nExact-math check: ALL PASS"
    : `\nExact-math check: ${failures} FAILURE(S)`,
);
if (failures > 0) process.exit(1);
