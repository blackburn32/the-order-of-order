import type { StrategyName } from "./bot";
import { SimConfig, UNLOCK_POOLS } from "./config";
import type { ShopItemId } from "../systems/Items";

export interface SimulationSeries {
  id: string;
  label: string;
  strategy: StrategyName;
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
    unlockedAtStart: UNLOCK_POOLS[pool],
    seedOffset: OFFSETS[strategy],
  };
}

export const SIM_SERIES: SimulationSeries[] = [
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

/** Every series is a shopper now — there is no no-buy baseline to exclude — so
 *  the pooled field the goal curve is designed against is simply all of them. */
export const SHOPPER_SERIES = SIM_SERIES;

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
  return { ...cfg, unlockedAtStart: [...series.unlockedAtStart] };
}
