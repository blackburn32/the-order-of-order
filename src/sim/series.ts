import type { StrategyName } from "./bot";
import { SimConfig, UNLOCK_POOLS } from "./config";
import type { ShopItemId } from "../systems/Items";

export interface SimulationSeries {
  id: string;
  label: string;
  strategy: StrategyName;
  curseAppetite: number;
  unlockedAtStart: readonly ShopItemId[];
  seedOffset: number;
}

// Nine series: every strategy against the full unlock pool, plus the two
// price-driven shoppers against the base pool as a first-run baseline.
//
// The themed bots only run against `all` because roughly half of every theme is
// gated — a "multiplier" bot with no Prism or Last Call is not measuring the
// multiplier build, it is measuring a worse version of the price-driven bots.
// Each strategy has its own seed offset, so the two greedy/thrifty pairs share a
// seed stream between their base and all variants and the base/all comparison
// does not pick up avoidable noise from unrelated rolls.
const OFFSETS: Record<StrategyName, number> = {
  greedy: 7_919,
  thrifty: 15_838,
  swarm: 23_757,
  multiplier: 31_676,
  precision: 39_595,
  economy: 47_514,
  tempo: 55_433,
  expert: 63_352,
};

function series(
  strategy: StrategyName,
  label: string,
  pool: "none" | "all",
): SimulationSeries {
  return {
    id: `${strategy}-${pool}`,
    label,
    strategy,
    curseAppetite: 0.5,
    unlockedAtStart: UNLOCK_POOLS[pool],
    seedOffset: OFFSETS[strategy],
  };
}

export const SIM_SERIES: SimulationSeries[] = [
  series("expert", "Expert · measured value", "all"),
  series("greedy", "Greedy · base only", "none"),
  series("greedy", "Greedy · all unlocked", "all"),
  series("thrifty", "Thrifty · base only", "none"),
  series("thrifty", "Thrifty · all unlocked", "all"),
  series("swarm", "Swarm · grow the grid", "all"),
  series("multiplier", "Multiplier · compound the roll", "all"),
  series("precision", "Precision · score more often", "all"),
  series("economy", "Economy · build the purse", "all"),
  series("tempo", "Tempo · rolls and safety", "all"),
];

/** The expert on its own — the only series that appraises what it buys and aims
 *  the cards that need a die (see sim/expert.ts).
 *
 *  Deliberately NOT folded into the two pooled fields below. Every shipped goal
 *  was designed against a field that shops by price and theme, and quietly
 *  adding a stronger shopper to that pool would move the whole curve as a side
 *  effect of this file being edited. Point a tuner at it on purpose:
 *
 *      FIELD=expert node node_modules/tsx/dist/cli.mjs src/sim/smartSurvivalCurve.ts
 */
export const EXPERT_SERIES = SIM_SERIES.filter(
  (series) => series.strategy === "expert",
);

/** Every series is a shopper now — there is no no-buy baseline to exclude — so
 *  the pooled field the goal curve is designed against is simply all of them,
 *  less the expert (see above). */
export const SHOPPER_SERIES = SIM_SERIES.filter(
  (series) => series.strategy !== "expert",
);

/** Coherent, fully unlocked shoppers used to set the survival curve. Base-pool
 * runs and the deliberately weak economy hoarder remain in validation, but do
 * not make the opening ladder lethal for builds that spend toward power. */
export const SMART_SERIES = SIM_SERIES.filter(
  (series) =>
    series.id.endsWith("-all") &&
    series.strategy !== "economy" &&
    series.strategy !== "expert",
);

/**
 * The field a tuner designs a curve against, named by the `FIELD` environment
 * variable.
 *
 * Which field is chosen IS the design decision, so it is made out loud on the
 * command line rather than by whichever constant a tuner happened to import:
 *
 *   `smart`   the coherent all-unlocked price-and-theme shoppers (the default,
 *             and what every shipped goal was designed against).
 *   `expert`  the appraising shopper alone — a curve for people who play the
 *             way it does, and a harder ladder for everyone who does not.
 *   `shopper` every series but the expert, base pools included.
 *
 * A curve designed against a stronger field is a harder game for weaker builds,
 * which is a design call and not a mechanical one. See sim/README.md.
 */
export function tunerField(): SimulationSeries[] {
  const name = (process.env.FIELD ?? "smart").toLowerCase();
  switch (name) {
    case "smart":
      return SMART_SERIES;
    case "expert":
      return EXPERT_SERIES;
    case "shopper":
      return SHOPPER_SERIES;
    default:
      throw new Error(
        `FIELD=${name} is not a field. Use smart, expert or shopper.`,
      );
  }
}

/** What `tunerField()` is currently pointed at, for a report header. */
export function tunerFieldName(): string {
  return (process.env.FIELD ?? "smart").toLowerCase();
}

export function seriesSeed(baseSeed: number, run: number, seedOffset: number) {
  return baseSeed * 1_000_003 + run + seedOffset;
}

/** The batch config as this series needs it: the series' own unlock pool, not
 *  the config's default. Every driver must build its config through here —
 *  passing the shared config straight to `simulateRun` silently gives every
 *  series the full pool, which makes the base/all comparison measure nothing. */
export function seriesConfig(
  cfg: SimConfig,
  series: SimulationSeries,
): SimConfig {
  return {
    ...cfg,
    unlockedAtStart: [...series.unlockedAtStart],
    curseAppetite: series.curseAppetite,
  };
}
