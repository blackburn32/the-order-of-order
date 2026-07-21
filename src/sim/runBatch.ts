// CLI entry for the balance simulation. Runs every strategy N times against the
// configured (editable) unlock pool, aggregates, and writes a self-contained
// HTML report. Run with:  npm run sim -- --runs=5000 --seed=1
//
// Flags (all optional; defaults from src/sim/config.ts):
//   --runs=N     runs per strategy
//   --seed=N     base RNG seed (reproducible)
//   --out=path   output HTML path (default sim-out/report.html)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_CONFIG, MAX_DICE_IN_GRID_UNLOCK, SimConfig } from './config';
import { installStorage, seedGlobalRandom } from './localStorageShim';
import { RunRecord, simulateRun, StrategyName } from './bot';
import { aggregate } from './stats';
import { buildReport } from './report';

const STRATEGIES: StrategyName[] = ['noBuy', 'random', 'greedy'];

function parseArgs(argv: string[]): { cfg: SimConfig; out: string } {
  const cfg: SimConfig = { ...DEFAULT_CONFIG, unlockedAtStart: [...DEFAULT_CONFIG.unlockedAtStart] };
  let out = 'sim-out/report.html';
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'runs') cfg.runs = Math.max(1, Number(val) | 0);
    else if (key === 'seed') cfg.seed = Number(val) | 0;
    else if (key === 'maxDice') cfg.maxDice = Math.max(1, Number(val) | 0);
    else if (key === 'out') out = val;
  }
  return { cfg, out };
}

function main(): void {
  const { cfg, out } = parseArgs(process.argv.slice(2));

  // Reproducible global RNG (covers effects that call Math.random directly) and
  // an in-memory localStorage seeded with the configured unlocked-items set.
  seedGlobalRandom(cfg.seed);
  installStorage(cfg.unlockedAtStart);

  if (cfg.maxDice <= MAX_DICE_IN_GRID_UNLOCK) {
    console.warn(
      `WARNING: --maxDice=${cfg.maxDice} is not above the largest diceInGrid unlock ` +
        `threshold (${MAX_DICE_IN_GRID_UNLOCK}); that unlock's likelihood will read as an ` +
        `artifactual 0%. Use --maxDice=${MAX_DICE_IN_GRID_UNLOCK + 1000} or higher.`
    );
  }

  console.log(
    `Simulating ${cfg.runs} runs × ${STRATEGIES.length} strategies ` +
      `(${STRATEGIES.join(', ')}), seed ${cfg.seed}, ${cfg.unlockedAtStart.length} gated items in pool…`
  );

  const byStrategy = {} as Record<StrategyName, RunRecord[]>;
  const t0 = Date.now();
  for (const name of STRATEGIES) {
    const records: RunRecord[] = [];
    for (let i = 0; i < cfg.runs; i++) {
      // Distinct, seed-derived per-run stream so strategies stay comparable.
      records.push(simulateRun(name, cfg.seed * 1_000_003 + i + STRATEGIES.indexOf(name) * 7_919, cfg));
    }
    byStrategy[name] = records;
    const wins = records.filter((r) => r.won).length;
    const medRound = [...records].map((r) => r.roundReached).sort((a, b) => a - b)[Math.floor(records.length / 2)];
    console.log(`  ${name.padEnd(7)} → win ${((wins / records.length) * 100).toFixed(1)}%  median round ${medRound}`);
  }

  const stats = aggregate(byStrategy, {
    seed: cfg.seed,
    maxDice: cfg.maxDice,
    unlockedAtStart: cfg.unlockedAtStart
  });
  const html = buildReport(stats);
  const outPath = resolve(process.cwd(), out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Report → ${outPath}`);
}

main();
