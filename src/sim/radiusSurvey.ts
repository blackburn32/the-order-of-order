// How the bots take to the radius dice: how often each series buys The Halo,
// Grace and The Censer, what they earn, and how Dieanne fares beside Diebert.
//
//   npm run radius:survey            (RUNS=200 STRATEGIES=greedy,thrifty,...)

import { installStorage } from "./localStorageShim";
import { DEFAULT_CONFIG } from "./config";
import { simulateRun, type StrategyName } from "./bot";
import type { CharacterId } from "../systems/Characters";
import { RADIUS_DICE, RADIUS_KINDS } from "../systems/RadiusDice";
import type { ShopItemId } from "../systems/Items";

installStorage(DEFAULT_CONFIG.unlockedAtStart);
const runs = Number(process.env.RUNS ?? 200);
const strategies = (
  process.env.STRATEGIES ??
  "greedy,thrifty,swarm,multiplier,precision,economy,tempo,player"
).split(",") as StrategyName[];
const characters = (process.env.CHARACTERS ?? "diebert,dieanne").split(
  ",",
) as CharacterId[];
const ids = RADIUS_KINDS.map((k) => RADIUS_DICE[k].source as ShopItemId);

for (const character of characters) {
  console.log(`\n${character}`);
  console.log(
    [
      "strategy".padEnd(12),
      "win%",
      ...ids.map((id) => `${id} buys/run`),
      "halo pts/run",
    ].join("  "),
  );
  for (const strategy of strategies) {
    let wins = 0;
    const buys: Record<string, number> = {};
    let haloPoints = 0;
    for (let seed = 1; seed <= runs; seed++) {
      const record = simulateRun(strategy, seed, {
        ...DEFAULT_CONFIG,
        character,
      });
      if (record.won) wins += 1;
      for (const id of ids)
        buys[id] = (buys[id] ?? 0) + (record.purchases[id] ?? 0);
      haloPoints += record.itemPoints.the_halo ?? 0;
    }
    console.log(
      [
        strategy.padEnd(12),
        ((100 * wins) / runs).toFixed(1).padStart(4),
        ...ids.map((id) =>
          (buys[id] / runs).toFixed(2).padStart(`${id} buys/run`.length),
        ),
        (haloPoints / runs).toExponential(2).padStart(12),
      ].join("  "),
    );
  }
}
