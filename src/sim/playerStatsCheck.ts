// Executable spec for the player's lifetime record: the aggregates and the
// three best-ten curve sets in systems/PlayerStats.ts that the Codex's Stats tab
// reads.
//
// Run: npm run stats:check
//
// The record is folded from a run's own counters at the moment it ends, and
// several of those counters are new fields threaded through the engine, the
// shop and the grid. What these assertions protect is that each of them is
// actually being fed — a badge reading a plausible zero forever is the failure
// mode, and it looks like nothing at all.

import { newRun } from "../state/RunState";
import { DicePool } from "../systems/DicePool";
import { makeDie } from "../systems/Dice";
import { spendGold } from "../systems/Gold";
import {
  loadPlayerStats,
  recordPlayerStatsRun,
  resetPlayerStats,
} from "../systems/PlayerStats";
import { recordRunEnd } from "../systems/SaveData";
import { beginRun, resolveRoll, resolveTrialEnd, rollPool } from "./engine";
import { installStorage, seedGlobalRandom } from "./localStorageShim";

installStorage([]);
seedGlobalRandom(11);

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
console.log("\nWhat a run brings to the record");

const state = newRun([]);
beginRun(state);
const startingDice = state.dice.length;
check(
  state.dice.everAdded === startingDice,
  "a fresh grid has taken in exactly the dice it holds",
);

const ROLLS = 40;
for (let i = 0; i < ROLLS; i++) {
  if (i === 10) state.dice.addDice(6, 4, {}, "extra_dice");
  rollPool(state, state.dice);
  resolveRoll(state);
  if (state.roll >= 7) resolveTrialEnd(state);
}
spendGold(state, 9);

check(state.rollsTaken === ROLLS, "its rolls are counted");
check(state.onesRolled > 0, "so are the dice that came up 1");
check(
  state.onesRolled <= state.rollsTaken * state.dice.length,
  "and never more of them than there were dice to show one",
);
check(
  state.dice.everAdded >= startingDice + 4,
  "the grid's intake includes dice bought partway through",
);
check(state.goldSpent === 9, "gold that leaves the purse is recorded as spent");

// ---------------------------------------------------------------------------
console.log("\nWhat the intake survives");

const shrinking = DicePool.fromDice([makeDie(6), makeDie(6)]);
shrinking.addDice(6, 8, {}, "test");
const beforeCull = shrinking.everAdded;
shrinking.cull(3);
check(
  shrinking.length === 3 && shrinking.everAdded === beforeCull,
  "dice destroyed after the fact leave the intake alone",
);
shrinking.multiply(3, "test");
check(
  shrinking.length === 9 && shrinking.everAdded === beforeCull + 6,
  "a grid multiplied counts only the copies it gained",
);

const restored = DicePool.fromStacks(
  shrinking.summarize(),
  shrinking.everAdded,
);
check(
  restored.everAdded === shrinking.everAdded,
  "a resumed grid carries the intake its summary cannot show",
);
check(
  DicePool.fromStacks(shrinking.summarize()).everAdded === shrinking.length,
  "and a save written before it was tracked starts from what it restored",
);

// ---------------------------------------------------------------------------
console.log("\nThe record itself");

resetPlayerStats();
recordRunEnd(state, false);
const one = loadPlayerStats();
check(one.runs === 1 && one.wins === 0, "a lost run counts, and does not win");
check(one.rolls === ROLLS, "its rolls join the lifetime tally");
check(one.onesRolled === state.onesRolled, "so do its ones");
check(one.goldEarned === state.goldEarned, "and its gold, earned and");
check(one.goldSpent === state.goldSpent, "spent");
check(one.points === state.totalScore, "its points are banked exactly");
check(
  one.diceCollected === state.dice.everAdded,
  "and the whole intake of its grid",
);
check(
  one.best.score.length === 1 &&
    one.best.dice.length === 1 &&
    one.best.gold.length === 1,
  "one run leaves one curve in each of the three charts",
);
check(
  one.best.score[0].final === Number(state.totalScore) &&
    one.best.dice[0].final === state.dice.length &&
    one.best.gold[0].final === state.goldEarned,
  "each ending where the run itself ended",
);
check(
  one.best.score[0].values[one.best.score[0].values.length - 1] ===
    one.best.score[0].final,
  "with the curve's last point on that same figure",
);
check(
  one.best.gold[0].values.every(
    (value, i) => i === 0 || value >= one.best.gold[0].values[i - 1],
  ),
  "and gold earned, which only ever climbs, never falling back",
);

// A second run, won, so the wins column and the win rate have something to say.
const second = newRun([]);
beginRun(second);
for (let i = 0; i < 12; i++) {
  rollPool(second, second.dice);
  resolveRoll(second);
  if (second.roll >= 7) resolveTrialEnd(second);
}
recordPlayerStatsRun(second, true);
const two = loadPlayerStats();
check(two.runs === 2 && two.wins === 1, "a won run is counted as one");
check(
  two.rolls === one.rolls + second.rollsTaken,
  "and its rolls are added to, not substituted for, the first run's",
);
check(
  two.best.score.length === 2 &&
    two.best.score[0].final >= two.best.score[1].final,
  "the charts rank their curves best first",
);

// ---------------------------------------------------------------------------
console.log("\nOnly ten curves are kept");

resetPlayerStats();
for (let r = 0; r < 14; r++) {
  const run = newRun([]);
  beginRun(run);
  for (let i = 0; i <= r; i++) {
    rollPool(run, run.dice);
    resolveRoll(run);
    if (run.roll >= 7) resolveTrialEnd(run);
  }
  recordPlayerStatsRun(run, false);
}
const many = loadPlayerStats();
check(many.runs === 14, "every run still counts toward the aggregates");
check(
  many.best.score.length === 10 &&
    many.best.dice.length === 10 &&
    many.best.gold.length === 10,
  "but each chart keeps only its best ten",
);
check(
  many.best.score.every(
    (curve, i) => i === 0 || curve.final <= many.best.score[i - 1].final,
  ),
  "still in order",
);

// ---------------------------------------------------------------------------
console.log("\nA record that cannot be read");

localStorage.setItem("ooo_player_stats_v1", "{not json");
const corrupt = loadPlayerStats();
check(
  corrupt.runs === 0 && corrupt.best.score.length === 0,
  "reads as a fresh one rather than throwing",
);

console.log(
  failures === 0
    ? "\nPlayer-stats check: ALL PASS"
    : `\nPlayer-stats check: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
