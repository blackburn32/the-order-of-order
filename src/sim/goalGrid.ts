// The strategy grid shared by the goal search and its validation pass.
//
// A grid point is one way of playing the game: a bot strategy, the unlock pool
// it shops from, how willing it is to take a cursed card, and the novice it is
// played as. A grid is the cross product of those axes, and every grid point
// plays the SAME seed for a given seed index — so on any one seed the grid's
// spread is the spread of play, not of luck (the first trial, before any shop
// has been visited, is literally identical across the whole grid).
//
// Two modes run the grid:
//
//   search    goals removed. Every trial plays its whole roll budget, nothing
//             is culled, and every trial counts as cleared on its final roll —
//             it pays its base gold, interest, item gold and Boss bonus, and
//             the next shop gets the Boss boon. No trial ends with rolls in
//             hand, so the unused-roll payout is replaced by an assumed
//             early-completion bonus (`CLEAR_GOLD`, default 1-3 gold a trial).
//             What each trial scores is what that build COULD score.
//   validate  goals on, real culling: the game as shipped (or as a candidate
//             table describes it), measuring who survives.
//
// Axes are read from the environment so a pass is described on its command
// line rather than by editing this file:
//
//   GRID_STRATEGIES  comma list of StrategyName (default: every bot but the
//                    expert, which costs ~100x the rest per run)
//   GRID_POOLS       all,none (default all — the fully unlocked shop)
//   GRID_APPETITES   curse appetites (default 0,0.5,1). The player bot refuses
//                    every curse by rule, so it gets one point, not three.
//   GRID_CHARACTERS  diebert,melodie,roland (default diebert)
//   SIM_WORKERS      worker threads (default cores - 1, at most 8)
//
// The grid is run through worker threads by `runGrid`; `goalGridWorker.mjs`
// boots this module inside each one.

import { availableParallelism } from "node:os";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import {
  setTrialGoals,
  setTrialRollCadenceForSimulation,
  WIN_TRIAL,
  type TrialRollCadence,
} from "../config";
import {
  CHARACTER_ORDER,
  DEFAULT_CHARACTER,
  isCharacterId,
  type CharacterId,
} from "../systems/Characters";
import { DEFAULT_CONFIG, SimConfig, UNLOCK_POOLS } from "./config";
import type { ShopItemId } from "../systems/Items";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { simulateRun, type StrategyName } from "./bot";
import { setCulling, setFullBudgetAllTrials } from "./engine";
import { ITEM_TREES, type TreeId } from "../systems/ItemTrees";

export const ALL_GRID_STRATEGIES: StrategyName[] = [
  "greedy",
  "thrifty",
  "swarm",
  "multiplier",
  "precision",
  "economy",
  "tempo",
  "player",
  "lessons",
  "resonance",
  "treasury",
  "canticle",
  "weighing",
  "pyre",
  "hermitage",
  "expert",
];

/** Bots that ignore the appetite axis entirely (they refuse every curse by a
 *  rule of their own), so running them at three appetites would count one
 *  strategy three times. */
const APPETITE_BLIND: ReadonlySet<StrategyName> = new Set(["player"]);

export interface GridPoint {
  id: string;
  strategy: StrategyName;
  pool: "all" | "none";
  curseAppetite: number;
  character: CharacterId;
}

function listEnv(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The grid this process was asked for (see the env table at the top). */
export function gridFromEnv(): GridPoint[] {
  const strategies = listEnv(
    "GRID_STRATEGIES",
    ALL_GRID_STRATEGIES.filter((s) => s !== "expert").join(","),
  );
  for (const s of strategies) {
    if (!ALL_GRID_STRATEGIES.includes(s as StrategyName))
      throw new Error(
        `GRID_STRATEGIES: "${s}" is not a strategy. One of: ${ALL_GRID_STRATEGIES.join(", ")}`,
      );
  }
  const pools = listEnv("GRID_POOLS", "all");
  for (const p of pools) {
    if (p !== "all" && p !== "none")
      throw new Error(`GRID_POOLS: "${p}" is not a pool. Use all or none.`);
  }
  const appetites = listEnv("GRID_APPETITES", "0,0.5,1").map(Number);
  const characters = listEnv("GRID_CHARACTERS", DEFAULT_CHARACTER);
  for (const c of characters) {
    if (!isCharacterId(c))
      throw new Error(
        `GRID_CHARACTERS: "${c}" is not a character. One of: ${CHARACTER_ORDER.join(", ")}`,
      );
  }

  const grid: GridPoint[] = [];
  for (const character of characters as CharacterId[]) {
    for (const strategy of strategies as StrategyName[]) {
      for (const pool of pools as ("all" | "none")[]) {
        const ladder = APPETITE_BLIND.has(strategy) ? [0] : appetites;
        for (const curseAppetite of ladder) {
          const parts: string[] = [strategy, pool];
          if (!APPETITE_BLIND.has(strategy)) parts.push(`a${curseAppetite}`);
          if (character !== DEFAULT_CHARACTER) parts.push(character);
          grid.push({
            id: parts.join("/"),
            strategy,
            pool,
            curseAppetite,
            character,
          });
        }
      }
    }
  }
  return grid;
}

/** The seed every grid point plays for seed index `i` of a pass. */
export function gridSeed(baseSeed: number, i: number): number {
  return baseSeed * 1_000_003 + i;
}

// ---- one job ---------------------------------------------------------------

export interface GridJob {
  mode: "search" | "validate";
  point: GridPoint;
  seedIndex: number;
  seed: number;
  /** The goal table the validate pass plays against (index = trial - 1), or
   *  null for the live table in config.ts. Ignored by search. */
  goals: (bigint | null)[] | null;
  /** Roll cadence override (Lesser, Greater, Boss), or null for the live one. */
  cadence: TrialRollCadence | null;
  /** Search only: assumed early-completion gold per trial, [min, max]. */
  clearGold: readonly [number, number] | null;
}

/** One trial of one run, as compactly as the passes need it. */
export interface GridTrial {
  trial: number;
  /** log10 of the trial's peak score (-1 for zero; see bot.scoreLog10). */
  log10: number;
  cleared: boolean;
  rollsUsed: number;
  budget: number;
  clearedOnRoll: number | null;
  /** Gold in the purse as the trial ended, after its payout — what the next
   *  shop opens with (before the search's assumed bonus). */
  goldAfter: number;
  /** The Boss modifier in force, if any (the first, when there are two). */
  boss: string | null;
  /** Search only: the cumulative score after each roll, as log10. */
  rolls?: number[];
}

export interface GridResult {
  pointId: string;
  seedIndex: number;
  won: boolean;
  trialReached: number;
  goldEarned: number;
  trials: GridTrial[];
  /** Every strategy tree's engine (its tier-3 card) the run came to own, with
   *  the first trial it was owned going into. Engines compound for the rest of
   *  the run, so WHEN one arrived explains much of a late score. */
  engines: { tree: TreeId; trial: number }[];
}

/** Each tree's engine card — the third link of its chain — to its tree. */
const ENGINE_TREE = new Map<string, TreeId>(
  ITEM_TREES.map((tree) => [tree.nodes[2].id, tree.id]),
);

function applyMode(job: GridJob): void {
  setTrialRollCadenceForSimulation(job.cadence);
  if (job.mode === "search") {
    // A goal of zero is met by the first roll whatever it scores, so every
    // trial is latched as cleared (paying the Boss bonus and boon) while the
    // full-budget switch makes it play on to its last roll regardless.
    setTrialGoals(new Array<bigint>(WIN_TRIAL).fill(0n));
    setFullBudgetAllTrials(true);
    setCulling(false);
  } else {
    setTrialGoals(job.goals);
    setFullBudgetAllTrials(false);
    setCulling(true);
  }
}

export function runGridJob(job: GridJob): GridResult {
  applyMode(job);
  seedGlobalRandom(job.seed);
  installStorage([...UNLOCK_POOLS[job.point.pool]]);
  const engines: GridResult["engines"] = [];
  const cfg: SimConfig = {
    ...DEFAULT_CONFIG,
    unlockedAtStart: [...UNLOCK_POOLS[job.point.pool]],
    curseAppetite: job.point.curseAppetite,
    character: job.point.character,
    traceRollsLog10: job.mode === "search",
    assumedClearGold:
      job.mode === "search" ? (job.clearGold ?? undefined) : undefined,
    onTrialStart: (state) => {
      for (const [id, tree] of ENGINE_TREE) {
        if ((state.purchases[id as ShopItemId] ?? 0) === 0) continue;
        if (!engines.some((e) => e.tree === tree))
          engines.push({ tree, trial: state.trial });
      }
    },
  };
  const record = simulateRun(job.point.strategy, job.seed, cfg);
  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    pointId: job.point.id,
    seedIndex: job.seedIndex,
    won: record.won,
    trialReached: record.trialReached,
    goldEarned: record.goldEarned,
    engines,
    trials: record.trajectory.map((t) => ({
      trial: t.trial,
      log10: round(t.trialScoreLog10),
      cleared: t.cleared,
      rollsUsed: t.rollsUsed,
      budget: t.rollBudget,
      clearedOnRoll: t.clearedOnRoll,
      goldAfter: t.goldAfter,
      boss: t.boss,
      rolls: t.rollLog10?.map(round),
    })),
  };
}

// ---- the pool --------------------------------------------------------------

const WORKER_KIND = "order-goal-grid";

function workerCount(jobCount: number): number {
  const requested = Number(process.env.SIM_WORKERS);
  const fallback = Math.max(1, Math.min(8, availableParallelism() - 1));
  const count =
    Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.max(1, Math.min(jobCount, Math.floor(count)));
}

/**
 * Run every job, in parallel across worker threads, and return the results in
 * job order. A job's result depends only on the job (each one seeds its own
 * RNG, storage and mode), so scheduling cannot change an answer.
 */
export async function runGrid(
  jobs: GridJob[],
  onProgress?: (done: number, total: number) => void,
): Promise<GridResult[]> {
  const results = new Array<GridResult>(jobs.length);
  const count = workerCount(jobs.length);
  if (count <= 1) {
    jobs.forEach((job, i) => {
      results[i] = runGridJob(job);
      onProgress?.(i + 1, jobs.length);
    });
    return results;
  }

  await new Promise<void>((resolveAll, rejectAll) => {
    const workers: Worker[] = [];
    let next = 0;
    let done = 0;
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      for (const worker of workers) void worker.terminate();
      rejectAll(error);
    };
    const assign = (worker: Worker) => {
      if (next < jobs.length) {
        const index = next++;
        worker.postMessage({ index, job: jobs[index] });
      } else worker.postMessage(null);
    };
    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL("./goalGridWorker.mjs", import.meta.url),
        { workerData: { kind: WORKER_KIND } },
      );
      workers.push(worker);
      worker.on("error", fail);
      worker.on("message", (msg: { index: number; result: GridResult }) => {
        if (failed) return;
        results[msg.index] = msg.result;
        done += 1;
        onProgress?.(done, jobs.length);
        assign(worker);
        if (done === jobs.length) resolveAll();
      });
      assign(worker);
    }
  });
  return results;
}

/** A progress line that rewrites itself, at most once a second. */
export function progressPrinter(label: string) {
  const t0 = Date.now();
  let last = 0;
  return (done: number, total: number) => {
    const now = Date.now();
    if (done !== total && now - last < 1000) return;
    last = now;
    const secs = (now - t0) / 1000;
    const eta = done > 0 ? (secs / done) * (total - done) : 0;
    process.stdout.write(
      `\r  ${label}: ${done}/${total} runs · ${secs.toFixed(0)}s elapsed · ~${eta.toFixed(0)}s left   ` +
        (done === total ? "\n" : ""),
    );
  };
}

// ---- small statistics shared by the passes ---------------------------------

/** Nearest-rank quantile: always an observed value, never an interpolation
 *  between two (which in log space would invent a score nobody reached). */
export function nearestRank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const k = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[k];
}

export function sortedCopy(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  parentPort?.on("message", (msg: { index: number; job: GridJob } | null) => {
    if (msg === null) {
      parentPort?.close();
      return;
    }
    parentPort?.postMessage({ index: msg.index, result: runGridJob(msg.job) });
  });
}
