// Executable spec for the run's input log (systems/InputLog): that what the
// player did survives every place a run is kept — the active-run save, the
// Hall, the global board's analysis blob — so a run picked out later can be
// audited by replaying it.
//
// Run: npm run inputlog:check

import { newRun } from "../state/RunState";
import {
  hydrateRunState,
  serializeRunState,
} from "../systems/ActiveRunPersistence";
import {
  buildsOf,
  isInputEvent,
  lastBuild,
  logInput,
  noteBuild,
  readInputLog,
  type InputEvent,
} from "../systems/InputLog";
import { BUILD_SHA } from "../buildInfo";
import { installStorage } from "./localStorageShim";

installStorage([]);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok     ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL   ${message}`);
  }
}

console.log("Logging");
const state = newRun([], 1234);
check(state.inputLog.length === 0, "a fresh run has an empty log");
noteBuild(state);
noteBuild(state);
check(
  state.inputLog.length === 1 && lastBuild(state.inputLog) === BUILD_SHA,
  "the build is noted once, however often it is asked",
);
logInput(state, "roll", 0, 4, 0, 0);
logInput(state, "move", 3, 0);
logInput(state, "buy", "shelf", 1, "extra_die", null, null);
logInput(state, "buy", "pack", 0, "loaded_die", 2, null);
logInput(state, "buy", "shelf", 2, "twin", null, [1, 4]);
logInput(state, "pack", 1, "booster_x");
logInput(state, "skip");
logInput(state, "reroll");
logInput(state, "leave");
state.trial = 3;
logInput(state, "tribute", "tollkeeper");
logInput(state, "endless");
logInput(state, "dev", "setGold");
check(state.inputLog.length === 13, "every kind of input is logged");
check(
  state.inputLog.every(isInputEvent),
  "every logged entry reads back as well-formed",
);
check(
  state.inputLog[1][0] === 1 && state.inputLog[10][0] === 3,
  "each entry carries the trial it happened on",
);

console.log("Persistence");
const saved = JSON.parse(JSON.stringify(serializeRunState(state)));
const resumed = hydrateRunState(saved);
check(resumed !== null, "a run with a log resumes");
check(
  JSON.stringify(resumed?.inputLog) === JSON.stringify(state.inputLog),
  "the log comes back from a save exactly as it went in",
);
resumed!.inputLog.push([1, "move", 0, 1]);
check(
  state.inputLog.length === 13,
  "a resumed log is a copy, not the live run's array",
);
const legacy = { ...saved };
delete legacy.inputLog;
check(
  hydrateRunState(legacy)?.inputLog.length === 0,
  "a save from before the log resumes with an empty one",
);
check(
  hydrateRunState({ ...saved, inputLog: [[1, "roll", "x"]] }) === null,
  "a save with a malformed log does not resume",
);

console.log("Reading untrusted logs");
const junk: unknown[] = [
  [1, "roll", 0, 4, 0, 0],
  [1, "roll", 0, 4, 2, 0],
  [1, "nope"],
  ["1", "leave"],
  [2, "buy", "floor", 0, "x", null, null],
  [2, "buy", "pack", 0, "x", null, [1, "2"]],
  "leave",
  null,
  [2, "leave"],
];
const read = readInputLog(junk);
check(
  JSON.stringify(read) ===
    JSON.stringify([
      [1, "roll", 0, 4, 0, 0],
      [2, "leave"],
    ]),
  "only well-formed entries survive a read",
);
check(readInputLog(undefined).length === 0, "no log at all reads as empty");

console.log("Builds");
const across: InputEvent[] = [
  [1, "build", "aaa"],
  [1, "roll", 0, 3, 0, 0],
  [2, "build", "bbb"],
  [2, "roll", 0, 3, 0, 0],
  [3, "build", "bbb"],
];
check(
  JSON.stringify(buildsOf(across)) === JSON.stringify(["aaa", "bbb"]),
  "the builds a run was played under are listed once each, in order",
);

console.log(
  failures === 0
    ? "\nInput log check: ALL PASS"
    : `\nInput log check: ${failures} FAILURE(S)`,
);
if (failures > 0) process.exit(1);
