// Executable spec and balance read for the Daily Rite (systems/Daily).
//
// Run: npm run daily:check            (RUNS=200 by default; DAYS=14)
//
// Two halves. The first asserts the rite's contract — a day always answers the
// same, its rules land on the run and survive a save, and it never leaks into
// an ordinary run's King's Demands. The second plays the field under every boon
// and bane on its own, then under each of the coming days' actual rites, and
// prints each against the field's unmodified win rate.
//
// The balance half is a read, not a gate: a day is meant to be different from
// the ordinary game, and a harsh day is allowed. What it guards against is a
// single modifier so strong, or so ruinous, that every day it turns up on is
// that modifier's day rather than the day's.

import { newRun } from "../state/RunState";
import { AFFLICTIONS, DAILY_BANE_IDS } from "../systems/Afflictions";
import {
  applyDailyRite,
  DAILY_BANE_COUNT,
  DAILY_BOON_COUNT,
  DAILY_BOON_IDS,
  dailyDay,
  dailyRite,
  dailySeed,
  dailyShopUnlocks,
  shelfOnlyBoons,
  type DailyRite,
} from "../systems/Daily";
import { rollKingsDemands } from "../systems/Endings";
import {
  CHARACTER_ORDER,
  DEFAULT_CHARACTER,
  type CharacterId,
} from "../systems/Characters";
import { weightsFor } from "../systems/Shop";
import { BOON_RARITY_WEIGHTS } from "../config";
import {
  hydrateRunState,
  serializeRunState,
} from "../systems/ActiveRunPersistence";
import { simulateRun } from "./bot";
import { DEFAULT_CONFIG } from "./config";
import { mulberry32 } from "../systems/Rng";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import {
  PLAYER_SERIES,
  seriesConfig,
  seriesSeed,
  SMART_SERIES,
} from "./series";

installStorage([]);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

// ---------------------------------------------------------------------------
console.log("The day");

const today = dailyDay(Date.parse("2026-10-23T23:59:59Z"));
check(today === "2026-10-23", "a day is its UTC date");
check(
  dailyDay(Date.parse("2026-10-24T00:00:00Z")) === "2026-10-24",
  "the rite rolls over at UTC midnight",
);
check(
  JSON.stringify(dailyRite(today)) === JSON.stringify(dailyRite(today)),
  "a day always answers the same",
);
const nextDays = Array.from({ length: 60 }, (_, i) =>
  dailyDay(Date.parse("2026-10-23T12:00:00Z") + i * 86_400_000),
);
check(
  new Set(nextDays.map(dailySeed)).size === nextDays.length,
  "sixty days, sixty seeds",
);
check(
  new Set(nextDays.map((d) => JSON.stringify(dailyRite(d)))).size > 30,
  "the rites vary from day to day",
);
for (const day of nextDays) {
  const rite = dailyRite(day);
  if (
    rite.boons.length !== DAILY_BOON_COUNT ||
    rite.banes.length !== DAILY_BANE_COUNT ||
    new Set(rite.boons).size !== DAILY_BOON_COUNT ||
    new Set(rite.banes).size !== DAILY_BANE_COUNT
  ) {
    check(
      false,
      `${day} holds ${DAILY_BOON_COUNT} boons and banes, no repeats`,
    );
  }
}
check(true, "every day holds two distinct boons and two distinct banes");
const seenBoons = new Set(nextDays.flatMap((d) => dailyRite(d).boons));
const seenBanes = new Set(nextDays.flatMap((d) => dailyRite(d).banes));
check(
  seenBoons.size === DAILY_BOON_IDS.length &&
    seenBanes.size === DAILY_BANE_IDS.length,
  "every boon and bane turns up within sixty days",
);
check(
  new Set(nextDays.map((d) => dailyRite(d).character)).size ===
    CHARACTER_ORDER.length,
  "every novice is named within sixty days",
);

// ---------------------------------------------------------------------------
console.log("\nThe run");

const rite: DailyRite = {
  day: today,
  seed: dailySeed(today),
  character: "melodie",
  boons: ["bell", "blessedMarket"],
  banes: ["dailyHaste", "dailyNarrowDoor"],
};
const state = newRun(dailyShopUnlocks(), rite.seed);
applyDailyRite(state, rite);
check(state.dailyRite?.day === today, "the run knows its day");
check(
  rite.banes.every((id) => state.afflictions.includes(id)),
  "the banes stand on the run's afflictions",
);
check((state.purchases.metronome ?? 0) === 1, "a granted boon is owned");
check(state.bonusRollsPerRound === 1, "and does what its card says");
check(state.gold === newRun().gold, "and costs nothing");
check(
  weightsFor(state) === BOON_RARITY_WEIGHTS,
  "the Blessed Market draws every shop at boon odds",
);
check(
  JSON.stringify(shelfOnlyBoons(state)) === JSON.stringify(["blessedMarket"]),
  "only the boon with no card is shelved as itself",
);
const restored = hydrateRunState(
  JSON.parse(JSON.stringify(serializeRunState(state))),
);
check(
  JSON.stringify(restored?.dailyRite) === JSON.stringify(state.dailyRite),
  "the rite survives a save and resume",
);
check(
  hydrateRunState({
    ...JSON.parse(JSON.stringify(serializeRunState(state))),
    dailyRite: { ...rite, boons: ["nonsense"] },
  }) === null,
  "a save carrying an unknown boon fails to resume",
);
check(
  hydrateRunState(JSON.parse(JSON.stringify(serializeRunState(newRun()))))
    ?.dailyRite === null,
  "an ordinary run resumes as an ordinary run",
);

const purse = newRun([], 1);
applyDailyRite(purse, { ...rite, boons: ["purse", "steadyHand"], banes: [] });
check(purse.gold === newRun().gold + 10, "the purse pays at the start");
check(
  purse.loadedSizes.includes(6) && purse.dice.dieAt(0)?.loaded === true,
  "the steady hand loads every d6",
);

const ordinary = newRun([], 1);
const demands = new Set(
  Array.from({ length: 200 }, (_, i) =>
    rollKingsDemands(ordinary, mulberry32(i), 5),
  ).flat(),
);
check(
  DAILY_BANE_IDS.every((id) => !demands.has(id)),
  "the Crown never demands a daily bane",
);
check(
  DAILY_BANE_IDS.every((id) => id in AFFLICTIONS),
  "every bane is an affliction",
);

// ---------------------------------------------------------------------------
const runs = Math.max(1, Number(process.env.RUNS ?? 200) | 0);
const days = Math.max(0, Number(process.env.DAYS ?? 14) | 0);
const field = [...SMART_SERIES, ...PLAYER_SERIES];

/** The field's win rate with `prepare` laid on every run. Every series plays
 *  the same seeds under every condition, so the differences are the rite's. */
function winRate(
  prepare?: (s: ReturnType<typeof newRun>) => void,
  character: CharacterId = DEFAULT_CHARACTER,
): number {
  let wins = 0;
  for (const series of field) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + series.seedOffset);
    installStorage([...series.unlockedAtStart]);
    for (let run = 0; run < runs; run++) {
      const record = simulateRun(
        series.strategy,
        seriesSeed(DEFAULT_CONFIG.seed, run, series.seedOffset),
        {
          ...seriesConfig(DEFAULT_CONFIG, series),
          character,
          prepareRun: prepare,
        },
      );
      if (record.won) wins += 1;
    }
  }
  return wins / (runs * field.length);
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(6);
const only = (boons: DailyRite["boons"], banes: DailyRite["banes"]) => {
  const r: DailyRite = {
    day: today,
    seed: 0,
    character: "diebert",
    boons,
    banes,
  };
  return (s: ReturnType<typeof newRun>) => applyDailyRite(s, r);
};

console.log(
  `\nBalance — ${runs} runs × ${field.length} series (${field.map((s) => s.strategy).join(", ")})`,
);
const baseline = winRate();
const baselines: Partial<Record<CharacterId, number>> = {
  [DEFAULT_CHARACTER]: baseline,
};
console.log(`  baseline             ${pct(baseline)}`);
console.log("\n  boon alone           win    ratio");
for (const id of DAILY_BOON_IDS) {
  const w = winRate(only([id], []));
  console.log(`  ${id.padEnd(20)} ${pct(w)}  ${(w / baseline).toFixed(2)}x`);
}
console.log("\n  bane alone           win    ratio");
for (const id of DAILY_BANE_IDS) {
  const w = winRate(only([], [id]));
  console.log(`  ${id.padEnd(20)} ${pct(w)}  ${(w / baseline).toFixed(2)}x`);
}
if (days > 0) {
  console.log("\n  the coming days (ratio against that novice unmodified)");
  for (const day of nextDays.slice(0, days)) {
    const r = dailyRite(day);
    // Read against the day's own novice unmodified, since that is the game the
    // rite is a variation of.
    const base = (baselines[r.character] ??= winRate(undefined, r.character));
    const w = winRate((s) => applyDailyRite(s, r), r.character);
    console.log(
      `  ${day}  ${pct(w)}  ${(w / base).toFixed(2)}x  ${r.character.padEnd(7)}  ${[...r.boons, ...r.banes].join(", ")}`,
    );
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Daily Rite checks passed.");
