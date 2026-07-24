// CLI entry for the balance simulation. Runs each shopper N times against both
// the base-only and all-unlocked item pools, aggregates, and writes a
// self-contained HTML report. Run with: npm run sim -- --runs=5000 --seed=1
//
// Flags (all optional; defaults from src/sim/config.ts):
//   --runs=N     runs per strategy
//   --seed=N     base RNG seed (reproducible)
//   --out=path   output HTML path (default sim-out/report.html)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_CONFIG, GATED_ITEM_IDS, SimConfig } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { RunRecord, simulateRun } from "./bot";
import { aggregate } from "./stats";
import { buildReport } from "./report";
import { seriesSeed, SIM_SERIES } from "./series";

function parseArgs(argv: string[]): { cfg: SimConfig; out: string } {
  const cfg: SimConfig = {
    ...DEFAULT_CONFIG,
    unlockedAtStart: [...DEFAULT_CONFIG.unlockedAtStart],
  };
  let out = "sim-out/report.html";
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "runs") cfg.runs = Math.max(1, Number(val) | 0);
    else if (key === "seed") cfg.seed = Number(val) | 0;
    else if (key === "out") out = val;
  }
  return { cfg, out };
}

function main(): void {
  const { cfg, out } = parseArgs(process.argv.slice(2));

  console.log(
    `Simulating ${cfg.runs} runs × ${SIM_SERIES.length} series ` +
      `(base only vs all ${GATED_ITEM_IDS.length} gated items), seed ${cfg.seed}…`,
  );

  const byStrategy: Record<string, RunRecord[]> = {};
  const t0 = Date.now();
  for (const series of SIM_SERIES) {
    // Reset storage and fallback global randomness for every series. Matched
    // base/all pairs intentionally receive the same seed stream.
    seedGlobalRandom(cfg.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    const records: RunRecord[] = [];
    for (let i = 0; i < cfg.runs; i++) {
      records.push(
        simulateRun(
          series.strategy,
          seriesSeed(cfg.seed, i, series.seedOffset),
          cfg,
        ),
      );
    }
    byStrategy[series.id] = records;
    const wins = records.filter((r) => r.won).length;
    const medRound = [...records]
      .map((r) => r.roundReached)
      .sort((a, b) => a - b)[Math.floor(records.length / 2)];
    console.log(
      `  ${series.id.padEnd(12)} → win ${((wins / records.length) * 100).toFixed(1)}%  median round ${medRound}`,
    );
  }

  // Attribution sanity: per-item points must sum to the run's total score.
  let maxDrift = 0;
  let totalPoints = 0;
  for (const series of SIM_SERIES) {
    for (const r of byStrategy[series.id]) {
      const summed =
        Object.values(r.dicePoints).reduce((a, b) => a + b, 0) +
        Object.values(r.itemPoints).reduce((a, b) => a + b, 0);
      maxDrift = Math.max(maxDrift, Math.abs(summed - r.totalScore));
      totalPoints += r.totalScore;
    }
  }
  console.log(
    `Attribution check: Σ per-item vs Σ totalScore, max per-run drift ${maxDrift.toFixed(4)} ` +
      `over ${Math.round(totalPoints).toLocaleString()} total points (should be ~0, tiny float error from multiplier split OK).`,
  );

  const stats = aggregate(byStrategy, {
    seed: cfg.seed,
    unlockPools: [
      { name: "Base items only", gatedItems: 0 },
      { name: "All unlocked", gatedItems: GATED_ITEM_IDS.length },
    ],
  });

  // Top point-contributing items among winning runs, per strategy.
  for (const s of stats.strategies) {
    if (s.winningRuns === 0) continue;
    const top = s.itemPointRanking
      .slice(0, 5)
      .map((it) => `${it.label} ${Math.round(it.avgPoints)}`)
      .join(", ");
    console.log(`  ${s.name.padEnd(7)} top items/win: ${top}`);
  }
  const html = buildReport(stats);
  const outPath = resolve(process.cwd(), out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");

  console.log(
    `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Report → ${outPath}`,
  );
}

main();
