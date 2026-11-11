// Replaying a finished run from its record, for an audit.
//
// A run is its seed, its unlock snapshot, its novice, the tutorial's rigging and
// its input log (systems/InputLog). This plays that log back through the same
// rules the game plays by — the trial loop in sim/engine, the shop in
// systems/ShopVisit, the story's turns in systems/Endings — walking the same
// screens in the same order the scenes do, and reports where the run ended and
// with what score. A run whose log does not replay, or replays to a different
// score than it claims, did not happen the way it says.
//
// Replay a run under the build that played it (`buildsOf(log)`): rules change
// between builds, and a run played under old ones will not replay under new
// ones. See sim/audit for the command line.

import { rankOf } from "../config";
import { newRun, type RunState } from "../state/RunState";
import { afflict, type AfflictionId } from "../systems/Afflictions";
import { CHARACTERS, type CharacterId } from "../systems/Characters";
import { applyDailyRite, dailyRite, dailyShopUnlocks } from "../systems/Daily";
import {
  endingAfterTrial,
  endingBeforeTrial,
  markEndingSeen,
  rollKingsDemands,
  type EndingDef,
} from "../systems/Endings";
import { buildsOf, type InputEvent } from "../systems/InputLog";
import type { ShopItemId } from "../systems/Items";
import { gridColumnsFor } from "../systems/RadiusDice";
import { streamFor } from "../systems/Rng";
import { ShopVisit } from "../systems/ShopVisit";
import {
  beginRun,
  continueEndless,
  openTrial,
  resolveRoll,
  resolveTrialEnd,
  rollPool,
  trialComplete,
  type TrialEndOutcome,
} from "./engine";

/** Everything a run's record carries that a replay needs. */
export interface RunRecord {
  seed: number;
  unlocks: readonly ShopItemId[];
  character: CharacterId;
  tutorialArmed: boolean;
  forcedRolls: readonly string[];
  /** The Daily Rite's day, for a run played as one. */
  daily?: string;
  log: readonly InputEvent[];
}

/** Where a replayed run stopped. */
export type ReplayEnd =
  | "gameOver" // a trial ended short of its goal
  | "won" // the final rank was cleared and the run ended there
  | "inProgress"; // the log stops mid-run (an endless run ended by the player)

export interface ReplayResult {
  /** Whether every entry in the log replayed. */
  ok: boolean;
  /** Why it stopped, when it did not. */
  error?: string;
  /** The log entry it stopped at. */
  at?: number;
  end: ReplayEnd;
  /** The run's total, which is what the board ranks and the Hall stores. */
  score: bigint;
  trial: number;
  rank: number;
  endless: boolean;
  rolls: number;
  /** The builds the run says it was played under, oldest first. */
  builds: string[];
  /** Dev-panel actions in the log: a run the dev panel touched cannot be
   *  replayed, and is not a run a player earned. */
  devActions: string[];
  /** Rolls the log says the tutorial rigged or re-rolled, on a run not played
   *  under the tutorial — which no honest client writes. */
  riggedOutsideTutorial: number;
  state: RunState;
}

type Phase =
  | { at: "overview" }
  | { at: "game" }
  | { at: "results"; outcome: TrialEndOutcome }
  | { at: "ending"; def: EndingDef }
  | {
      at: "tribute";
      gift: "kingsDemands" | "betrayal";
      choices: AfflictionId[];
    }
  | { at: "victory" }
  | { at: "shop"; visit: ShopVisit }
  | { at: "over"; won: boolean };

class ReplayError extends Error {}

function fail(message: string): never {
  throw new ReplayError(message);
}

/** Deal the run the way Tutorial.beginRun does. */
function dealRun(record: RunRecord): RunState {
  if (record.daily) {
    const rite = dailyRite(record.daily);
    if (rite.seed !== record.seed)
      fail(`daily ${record.daily}'s seed is ${rite.seed}, not ${record.seed}`);
    const state = newRun(dailyShopUnlocks(), rite.seed, rite.character);
    applyDailyRite(state, rite);
    beginRun(state, streamFor(state.seed, "boss", 1));
    return state;
  }
  if (!(record.character in CHARACTERS))
    fail(`unknown character ${record.character}`);
  const state = newRun([...record.unlocks], record.seed, record.character);
  beginRun(state, streamFor(state.seed, "boss", 1));
  state.tutorialArmed = record.tutorialArmed;
  return state;
}

/** Lay the grid out `cols` wide for the radius dice, as the player's screen
 *  did: the pool takes a frame shape, so hand it one that gives those
 *  columns. */
function layOut(state: RunState, cols: number): void {
  const n = Math.max(1, state.dice.length);
  if (!Number.isInteger(cols) || cols < 1 || cols > n)
    fail(`a roll laid ${n} dice out ${cols} wide`);
  state.dice.setGridAspect(((cols - 0.5) * (cols - 0.5)) / n);
  if (gridColumnsFor(state.dice.length, state.dice.gridAspect) !== cols)
    fail(`could not lay ${n} dice out ${cols} wide`);
}

/** The screens a run passes through on its own, between the ones that wait on
 *  the player. Mirrors the scenes' hand-offs. */
function advance(state: RunState, phase: Phase): Phase {
  for (;;) {
    switch (phase.at) {
      case "overview": {
        // TrialOverviewScene.startTrial: an act may stand in front of the trial.
        const def = endingBeforeTrial(state.trial, state.endingsSeen);
        phase = def ? { at: "ending", def } : { at: "game" };
        continue;
      }
      case "game":
        // GameScene.create resolves a trial it finds already over.
        if (trialComplete(state)) {
          phase = endTrial(state);
          continue;
        }
        return phase;
      case "results": {
        // TrialResultsScene.continue.
        const def = endingAfterTrial(
          phase.outcome.completedTrial,
          state.endingsSeen,
        );
        phase = def
          ? { at: "ending", def }
          : phase.outcome.phase === "victory"
            ? { at: "victory" }
            : { at: "shop", visit: ShopVisit.open(state) };
        continue;
      }
      case "ending": {
        // EndingScene: the act is marked seen, then hands off.
        markEndingSeen(state, phase.def.id);
        switch (phase.def.next) {
          case "Tribute": {
            const gift = phase.def.gift ?? "kingsDemands";
            phase = {
              at: "tribute",
              gift,
              choices:
                gift === "betrayal"
                  ? ["betrayal"]
                  : rollKingsDemands(
                      state,
                      streamFor(state.seed, "demands", state.trial),
                    ),
            };
            break;
          }
          case "Shop":
            phase = { at: "shop", visit: ShopVisit.open(state) };
            break;
          case "Victory":
            phase = { at: "victory" };
            break;
          default:
            phase = { at: "game" };
        }
        continue;
      }
      default:
        return phase;
    }
  }
}

/** GameScene.resolveEndOfTrial. */
function endTrial(state: RunState): Phase {
  const outcome = resolveTrialEnd(
    state,
    streamFor(state.seed, "trialEnd", state.trial),
  );
  if (outcome.phase === "gameOver") return { at: "over", won: false };
  return { at: "results", outcome };
}

/** GameScene.startRoll and settleRoll, without the table. */
function roll(
  state: RunState,
  record: RunRecord,
  event: Extract<InputEvent, [number, "roll", ...unknown[]]>,
): void {
  const [, , rollIndex, cols, rigged, redo] = event;
  if (trialComplete(state)) fail("a roll after the trial was over");
  if (rollIndex !== state.roll)
    fail(`roll ${rollIndex} logged where the trial is on roll ${state.roll}`);
  const key = `${state.trial}:${state.roll}`;
  if (rigged === 1 && !record.forcedRolls.includes(key))
    fail(`roll ${key} was rigged but the run does not list it as forced`);
  if (rigged === 1 && !state.forcedRolls.includes(key))
    state.forcedRolls.push(key);
  layOut(state, cols);
  const diceRng = streamFor(state.seed, "roll", key);
  const rollDice = () =>
    rollPool(state, state.dice, rigged === 1 ? () => 0 : diceRng);
  rollDice();
  for (let i = 0; i < redo; i++) rollDice();
  resolveRoll(state, streamFor(state.seed, "roll", `${key}:resolve`));
}

/** Play one entry of the log against the screen the run is on. */
function play(
  state: RunState,
  record: RunRecord,
  phase: Phase,
  event: InputEvent,
): Phase {
  const kind = event[1];
  if (event[0] !== state.trial)
    fail(
      `a ${kind} logged on trial ${event[0]} while the run is on ${state.trial}`,
    );
  switch (phase.at) {
    case "game":
      switch (event[1]) {
        case "open":
          openTrial(state);
          return phase;
        case "move":
          if (!state.dice.move(event[2], event[3]))
            fail(`could not move die ${event[2]} to ${event[3]}`);
          return phase;
        case "roll":
          roll(state, record, event);
          return trialComplete(state) ? endTrial(state) : phase;
      }
      break;
    case "shop": {
      const visit = phase.visit;
      switch (event[1]) {
        case "reroll":
          if (!visit.reroll()) fail("a shelf reroll the purse could not pay");
          return phase;
        case "pack": {
          const pack = visit.packs[event[2]];
          if (!pack || pack.id !== event[3])
            fail(
              `pack ${event[2]} is ${pack?.id ?? "missing"}, not ${event[3]}`,
            );
          if (!visit.openPack(pack))
            fail(`pack ${pack.id} could not be opened`);
          return phase;
        }
        case "skip":
          if (!visit.skipPack()) fail("skipped a pack that was not open");
          return phase;
        case "buy": {
          const [, , from, index, id, target, targets] = event;
          const row = from === "pack" ? visit.packChoices : visit.offers;
          const offer = row?.[index];
          if (!offer || offer.id !== id)
            fail(
              `${from} card ${index} is ${offer?.id ?? "missing"}, not ${id}`,
            );
          if (!visit.buy(offer, target ?? undefined, targets ?? undefined))
            fail(`${id} could not be bought`);
          return phase;
        }
        case "leave":
          visit.leave();
          return { at: "overview" };
      }
      break;
    }
    case "tribute":
      if (event[1] === "tribute") {
        const id = event[2] as AfflictionId;
        if (!phase.choices.includes(id))
          fail(`${id} was not among the Tribute's ${phase.choices.join(", ")}`);
        afflict(state, id);
        if (phase.gift === "kingsDemands") state.kingsDemand = id;
        return { at: "shop", visit: ShopVisit.open(state) };
      }
      break;
    case "victory":
      if (event[1] === "endless") {
        continueEndless(
          state,
          streamFor(state.seed, "boss", rankOf(state.trial + 1)),
        );
        return { at: "shop", visit: ShopVisit.open(state) };
      }
      break;
  }
  fail(`a ${kind} entry where the run is at ${phase.at}`);
}

/** Replay a run from its record. Never throws: a log that does not replay
 *  comes back as `ok: false` with where and why. */
export function replayRun(record: RunRecord): ReplayResult {
  const devActions = record.log
    .filter((e) => e[1] === "dev")
    .map((e) => e[2] as string);
  let riggedOutsideTutorial = 0;
  if (!record.tutorialArmed)
    for (const e of record.log)
      if (e[1] === "roll" && (e[4] === 1 || e[5] > 0)) riggedOutsideTutorial++;

  let state: RunState | undefined;
  let phase: Phase = { at: "overview" };
  let at: number | undefined;
  let error: string | undefined;
  // Every random decision a run makes is drawn from a stream named off its
  // seed. Anything that reaches for Math.random instead is a rule the seed does
  // not fix, so the replay refuses it rather than quietly drawing a number the
  // player's run never drew.
  const random = Math.random;
  Math.random = () =>
    fail("a rule drew from Math.random instead of the run's seed");
  try {
    state = dealRun(record);
    phase = advance(state, phase);
    for (let i = 0; i < record.log.length; i++) {
      at = i;
      const event = record.log[i];
      if (event[1] === "build") continue;
      if (event[1] === "dev")
        fail(`the dev panel touched the run (${event[2]})`);
      if (phase.at === "over") fail(`a ${event[1]} after the run ended`);
      phase = advance(state, play(state, record, phase, event));
    }
    at = undefined;
  } catch (err) {
    if (!(err instanceof ReplayError)) throw err;
    error = err.message;
  } finally {
    Math.random = random;
  }
  state ??= newRun([...record.unlocks], record.seed, record.character);
  const end: ReplayEnd =
    phase.at === "over"
      ? phase.won
        ? "won"
        : "gameOver"
      : phase.at === "victory" && !state.endless
        ? "won"
        : "inProgress";
  return {
    ok: error === undefined,
    ...(error !== undefined ? { error, at } : {}),
    end,
    score: state.totalScore,
    trial: state.trial,
    rank: rankOf(state.trial),
    endless: state.endless,
    rolls: state.rollsTaken,
    builds: buildsOf(record.log),
    devActions,
    riggedOutsideTutorial,
    state,
  };
}
