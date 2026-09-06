// Is the bot as good as the player?
//
// A goal is set from what the field can score, so a field that plays worse than
// the people it is designing for produces goals those people meet on their
// opening roll. That is not a number that can be argued about from the outside:
// it needs a run somebody actually played, measured against the bots at the same
// point on the ladder, under the same rules.
//
// This is that measurement. Export a run from the dev panel, point this at it,
// and it prints — for the fixture's trial — what the human build could score with
// its whole roll budget, what each bot arrives at that trial able to score, and
// where the live goal sits between them.
//
//   npm run benchmark -- sim-fixtures/trial-14-rank-5-roll-0.json
//   RUNS=120 SAMPLES=9 npm run benchmark -- sim-fixtures/*.json
//
// Reading it: the column that matters is `p50 vs you`. A bot at -1.0 reaches a
// tenth of what you reach, so any goal set to challenge it is a goal you clear
// ten times over — on one roll, which the `1-roll` column then confirms. The
// expert exists to close that gap; the other eight are there to show how wide it
// was.

import { globSync } from "node:fs";
import { goalFor } from "../systems/Boss";
import { rankOf, trialInRank, trialName } from "../config";
import type { RunState } from "../state/RunState";
import { simulateRun, type StrategyName } from "./bot";
import { cloneRunState } from "./cloneRun";
import { log10Big, measureCapacity, quantile, type Capacity } from "./appraise";
import { DEFAULT_CONFIG } from "./config";
import {
  describeBuild,
  describeFixture,
  loadRunFixtures,
  type RunFixture,
} from "./importRun";
import { SIM_SERIES, seriesConfig, seriesSeed } from "./series";
import { trialRollTarget } from "./engine";

const RUNS = Number(process.env.RUNS ?? 80);
const SAMPLES = Number(process.env.SAMPLES ?? 7);
const SEED = Number(process.env.SEED ?? DEFAULT_CONFIG.seed);
const DEFAULT_GLOB = "sim-fixtures/*.json";

/** Capacity measured for one series at one trial, pooled across its runs. */
interface FieldResult {
  label: string;
  strategy: StrategyName;
  /** Runs that were still alive to enter the trial at all. */
  reached: number;
  attempted: number;
  logSamples: number[];
  clearRate: number;
  oneRollShare: number;
  meanClearRoll: number;
  dice: number;
  gold: number;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The field measured at one trial, remembered.
 *
 * The bots know nothing about the fixture they are being compared to — only
 * about the trial they are measured at — so two fixtures at trial 10 get
 * identical field rows, at the cost of simulating the whole field twice.
 * Exporting at "the start of rank 4" in three different runs is the obvious way
 * to use this tool, so the obvious way had better not cost three times as much.
 *
 * Keyed by trial alone, and safely: `RUNS`, `SAMPLES` and `SEED` are read once
 * from the environment at module load, so nothing else feeding a measurement can
 * differ between two calls within one run of this script.
 */
const fieldCache = new Map<number, FieldResult[]>();

function measureField(trial: number): FieldResult[] {
  const remembered = fieldCache.get(trial);
  if (remembered) return remembered;
  const measured = measureFieldAt(trial);
  fieldCache.set(trial, measured);
  return measured;
}

/**
 * Measure every series' capacity at one trial.
 *
 * Each run is simulated normally — real culling, real shops, real gold — and
 * stopped once it reaches the trial in question. The state it walked in with is
 * cloned out through `SimConfig.onTrialStart` and rolled out separately, so the
 * measurement never disturbs the run it came from.
 */
function measureFieldAt(trial: number): FieldResult[] {
  const results: FieldResult[] = [];

  for (const series of SIM_SERIES) {
    const logSamples: number[] = [];
    const clearRates: number[] = [];
    const oneRollShares: number[] = [];
    const clearRolls: number[] = [];
    const dice: number[] = [];
    const gold: number[] = [];
    let reached = 0;

    for (let run = 0; run < RUNS; run++) {
      const seed = seriesSeed(SEED, run, series.seedOffset);
      let captured: RunState | null = null;
      const cfg = seriesConfig(
        {
          ...DEFAULT_CONFIG,
          runs: 1,
          seed: SEED,
          stopAfterTrial: trial,
          onTrialStart: (state) => {
            if (state.trial === trial && !captured)
              captured = cloneRunState(state);
          },
        },
        series,
      );
      simulateRun(series.strategy, seed, cfg);
      if (!captured) continue;

      reached += 1;
      const entered: RunState = captured;
      const capacity = measureCapacity(entered, {
        samples: SAMPLES,
        seed: seed ^ 0x9e37_79b9,
      });
      logSamples.push(...capacity.logSamples);
      clearRates.push(capacity.clearRate);
      oneRollShares.push(capacity.oneRollShare);
      if (capacity.clearRate > 0) clearRolls.push(capacity.meanClearRoll);
      dice.push(entered.dice.length);
      gold.push(entered.gold);
    }

    logSamples.sort((a, b) => a - b);
    results.push({
      label: series.label,
      strategy: series.strategy,
      reached,
      attempted: RUNS,
      logSamples,
      clearRate: mean(clearRates),
      oneRollShare: mean(oneRollShares),
      meanClearRoll: mean(clearRolls),
      dice: mean(dice),
      gold: mean(gold),
    });
  }

  return results;
}

/** `1.0e6` rather than `6.00`, so a log column can still be read as a score. */
function asScore(log: number): string {
  if (log <= 0) return "0";
  const exp = Math.floor(log);
  const mantissa = 10 ** (log - exp);
  return exp < 6
    ? Math.round(10 ** log).toLocaleString("en-US")
    : `${mantissa.toFixed(1)}e${exp}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function reportFixture(fixture: RunFixture): void {
  const state = fixture.state;
  const trial = state.trial;
  const budget = trialRollTarget(state);
  const goal = goalFor(state);
  const goalLog = log10Big(goal);

  const human: Capacity = measureCapacity(state, {
    samples: Math.max(SAMPLES, 25),
    seed: SEED ^ 0x51ed_270b,
  });
  const humanP50 = quantile(human.logSamples, 0.5);

  console.log("");
  console.log("=".repeat(96));
  console.log(`FIXTURE  ${fixture.name}`);
  console.log(`         ${describeFixture(state)}`);
  console.log(`         ${describeBuild(state)}`);
  console.log("");
  console.log(
    `TRIAL ${trial} — ${trialName(trial)} of rank ${rankOf(trial)} ` +
      `(${trialInRank(trial)}/3), ${budget} rolls, goal ${asScore(goalLog)}`,
  );
  console.log("");
  console.log(
    `YOUR BUILD  full-budget capacity  p10 ${asScore(quantile(human.logSamples, 0.1))}` +
      `  p50 ${asScore(humanP50)}  p90 ${asScore(quantile(human.logSamples, 0.9))}`,
  );
  console.log(
    `            meets this goal ${pct(human.clearRate)} of the time, ` +
      `${pct(human.oneRollShare)} of it on roll 1` +
      (human.meanClearRoll > 0
        ? `; mean clearing roll ${human.meanClearRoll.toFixed(1)} of ${budget}`
        : ""),
  );
  console.log("");

  // Said on its own line rather than in the header, which is a fixed-width ruler
  // the data rows are aligned to — widening it moves the columns for one row.
  if (fieldCache.has(trial)) {
    console.log(
      `(field reused — trial ${trial} was measured for an earlier fixture)`,
    );
  }
  const header =
    pad("FIELD", 30) +
    padStart("reach", 7) +
    padStart("p50", 11) +
    padStart("vs you", 9) +
    padStart("clears", 8) +
    padStart("1-roll", 8) +
    padStart("roll", 7) +
    padStart("dice", 9) +
    padStart("gold", 6);
  console.log(header);
  console.log("-".repeat(header.length));

  for (const result of measureField(trial)) {
    if (result.reached === 0) {
      console.log(
        pad(result.label, 30) + padStart(`0/${result.attempted}`, 7) + "   —",
      );
      continue;
    }
    const p50 = quantile(result.logSamples, 0.5);
    const delta = p50 - humanP50;
    console.log(
      pad(result.label, 30) +
        padStart(`${pct(result.reached / result.attempted)}`, 7) +
        padStart(asScore(p50), 11) +
        padStart(`${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`, 9) +
        padStart(pct(result.clearRate), 8) +
        padStart(pct(result.oneRollShare), 8) +
        padStart(
          result.meanClearRoll > 0 ? result.meanClearRoll.toFixed(1) : "—",
          7,
        ) +
        padStart(Math.round(result.dice).toLocaleString("en-US"), 9) +
        padStart(result.gold.toFixed(1), 6),
    );
  }

  console.log("");
  console.log(
    "vs you: log10 of the capacity ratio. -1.00 means the bot reaches a tenth of",
  );
  console.log(
    "what you reach, so a goal tuned to challenge it is one you clear tenfold.",
  );
}

function main(): void {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const paths = args.length > 0 ? args : globSync(DEFAULT_GLOB);
  if (paths.length === 0) {
    console.error(
      `No run fixtures found (looked for ${DEFAULT_GLOB}).\n\n` +
        `Play the game with \`npm run dev\`, open the dev panel with the \` key,\n` +
        `and press "Export run (JSON)" at the point on the ladder you want\n` +
        `measured. Save the downloaded file into sim-fixtures/ and run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Benchmark — ${paths.length} fixture(s), ${RUNS} runs per series, ` +
      `${SAMPLES} roll-outs per state, seed ${SEED}`,
  );
  for (const fixture of loadRunFixtures(paths)) reportFixture(fixture);
}

main();
