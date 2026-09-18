// CLI entry for the balance simulation. Runs each shopper N times against both
// the base-only and all-unlocked item pools, aggregates, and writes a
// self-contained HTML report. Run with: npm run sim -- --runs=5000 --seed=1
//
// Flags (all optional; defaults from src/sim/config.ts):
//   --runs=N     runs per strategy
//   --seed=N     base RNG seed (reproducible)
//   --out=path   output HTML path (default sim-out/report.html)
//   SIM_WORKERS=N overrides the default bounded CPU worker count (use 1 for serial)

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { DEFAULT_CONFIG, GATED_ITEM_IDS, SimConfig } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { RunRecord, simulateRun } from "./bot";
import { aggregate } from "./stats";
import { buildReport } from "./report";
import { seriesConfig, seriesSeed, SIM_SERIES } from "./series";

interface RunJob {
  cfg: SimConfig;
  seriesIndex: number;
  runIndex: number;
  seed: number;
}

interface RunJobResult {
  seriesIndex: number;
  runIndex: number;
  record: RunRecord;
}

const WORKER_KIND = "order-sim-runner";

function runJob(job: RunJob): RunJobResult {
  const series = SIM_SERIES[job.seriesIndex];
  // Every job owns its fallback global RNG and storage. The simulation threads
  // the same seed through its explicit RNGs and into RunState, so scheduling a
  // job on a different worker cannot change its result.
  seedGlobalRandom(job.seed);
  installStorage([...series.unlockedAtStart]);
  return {
    seriesIndex: job.seriesIndex,
    runIndex: job.runIndex,
    record: simulateRun(
      series.strategy,
      job.seed,
      seriesConfig(job.cfg, series),
    ),
  };
}

function workerCount(jobCount: number): number {
  const requested = Number(process.env.SIM_WORKERS);
  const fallback = Math.max(1, Math.min(8, availableParallelism() - 1));
  const count =
    Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.max(1, Math.min(jobCount, Math.floor(count)));
}

async function runJobs(
  jobs: RunJob[],
  byStrategy: Record<string, RunRecord[]>,
): Promise<number> {
  const count = workerCount(jobs.length);
  if (count === 1) {
    for (const job of jobs) {
      const result = runJob(job);
      byStrategy[SIM_SERIES[result.seriesIndex].id][result.runIndex] =
        result.record;
    }
    return count;
  }

  await new Promise<void>((resolveJobs, rejectJobs) => {
    const workers: Worker[] = [];
    let next = 0;
    let completed = 0;
    let failed = false;

    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      for (const worker of workers) void worker.terminate();
      rejectJobs(error);
    };

    const assign = (worker: Worker) => {
      if (next < jobs.length) worker.postMessage(jobs[next++]);
      else worker.postMessage(null);
    };

    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL("./runBatchWorker.mjs", import.meta.url),
        {
          workerData: { kind: WORKER_KIND },
        },
      );
      workers.push(worker);
      worker.on("error", fail);
      worker.on("message", (result: RunJobResult) => {
        if (failed) return;
        byStrategy[SIM_SERIES[result.seriesIndex].id][result.runIndex] =
          result.record;
        completed += 1;
        if (completed === jobs.length) resolveJobs();
        assign(worker);
      });
      assign(worker);
    }
  });

  return count;
}

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

async function main(): Promise<void> {
  const { cfg, out } = parseArgs(process.argv.slice(2));

  console.log(
    `Simulating ${cfg.runs} runs × ${SIM_SERIES.length} series ` +
      `(base only vs all ${GATED_ITEM_IDS.length} gated items), seed ${cfg.seed}…`,
  );

  const byStrategy: Record<string, RunRecord[]> = {};
  const jobs: RunJob[] = [];
  for (let seriesIndex = 0; seriesIndex < SIM_SERIES.length; seriesIndex++) {
    const series = SIM_SERIES[seriesIndex];
    byStrategy[series.id] = new Array<RunRecord>(cfg.runs);
    for (let runIndex = 0; runIndex < cfg.runs; runIndex++) {
      jobs.push({
        cfg,
        seriesIndex,
        runIndex,
        seed: seriesSeed(cfg.seed, runIndex, series.seedOffset),
      });
    }
  }

  const t0 = Date.now();
  const workers = await runJobs(jobs, byStrategy);
  console.log(`  workers              → ${workers}`);
  for (const series of SIM_SERIES) {
    const records = byStrategy[series.id];
    const wins = records.filter((r) => r.won).length;
    const medRank = [...records]
      .map((r) => r.rankReached)
      .sort((a, b) => a - b)[Math.floor(records.length / 2)];
    const gold = Math.round(
      records.reduce((a, r) => a + r.goldEarned, 0) / records.length,
    );
    console.log(
      `  ${series.id.padEnd(20)} → win ${((wins / records.length) * 100).toFixed(1)}%  median rank ${medRank}  avg gold ${gold}`,
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

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  parentPort?.on("message", (job: RunJob | null) => {
    if (job === null) {
      parentPort?.close();
      return;
    }
    parentPort?.postMessage(runJob(job));
  });
} else if (isMainThread) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
