// Fit the four goal tiers of every trial, and the four ranks a run ends on.
//
// Every trial is played to its last roll, and asks four goals rather than one:
// bronze to survive it, then silver, gold and legendary for more gold. This is
// goalTune's sequential fit (see goalTune.ts) with the upper tiers fitted
// alongside bronze, from the same measurement.
//
// Trial by trial, with trials 1..t-1 already fitted, trial t is played with
// every tier unreachable, so each run that enters it plays its whole budget
// with exactly the build it would really arrive with, and the share of those
// entrants each tier lets through is chosen:
//
//   bronze     fitted to a survival curve (CHECKPOINTS), exactly as goalTune
//              fits the single goal — a slightly gentler curve than the one the
//              single goal was fitted to (OLD_CHECKPOINTS), except for rank 1,
//              which is authored (PIN, 1 / 2 / 3 points).
//   silver     the share the single goal let through on the old curve, times
//              SILVER (0.85): a little harder than the goal it replaced.
//   gold       GOLD (30%) of the entrants: well above silver.
//   legendary  LEGENDARY (2%) of the entrants: their 98th percentile.
//
// Measuring trial t pays no tier gold for it (its tiers are unreachable), but
// that gold only reaches the shops after it, and trial t+1 is measured with
// trial t's tiers in place, so every trial is fitted against the economy the
// tiers before it really pay.
//
// The run ranks are fitted last, from a final pass of the whole table: the
// total score (RunState.totalScore) the top RUN_RANKS shares of every run reach,
// dead or alive — by default the top 50% bronze, 25% silver, 8% gold and 2%
// legendary.
//
//   npm run goals:tiers                                  # fit → sim-out/goal-tiers.json
//   VALIDATE=1 SEED=2 npm run goals:tiers                # grade the live tables held out
//   VALIDATE=sim-out/goal-tiers.json SEED=2 npm run goals:tiers
//
// | env             | default                    | what it does                             |
// | --------------- | -------------------------- | ---------------------------------------- |
// | CHECKPOINTS     | 1=0.7,3=0.46,6=0.25,10=0.065 | bronze's survival curve; rank 10 = win |
// | OLD_CHECKPOINTS | 1=0.7,3=0.4,6=0.2,10=0.05  | the curve the single goal was fitted to  |
// | SILVER          | 0.85                       | silver's share, × the old goal's share   |
// | GOLD            | 0.3                        | share of entrants gold lets through      |
// | LEGENDARY       | 0.02                       | share of entrants legendary lets through |
// | RUN_RANKS       | 0.5,0.25,0.08,0.02         | share of runs at or above each run rank  |
// | DUEL_RATE       | 0.5                        | share of duel entrants who win it        |
// | PIN             | 1=1,2=2,3=3                | `trial=goal` bronze pairs kept authored  |
// | SEEDS           | 300                        | seeds; every grid point plays every one  |
// | SEED            | 1                          | base seed                                |
// | SIG             | 3                          | significant figures a goal is rounded to |
// | VALIDATE        | (off)                      | `1` grades the live tables; a path, a    |
// |                 |                            | fitted JSON's                            |
// | OUT             | sim-out/goal-tiers.json    | the fitted tables                        |
// | GRID_*          | see goalGrid.ts            | the strategy grid                        |

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  GOAL_TIERS,
  rankOf,
  runRankThresholds,
  setRunRankThresholds,
  TRIALS_PER_RANK,
  trialInRank,
  trialTierGoals,
  WIN_RANK,
  WIN_TRIAL,
  type TierGoals,
} from "../config";
import {
  gridFromEnv,
  gridSeed,
  progressPrinter,
  runGrid,
  sortedCopy,
  type GridJob,
  type GridResult,
  goalFromLog10,
  rankSurvival,
} from "./goalGrid";

type Upper = readonly [bigint, bigint, bigint];

const CHECKPOINTS = parseCheckpoints(
  process.env.CHECKPOINTS ?? "1=0.7,3=0.46,6=0.25,10=0.065",
);
const OLD_CHECKPOINTS = parseCheckpoints(
  process.env.OLD_CHECKPOINTS ?? "1=0.7,3=0.4,6=0.2,10=0.05",
);
const SILVER = Number(process.env.SILVER ?? 0.85);
const GOLD = Number(process.env.GOLD ?? 0.3);
const LEGENDARY = Number(process.env.LEGENDARY ?? 0.02);
const RUN_RANKS = (process.env.RUN_RANKS ?? "0.5,0.25,0.08,0.02")
  .split(",")
  .map(Number);
const DUEL_RATE = Number(process.env.DUEL_RATE ?? 0.5);
const SEEDS = Number(process.env.SEEDS ?? 300);
const SEED = Number(process.env.SEED ?? 1);
const SIG = Number(process.env.SIG ?? 3);
const VALIDATE = process.env.VALIDATE;
const OUT =
  process.env.OUT ??
  (VALIDATE ? "sim-out/goal-tiers-validate.json" : "sim-out/goal-tiers.json");

/** A rank's losses, split across its Lesser, Greater and Boss Trials. */
const CULL_SHARE = [0.15, 0.3, 0.55] as const;
const PINNED = new Map<number, bigint>(
  (process.env.PIN ?? "1=1,2=2,3=3").split(",").map((part) => {
    const [trial, goal] = part.split("=").map((x) => x.trim());
    if (!/^\d+$/.test(trial) || !/^\d+$/.test(goal))
      throw new Error(`PIN: "${part}" is not trial=goal`);
    return [Number(trial), BigInt(goal)];
  }),
);
const UNREACHABLE = 10n ** 200n;
const UNREACHABLE_UPPER: Upper = [UNREACHABLE, UNREACHABLE, UNREACHABLE];

function parseCheckpoints(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of text.split(",")) {
    const [rank, share] = part.split("=").map((s) => Number(s.trim()));
    if (!Number.isInteger(rank) || rank < 1 || rank > WIN_RANK || !(share > 0))
      throw new Error(`checkpoints: "${part}" is not rank=share`);
    out.set(rank, share);
  }
  if (!out.has(WIN_RANK))
    throw new Error(`checkpoints: rank ${WIN_RANK} (the win rate) is required`);
  return out;
}

/** The curve to the duel's door: survival after each rank, with the last rank's
 *  share the share that should REACH the duel. */
function curveToDuel(checkpoints: Map<number, number>): number[] {
  const winRate = checkpoints.get(WIN_RANK)!;
  return rankSurvival(new Map(checkpoints).set(WIN_RANK, winRate / DUEL_RATE));
}

/** Share of the field alive after `trial` on a curve, with `aliveInto` alive as
 *  the rank's first fitted trial began and the rank's losses spread over its
 *  fitted trials by CULL_SHARE. `pins` names trials not fitted. */
function aliveAfter(
  trial: number,
  rankEnd: number,
  aliveInto: number,
  pins: ReadonlySet<number>,
): number {
  const slot = trialInRank(trial) - 1;
  const firstTrial = (rankOf(trial) - 1) * TRIALS_PER_RANK + 1;
  const fitted = [0, 1, 2].filter((s) => !pins.has(firstTrial + s));
  const total = fitted.reduce((a, s) => a + CULL_SHARE[s], 0);
  const done = fitted
    .filter((s) => s <= slot)
    .reduce((a, s) => a + CULL_SHARE[s], 0);
  return aliveInto - (aliveInto - rankEnd) * (done / total);
}

/**
 * The share of a trial's entrants the single goal was meant to let through on
 * the old curve, read off the curve alone. Rank 1 is spread over all three of
 * its trials, as though it were fitted, since its pinned goals are what the
 * share describes.
 */
function oldClearShare(trial: number): number {
  const ends = curveToDuel(OLD_CHECKPOINTS);
  const rank = rankOf(trial);
  const into = rank === 1 ? 1 : ends[rank - 2];
  const none = new Set<number>();
  const before =
    trialInRank(trial) === 1
      ? into
      : aliveAfter(trial - 1, ends[rank - 1], into, none);
  return aliveAfter(trial, ends[rank - 1], into, none) / before;
}

/** The score a `share` of `sorted` (ascending log10s) reach. */
function scoreAtShare(sorted: readonly number[], share: number): bigint {
  if (sorted.length === 0) return 1n;
  const clear = Math.min(1, Math.max(0, share));
  const at = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((1 - clear) * sorted.length)),
  );
  return goalFromLog10(sorted[at], SIG);
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

async function play(
  label: string,
  goals: (bigint | null)[] | null,
  tiers: (Upper | null)[] | null,
): Promise<GridResult[]> {
  const grid = gridFromEnv();
  const jobs: GridJob[] = [];
  for (let i = 0; i < SEEDS; i++)
    for (const point of grid)
      jobs.push({
        mode: "validate",
        point,
        seedIndex: i,
        seed: gridSeed(SEED, i),
        goals,
        tiers,
        cadence: null,
        clearGold: null,
      });
  return runGrid(jobs, progressPrinter(label));
}

/** The least total score each share of `results` reaches. */
function runRanksFrom(results: GridResult[]): TierGoals {
  const sorted = sortedCopy(results.map((r) => r.totalLog10));
  return RUN_RANKS.map((share) =>
    scoreAtShare(sorted, share),
  ) as unknown as TierGoals;
}

interface TrialReport {
  trial: number;
  entered: number;
  /** Share of entrants at or above each tier. */
  tierShare: number[];
}

/** Survival per rank, the share of each trial's entrants meeting each tier,
 *  and the run-rank spread, for one played table. */
function report(
  results: GridResult[],
  tiersByTrial: TierGoals[],
  rankThresholds: TierGoals,
) {
  const total = results.length;
  const trials: TrialReport[] = [];
  for (let trial = 1; trial < WIN_TRIAL; trial++) {
    const rows = results.flatMap((r) =>
      r.trials.filter((t) => t.trial === trial),
    );
    const goals = tiersByTrial[trial - 1].map((g) => Math.log10(Number(g)));
    trials.push({
      trial,
      entered: rows.length / total,
      tierShare: goals.map(
        (g) =>
          rows.filter((t) => t.log10 >= g - 1e-9).length / (rows.length || 1),
      ),
    });
  }
  const alive = (trial: number) =>
    results.filter((r) => r.trialReached >= trial).length / total;
  const wins = results.filter((r) => r.won).length / total;
  const survival = Array.from({ length: WIN_RANK }, (_, i) =>
    i === WIN_RANK - 1 ? wins : alive((i + 1) * TRIALS_PER_RANK + 1),
  );
  const rankLog = rankThresholds.map((g) => Math.log10(Number(g)));
  const runRanks = rankLog.map(
    (g) => results.filter((r) => r.totalLog10 >= g - 1e-9).length / total,
  );
  return { survival, trials, runRanks };
}

function printReport(
  r: ReturnType<typeof report>,
  wantSurvival: number[] | null,
): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);
  console.log("\nrank | alive after" + (wantSurvival ? " | wanted" : ""));
  r.survival.forEach((s, i) =>
    console.log(
      `${String(i + 1).padStart(4)} | ${pct(s)}` +
        (wantSurvival ? `      | ${pct(wantSurvival[i])}` : ""),
    ),
  );
  console.log(
    "\ntrial | entered | bronze | silver |  gold  | legendary  (share of entrants)",
  );
  for (const t of r.trials)
    console.log(
      `${String(t.trial).padStart(5)} | ${pct(t.entered)}  | ` +
        t.tierShare.map(pct).join(" | "),
    );
  console.log(
    "\nRun ranks (share of every run at or above): " +
      GOAL_TIERS.map((tier, i) => `${tier} ${pct(r.runRanks[i])}`).join("  "),
  );
}

function readTables(path: string): {
  goals: bigint[];
  tiers: Upper[];
  runRanks: TierGoals;
} {
  const parsed = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
  return {
    goals: (parsed.goals as string[]).map((g) => BigInt(g)),
    tiers: (parsed.tiers as string[][]).map(
      (row) => row.map((g) => BigInt(g)) as unknown as Upper,
    ),
    runRanks: (parsed.runRanks as string[]).map((g) =>
      BigInt(g),
    ) as unknown as TierGoals,
  };
}

async function validate(): Promise<void> {
  const live = VALIDATE === "1" || VALIDATE === "live";
  const tables = live ? null : readTables(VALIDATE!);
  if (tables) setRunRankThresholds(tables.runRanks);
  const tiersByTrial: TierGoals[] = [];
  for (let t = 1; t <= WIN_TRIAL; t++)
    tiersByTrial.push(
      tables
        ? ([
            tables.goals[t - 1],
            ...tables.tiers[t - 1],
          ] as unknown as TierGoals)
        : trialTierGoals(t),
    );
  const grid = gridFromEnv();
  console.log(
    `Validating ${live ? "the live tables" : VALIDATE}: ${grid.length * SEEDS} runs ` +
      `(${SEEDS} seeds × ${grid.length} grid points, base seed ${SEED})`,
  );
  const results = await play(
    "validate",
    tables ? tables.goals : null,
    tables ? tables.tiers : null,
  );
  const r = report(results, tiersByTrial, runRankThresholds());
  printReport(r, null);
  // How much of each trial's budget a run that survived it used, which is now
  // always all of it; recorded so the report states it rather than assumes it.
  const used = results.flatMap((res) =>
    res.trials.filter((t) => t.cleared).map((t) => t.rollsUsed / t.budget),
  );
  const share = used.reduce((a, b) => a + b, 0) / (used.length || 1);
  console.log(`Rolls used by a cleared trial: ${(share * 100).toFixed(0)}%`);
  write({ kind: "goal-tiers-validate", seeds: SEEDS, seed: SEED, ...r });
}

function write(body: object): void {
  const outPath = resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      body,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      1,
    ),
  );
  console.log(`\n→ ${outPath}`);
}

async function fit(): Promise<void> {
  const rankEnd = curveToDuel(CHECKPOINTS);
  const winRate = CHECKPOINTS.get(WIN_RANK)!;
  const survival = rankEnd.map((s, i) => (i === WIN_RANK - 1 ? winRate : s));
  const grid = gridFromEnv();
  const total = grid.length * SEEDS;
  console.log(
    `Fitting goal tiers: ${total} runs (${SEEDS} seeds × ${grid.length} grid points)`,
  );
  console.log(
    "Bronze, wanted alive after each rank: " +
      survival.map((s, i) => `${i + 1}:${(s * 100).toFixed(1)}%`).join("  "),
  );

  const goals: bigint[] = new Array<bigint>(WIN_TRIAL).fill(UNREACHABLE);
  const tiers: Upper[] = new Array<Upper>(WIN_TRIAL).fill(UNREACHABLE_UPPER);
  const pins = new Set(PINNED.keys());
  const rows: object[] = [];
  let aliveIntoFirstFitted = 1;

  for (let trial = 1; trial < WIN_TRIAL; trial++) {
    goals[trial - 1] = UNREACHABLE;
    tiers[trial - 1] = UNREACHABLE_UPPER;
    const results = await play(`trial ${trial}`, goals, tiers);
    const scores = sortedCopy(
      results.flatMap((r) =>
        r.trials.filter((t) => t.trial === trial).map((t) => t.log10),
      ),
    );
    const entered = scores.length / total;

    // Bronze: pinned, or fitted to the survival curve as goalTune fits it.
    let bronze = PINNED.get(trial);
    let bronzeFloor = false;
    if (bronze === undefined) {
      if (trialInRank(trial) === 1 || pins.has(trial - 1))
        aliveIntoFirstFitted = entered;
      const floor = [trial - 1, trial - TRIALS_PER_RANK]
        .filter((t, i) => t >= 1 && (i === 1 || trialInRank(trial) > 1))
        .map((t) => goals[t - 1])
        .reduce(maxBig, 1n);
      if (trial === WIN_TRIAL - 1) {
        // The last goal is fitted to the win rate itself (see goalTune): play
        // it once more at its floor to see which entrants go on to win the
        // duel, and keep the strongest until they hold the wanted wins.
        goals[trial - 1] = floor;
        tiers[trial - 1] = UNREACHABLE_UPPER;
        const atFloor = await play(`trial ${trial} duel`, goals, tiers);
        const won = new Set(
          atFloor
            .filter((r) => r.won)
            .map((r) => `${r.pointId}#${r.seedIndex}`),
        );
        const entrants = results
          .flatMap((r) =>
            r.trials
              .filter((t) => t.trial === trial)
              .map((t) => ({
                log10: t.log10,
                won: won.has(`${r.pointId}#${r.seedIndex}`),
              })),
          )
          .sort((a, b) => b.log10 - a.log10);
        const wantWins = winRate * total;
        let wins = 0;
        let at = entrants.length - 1;
        for (let i = 0; i < entrants.length; i++) {
          if (entrants[i].won) wins += 1;
          if (wins >= wantWins) {
            at = i;
            break;
          }
        }
        bronze = entrants.length ? goalFromLog10(entrants[at].log10, SIG) : 1n;
      } else {
        const want = aliveAfter(
          trial,
          rankEnd[rankOf(trial) - 1],
          aliveIntoFirstFitted,
          pins,
        );
        bronze = scoreAtShare(scores, want / (entered || 1));
      }
      bronzeFloor = bronze < floor;
      if (bronzeFloor) bronze = floor;
    }

    // The upper tiers: shares of the same entrants, each above the last.
    const oldShare = oldClearShare(trial);
    let silver = scoreAtShare(scores, oldShare * SILVER);
    if (silver <= bronze) silver = bronze + 1n;
    let gold = scoreAtShare(scores, GOLD);
    if (gold <= silver) gold = silver + 1n;
    let legendary = scoreAtShare(scores, LEGENDARY);
    if (legendary <= gold) legendary = gold + 1n;

    goals[trial - 1] = bronze;
    tiers[trial - 1] = [silver, gold, legendary];
    rows.push({ trial, entered, oldShare, bronzeFloor });
    console.log(
      `\n  trial ${String(trial).padStart(2)}: entered ${(entered * 100).toFixed(1)}% → ` +
        `${bronze}${bronzeFloor ? " (floor)" : ""} / ${silver} / ${gold} / ${legendary}` +
        `  (old goal let ${(oldShare * 100).toFixed(0)}% through)`,
    );
  }

  // The duel's row is never played; the endless ladder walks out from its
  // bronze, so keep it a step above the last as the live table does.
  const last = goals[WIN_TRIAL - 2];
  // At least a doubling: trial 29 often sits on its floor, which would leave the
  // endless ladder opening level with it.
  const step = maxBig(2n, last / (goals[WIN_TRIAL - 3] || 1n));
  goals[WIN_TRIAL - 1] = last * step;
  tiers[WIN_TRIAL - 1] = tiers[WIN_TRIAL - 2].map(
    (g) => g * step,
  ) as unknown as Upper;

  const results = await play("final", goals, tiers);
  const runRanks = runRanksFrom(results);
  const tiersByTrial = goals.map(
    (g, i) => [g, ...tiers[i]] as unknown as TierGoals,
  );
  const r = report(results, tiersByTrial, runRanks);
  printReport(r, survival);

  console.log("\nPaste into MEASURED_GOALS in config.ts:\n");
  for (let rank = 1; rank <= WIN_RANK; rank++) {
    const row = goals
      .slice((rank - 1) * TRIALS_PER_RANK, rank * TRIALS_PER_RANK)
      .map((g) => `"${g}",`)
      .join(" ");
    console.log(`  ${row.padEnd(44)}// rank ${rank}`);
  }
  console.log("\nPaste into MEASURED_TIER_GOALS in config.ts:\n");
  for (let rank = 1; rank <= WIN_RANK; rank++) {
    const row = tiers
      .slice((rank - 1) * TRIALS_PER_RANK, rank * TRIALS_PER_RANK)
      .map((t) => `[${t.map((g) => `"${g}"`).join(", ")}],`)
      .join(" ");
    console.log(`  ${row} // rank ${rank}`);
  }
  console.log("\nPaste into MEASURED_RUN_RANKS in config.ts:\n");
  console.log(`  ${runRanks.map((g) => `"${g}",`).join(" ")}`);

  write({
    kind: "goal-tiers",
    checkpoints: Object.fromEntries(CHECKPOINTS),
    oldCheckpoints: Object.fromEntries(OLD_CHECKPOINTS),
    shares: { silver: SILVER, gold: GOLD, legendary: LEGENDARY },
    runRankShares: RUN_RANKS,
    duelRate: DUEL_RATE,
    seeds: SEEDS,
    seed: SEED,
    survival,
    goals: goals.map(String),
    tiers: tiers.map((t) => t.map(String)),
    runRanks: runRanks.map(String),
    trials: rows,
    fitted: r,
  });
}

void (VALIDATE ? validate() : fit()).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
