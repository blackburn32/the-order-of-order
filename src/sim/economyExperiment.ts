// Matched-seed, simulation-only experiments for economy pacing. Scenarios may
// alter the bot's unused-roll payout or temporarily move item metadata while a
// batch runs; every mutation is restored before the next scenario and none of
// these variants changes live play.

import {
  ITEMS,
  type PriceBand,
  type Rarity,
  type ShopItemId,
} from "../systems/Items";
import { simulateRun, type RunRecord, type TrialPoint } from "./bot";
import { DEFAULT_CONFIG, type SimConfig } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { seriesConfig, seriesSeed, SMART_SERIES } from "./series";

interface ItemPatch {
  id: ShopItemId;
  rarity?: Rarity;
  priceBand?: PriceBand;
}

interface Scenario {
  id: string;
  label: string;
  config?: Pick<SimConfig, "unusedRollBaseMultiplier" | "unusedRollCap">;
  patches?: ItemPatch[];
}

interface Metrics {
  id: string;
  label: string;
  records: RunRecord[];
  rankSurvival: number[];
  winRate: number;
  meanGoldEarned: number;
  meanGoldSpent: number;
  meanPurchases: number;
  meanRollShare: number;
  firstRollRate: number;
  lateRollShare: number;
  lateFirstRollRate: number;
  rankRollShare: number[];
  rankFirstRollRate: number[];
  p90LogScore: number;
  p99LogScore: number;
  itemBuyRates: Partial<Record<ShopItemId, number>>;
}

const RUNS = Math.max(1, Number(process.env.RUNS ?? 200) | 0);
const PRICE_ORDER: PriceBand[] = ["free", "low", "standard", "strong", "build"];
const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare"];
const ITEM_BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

function nextPrice(price: PriceBand): PriceBand {
  return PRICE_ORDER[
    Math.min(PRICE_ORDER.length - 1, PRICE_ORDER.indexOf(price) + 1)
  ];
}

function nextRarity(rarity: Rarity): Rarity {
  return RARITY_ORDER[
    Math.min(RARITY_ORDER.length - 1, RARITY_ORDER.indexOf(rarity) + 1)
  ];
}

const explosive = ITEMS.filter(
  (item) => item.stackPricing === "explosive" && !item.cursed,
);
const explosiveRarityPatches = explosive
  .filter((item) => item.rarity !== "rare")
  .map((item) => ({ id: item.id, rarity: nextRarity(item.rarity) }));
const explosivePricePatches = explosive
  .filter((item) => item.priceBand !== "build")
  .map((item) => ({ id: item.id, priceBand: nextPrice(item.priceBand) }));

const SCENARIOS: Scenario[] = [
  { id: "baseline", label: "Live baseline" },
  {
    id: "unused-80",
    label: "80% ordinary unused-roll gold",
    config: { unusedRollBaseMultiplier: 0.8 },
  },
  {
    id: "unused-cap-4",
    label: "Only four unused rolls pay",
    config: { unusedRollCap: 4 },
  },
  {
    id: "unused-half",
    label: "Half ordinary unused-roll gold",
    config: { unusedRollBaseMultiplier: 0.5 },
  },
  {
    id: "unused-cap-2",
    label: "Only two unused rolls pay",
    config: { unusedRollCap: 2 },
  },
  {
    id: "unused-none",
    label: "No ordinary unused-roll gold",
    config: { unusedRollBaseMultiplier: 0 },
  },
  {
    id: "explosive-rarity",
    label: "All repeatable explosives +1 rarity",
    patches: explosiveRarityPatches,
  },
  {
    id: "explosive-price",
    label: "All repeatable explosives +1 price band",
    patches: explosivePricePatches,
  },
  {
    id: "last-call-rare",
    label: "Last Call uncommon → rare",
    patches: [{ id: "last_call", rarity: "rare" }],
  },
  {
    id: "downbeat-premium",
    label: "Downbeat rare + build price",
    patches: [{ id: "downbeat", rarity: "rare", priceBand: "build" }],
  },
  {
    id: "lucky-seven-premium",
    label: "Lucky Seven rare + build price",
    patches: [{ id: "lucky_seven", rarity: "rare", priceBand: "build" }],
  },
  {
    id: "foundry-premium",
    label: "Foundry rare + build price",
    patches: [{ id: "foundry", rarity: "rare", priceBand: "build" }],
  },
  {
    id: "foundry-rare",
    label: "Foundry uncommon → rare",
    patches: [{ id: "foundry", rarity: "rare" }],
  },
  {
    id: "foundry-build",
    label: "Foundry strong → build price",
    patches: [{ id: "foundry", priceBand: "build" }],
  },
  {
    id: "lucky-seven-uncommon",
    label: "Lucky Seven rare → uncommon rollback",
    patches: [{ id: "lucky_seven", rarity: "uncommon" }],
  },
  {
    id: "lucky-seven-build",
    label: "Lucky Seven strong → build price",
    patches: [{ id: "lucky_seven", priceBand: "build" }],
  },
  {
    id: "double-fun-rare",
    label: "Double the Fun uncommon → rare",
    patches: [{ id: "double_the_fun", rarity: "rare" }],
  },
  {
    id: "dividend-uncommon",
    label: "Dividend common → uncommon",
    patches: [{ id: "dividend", rarity: "uncommon" }],
  },
  {
    id: "mult2-rare",
    label: "Multiply Dice ×2 uncommon → rare",
    patches: [{ id: "mult2", rarity: "rare" }],
  },
  {
    id: "targeted-rarity",
    label: "Foundry/Double Fun/Dividend rarity pass",
    patches: [
      { id: "foundry", rarity: "rare" },
      { id: "double_the_fun", rarity: "rare" },
      { id: "dividend", rarity: "uncommon" },
    ],
  },
  {
    id: "cap4-double-rare",
    label: "4g early bonus + Double the Fun rare",
    config: { unusedRollCap: 4 },
    patches: [{ id: "double_the_fun", rarity: "rare" }],
  },
  {
    id: "top-four-access",
    label: "Last Call/Downbeat/Lucky Seven/Foundry premium",
    patches: [
      { id: "last_call", rarity: "rare" },
      { id: "downbeat", rarity: "rare", priceBand: "build" },
      { id: "lucky_seven", rarity: "rare", priceBand: "build" },
      { id: "foundry", rarity: "rare", priceBand: "build" },
    ],
  },
];

const originals = new Map(
  ITEMS.map((item) => [
    item.id,
    { rarity: item.rarity, priceBand: item.priceBand },
  ]),
);

function restoreItems(): void {
  for (const item of ITEMS) {
    const original = originals.get(item.id)!;
    item.rarity = original.rarity;
    item.priceBand = original.priceBand;
  }
}

function applyScenario(scenario: Scenario): void {
  restoreItems();
  for (const patch of scenario.patches ?? []) {
    const item = ITEM_BY_ID.get(patch.id)!;
    if (patch.rarity) item.rarity = patch.rarity;
    if (patch.priceBand) item.priceBand = patch.priceBand;
  }
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor(q * (sorted.length - 1))),
    )
  ];
}

function clearedRank(record: RunRecord, rank: number): boolean {
  const trial = rank * 3;
  return record.trajectory.some(
    (point) => point.trial === trial && point.cleared,
  );
}

function pace(points: TrialPoint[]): { share: number; firstRoll: number } {
  const cleared = points.filter((point) => point.cleared && point.trial < 30);
  return {
    share: mean(
      cleared.map(
        (point) =>
          (point.clearedOnRoll ?? point.rollsUsed) /
          Math.max(1, point.rollBudget),
      ),
    ),
    firstRoll: cleared.length
      ? cleared.filter((point) => (point.clearedOnRoll ?? point.rollsUsed) <= 1)
          .length / cleared.length
      : 0,
  };
}

function metricsFor(scenario: Scenario, records: RunRecord[]): Metrics {
  const points = records.flatMap((record) => record.trajectory);
  const overallPace = pace(points);
  const latePace = pace(points.filter((point) => point.rank >= 4));
  const rankPace = Array.from({ length: 10 }, (_, index) =>
    pace(points.filter((point) => point.rank === index + 1)),
  );
  const itemBuyRates: Partial<Record<ShopItemId, number>> = {};
  for (const item of ITEMS) {
    itemBuyRates[item.id] =
      records.filter((record) => (record.purchases[item.id] ?? 0) > 0).length /
      records.length;
  }
  return {
    id: scenario.id,
    label: scenario.label,
    records,
    rankSurvival: Array.from({ length: 10 }, (_, index) =>
      mean(records.map((record) => (clearedRank(record, index + 1) ? 1 : 0))),
    ),
    winRate: mean(records.map((record) => (record.won ? 1 : 0))),
    meanGoldEarned: mean(records.map((record) => record.goldEarned)),
    meanGoldSpent: mean(records.map((record) => record.goldSpent)),
    meanPurchases: mean(
      records.map((record) =>
        Object.values(record.purchases).reduce(
          (sum, count) => sum + (count ?? 0),
          0,
        ),
      ),
    ),
    meanRollShare: overallPace.share,
    firstRollRate: overallPace.firstRoll,
    lateRollShare: latePace.share,
    lateFirstRollRate: latePace.firstRoll,
    rankRollShare: rankPace.map((entry) => entry.share),
    rankFirstRollRate: rankPace.map((entry) => entry.firstRoll),
    p90LogScore: quantile(
      records.map((record) => Math.log10(1 + Math.max(0, record.totalScore))),
      0.9,
    ),
    p99LogScore: quantile(
      records.map((record) => Math.log10(1 + Math.max(0, record.totalScore))),
      0.99,
    ),
    itemBuyRates,
  };
}

function runScenario(scenario: Scenario): Metrics {
  applyScenario(scenario);
  const records: RunRecord[] = [];
  for (const series of SMART_SERIES) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    for (let run = 0; run < RUNS; run++) {
      records.push(
        simulateRun(
          series.strategy,
          seriesSeed(DEFAULT_CONFIG.seed, run, series.seedOffset),
          {
            ...seriesConfig(DEFAULT_CONFIG, series),
            ...scenario.config,
          },
        ),
      );
    }
  }
  return metricsFor(scenario, records);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function baselineItemSignals(records: RunRecord[]): void {
  const topThreshold = quantile(
    records.map((record) => record.totalScore),
    0.9,
  );
  const top = records.filter((record) => record.totalScore >= topThreshold);
  const baselineWins = mean(records.map((record) => (record.won ? 1 : 0)));
  const rows = ITEMS.filter((item) => !item.cursed)
    .map((item) => {
      const buyers = records.filter(
        (record) => (record.purchases[item.id] ?? 0) > 0,
      );
      const topBuyRate = mean(
        top.map((record) => ((record.purchases[item.id] ?? 0) > 0 ? 1 : 0)),
      );
      const buyRate = buyers.length / records.length;
      const winRate = mean(buyers.map((record) => (record.won ? 1 : 0)));
      const attributed = records.reduce(
        (sum, record) =>
          sum +
          (record.dicePoints[item.id] ?? 0) +
          (record.itemPoints[item.id] ?? 0),
        0,
      );
      const allPoints = records.reduce(
        (sum, record) => sum + Math.max(0, record.totalScore),
        0,
      );
      return {
        item,
        buyRate,
        topBuyRate,
        topLift: buyRate ? topBuyRate / buyRate : 0,
        winLift: baselineWins ? winRate / baselineWins : 0,
        pointShare: allPoints ? attributed / allPoints : 0,
      };
    })
    .filter((row) => row.buyRate >= 0.02)
    .sort(
      (a, b) =>
        b.pointShare - a.pointShare ||
        b.topLift - a.topLift ||
        b.winLift - a.winLift,
    )
    .slice(0, 18);

  console.log(
    "\nBaseline item signals (all smart runs; correlation, not causation):",
  );
  console.log(
    "item                 rarity/cost       buy%  top-decile%  top lift  win lift  point share",
  );
  for (const row of rows) {
    console.log(
      `${row.item.name.padEnd(20)} ${(row.item.rarity + "/" + row.item.priceBand).padEnd(17)} ` +
        `${percent(row.buyRate).padStart(6)} ${percent(row.topBuyRate).padStart(12)} ` +
        `${`${row.topLift.toFixed(2)}×`.padStart(9)} ${`${row.winLift.toFixed(2)}×`.padStart(9)} ` +
        `${percent(row.pointShare).padStart(11)}`,
    );
  }
}

console.log(
  `Economy experiments — ${RUNS} runs × ${SMART_SERIES.length} coherent series per scenario`,
);
const requested = new Set(
  (process.env.SCENARIOS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
const selectedScenarios = requested.size
  ? SCENARIOS.filter(
      (scenario) => scenario.id === "baseline" || requested.has(scenario.id),
    )
  : SCENARIOS;
const results: Metrics[] = [];
try {
  for (const scenario of selectedScenarios) {
    const started = Date.now();
    const result = runScenario(scenario);
    results.push(result);
    console.log(
      `  ${scenario.id.padEnd(22)} rank3 ${percent(result.rankSurvival[2])} · rank9 ${percent(result.rankSurvival[8])} · ` +
        `win ${percent(result.winRate)} · gold ${result.meanGoldEarned.toFixed(1)} · ` +
        `late pace ${percent(result.lateRollShare)}/${percent(result.lateFirstRollRate)} ` +
        `(${((Date.now() - started) / 1_000).toFixed(1)}s)`,
    );
  }
} finally {
  restoreItems();
}

const baseline = results[0];
console.log(
  "\nScenario deltas from baseline (pace = mean budget share; 1-roll = cleared on opening roll):",
);
console.log(
  "scenario                 r3 pp  r9 pp  win pp   gold  spend  buys  pace pp  1-roll pp  log-p99",
);
for (const result of results) {
  console.log(
    `${result.label.padEnd(25)} ` +
      `${signed((result.rankSurvival[2] - baseline.rankSurvival[2]) * 100).padStart(6)} ` +
      `${signed((result.rankSurvival[8] - baseline.rankSurvival[8]) * 100).padStart(6)} ` +
      `${signed((result.winRate - baseline.winRate) * 100).padStart(7)} ` +
      `${signed(result.meanGoldEarned - baseline.meanGoldEarned).padStart(6)} ` +
      `${signed(result.meanGoldSpent - baseline.meanGoldSpent).padStart(6)} ` +
      `${signed(result.meanPurchases - baseline.meanPurchases, 2).padStart(6)} ` +
      `${signed((result.lateRollShare - baseline.lateRollShare) * 100).padStart(8)} ` +
      `${signed((result.lateFirstRollRate - baseline.lateFirstRollRate) * 100).padStart(10)} ` +
      `${result.p99LogScore.toFixed(2).padStart(8)}`,
  );
}

console.log("\nSmart-build survival by rank:");
console.log(
  "scenario                 r1    r2    r3    r4    r5    r6    r7    r8    r9   r10",
);
for (const result of results) {
  console.log(
    `${result.label.padEnd(25)} ${result.rankSurvival
      .map((value) => percent(value).padStart(5))
      .join(" ")}`,
  );
}

console.log(
  "\nCleared-trial roll pacing by rank (budget used / opening-roll clears):",
);
for (const result of results) {
  console.log(`  ${result.label}`);
  console.log(
    `    used   ${result.rankRollShare
      .map((value) => percent(value).padStart(5))
      .join(" ")}`,
  );
  console.log(
    `    1-roll ${result.rankFirstRollRate
      .map((value) => percent(value).padStart(5))
      .join(" ")}`,
  );
}

console.log("\nModified-item buy-rate deltas:");
for (const result of results.slice(1)) {
  const scenario = selectedScenarios.find((entry) => entry.id === result.id)!;
  if (!scenario.patches?.length) continue;
  const changes = scenario.patches
    .map((patch) => {
      const before = baseline.itemBuyRates[patch.id] ?? 0;
      const after = result.itemBuyRates[patch.id] ?? 0;
      return `${ITEM_BY_ID.get(patch.id)!.name} ${percent(before)}→${percent(after)}`;
    })
    .join(" · ");
  console.log(`  ${result.id.padEnd(22)} ${changes}`);
}

baselineItemSignals(baseline.records);
