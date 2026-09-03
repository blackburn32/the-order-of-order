// Decision-quality report for cursed cards. Runs the same field at both ends
// of the appetite axis and compares every accepted curse with the baseline win
// rate of the strategies that accepted it.

import { ITEMS, type ShopItemId } from "../systems/Items";
import { simulateRun, type RunRecord } from "./bot";
import { DEFAULT_CONFIG } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { seriesConfig, seriesSeed, SIM_SERIES } from "./series";

const runs = Math.max(1, Number(process.env.RUNS ?? DEFAULT_CONFIG.runs) | 0);
const cursed = ITEMS.filter((def) => def.cursed);

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const mean = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;

for (const appetite of [0, 1]) {
  const recordsBySeries = new Map<string, RunRecord[]>();
  for (const series of SIM_SERIES) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    const records: RunRecord[] = [];
    for (let run = 0; run < runs; run++) {
      records.push(
        simulateRun(
          series.strategy,
          seriesSeed(DEFAULT_CONFIG.seed, run, series.seedOffset),
          {
            ...seriesConfig(DEFAULT_CONFIG, series),
            curseAppetite: appetite,
          },
        ),
      );
    }
    recordsBySeries.set(series.id, records);
  }

  const totalRuns = runs * SIM_SERIES.length;
  console.log(
    `\nCurse appetite ${appetite.toFixed(1)} — ${runs} runs × ${SIM_SERIES.length} series`,
  );
  console.log(
    "card                 | offered | offer/run | taken | take% | win taken | baseline | ratio | rank taken | rank declined",
  );

  for (const def of cursed) {
    const row = summarize(def.id, recordsBySeries, totalRuns);
    const flag =
      appetite === 1 && row.taken === 0
        ? "  <-- no takes at appetite 1"
        : row.taken > 0 && (row.ratio < 0.6 || row.ratio > 1.4)
          ? "  <-- out of band"
          : "";
    console.log(
      `${def.name.padEnd(20)} | ${String(row.offered).padStart(7)} | ${row.offerPerRun.toFixed(2).padStart(9)} | ` +
        `${String(row.taken).padStart(5)} | ${pct(row.takeRate).padStart(5)} | ` +
        `${(row.taken ? pct(row.winRateTaken) : "—").padStart(9)} | ${pct(row.baseline).padStart(8)} | ` +
        `${(row.taken ? `${row.ratio.toFixed(2)}x` : "—").padStart(5)} | ` +
        `${(row.taken ? row.rankTaken.toFixed(1) : "—").padStart(10)} | ` +
        `${(row.declined ? row.rankDeclined.toFixed(1) : "—").padStart(13)}${flag}`,
    );
  }
}

function summarize(
  id: ShopItemId,
  recordsBySeries: ReadonlyMap<string, RunRecord[]>,
  totalRuns: number,
) {
  let offered = 0;
  let taken = 0;
  let winsTaken = 0;
  let baselineWeighted = 0;
  let baselineWeight = 0;
  const ranksTaken: number[] = [];
  const ranksDeclined: number[] = [];

  for (const records of recordsBySeries.values()) {
    const baseline =
      records.filter((record) => record.won).length / records.length;
    const takenHere = records.filter(
      (record) => record.cursesTaken[id] !== undefined,
    );
    const exposedHere = records.filter(
      (record) => (record.cursesOffered[id] ?? 0) > 0,
    );
    offered += records.reduce(
      (sum, record) => sum + (record.cursesOffered[id] ?? 0),
      0,
    );
    taken += takenHere.length;
    winsTaken += takenHere.filter((record) => record.won).length;
    for (const record of takenHere) ranksTaken.push(record.rankReached);
    for (const record of exposedHere)
      if (record.cursesTaken[id] === undefined)
        ranksDeclined.push(record.rankReached);

    const weight = takenHere.length || exposedHere.length;
    baselineWeighted += baseline * weight;
    baselineWeight += weight;
  }

  const winRateTaken = taken ? winsTaken / taken : 0;
  const baseline = baselineWeight ? baselineWeighted / baselineWeight : 0;
  return {
    offered,
    offerPerRun: totalRuns ? offered / totalRuns : 0,
    taken,
    declined: ranksDeclined.length,
    takeRate: offered ? taken / offered : 0,
    winRateTaken,
    baseline,
    ratio: baseline > 0 ? winRateTaken / baseline : 1,
    rankTaken: mean(ranksTaken),
    rankDeclined: mean(ranksDeclined),
  };
}
