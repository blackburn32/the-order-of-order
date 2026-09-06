// Executable spec for the run timeline: the per-roll series in
// systems/RunHistory.ts that the analysis screen charts a run's points and pool
// size from.
//
// Run: npm run history:check
//
// The series is written by the engine and read back off two different saves, so
// what these assertions protect is that a run's curves say the same thing on the
// Game Over screen, on a resumed run, and in the Hall a week later.

import { newRun } from "../state/RunState";
import {
  hydrateRunState,
  serializeRunState,
} from "../systems/ActiveRunPersistence";
import {
  historyStride,
  recordRollSample,
  ROLL_HISTORY_CAP,
} from "../systems/RunHistory";
import { loadHall, recordRunEnd } from "../systems/SaveData";
import { beginRun, resolveRoll, resolveTrialEnd, rollPool } from "./engine";
import { installStorage, seedGlobalRandom } from "./localStorageShim";

installStorage([]);
seedGlobalRandom(7);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

function stableMap(
  values: Record<string, bigint | number> | undefined,
): string {
  if (!values) return "legacy";
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => `${id}:${value}`)
    .join(",");
}

/** The persisted form, for comparing two timelines value by value. */
function stable(
  state: {
    score: bigint;
    dice: number;
    trial: number;
    pointsByItem?: Record<string, bigint>;
    diceByItem?: Record<string, number>;
  }[],
) {
  return state
    .map(
      (s) =>
        `${s.trial}:${s.score}:${s.dice}:${stableMap(s.pointsByItem)}:${stableMap(s.diceByItem)}`,
    )
    .join("|");
}

// ---------------------------------------------------------------------------
console.log("\nWhat the engine records");

const state = newRun([]);
beginRun(state);
check(
  state.rollHistory.length === 1,
  "a fresh run opens on an origin sample, before any roll",
);
check(state.rollHistory[0].score === 0n, "which has banked nothing");

const ROLLS = 60;
for (let i = 0; i < ROLLS; i++) {
  // Introduce a second source partway through so both item series have a real
  // appearance transition to preserve, not just the starter line.
  if (i === 20) state.dice.addDice(6, 2, {}, "extra_dice");
  rollPool(state, state.dice);
  resolveRoll(state);
  if (state.roll >= 7) resolveTrialEnd(state);
}

check(state.rollsTaken === ROLLS, "every roll of the run is counted");
check(
  state.rollHistory.length === ROLLS + 1,
  "and a run this short is sampled one roll for one sample",
);
check(
  state.rollHistory.every(
    (sample, i) => i === 0 || sample.score >= state.rollHistory[i - 1].score,
  ),
  "banked points never go backwards",
);
check(
  state.rollHistory[state.rollHistory.length - 1].score === state.totalScore,
  "the last sample is the run's own total",
);
check(
  state.rollHistory[state.rollHistory.length - 1].dice === state.dice.length,
  "taken late enough to carry the grid the roll left behind",
);
check(
  state.rollHistory.every((sample) => {
    if (!sample.pointsByItem || !sample.diceByItem) return false;
    const points = Object.values(sample.pointsByItem).reduce(
      (sum, value) => sum + value,
      0n,
    );
    const dice = Object.values(sample.diceByItem).reduce(
      (sum, value) => sum + value,
      0,
    );
    return points === sample.score && dice === sample.dice;
  }),
  "every sample splits both totals into item/source series",
);
check(
  state.rollHistory.some((sample) => (sample.diceByItem?.extra_dice ?? 0) > 0),
  "including a source that joined partway through the run",
);
check(
  state.rollHistory.some((sample) => sample.trial > 1),
  "and the series follows the run up the ladder",
);

// ---------------------------------------------------------------------------
console.log("\nThe active-run save");

const resumed = hydrateRunState(
  JSON.parse(JSON.stringify(serializeRunState(state))),
);
check(resumed !== null, "a run carrying a timeline still hydrates");
check(
  resumed !== null && stable(resumed.rollHistory) === stable(state.rollHistory),
  "and the aggregate and item timelines come back sample for sample",
);
check(
  resumed?.rollsTaken === ROLLS,
  "along with the roll count that spaces it",
);

const legacy = JSON.parse(JSON.stringify(serializeRunState(state))) as Record<
  string,
  unknown
>;
delete legacy.rollHistory;
delete legacy.rollsTaken;
const restoredLegacy = hydrateRunState(legacy);
check(
  restoredLegacy !== null,
  "a save written before the timeline existed still resumes",
);
check(
  restoredLegacy?.rollHistory.length === 0 && restoredLegacy?.rollsTaken === 0,
  "and simply has no curves to draw",
);

const aggregateOnly = JSON.parse(
  JSON.stringify(serializeRunState(state)),
) as Record<string, unknown>;
aggregateOnly.rollHistory = (
  aggregateOnly.rollHistory as Array<Record<string, unknown>>
).map(({ t, s, d }) => ({ t, s, d }));
const restoredAggregateOnly = hydrateRunState(aggregateOnly);
check(
  restoredAggregateOnly?.rollHistory.every(
    (sample) => !sample.pointsByItem && !sample.diceByItem,
  ) ?? false,
  "an older aggregate timeline still loads without inventing item lines",
);

const corrupt = JSON.parse(JSON.stringify(serializeRunState(state))) as Record<
  string,
  unknown
>;
corrupt.rollHistory = [{ t: 1, s: "not a number", d: 5 }];
const restoredCorrupt = hydrateRunState(corrupt);
check(
  restoredCorrupt?.rollHistory.length === 0 &&
    restoredCorrupt?.rollsTaken === 0,
  "an unreadable timeline costs the curves, never the run",
);

// ---------------------------------------------------------------------------
console.log("\nThe Hall entry");

recordRunEnd(state, false);
const [filed] = loadHall();
check(filed !== undefined, "a finished run is filed with its timeline");
check(filed?.rolls === ROLLS, "and with the roll count that spaces it");
check(
  stable(filed?.history ?? []) === stable(state.rollHistory),
  "read back off storage exactly as recorded",
);

// ---------------------------------------------------------------------------
console.log("\nA run that outgrows the cap");

const long = newRun([]);
beginRun(long);
const LONG_ROLLS = 5000;
for (let i = 0; i < LONG_ROLLS; i++) {
  long.totalScore += 3n;
  recordRollSample(long);
}
const stride = historyStride(long.rollsTaken);
check(long.rollsTaken === LONG_ROLLS, "every roll is still counted");
check(
  long.rollHistory.length <= ROLL_HISTORY_CAP,
  `the series is thinned to the cap (${long.rollHistory.length} samples)`,
);
check(
  long.rollHistory.length === Math.floor(LONG_ROLLS / stride) + 1,
  `holding one sample every ${stride} rolls`,
);
check(
  long.rollHistory.every(
    (sample, i) => sample.score === BigInt(i * stride * 3),
  ),
  "evenly spaced from the run's first roll to its last, not truncated",
);

console.log(
  failures === 0
    ? "\nRun-history check: ALL PASS"
    : `\nRun-history check: ${failures} FAILURE(S)`,
);
if (failures > 0) process.exit(1);
