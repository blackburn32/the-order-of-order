// Fit the goal table to a survival curve: what share of runs should still be
// alive at the end of each rank.
//
// The goal search (goalSearch.ts) sets each goal at a percentile of what the
// field COULD score, and a per-trial percentile compounds: twenty-eight trials
// at the 80th percentile left almost no one alive, and how many survive a
// given rank fell out of that rather than being chosen. This works the other
// way round. The intent is a handful of checkpoints — "about 70% of runs get
// through rank 1, about 40% through rank 3" — and every goal is fitted, trial
// by trial, so the grid's survival lands on the curve through them.
//
// The fit is sequential, with real culling. A goal can only change the trials
// from its own on, so with trials 1..t-1 already fitted, trial t is played with
// an unreachable goal: every run that enters it plays its whole budget and
// records what it COULD score there, with exactly the build it would really
// arrive with. Trial t's goal is then the score that the wanted share of those
// entrants reach. Because each step measures who is actually still alive, an
// error at one trial is corrected at the next instead of compounding.
//
// Between checkpoints, survival falls by the same factor every rank (the curve
// is geometric, so no rank is a cliff), and a rank's losses are weighted
// toward its Boss Trial (CULL_SHARE). Trial 1 keeps its goal of one point: a
// lone d6 already ends about a quarter of runs there, so rank 1's other two
// trials only take what is left of its share. The duel (trial 30) has no goal,
// and who wins it is not a fixed share of who reaches it, so trial 29 is
// fitted to the win rate directly: it keeps the strongest entrants until they
// hold the wanted number of duel wins. The duel ends most of the runs that
// reach it (about 37% win it on the grid), so the curve's last point is the
// share that should reach the duel, the win rate over DUEL_RATE, and ranks 7-10
// fall toward that rather than toward the win rate itself.
//
//   npm run goals:tune
//   CHECKPOINTS="1=0.7,3=0.4,6=0.2,10=0.05" SEEDS=300 npm run goals:tune
//   GOALS=sim-out/goal-tune.json npm run goals:validate     # grade it held out
//
// | env         | default                  | what it does                              |
// | ----------- | ------------------------ | ----------------------------------------- |
// | CHECKPOINTS | 1=0.7,3=0.4,6=0.2,10=0.05 | `rank=share alive after it`; rank 10's |
// |             |                          | share is the win rate                     |
// | DUEL_RATE   | 0.37                     | share of duel entrants who win it, which  |
// |             |                          | sets how many should reach it             |
// | SEEDS       | 300                      | seeds; every grid point plays every one   |
// | SEED        | 1                        | base seed (validation defaults to 2)      |
// | SIG         | 3                        | significant figures a goal is rounded to  |
// | OUT         | sim-out/goal-tune.json   | the table (`goals`), readable by GOALS=   |
// | GRID_*      | see goalGrid.ts          | the strategy grid                         |

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  rankOf,
  TRIALS_PER_RANK,
  trialInRank,
  WIN_RANK,
  WIN_TRIAL,
} from "../config";
import {
  gridFromEnv,
  gridSeed,
  progressPrinter,
  runGrid,
  sortedCopy,
  type GridJob,
} from "./goalGrid";

const CHECKPOINTS = parseCheckpoints(
  process.env.CHECKPOINTS ?? "1=0.7,3=0.4,6=0.2,10=0.05",
);
const DUEL_RATE = Number(process.env.DUEL_RATE ?? 0.37);
const SEEDS = Number(process.env.SEEDS ?? 300);
const SEED = Number(process.env.SEED ?? 1);
const SIG = Number(process.env.SIG ?? 3);
const OUT = process.env.OUT ?? "sim-out/goal-tune.json";

/** A rank's losses, split across its Lesser, Greater and Boss Trials. */
const CULL_SHARE = [0.15, 0.3, 0.55] as const;
/** Trials whose goal is authored, not fitted. */
const PINNED = new Map<number, bigint>([[1, 1n]]);
/** A goal no build reaches: the trial being measured plays its whole budget. */
const UNREACHABLE = 10n ** 200n;

function parseCheckpoints(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of text.split(",")) {
    const [rank, share] = part.split("=").map((s) => Number(s.trim()));
    if (!Number.isInteger(rank) || rank < 1 || rank > WIN_RANK || !(share > 0))
      throw new Error(`CHECKPOINTS: "${part}" is not rank=share`);
    out.set(rank, share);
  }
  if (!out.has(WIN_RANK))
    throw new Error(`CHECKPOINTS: rank ${WIN_RANK} (the win rate) is required`);
  return out;
}

/** Share of runs alive after each rank (index = rank - 1): the checkpoints,
 *  joined by a constant factor per rank between them. */
export function rankSurvival(checkpoints: Map<number, number>): number[] {
  const known: [number, number][] = [
    [0, 1] as [number, number],
    ...checkpoints.entries(),
  ].sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (let rank = 1; rank <= WIN_RANK; rank++) {
    const hi = known.findIndex(([r]) => r >= rank);
    const [r1, s1] = known[hi];
    const [r0, s0] = known[hi - 1];
    out.push(s0 * (s1 / s0) ** ((rank - r0) / (r1 - r0)));
  }
  return out;
}

export function goalFromLog10(x: number, sig = SIG): bigint {
  if (x < 0) return 1n;
  if (x < sig) return BigInt(Math.max(1, Math.round(10 ** x)));
  let exponent = Math.floor(x) - (sig - 1);
  let mantissa = Math.round(10 ** (x - exponent));
  if (mantissa >= 10 ** sig) {
    mantissa = Math.round(mantissa / 10);
    exponent += 1;
  }
  return BigInt(mantissa) * 10n ** BigInt(exponent);
}

/**
 * The share of the field that should be alive after `trial`, given the share
 * actually alive as its rank began (`rankStart`, measured) and after its
 * pinned trials. The rank's losses are spread over its fitted trials in
 * proportion to CULL_SHARE.
 */
function wantAliveAfter(
  trial: number,
  rankEnd: number,
  aliveIntoFirstFitted: number,
): number {
  const slot = trialInRank(trial) - 1;
  const firstTrial = (rankOf(trial) - 1) * TRIALS_PER_RANK + 1;
  const fitted = [0, 1, 2].filter((s) => !PINNED.has(firstTrial + s));
  const total = fitted.reduce((a, s) => a + CULL_SHARE[s], 0);
  const done = fitted
    .filter((s) => s <= slot)
    .reduce((a, s) => a + CULL_SHARE[s], 0);
  return (
    aliveIntoFirstFitted - (aliveIntoFirstFitted - rankEnd) * (done / total)
  );
}

async function main(): Promise<void> {
  // The duel takes the last step on its own, so the curve runs to the share
  // that should REACH the duel, and only the report names the win rate.
  const winRate = CHECKPOINTS.get(WIN_RANK)!;
  const rankEnd = rankSurvival(
    new Map(CHECKPOINTS).set(WIN_RANK, winRate / DUEL_RATE),
  );
  const survival = rankEnd.map((s, i) => (i === WIN_RANK - 1 ? winRate : s));
  const grid = gridFromEnv();
  const total = grid.length * SEEDS;
  console.log(
    `Fitting goals: ${total} runs (${SEEDS} seeds × ${grid.length} grid points)`,
  );
  console.log(
    "Wanted alive after each rank: " +
      survival.map((s, i) => `${i + 1}:${(s * 100).toFixed(1)}%`).join("  "),
  );

  const goals: bigint[] = new Array<bigint>(WIN_TRIAL).fill(UNREACHABLE);
  const rows: {
    trial: number;
    entered: number;
    want: number;
    goal: string;
    clamped: boolean;
  }[] = [];
  let aliveIntoFirstFitted = 1;

  const play = async (label: string) => {
    const jobs: GridJob[] = [];
    for (let i = 0; i < SEEDS; i++)
      for (const point of grid)
        jobs.push({
          mode: "validate",
          point,
          seedIndex: i,
          seed: gridSeed(SEED, i),
          goals,
          cadence: null,
          clearGold: null,
        });
    return runGrid(jobs, progressPrinter(label));
  };

  for (let trial = 1; trial < WIN_TRIAL; trial++) {
    const pinned = PINNED.get(trial);
    if (pinned !== undefined) {
      goals[trial - 1] = pinned;
      continue;
    }
    goals[trial - 1] = UNREACHABLE;
    const results = await play(`trial ${trial}`);
    const scores = results.flatMap((r) =>
      r.trials.filter((t) => t.trial === trial).map((t) => t.log10),
    );
    const entered = scores.length / total;
    if (trialInRank(trial) === 1 || PINNED.has(trial - 1))
      aliveIntoFirstFitted = entered;
    const want = wantAliveAfter(
      trial,
      rankEnd[rankOf(trial) - 1],
      aliveIntoFirstFitted,
    );
    // Never lower than the trial before it in its rank, nor the same slot a
    // rank down.
    const floor = [trial - 1, trial - TRIALS_PER_RANK]
      .filter((t, i) => t >= 1 && (i === 1 || trialInRank(trial) > 1))
      .map((t) => goals[t - 1])
      .reduce((a, b) => (b > a ? b : a), 1n);
    let goal: bigint;
    if (trial === WIN_TRIAL - 1) {
      // The last goal is fitted to the win rate itself. Play the trial once
      // more at its floor to see which entrants go on to win the duel, then
      // keep the strongest entrants until they hold the wanted wins: the duel
      // is a race against the run's own grid, so who wins it is not a fixed
      // share of who reaches it.
      goals[trial - 1] = floor;
      const atFloor = await play(`trial ${trial} duel`);
      const won = new Set(
        atFloor.filter((r) => r.won).map((r) => `${r.pointId}#${r.seedIndex}`),
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
      const wantWins = survival[WIN_RANK - 1] * total;
      let wins = 0;
      let at = entrants.length - 1;
      for (let i = 0; i < entrants.length; i++) {
        if (entrants[i].won) wins += 1;
        if (wins >= wantWins) {
          at = i;
          break;
        }
      }
      goal = entrants.length ? goalFromLog10(entrants[at].log10) : 1n;
    } else {
      const clear = Math.min(1, Math.max(0, want / (entered || 1)));
      const sorted = sortedCopy(scores);
      // The score that a `clear` share of the entrants reach.
      const at = Math.min(
        sorted.length - 1,
        Math.max(0, Math.floor((1 - clear) * sorted.length)),
      );
      goal = sorted.length ? goalFromLog10(sorted[at]) : 1n;
    }
    const clamped = goal < floor;
    if (clamped) goal = floor;
    goals[trial - 1] = goal;
    rows.push({ trial, entered, want, goal: goal.toString(), clamped });
    console.log(
      `\n  trial ${String(trial).padStart(2)}: entered ${(entered * 100).toFixed(1)}%, ` +
        `want ${(want * 100).toFixed(1)}% through → goal ${goal}${clamped ? " (floor)" : ""}`,
    );
  }

  // The duel's goal is never played; the endless ladder walks out from it, so
  // keep it a step above the last real goal as the live table does.
  goals[WIN_TRIAL - 1] =
    goals[WIN_TRIAL - 2] * (goals[WIN_TRIAL - 2] / goals[WIN_TRIAL - 3] || 1n);

  const results = await play("final");
  const alive = (trial: number) =>
    results.filter((r) => r.trialReached >= trial).length / total;
  const wins = results.filter((r) => r.won).length / total;
  console.log("\n\nrank | wanted | fitted (on the fitting seeds)");
  for (let rank = 1; rank <= WIN_RANK; rank++) {
    const got = rank === WIN_RANK ? wins : alive(rank * TRIALS_PER_RANK + 1);
    console.log(
      `${String(rank).padStart(4)} | ${(survival[rank - 1] * 100).toFixed(1).padStart(5)}% | ${(got * 100).toFixed(1).padStart(5)}%`,
    );
  }

  console.log("\nPaste into MEASURED_GOALS in config.ts:\n");
  for (let rank = 1; rank <= WIN_RANK; rank++) {
    const row = goals
      .slice((rank - 1) * TRIALS_PER_RANK, rank * TRIALS_PER_RANK)
      .map((g) => `"${g}",`)
      .join(" ");
    console.log(`  ${row.padEnd(44)}// rank ${rank}`);
  }

  const outPath = resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        kind: "goal-tune",
        checkpoints: Object.fromEntries(CHECKPOINTS),
        duelRate: DUEL_RATE,
        seeds: SEEDS,
        seed: SEED,
        survival,
        goals: goals.map(String),
        trials: rows,
      },
      null,
      1,
    ),
  );
  console.log(`\nTable → ${outPath}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
