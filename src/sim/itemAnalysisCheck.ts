// Executable spec for Codex item analysis persistence and authored payoff units.
// Run: node node_modules/tsx/dist/cli.mjs src/sim/itemAnalysisCheck.ts

import { newRun } from "../state/RunState";
import {
  hydrateRunState,
  serializeRunState,
} from "../systems/ActiveRunPersistence";
import {
  histogramMedian,
  loadItemAnalysis,
  recordItemAnalysisRun,
} from "../systems/ItemAnalytics";
import {
  recordRunItemPurchase,
  snapshotItemValues,
} from "../systems/ItemValue";
import { applyOffer, offerFor } from "../systems/Shop";
import { beginRun } from "./engine";
import { installStorage } from "./localStorageShim";

installStorage([]);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) console.log(`  ok   ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

const run = newRun();
beginRun(run);
const growth = offerFor("extra_die", run);
check(applyOffer(run, growth), "a growth card applies");
recordRunItemPurchase(run, "extra_die", 7);
run.rollHistory.push({
  trial: run.trial,
  score: run.totalScore,
  dice: run.dice.length,
  valueByItem: snapshotItemValues(run),
});
recordItemAnalysisRun(run, true);

const analysis = loadItemAnalysis("extra_die");
check(analysis.runs === 1, "a taken item records one analyzed run");
check(analysis.wins === 1 && analysis.losses === 0, "its win is recorded");
check(analysis.purchases === 1, "actual card selections are counted");
check(analysis.goldSpent === 7, "the transaction's supplied cost is retained");
check(analysis.totalValue === 2, "growth payoff is measured in dice added");
check(
  analysis.topRuns[0]?.values[analysis.topRuns[0].values.length - 1] === 2,
  "the retained run curve ends at the same payoff",
);

const restored = hydrateRunState(serializeRunState(run));
check(
  restored?.itemPurchases[0]?.cost === 7 && restored.itemValues.extra_die === 2,
  "active-run saves preserve purchases and payoff counters",
);
check(
  histogramMedian({ "1": 1, "2": 1 }) === 1.5,
  "numeric medians average their two middle observations",
);
check(
  histogramMedian({ "1": 1, "2": 1 }, true) === 1,
  "pickup medians stay on a real trial",
);

if (failures > 0) {
  console.error(`\nItem-analysis check: ${failures} FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nItem-analysis check: ALL PASS");
}
