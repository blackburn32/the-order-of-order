// Throwaway: compare the recorded totalScore distribution between Normal and
// Hard mode for the pooled buying field, using identical seeds so it's a fair
// A/B. Answers "do hard-mode runs post systematically higher scores?" (i.e.
// would they dominate a shared leaderboard).
//
// Run: RUNS=5000 npx tsx src/sim/scoreCompare.ts
// Not shipped; delete when done.

import { DEFAULT_CONFIG } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { RunRecord, simulateRun } from "./bot";
import { seriesSeed, SHOPPER_SERIES } from "./series";
import { setHardMultipliers } from "../config";

const RUNS = Number(process.env.RUNS ?? 5000);

function runField(hardMode: boolean): RunRecord[] {
  const cfg = { ...DEFAULT_CONFIG, runs: RUNS, hardMode };
  const pooled: RunRecord[] = [];
  for (const series of SHOPPER_SERIES) {
    seedGlobalRandom(cfg.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    for (let i = 0; i < RUNS; i++) {
      pooled.push(
        simulateRun(series.strategy, seriesSeed(cfg.seed, i, series.seedOffset), cfg),
      );
    }
  }
  return pooled;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function fmt(n: number): string {
  return n.toExponential(2);
}

function summarize(label: string, records: RunRecord[]): void {
  const all = records.map((r) => r.totalScore).sort((a, b) => a - b);
  const winners = records
    .filter((r) => r.won)
    .map((r) => r.totalScore)
    .sort((a, b) => a - b);
  console.log(
    `${label.padEnd(8)} n=${records.length} winners=${winners.length} ` +
      `(${((winners.length / records.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  all runs   p50=${fmt(pct(all, 50))} p90=${fmt(pct(all, 90))} ` +
      `p99=${fmt(pct(all, 99))} max=${fmt(all[all.length - 1] ?? 0)}`,
  );
  console.log(
    `  winners    p50=${fmt(pct(winners, 50))} p90=${fmt(pct(winners, 90))} ` +
      `p99=${fmt(pct(winners, 99))} max=${fmt(winners[winners.length - 1] ?? 0)}`,
  );
  // Top-10 leaderboard proxy: the highest scores that would actually show up.
  const top = all.slice(-10).reverse().map(fmt).join(", ");
  console.log(`  top 10     ${top}`);
}

console.log(`Score comparison · ${RUNS} runs/series · pooled buying field\n`);

setHardMultipliers(null, null);
summarize("Normal", runField(false));
console.log();
setHardMultipliers(null, null); // hard uses the shipped 2.45 / 1.25 constants
summarize("Hard", runField(true));
