// Validation pass for a candidate target curve (the "re-test" step).
//
// analyze.ts designs curves analytically from trivial-target trajectories. This
// script sets one of those curves as the live override and runs the REAL sim
// (actual survival gate + Last Call coupling + real culling), so it confirms the
// predicted death spread holds up, and regenerates sim-out/report.html against
// the new curve so it can be inspected in the browser.
//
// Run: npx tsx src/sim/validate.ts            (defaults to MEDIUM)
//      CURVE="HARD    (~5% bot win)" npx tsx src/sim/validate.ts
//
// Not shipped with the game; delete when balancing is done.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG } from './config';
import { installStorage, seedGlobalRandom } from './localStorageShim';
import { RunRecord, simulateRun, StrategyName } from './bot';
import { aggregate } from './stats';
import { buildReport } from './report';
import { setRoundTargets, WIN_ROUND } from '../config';

const STRATS: StrategyName[] = ['noBuy', 'random', 'greedy'];
const curves = JSON.parse(readFileSync('sim-out/candidate.json', 'utf8')) as Record<string, number[]>;
const label = process.env.CURVE ?? 'MEDIUM  (~12% bot win)';
const curve = curves[label];
if (!curve) throw new Error(`No curve "${label}" in candidate.json. Have: ${Object.keys(curves).join(' | ')}`);

seedGlobalRandom(DEFAULT_CONFIG.seed);
installStorage(DEFAULT_CONFIG.unlockedAtStart);
setRoundTargets(curve); // <-- the real survival gate now uses the candidate curve

console.log(`Validating "${label}" with REAL culling · ${DEFAULT_CONFIG.runs} runs/strategy`);
console.log('curve = [' + curve.join(', ') + ']\n');

const byStrategy = {} as Record<StrategyName, RunRecord[]>;
for (const name of STRATS) {
  const records: RunRecord[] = [];
  for (let i = 0; i < DEFAULT_CONFIG.runs; i++) {
    records.push(simulateRun(name, DEFAULT_CONFIG.seed * 1_000_003 + i + STRATS.indexOf(name) * 7919, DEFAULT_CONFIG));
  }
  byStrategy[name] = records;
  const wins = records.filter((r) => r.won).length;
  const hist = new Array(WIN_ROUND).fill(0);
  for (const r of records) hist[Math.min(WIN_ROUND, r.roundReached) - 1]++;
  const bars = hist.map((c, i) => (c > 0 ? `r${i + 1}=${c}` : '')).filter(Boolean).join('  ');
  console.log(`${name.padEnd(7)} win ${((wins / records.length) * 100).toFixed(1)}%  | deaths: ${bars}`);
}

const stats = aggregate(byStrategy, {
  seed: DEFAULT_CONFIG.seed,
  maxDice: DEFAULT_CONFIG.maxDice,
  unlockedAtStart: DEFAULT_CONFIG.unlockedAtStart
});
const out = resolve(process.cwd(), 'sim-out/report.html');
mkdirSync(resolve(process.cwd(), 'sim-out'), { recursive: true });
writeFileSync(out, buildReport(stats), 'utf8');
console.log(`\nRegenerated report against the candidate curve → ${out}`);
