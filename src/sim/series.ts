import type { ShopItemId } from "../systems/Items";
import type { StrategyName } from "./bot";
import { UNLOCK_POOLS } from "./config";

export interface SimulationSeries {
  id: string;
  label: string;
  strategy: StrategyName;
  unlockedAtStart: readonly ShopItemId[];
  seedOffset: number;
}

// No-buy appears once because its shop pool is irrelevant. Each buying strategy
// appears in a matched base/all pair using the same seed stream.
export const SIM_SERIES: SimulationSeries[] = [
  {
    id: "noBuy",
    label: "No-buy (baseline)",
    strategy: "noBuy",
    unlockedAtStart: UNLOCK_POOLS.none,
    seedOffset: 0,
  },
  {
    id: "random-none",
    label: "Random · base only",
    strategy: "random",
    unlockedAtStart: UNLOCK_POOLS.none,
    seedOffset: 7_919,
  },
  {
    id: "random-all",
    label: "Random · all unlocked",
    strategy: "random",
    unlockedAtStart: UNLOCK_POOLS.all,
    seedOffset: 7_919,
  },
  {
    id: "greedy-none",
    label: "Greedy · base only",
    strategy: "greedy",
    unlockedAtStart: UNLOCK_POOLS.none,
    seedOffset: 15_838,
  },
  {
    id: "greedy-all",
    label: "Greedy · all unlocked",
    strategy: "greedy",
    unlockedAtStart: UNLOCK_POOLS.all,
    seedOffset: 15_838,
  },
];

/** Buying series used to design the README's pooled naive-bot attrition curve. */
export const SHOPPER_SERIES = SIM_SERIES.filter(
  (series) => series.strategy !== "noBuy",
);

export function seriesSeed(baseSeed: number, run: number, seedOffset: number) {
  return baseSeed * 1_000_003 + run + seedOffset;
}
