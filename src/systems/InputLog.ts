// The run's input log: every choice the player made, in the order they made
// it, so a finished run can be audited by replaying it.
//
// The seed fixes what the run was dealt (see systems/Rng) and `shopUnlocks`
// fixes what its shop could draw from, but neither says what the player DID
// with it: which cards they bought, where they dragged their dice, when they
// rerolled the shelf. Those are the inputs, and they are written down here as
// they happen. Seed + unlocks + tutorial rigging + this log is the whole run.
//
// Each entry is a small tuple, led by the trial it happened on, so the log stays
// compact in a saved hall entry and readable by eye in an exported blob:
//
//   [trial, "build", sha]                  the build that played from here on
//   [trial, "roll", roll, cols, rig, redo] a roll of the dice (see below)
//   [trial, "move", from, to]              a die dragged to a new grid slot
//   [trial, "buy", "shelf"|"pack", index, id, target, targets]
//   [trial, "pack", index, id]             a booster bought and opened
//   [trial, "skip"]                        an opened pack closed with no pick
//   [trial, "reroll"]                      the shelf rerolled
//   [trial, "leave"]                       the shop left
//   [trial, "tribute", afflictionId]       a drawback taken at the Tribute
//   [trial, "endless"]                     pressed on past the final rank
//   [trial, "dev", action]                 the dev panel touched the run
//
// A roll records `cols`, the columns the grid was laid out in, because the
// radius dice measure their reach across them and the layout follows the
// shape of the player's screen (see systems/RadiusDice.gridColumnsFor). `rig`
// is 1 when the tutorial forced that roll to all ones, and `redo` is how many
// times the tutorial re-rolled an opening roll that scored — neither is a
// function of the run's state, so a replay has to be told.
//
// A "build" entry is written when a run starts and again whenever it is resumed
// under a different build, so an audit knows which version of the rules each
// stretch of the run was played under.

import { BUILD_SHA } from "../buildInfo";
import type { RunState } from "../state/RunState";

export type InputEvent =
  | [trial: number, kind: "build", sha: string]
  | [
      trial: number,
      kind: "roll",
      roll: number,
      cols: number,
      rigged: 0 | 1,
      redo: number,
    ]
  | [trial: number, kind: "move", from: number, to: number]
  | [
      trial: number,
      kind: "buy",
      from: "shelf" | "pack",
      index: number,
      id: string,
      target: number | null,
      targets: number[] | null,
    ]
  | [trial: number, kind: "pack", index: number, id: string]
  | [trial: number, kind: "skip"]
  | [trial: number, kind: "reroll"]
  | [trial: number, kind: "leave"]
  | [trial: number, kind: "tribute", id: string]
  | [trial: number, kind: "endless"]
  | [trial: number, kind: "dev", action: string];

export type InputKind = InputEvent[1];

type Rest<K extends InputKind> =
  Extract<InputEvent, [number, K, ...unknown[]]> extends [number, K, ...infer R]
    ? R
    : never;

/** Append one input to the run's log, stamped with the trial it happened on. */
export function logInput<K extends InputKind>(
  state: RunState,
  kind: K,
  ...rest: Rest<K>
): void {
  state.inputLog.push([state.trial, kind, ...rest] as unknown as InputEvent);
}

/** The build the run was last played under, per its log. */
export function lastBuild(log: readonly InputEvent[]): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e[1] === "build") return e[2];
  }
  return null;
}

/** Every build the run was played under, oldest first. */
export function buildsOf(log: readonly InputEvent[]): string[] {
  const out: string[] = [];
  for (const e of log)
    if (e[1] === "build" && out[out.length - 1] !== e[2]) out.push(e[2]);
  return out;
}

/** Mark that this build is now playing the run, unless it already was. Called
 *  when a run starts and whenever one is resumed. */
export function noteBuild(state: RunState): void {
  if (lastBuild(state.inputLog) !== BUILD_SHA)
    logInput(state, "build", BUILD_SHA);
}

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isIntOrNull = (v: unknown) => v === null || isInt(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** Whether `value` is one well-formed log entry. Untrusted input: this comes
 *  out of localStorage and, for a global row, off the network. */
export function isInputEvent(value: unknown): value is InputEvent {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [trial, kind, ...rest] = value as unknown[];
  if (!isInt(trial)) return false;
  switch (kind) {
    case "build":
    case "tribute":
    case "dev":
      return rest.length === 1 && isStr(rest[0]);
    case "roll":
      return (
        rest.length === 4 &&
        isInt(rest[0]) &&
        isInt(rest[1]) &&
        (rest[2] === 0 || rest[2] === 1) &&
        isInt(rest[3])
      );
    case "move":
      return rest.length === 2 && isInt(rest[0]) && isInt(rest[1]);
    case "buy":
      return (
        rest.length === 5 &&
        (rest[0] === "shelf" || rest[0] === "pack") &&
        isInt(rest[1]) &&
        isStr(rest[2]) &&
        isIntOrNull(rest[3]) &&
        (rest[4] === null ||
          (Array.isArray(rest[4]) && (rest[4] as unknown[]).every(isInt)))
      );
    case "pack":
      return rest.length === 2 && isInt(rest[0]) && isStr(rest[1]);
    case "skip":
    case "reroll":
    case "leave":
    case "endless":
      return rest.length === 0;
    default:
      return false;
  }
}

/** A stored log, keeping only well-formed entries — or none at all for a run
 *  recorded before the log existed. */
export function readInputLog(value: unknown): InputEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isInputEvent).map((e) => [...e] as InputEvent);
}
