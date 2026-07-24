// Hard Mode tuning: find the target multiplier that lands ~10% survival to
// round 10 for the pooled naive-bot buying field (normal mode lands ~22%).
//
// Runs the REAL survival gate + shop pricing with `hardMode: true`, sweeping the
// survival-target multiplier while holding the extra shop-price multiplier fixed
// (override either via env). For each multiplier it prints the pooled buying
// field's win rate (= share still alive at the end) plus the per-round attrition
// so you can see where the deaths land.
//
// Run: npx tsx src/sim/hardMode.ts
//      RUNS=5000 PRICE=1.25 MULTS="1.5,1.75,2,2.25,2.5" npx tsx src/sim/hardMode.ts
//
// Bake the chosen values into HARD_TARGET_MULT / HARD_PRICE_MULT in src/config.ts.
// Not shipped with the game; delete when balancing is done.

import { DEFAULT_CONFIG } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { RunRecord, simulateRun } from "./bot";
import { seriesSeed, SHOPPER_SERIES } from "./series";
import {
  HARD_PRICE_MULT,
  setHardMultipliers,
  survivalTarget,
  WIN_ROUND,
} from "../config";

const RUNS = Number(process.env.RUNS ?? 2000);
const PRICE = Number(process.env.PRICE ?? HARD_PRICE_MULT);
const MULTS = (process.env.MULTS ?? "1.5,1.75,2,2.25,2.5,3")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

console.log(
  `Hard Mode sweep · ${RUNS} runs/series · price ×${PRICE} · pooled buying field\n` +
    `target: ~10% should survive to round ${WIN_ROUND}\n`,
);

for (const mult of MULTS) {
  setHardMultipliers(mult, PRICE);
  const cfg = { ...DEFAULT_CONFIG, runs: RUNS, hardMode: true };

  const pooled: RunRecord[] = [];
  for (const series of SHOPPER_SERIES) {
    seedGlobalRandom(cfg.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    for (let i = 0; i < RUNS; i++) {
      pooled.push(
        simulateRun(
          series.strategy,
          seriesSeed(cfg.seed, i, series.seedOffset),
          cfg,
        ),
      );
    }
  }

  const wins = pooled.filter((r) => r.won).length;
  const winPct = (wins / pooled.length) * 100;

  // Per-round field-alive %, mirroring validate.ts's attrition table.
  let alive = pooled;
  const alivePct: string[] = [];
  for (let round = 1; round <= WIN_ROUND; round++) {
    const survivors = alive.filter((r) => r.won || r.roundReached > round);
    alivePct.push(
      `r${round}=${((survivors.length / pooled.length) * 100).toFixed(0)}%`,
    );
    alive = survivors;
  }

  const t10 = survivalTarget(WIN_ROUND, true).toLocaleString();
  console.log(
    `mult ×${mult.toFixed(2).padStart(5)} | r${WIN_ROUND} target ${t10.padStart(9)} | ` +
      `survive ${winPct.toFixed(1).padStart(5)}%  | ${alivePct.join(" ")}`,
  );
}

setHardMultipliers(null, null);
