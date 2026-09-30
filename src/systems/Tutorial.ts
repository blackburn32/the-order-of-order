import type Phaser from "phaser";
import { newRun, setRun, type RunState } from "../state/RunState";
import {
  loadProgress,
  loadSettings,
  loadTutorialSeen,
  saveSettings,
  saveTutorialSeen,
} from "./SaveData";
import { beginRun as initializeRun } from "../sim/engine";
import { randomSeed, streamFor } from "./Rng";
import { goalFor } from "./Boss";
import { trialRollTarget } from "./Trial";
import { PHONE_BUILD } from "../buildFlags";
import { WIN_RANK } from "../config";
import { GOLD_PER_INTEREST, INTEREST_CAP } from "./Gold";
import { refreshActiveRun, saveActiveRun } from "./ActiveRunPersistence";
import { DEFAULT_CHARACTER, type CharacterId } from "./Characters";

// The tutorial steps, in the order they are shown — the script in TUTORIAL.md,
// one member per numbered step. They follow the run's own loop rather than one
// screen: the route screen teaches the shape of a rank, the table teaches a
// roll, the results screen teaches what a clear pays, the shop teaches spending
// it, and the route screen closes the lesson on the first boss and the rank
// after it. `Done` is the terminal marker.
//
// Every step belongs to exactly one scene, which is what lets each scene render
// the current stage (and only it) without coordinating with the others.
//
// Some steps wait on the run rather than on the step before them. Boss waits in
// place for the route to reach the rank's Boss Trial, and NewRank waits in
// place for the route to reach the rank after it.
//
// EarlyGold and Interest cannot wait in place, because the run may take several
// trials to pay either and may never pay them at all: a trial cleared on its
// last roll pays nothing for rolls left in hand, and a purse under five pays no
// interest — the first clear is paid on the four gold a run starts with, so it
// never does. A step like that is *deferred* rather than blocking (see
// `deferTutorialStage`): the script carries on without it and it returns at the
// first clear that finally prints the line it is about — even one after the
// script itself has finished.
export enum TutorialStage {
  Welcome, // TrialOverview: the rank the order starts at
  RankCount, // TrialOverview: how many ranks win the game
  Trials, // TrialOverview: the three trials of a rank
  TrialGoal, // TrialOverview: a trial's goal
  Points, // TrialOverview: what scores toward it
  Begin, // TrialOverview: the button that starts the first trial
  Grid, // Game: where the dice are
  Pan, // Game: dragging the grid
  Zoom, // Game: scrolling / pinching it
  Roll, // Game: the seal
  RollOne, // Game: after the first roll
  Cleared, // TrialResults: the verdict
  Gold, // TrialResults: what the clear paid
  EarlyGold, // TrialResults: and what it paid for finishing with rolls to spare
  Interest, // TrialResults: and what the purse pays on itself
  EnterShop, // TrialResults: the way on
  LooseCards, // Shop: the offer cards
  Reroll, // Shop: the reroll button
  Boosters, // Shop: the packs
  LeaveShop, // Shop: the way out
  GoalGrows, // TrialOverview: the second trial's steeper goal
  Boss, // TrialOverview: once the route reaches the Boss Trial
  BossAdvance, // TrialOverview: what beating it earns
  NewRank, // TrialOverview: once the route reaches rank 2
  GoalsGrown, // TrialOverview: its steeper goals
  Finale, // TrialOverview: the send-off
  Done,
}

// The mouse and the finger name their gestures differently; the phone build
// is the one that only ever has fingers.
const PRESS = PHONE_BUILD ? "Press" : "Click";

// The callout copy for every step. Each scene still owns where its callouts
// point and what dismisses them, but the words all live here so the script can
// be read — and reworded — as the one continuous lesson it is meant to be.
//
// `Done` is absent by construction: it is the terminal marker, not a step, and
// leaving it out of the type is what makes a missing step a compile error.
export const TUTORIAL_TEXT: Record<
  Exclude<TutorialStage, TutorialStage.Done>,
  string
> = {
  [TutorialStage.Welcome]:
    "Welcome young leader! Your order starts in its infancy at rank 1.",
  [TutorialStage.RankCount]: `Complete ${WIN_RANK} ranks to win the game.`,
  [TutorialStage.Trials]:
    "Each rank is composed of three trials of increasing difficulty.",
  [TutorialStage.TrialGoal]:
    "To complete a trial you must meet its goal by earning points.",
  [TutorialStage.Points]: "Points are earned by rolling a 1 on any die.",
  [TutorialStage.Begin]: `${PRESS} here to begin the first trial.`,

  [TutorialStage.Grid]: "This is where your dice are shown.",
  [TutorialStage.Pan]: "You can pan around by dragging.",
  [TutorialStage.Zoom]: `And you can zoom in and out by ${PHONE_BUILD ? "pinching" : "scrolling"}.`,
  [TutorialStage.Roll]: `${PRESS} here to roll your dice.`,
  [TutorialStage.RollOne]: "To score you must roll a 1, good luck.",

  [TutorialStage.Cleared]: "Congratulations on completing your first trial!",
  [TutorialStage.Gold]:
    "After each trial you will receive gold which can be spent in the store!",
  [TutorialStage.EarlyGold]:
    "You'll gain extra gold for completing a trial with rolls to spare.",
  [TutorialStage.Interest]: `Your gold earns interest! 1 gold per ${GOLD_PER_INTEREST} gold held at a trial's end, up to ${INTEREST_CAP}.`,
  [TutorialStage.EnterShop]: `${PRESS} here to enter the store.`,

  [TutorialStage.LooseCards]: "Purchase new cards to upgrade your order.",
  [TutorialStage.Reroll]:
    "You can reroll the selection if nothing is to your liking.",
  [TutorialStage.Boosters]:
    "Booster packs allow you to choose 1 out of the 3 cards in the pack.",
  [TutorialStage.LeaveShop]:
    "When you're ready, press here to get to the next trial.",

  [TutorialStage.GoalGrows]:
    "The goal will grow each trial, you'll need to grow your order's power to keep up!",
  [TutorialStage.Boss]:
    "The next round is this rank's boss fight, take note of its special effects!",
  [TutorialStage.BossAdvance]:
    "When you complete the boss round you will advance a rank!",
  [TutorialStage.NewRank]:
    "Congratulations! Your order has advanced to the second rank.",
  [TutorialStage.GoalsGrown]:
    "The point requirements for each trial have grown!",
  [TutorialStage.Finale]: `You're ready. Complete rank ${WIN_RANK} to win, good luck!`,
};

export interface TutorialState {
  /** Whether the script is still running. Once it has run off its end this is
   *  false, but `deferred` may still hold steps owed to a later receipt. */
  active: boolean;
  stage: TutorialStage;
  /** Steps the script has passed without showing, because the run had not yet
   *  produced the thing they explain. They are owed, not spent: the scene that
   *  owns them shows them again the moment it can (see `deferTutorialStage`),
   *  and they outlive the script itself — only the run ending drops them. */
  deferred: TutorialStage[];
}

// Kept in the Phaser registry (like RunState) rather than a scene field, so it
// survives the Game -> Shop -> Game scene transitions the tutorial spans.
const KEY = "tutorial";

export function getTutorial(registry: Phaser.Data.DataManager): TutorialState {
  return (
    (registry.get(KEY) as TutorialState | undefined) ?? {
      active: false,
      stage: TutorialStage.Done,
      deferred: [],
    }
  );
}

export function setTutorial(
  registry: Phaser.Data.DataManager,
  state: TutorialState,
): void {
  registry.set(KEY, state);
}

// ---- steps seen across runs -------------------------------------------------
//
// A run that ends partway through the script does not spend the tutorial: the
// next run picks it up at the first step the player has not yet been shown,
// and skips every one they have. Only once every step has been seen does the
// Show Tutorial setting switch itself off, and switching it back on in
// Settings forgets them all (see `resetTutorialProgress`) so the whole script
// plays again.

const STEPS = Object.values(TutorialStage).filter(
  (stage): stage is TutorialStage =>
    typeof stage === "number" && stage !== TutorialStage.Done,
);

function seenSteps(): Set<string> {
  return new Set(loadTutorialSeen());
}

/** The first step from `from` on that the player has not yet been shown, or
 *  `Done` when there is none. */
function firstUnseen(from: TutorialStage): TutorialStage {
  const seen = seenSteps();
  for (let stage = from; stage < TutorialStage.Done; stage++) {
    if (!seen.has(TutorialStage[stage])) return stage;
  }
  return TutorialStage.Done;
}

/** Record `stage` as shown. Seeing the last unseen step is what retires the
 *  tutorial for good. */
function markSeen(stage: TutorialStage): void {
  const seen = seenSteps();
  const name = TutorialStage[stage];
  if (seen.has(name)) return;
  seen.add(name);
  saveTutorialSeen([...seen]);
  if (STEPS.every((step) => seen.has(TutorialStage[step]))) {
    const settings = loadSettings();
    if (settings.showTutorial) {
      settings.showTutorial = false;
      saveSettings(settings);
    }
  }
}

/** Forget every step seen, so the next run plays the whole script. Called
 *  when the player turns the tutorial back on in Settings. */
export function resetTutorialProgress(): void {
  saveTutorialSeen([]);
}

/** Arm the tutorial for a fresh run when the player hasn't turned it off,
 *  starting at the first step they have not been shown yet. */
export function beginTutorial(registry: Phaser.Data.DataManager): void {
  const stage = loadSettings().showTutorial
    ? firstUnseen(TutorialStage.Welcome)
    : TutorialStage.Done;
  if (stage !== TutorialStage.Done) {
    setTutorial(registry, { active: true, stage, deferred: [] });
  } else {
    setTutorial(registry, {
      active: false,
      stage: TutorialStage.Done,
      deferred: [],
    });
  }
}

/** Advance to the next stage the player has not yet seen (no-op once
 *  inactive), recording the one being left as seen — unless it is only being
 *  set aside (see `deferTutorialStage`). Running off the end of the list is
 *  what finishes the tutorial, so the last step needs no special case at its
 *  call site. */
export function advanceTutorial(registry: Phaser.Data.DataManager): void {
  const t = getTutorial(registry);
  if (!t.active) return;
  if (!t.deferred.includes(t.stage)) markSeen(t.stage);
  const next = firstUnseen(t.stage + 1);
  if (next >= TutorialStage.Done) {
    completeTutorial(registry, { keepDeferred: true });
    return;
  }
  setTutorial(registry, { ...t, stage: next });
  refreshActiveRun(registry);
}

/** Advance only if the tutorial is sitting on exactly `stage`. For the steps
 *  dismissed by using the thing they point at, whose handlers run whether or
 *  not a tutorial is on. Returns whether it advanced. */
export function advanceFrom(
  registry: Phaser.Data.DataManager,
  stage: TutorialStage,
): boolean {
  if (!atStage(registry, stage)) return false;
  advanceTutorial(registry);
  return true;
}

/**
 * Set the current step aside and carry on to the next one. For a step whose
 * scene has nothing to point at yet — no gold paid for rolls left in hand, no
 * interest on the purse — this is what keeps the lessons behind it, the shop's
 * among them, from waiting on a line the receipt may not print for several
 * trials or ever. The step stays owed on `deferred` until its scene finds
 * something to point at — past the end of the script, if need be. Only the
 * first run's safety net (`tutorialForcesRoll`) ends with the script, since it
 * reads `active`, which the owed steps do not hold open.
 */
export function deferTutorialStage(registry: Phaser.Data.DataManager): void {
  const t = getTutorial(registry);
  if (!t.active || t.deferred.includes(t.stage)) return;
  setTutorial(registry, { ...t, deferred: [...t.deferred, t.stage] });
  advanceTutorial(registry);
}

/** Mark a deferred step as finally shown and dismissed. */
export function resolveDeferredStage(
  registry: Phaser.Data.DataManager,
  stage: TutorialStage,
): void {
  const t = getTutorial(registry);
  if (!t.deferred.includes(stage)) return;
  markSeen(stage);
  setTutorial(registry, {
    ...t,
    deferred: t.deferred.filter((owed) => owed !== stage),
  });
  refreshActiveRun(registry);
}

/** True when the tutorial is sitting on exactly this stage. */
export function atStage(
  registry: Phaser.Data.DataManager,
  stage: TutorialStage,
): boolean {
  const t = getTutorial(registry);
  return t.active && t.stage === stage;
}

/** Stop the tutorial for this run. Spends nothing: what the player has been
 *  shown is already recorded step by step (see `markSeen`), so a run ended
 *  partway through leaves the rest for the next one.
 *
 *  `keepDeferred` is for the script running off its own end mid-run: the
 *  steps still owed stay owed. The run ending drops them — they are unseen, so
 *  the next run owes them again. */
export function completeTutorial(
  registry: Phaser.Data.DataManager,
  { keepDeferred = false }: { keepDeferred?: boolean } = {},
): void {
  const t = getTutorial(registry);
  setTutorial(registry, {
    active: false,
    stage: TutorialStage.Done,
    deferred: keepDeferred ? t.deferred : [],
  });
  refreshActiveRun(registry);
}

/**
 * Whether this roll is rigged to show a 1 on every die. A first run must not be
 * able to end while the tutorial is still teaching it, and the single starting
 * d6 misses all seven rolls of the Lesser Trial better than a quarter of the
 * time — so the tutorial hands back exactly as many guaranteed rolls as the
 * trial still needs points, and no more.
 *
 * On the Lesser Trial (goal 1) that is precisely the seventh roll: the six
 * before it are honest, and the player who clears early — most of them — never
 * sees the safety net at all.
 *
 * The net covers the run's first trial only. Everything after it is played
 * for real, the rank 1 boss included, however much of the script is left. And
 * only for a run armed to teach that trial (`RunState.tutorialArmed`): a
 * player resuming the script past the table's steps has been through it once.
 */
export function tutorialForcesRoll(
  registry: Phaser.Data.DataManager,
  state: RunState,
): boolean {
  if (!getTutorial(registry).active || !state.tutorialArmed) return false;
  if (state.trial !== 1) return false;
  const rollsLeft = trialRollTarget(state) - state.roll; // this roll included
  return BigInt(rollsLeft) <= goalFor(state) - state.score;
}

/**
 * Whether this roll must come up empty. The Lesser Trial's goal is a single
 * point, so a scoring first roll would clear the trial the moment the tutorial
 * has finished pointing at the seal — skipping the step that tells the player
 * to roll a 1 before they ever get the chance to. The run's opening roll is
 * therefore re-rolled until nothing on it scores, so the lesson always runs in
 * its written order.
 *
 * Only the very first roll of the run is held back; from the second onwards the
 * dice are honest again (and `tutorialForcesRoll` guarantees the trial still
 * ends in a clear). A run not armed to teach the table (`tutorialArmed`) is
 * left alone: there is no lesson left for the roll to protect.
 */
export function tutorialBlocksScore(
  registry: Phaser.Data.DataManager,
  state: RunState,
): boolean {
  if (!getTutorial(registry).active || !state.tutorialArmed) return false;
  return state.trial === 1 && state.roll === 0;
}

/**
 * Shared entry point for starting a run from the menu / intro: seeds a fresh
 * RunState as `character`, arms the tutorial if enabled, and enters the Game
 * scene. Keeps the intro and no-intro paths identical.
 *
 * The character is a parameter rather than something read back off storage
 * because it is chosen for THIS run, on the screen immediately before this call
 * (see scenes/CharacterScene) — nothing persists a "current" character, and a
 * run is the only thing that ever holds one.
 */
export function beginRun(
  scene: Phaser.Scene,
  character: CharacterId = DEFAULT_CHARACTER,
): void {
  // Freeze shop eligibility at run start. Unlocks earned during this run are
  // still saved and announced, but only the next run's snapshot can offer them.
  const state = newRun(loadProgress().unlocked, randomSeed(), character);
  // The run's first random decision, and so the first to be drawn from the seed
  // rather than from Math.random: rank 1's boss assignment.
  initializeRun(state, streamFor(state.seed, "boss", 1));
  setRun(scene.registry, state);
  beginTutorial(scene.registry);
  // Recorded on the run, not just in the registry: the registry copy is what
  // the tutorial spends as the player works through it, while this is the fact
  // that the run's dice may be rigged by it, and it has to outlive the run.
  // Only a run that opens with the table's lessons still to teach is: one
  // resuming the script further on plays its first trial straight.
  const opening = getTutorial(scene.registry);
  state.tutorialArmed =
    opening.active && opening.stage <= TutorialStage.RollOne;
  saveActiveRun(scene.registry, { scene: "TrialOverview" });
  scene.scene.start("TrialOverview");
}
