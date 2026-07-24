// Validation pass for a candidate target curve (the "re-test" step).
//
// analyze.ts designs curves analytically from trivial-target trajectories. This
// script sets one of those curves as the live override and runs the REAL sim
// (actual survival gate + Last Call coupling + real culling), so it confirms the
// predicted death spread holds up, and regenerates sim-out/report.html against
// the new curve so it can be inspected in the browser.
//
// Run: npx tsx src/sim/validate.ts            (defaults to MEDIUM)
//      CURVE="HARD    (~5% bot win)" npx tsx src/sim/validate.ts
//
// Not shipped with the game; delete when balancing is done.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, GATED_ITEM_IDS } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { RunRecord, simulateRun } from "./bot";
import { aggregate } from "./stats";
import { buildReport } from "./report";
import { seriesSeed, SHOPPER_SERIES, SIM_SERIES } from "./series";
import { roundTarget, setRoundTargets, WIN_ROUND } from "../config";

const curves = JSON.parse(
  readFileSync("sim-out/candidate.json", "utf8"),
) as Record<string, number[]>;
const label = process.env.CURVE ?? "DESIGNED (10-round intent)";
const curve = curves[label];
if (!curve)
  throw new Error(
    `No curve "${label}" in candidate.json. Have: ${Object.keys(curves).join(" | ")}`,
  );

setRoundTargets(curve); // <-- the real survival gate now uses the candidate curve

console.log(
  `Validating "${label}" with REAL culling · ${DEFAULT_CONFIG.runs} runs/series`,
);
console.log("curve = [" + curve.join(", ") + "]\n");

const byStrategy: Record<string, RunRecord[]> = {};
for (const series of SIM_SERIES) {
  seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
  installStorage([...series.unlockedAtStart]);
  const records: RunRecord[] = [];
  for (let i = 0; i < DEFAULT_CONFIG.runs; i++) {
    records.push(
      simulateRun(
        series.strategy,
        seriesSeed(DEFAULT_CONFIG.seed, i, series.seedOffset),
        DEFAULT_CONFIG,
      ),
    );
  }
  byStrategy[series.id] = records;
  const wins = records.filter((r) => r.won).length;
  const hist = new Array(WIN_ROUND).fill(0);
  for (const r of records) hist[Math.min(WIN_ROUND, r.roundReached) - 1]++;
  const bars = hist
    .map((c, i) => (c > 0 ? `r${i + 1}=${c}` : ""))
    .filter(Boolean)
    .join("  ");
  console.log(
    `${series.id.padEnd(12)} win ${((wins / records.length) * 100).toFixed(1)}%  | deaths: ${bars}`,
  );
}

const pooled = SHOPPER_SERIES.flatMap((series) => byStrategy[series.id]);
let alive = pooled;
console.log("\nPooled buying field (README attrition measure):");
console.log(
  "round | target | entrants | died | die% field | survivors | field alive",
);
for (let round = 1; round <= WIN_ROUND; round++) {
  const entrants = alive.length;
  const survivors = alive.filter(
    (record) => record.won || record.roundReached > round,
  );
  const died = entrants - survivors.length;
  console.log(
    `${String(round).padStart(5)} | ${roundTarget(round).toLocaleString().padStart(8)} | ` +
      `${String(entrants).padStart(8)} | ${String(died).padStart(4)} | ` +
      `${((died / pooled.length) * 100).toFixed(1).padStart(9)}% | ` +
      `${String(survivors.length).padStart(9)} | ${((survivors.length / pooled.length) * 100).toFixed(1).padStart(10)}%`,
  );
  alive = survivors;
}

const stats = aggregate(byStrategy, {
  seed: DEFAULT_CONFIG.seed,
  unlockPools: [
    { name: "Base items only", gatedItems: 0 },
    { name: "All unlocked", gatedItems: GATED_ITEM_IDS.length },
  ],
});
const out = resolve(process.cwd(), "sim-out/report.html");
mkdirSync(resolve(process.cwd(), "sim-out"), { recursive: true });
writeFileSync(out, buildReport(stats), "utf8");
console.log(`\nRegenerated report against the candidate curve → ${out}`);
