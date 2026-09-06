// Tuning the expert against runs somebody actually played.
//
// `benchmark.ts` asks whether the FIELD is as good as the player, and answers it
// for one fixed field. This asks the next question: which settings of the expert
// close the gap it finds. It sweeps the appraising shopper's knobs over a matched
// seed stream and, for every trial a fixture was exported at, prints what that
// variant of the bot arrives with against what the player arrived with.
//
//   npm run expert:tune
//   RUNS=40 HORIZONS=2,4,6 npm run expert:tune
//   HORIZONS=6 APPETITES=0.5,1 npm run expert:tune -- sim-fixtures/trial-20-*.json
//
// The column to read is `vs you`, exactly as in the benchmark: log10 of the
// capacity ratio at that trial, so -1.00 is a bot arriving with a tenth of the
// player's build and +0.30 is one arriving with twice it. `reach` beside it is
// the share of runs that got to the trial at all, and it is half the answer — a
// setting that scores well from trial 20 but only reaches it once in ten runs has
// not been tuned, it has been made lucky.
//
// Every variant plays the SAME seeds, so two columns differ because the knob
// differs and not because one of them drew better shops.

import { globSync } from "node:fs";
import type { RunState } from "../state/RunState";
import { simulateRun } from "./bot";
import { cloneRunState } from "./cloneRun";
import { measureCapacity, quantile } from "./appraise";
import { mulberry32 } from "./localStorageShim";
import { DEFAULT_CONFIG } from "./config";
import { describeFixture, loadRunFixtures } from "./importRun";
import {
  BUNDLE_SIZE,
  CROSS_TRIAL_ROLLOUTS,
  LADDER_OBJECTIVE,
  LOOKAHEAD_TRIALS,
  MAX_APPRAISAL_PASSES,
  RELATIVE_FLOOR,
} from "./expert";
import { EXPERT_SERIES, seriesConfig, seriesSeed } from "./series";

const RUNS = Number(process.env.RUNS ?? 24);
const SEED = Number(process.env.SEED ?? DEFAULT_CONFIG.seed);
/** Roll-outs each captured state is measured over. The states being compared
 *  are not matched to each other — different runs arrive at trial 20 with
 *  different builds — so this is ordinary sampling and wants more than the
 *  shared-seed appraisals inside the bot do. */
const SAMPLES = Number(process.env.SAMPLES ?? 9);

// The sweep axes. Each takes a comma-separated list and the run is their cross
// product, so one axis at a time keeps the table readable and two crossed
// answers "do these two knobs interact".
const HORIZONS = numbers(process.env.HORIZONS, [LOOKAHEAD_TRIALS]);
const EXPERT_SAMPLES = numbers(process.env.EXPERT_SAMPLES, [3]);
const APPETITES = numbers(process.env.APPETITES, [
  EXPERT_SERIES[0].curseAppetite,
]);
const FLOORS = numbers(process.env.FLOORS, [RELATIVE_FLOOR]);
const PASSES = numbers(process.env.PASSES, [MAX_APPRAISAL_PASSES]);
const GOLD_WEIGHTS = numbers(process.env.GOLD_WEIGHTS, [1]);
/** 0 and 1 rather than a boolean, so it sweeps like every other axis. */
const CROSS_TRIALS = numbers(process.env.CROSS_TRIALS, [
  CROSS_TRIAL_ROLLOUTS ? 1 : 0,
]);
const BUNDLES = numbers(process.env.BUNDLES, [BUNDLE_SIZE]);
/** Again 0 and 1: 1 is the ladder objective, 0 the older score one. */
const LADDERS = numbers(process.env.LADDERS, [
  LADDER_OBJECTIVE === "ladder" ? 1 : 0,
]);

/** Fixtures produced by a bot are not a yardstick — measuring the expert against
 *  one is measuring it against itself. `sample-` is what `README.md` calls the
 *  generated stand-in, so the default sweep skips it and an explicit path on the
 *  command line still loads it. */
const DEFAULT_GLOB = "sim-fixtures/*.json";
const GENERATED_PREFIX = "sample-";

function numbers(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

interface Variant {
  label: string;
  horizonScale: number;
  samples: number;
  curseAppetite: number;
  relativeFloor: number;
  passes: number;
  goldWeight: number;
  crossTrials: boolean;
  bundleSize: number;
  objective: "score" | "ladder";
}

/** Name a variant by the axes actually being swept, so a one-axis sweep reads
 *  `h2 / h4 / h6` rather than repeating five settings that never change. */
function label(parts: [string, number, number[]][]): string {
  const moving = parts.filter(([, , axis]) => axis.length > 1);
  const shown = moving.length > 0 ? moving : [parts[0]];
  return shown.map(([prefix, value]) => `${prefix}${value}`).join(" ");
}

function variants(): Variant[] {
  const out: Variant[] = [];
  for (const horizonScale of HORIZONS)
    for (const samples of EXPERT_SAMPLES)
      for (const curseAppetite of APPETITES)
        for (const relativeFloor of FLOORS)
          for (const passes of PASSES)
            for (const goldWeight of GOLD_WEIGHTS)
              for (const crossTrials of CROSS_TRIALS)
                for (const bundleSize of BUNDLES)
                  for (const ladder of LADDERS)
                    out.push({
                      label: label([
                        ["h", horizonScale, HORIZONS],
                        ["s", samples, EXPERT_SAMPLES],
                        ["c", curseAppetite, APPETITES],
                        ["f", relativeFloor, FLOORS],
                        ["p", passes, PASSES],
                        ["g", goldWeight, GOLD_WEIGHTS],
                        ["x", crossTrials, CROSS_TRIALS],
                        ["b", bundleSize, BUNDLES],
                        ["l", ladder, LADDERS],
                      ]),
                      horizonScale,
                      samples,
                      curseAppetite,
                      relativeFloor,
                      passes,
                      goldWeight,
                      crossTrials: crossTrials !== 0,
                      bundleSize,
                      objective: ladder !== 0 ? "ladder" : "score",
                    });
  return out;
}

/** What one variant of the bot did, at one of the trials being compared. */
interface TrialResult {
  reached: number;
  logSamples: number[];
}

interface VariantResult {
  variant: Variant;
  /** Every run's trial reached, in run order — the same order for every
   *  variant, which is what makes the comparison a paired one. */
  reaches: number[];
  /** The same runs' outcomes as 1 and 0, so wins difference pairwise too. A win
   *  is the rarer event and the sharper signal: the knob that survived this
   *  file's last pass did it on this row rather than on reach. */
  won: number[];
  meanReach: number;
  /** Cards bought per run, copies counted — the readout for the spend knobs. */
  meanCards: number;
  wins: number;
  seconds: number;
  byTrial: Map<number, TrialResult>;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Play `RUNS` runs under one variant, capturing the state the bot entered each
 * measured trial with.
 *
 * The capture is `onTrialStart` — after that trial's shop, before its first
 * roll — which is the same moment a dev-panel export is taken at, so the two
 * sides of the comparison are states of the same kind.
 */
function measureVariant(
  variant: Variant,
  trials: readonly number[],
): VariantResult {
  const wanted = new Set(trials);
  const byTrial = new Map<number, TrialResult>();
  for (const trial of trials)
    byTrial.set(trial, { reached: 0, logSamples: [] });

  const reaches: number[] = [];
  const won: number[] = [];
  const cardsBought: number[] = [];
  let wins = 0;
  const started = Date.now();

  for (let run = 0; run < RUNS; run++) {
    const seed = seriesSeed(SEED, run, EXPERT_SERIES[0].seedOffset);
    const captured = new Map<number, RunState>();
    const cfg = seriesConfig(
      {
        ...DEFAULT_CONFIG,
        runs: 1,
        seed: SEED,
        expertSamples: variant.samples,
        expertHorizonScale: variant.horizonScale,
        expertRelativeFloor: variant.relativeFloor,
        expertPasses: variant.passes,
        expertGoldWeight: variant.goldWeight,
        expertCrossTrials: variant.crossTrials,
        expertBundleSize: variant.bundleSize,
        expertObjective: variant.objective,
        onTrialStart: (state) => {
          if (wanted.has(state.trial) && !captured.has(state.trial))
            captured.set(state.trial, cloneRunState(state));
        },
      },
      EXPERT_SERIES[0],
    );
    cfg.curseAppetite = variant.curseAppetite;

    const record = simulateRun("expert", seed, cfg);
    reaches.push(record.trialReached);
    won.push(record.won ? 1 : 0);
    cardsBought.push(
      Object.values(record.purchases).reduce(
        (sum, copies) => sum + (copies ?? 0),
        0,
      ),
    );
    if (record.won) wins += 1;

    for (const [trial, state] of captured) {
      const result = byTrial.get(trial);
      if (!result) continue;
      result.reached += 1;
      const capacity = measureCapacity(state, {
        samples: SAMPLES,
        seed: seed ^ 0x9e37_79b9,
      });
      result.logSamples.push(...capacity.logSamples);
    }
  }

  for (const result of byTrial.values())
    result.logSamples.sort((a, b) => a - b);
  return {
    variant,
    reaches,
    won,
    meanReach: mean(reaches),
    meanCards: mean(cardsBought),
    wins,
    seconds: (Date.now() - started) / 1000,
    byTrial,
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

/**
 * The difference between two variants, measured the way the runs were actually
 * produced: paired.
 *
 * Every variant plays the same seeds, so run 7 of one and run 7 of the other
 * differ by the knob and by nothing else. Comparing their MEANS throws that
 * away and compares two swingy numbers instead — and the swing is enormous here,
 * enough that giving the appraiser strictly more samples once read three trials
 * WORSE. Differencing per run first cancels the seed, which is the whole reason
 * to have matched them.
 *
 * The interval is a percentile bootstrap over those per-run differences: resample
 * the pairs with replacement, take the mean each time, and report the middle 95%
 * of it. An interval that straddles zero is a knob that did nothing this sweep
 * could see — which is a result, and the one this tool got wrong before it said
 * so out loud.
 */
const BOOTSTRAP_RESAMPLES = 2_000;

function pairedDelta(
  after: readonly number[],
  before: readonly number[],
): { mean: number; low: number; high: number } | null {
  const n = Math.min(after.length, before.length);
  if (n === 0) return null;
  const diffs = Array.from({ length: n }, (_, i) => after[i] - before[i]);
  const rng = mulberry32(0x5eed_1234);
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += diffs[Math.floor(rng() * n)];
    means.push(total / n);
  }
  means.sort((a, b) => a - b);
  return {
    mean: mean(diffs),
    low: quantile(means, 0.025),
    high: quantile(means, 0.975),
  };
}

function main(): void {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const paths =
    args.length > 0
      ? args
      : globSync(DEFAULT_GLOB).filter(
          (path) => !path.split(/[\\/]/).pop()?.startsWith(GENERATED_PREFIX),
        );
  if (paths.length === 0) {
    console.error(
      `No played runs to tune against (looked for ${DEFAULT_GLOB}).\n\n` +
        `Play the game with \`npm run dev\`, open the dev panel with the \` key,\n` +
        `and press "Export run (JSON)" at the points on the ladder you want the\n` +
        `bot measured at. Save the downloads into sim-fixtures/ and run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  const fixtures = loadRunFixtures(paths).sort(
    (a, b) => a.state.trial - b.state.trial,
  );
  const sweep = variants();

  console.log(
    `Expert tuning — ${sweep.length} variant(s) × ${RUNS} matched runs, ` +
      `${SAMPLES} roll-outs per captured state, seed ${SEED}`,
  );
  console.log("");
  console.log("PLAYED RUNS (the yardstick)");
  const humanP50 = new Map<string, number>();
  for (const fixture of fixtures) {
    const capacity = measureCapacity(fixture.state, {
      samples: Math.max(SAMPLES, 25),
      seed: SEED ^ 0x51ed_270b,
    });
    humanP50.set(fixture.name, quantile(capacity.logSamples, 0.5));
    console.log(
      `  ${pad(fixture.name, 30)} ${describeFixture(fixture.state)}` +
        `  → p50 1e${humanP50.get(fixture.name)?.toFixed(2)}`,
    );
  }

  // Two fixtures can sit at the same trial (two runs exported at the same point
  // on the ladder); the bot only has to reach that trial once to answer both.
  const trials = [...new Set(fixtures.map((f) => f.state.trial))].sort(
    (a, b) => a - b,
  );

  const results: VariantResult[] = [];
  for (const variant of sweep) {
    results.push(measureVariant(variant, trials));
    const last = results[results.length - 1];
    console.log(
      `\n[${last.variant.label}] reach ${last.meanReach.toFixed(1)}, ` +
        `${last.wins}/${RUNS} won, ${(last.seconds / RUNS).toFixed(2)}s per run`,
    );
  }

  console.log("");
  console.log(
    "AGAINST EACH PLAYED RUN — vs you (log10 capacity ratio), and reach",
  );
  const header =
    pad("FIXTURE", 26) +
    sweep.map((variant) => padStart(variant.label, 14)).join("");
  console.log(header);
  console.log("-".repeat(header.length));

  // Reach is printed beside every ratio rather than once for the row, because
  // the two numbers only mean anything together: a variant reads high from a
  // trial that its weaker runs died before entering, and that is a survivor
  // talking rather than a setting.
  for (const fixture of fixtures) {
    const trial = fixture.state.trial;
    const you = humanP50.get(fixture.name) ?? 0;
    let row = pad(fixture.name, 26);
    for (const result of results) {
      const at = result.byTrial.get(trial);
      row += padStart(
        at && at.logSamples.length > 0
          ? `${signed(quantile(at.logSamples, 0.5) - you)} ${pct(at.reached / RUNS)}`
          : "—",
        14,
      );
    }
    console.log(row);
  }

  console.log("");
  console.log(
    pad("mean trial reached", 26) +
      results
        .map((result) => padStart(result.meanReach.toFixed(1), 14))
        .join(""),
  );
  // The first variant is the reference — a sweep is read as "what did changing
  // this do", and the first column is what it was changed from.
  const reference = results[0];
  console.log(
    pad("Δ reach, paired 95%", 26) +
      results
        .map((result, index) => {
          if (index === 0) return padStart("(reference)", 14);
          const delta = pairedDelta(result.reaches, reference.reaches);
          return padStart(delta ? signed(delta.mean) : "—", 14);
        })
        .join(""),
  );
  console.log(
    pad("", 26) +
      results
        .map((result, index) => {
          if (index === 0) return padStart("", 14);
          const delta = pairedDelta(result.reaches, reference.reaches);
          return padStart(
            delta ? `[${signed(delta.low)},${signed(delta.high)}]` : "",
            14,
          );
        })
        .join(""),
  );
  console.log(
    pad("Δ wins, paired 95%", 26) +
      results
        .map((result, index) => {
          if (index === 0) return padStart("(reference)", 14);
          const delta = pairedDelta(result.won, reference.won);
          return padStart(delta ? `${signed(delta.mean * 100)}pp` : "—", 14);
        })
        .join(""),
  );
  console.log(
    pad("", 26) +
      results
        .map((result, index) => {
          if (index === 0) return padStart("", 14);
          const delta = pairedDelta(result.won, reference.won);
          return padStart(
            delta
              ? `[${signed(delta.low * 100)},${signed(delta.high * 100)}]`
              : "",
            14,
          );
        })
        .join(""),
  );
  console.log(
    pad("cards bought per run", 26) +
      results
        .map((result) => padStart(result.meanCards.toFixed(1), 14))
        .join(""),
  );
  console.log(
    pad("runs won", 26) +
      results.map((result) => padStart(`${result.wins}/${RUNS}`, 14)).join(""),
  );
  console.log(
    pad("seconds per run", 26) +
      results
        .map((result) => padStart((result.seconds / RUNS).toFixed(2), 14))
        .join(""),
  );
  console.log("");
  console.log(
    "A variant is better when its `vs you` numbers rise WITHOUT its reach falling:",
  );
  console.log(
    "capacity measured from a trial only one run in ten survives to is a measure of",
  );
  console.log("that one run, not of the setting.");
  console.log("");
  console.log(
    "Read the paired interval, not the means: a run of this game swings whole",
  );
  console.log(
    "ranks on its seed, and an interval straddling zero is a knob that did nothing.",
  );
}

main();
