/**
 * Confirms the bucket-native pool didn't change game behaviour.
 *   npx tsx src/sim/parityCheck.ts
 *
 * Runs the same seeds twice: once with the real bucket threshold, once with the
 * threshold forced sky-high so every grid stays per-die (the pre-refactor path).
 * A run whose grid never crosses the real threshold consumes RNG identically in
 * both modes, so its outcome must match EXACTLY. Runs that do cross diverge (the
 * bucket path samples face histograms instead of rolling each die) — those we
 * only expect to agree in aggregate, which the summary at the end checks.
 */
import { setBucketThreshold, BUCKET_THRESHOLD } from '../systems/DicePool';
import { simulateRun } from './bot';
import { DEFAULT_CONFIG } from './config';

function run(seed: number, threshold: number) {
  setBucketThreshold(threshold);
  return simulateRun('greedy', seed, DEFAULT_CONFIG);
}

const N = 50;
let exactChecked = 0;
let exactMatches = 0;
let crossed = 0;
let winsReal = 0;
let winsList = 0;
let scoreReal = 0;
let scoreList = 0;

for (let seed = 1; seed <= N; seed++) {
  const real = run(seed, BUCKET_THRESHOLD);
  const list = run(seed, Number.MAX_SAFE_INTEGER);

  winsReal += real.won ? 1 : 0;
  winsList += list.won ? 1 : 0;
  scoreReal += real.totalScore;
  scoreList += list.totalScore;

  // Did the real-threshold run ever bucket? Its peak dice count is unknown after
  // the fact, but if neither run bucketed they share an RNG stream and must match.
  const stayedSmall = real.finalDiceTotal < BUCKET_THRESHOLD && list.finalDiceTotal < BUCKET_THRESHOLD;
  if (stayedSmall) {
    exactChecked++;
    const same = real.totalScore === list.totalScore && real.roundReached === list.roundReached && real.won === list.won;
    if (same) exactMatches++;
    else console.log(`  seed ${seed}: MISMATCH (small run) real=${real.totalScore}/${real.roundReached} list=${list.totalScore}/${list.roundReached}`);
  } else {
    crossed++;
  }
}

console.log('\n=== Parity: bucket threshold vs forced per-die ===\n');
console.log(`seeds: ${N}   never-bucketed (exact-match required): ${exactChecked}   bucketed at some point: ${crossed}`);
console.log(`exact matches among small runs: ${exactMatches}/${exactChecked}  ${exactMatches === exactChecked ? '✓' : '✗ REGRESSION'}`);
console.log('\nAggregate (should be close; bucketed runs sample, so not identical):');
console.log(`  win rate   real=${(100 * winsReal / N).toFixed(1)}%   list=${(100 * winsList / N).toFixed(1)}%`);
console.log(`  Σ score    real=${scoreReal.toExponential(4)}   list=${scoreList.toExponential(4)}   ratio=${(scoreReal / scoreList).toFixed(3)}`);
