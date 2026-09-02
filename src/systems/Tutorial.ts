import type Phaser from "phaser";
import { newRun, setRun, type RunState } from "../state/RunState";
import { loadProgress, loadSettings, saveSettings } from "./SaveData";
import { beginRun as initializeRun } from "../sim/engine";
import { goalFor } from "./Boss";
import { trialRollTarget } from "./Trial";
import { PHONE_BUILD } from "../buildFlags";
import { WIN_RANK } from "../config";
import { refreshActiveRun, saveActiveRun } from "./ActiveRunPersistence";

// The tutorial steps, in the order they are shown. They follow the run's own
// loop rather than one screen: the route screen teaches the shape of a rank,
// the table teaches a roll, the results screen teaches what a clear pays, and
// the shop teaches spending it. `Done` is the terminal marker.
//
// Every step belongs to exactly one scene, which is what lets each scene render
// the current stage (and only it) without coordinating with the others.
//
// Boss fires on the first Boss Trial rather than in sequence, because it has
// nothing to point at until one arrives — and the two steps after it wait on
// that same trial being cleared, which is the earliest the ladder ahead is
// something the player can be shown rather than told.
export enum TutorialStage {
  Route, // TrialOverview: the three trials of a rank
  RouteStart, // TrialOverview: the button that begins the first one
  Score, // Game
  Roll,
  Viewport,
  Goal,
  Rolls,
  Results, // TrialResults: what a clear paid
  Interest, // TrialResults: and what the purse pays on itself
  Shop, // Shop: spending it
  Boss, // Game, once a Boss Trial is actually in force
  RankReset, // TrialOverview: the rank after that boss, and its steeper goals
  RankGoal, // TrialOverview: how far the ladder runs
  Done,
}

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
  [TutorialStage.Route]:
    "You will face three trials each rank. Complete all three to advance to the next rank.",

  [TutorialStage.RouteStart]: "Press here to begin your first trial",
  [TutorialStage.Score]: "This is your score, roll a one to score a point.",
  [TutorialStage.Roll]: "Press the seal to roll.",

  // The grid pans the same way everywhere; only the second gesture differs, so
  // the phone build is told to pinch and every other build to scroll.
  [TutorialStage.Viewport]: PHONE_BUILD
    ? "Drag to move around your dice. Pinch to zoom."
    : "Drag to move around your dice. Scroll to zoom.",

  [TutorialStage.Goal]:
    "This is the trial's goal, score this many points to proceed. Fail and your run ends.",

  [TutorialStage.Rolls]:
    "Here are your remaining rolls. Score extra gold by completing the trial early!",

  [TutorialStage.Results]:
    "Clearing a trial pays gold. You'll spend it in the shop for new dice and upgrades.",
  [TutorialStage.Interest]: `Gold you hold at at a trial's end pays interest. Saving earns!`,
  [TutorialStage.Shop]:
    "Welcome to the shop. Purchase cards or booster packs to improve your odds.",
  [TutorialStage.Boss]:
    "Be careful, the boss effect is active and will make your task harder. Defeat the boss to advance a rank!",

  [TutorialStage.RankReset]:
    "The rank is yours. Three fresh trials await, and each rank asks for far more points than the last.",
  [TutorialStage.RankGoal]: `This is your rank. Clear rank ${WIN_RANK} to win the game.`,
};

export interface TutorialState {
  active: boolean;
  stage: TutorialStage;
}

// Kept in the Phaser registry (like RunState) rather than a scene field, so it
// survives the Game -> Shop -> Game scene transitions the tutorial spans.
const KEY = "tutorial";

export function getTutorial(registry: Phaser.Data.DataManager): TutorialState {
  return (
    (registry.get(KEY) as TutorialState | undefined) ?? {
      active: false,
      stage: TutorialStage.Done,
    }
  );
}

export function setTutorial(
  registry: Phaser.Data.DataManager,
  state: TutorialState,
): void {
  registry.set(KEY, state);
}

/** Arm the tutorial for a fresh run when the player hasn't turned it off. */
export function beginTutorial(registry: Phaser.Data.DataManager): void {
  if (loadSettings().showTutorial) {
    setTutorial(registry, { active: true, stage: TutorialStage.Route });
  } else {
    setTutorial(registry, { active: false, stage: TutorialStage.Done });
  }
}

/** Advance to the next stage (no-op once inactive). Running off the end of the
 *  list is what finishes the tutorial, so the last step needs no special case
 *  at its call site. */
export function advanceTutorial(registry: Phaser.Data.DataManager): void {
  const t = getTutorial(registry);
  if (!t.active) return;
  const next = t.stage + 1;
  if (next >= TutorialStage.Done) {
    completeTutorial(registry);
    return;
  }
  setTutorial(registry, { active: true, stage: next });
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

/** Finish the tutorial and persist that it shouldn't play again (re-enableable
 *  from the Settings menu). */
export function completeTutorial(registry: Phaser.Data.DataManager): void {
  setTutorial(registry, { active: false, stage: TutorialStage.Done });
  refreshActiveRun(registry);
  const settings = loadSettings();
  if (settings.showTutorial) {
    settings.showTutorial = false;
    saveSettings(settings);
  }
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
 */
export function tutorialForcesRoll(
  registry: Phaser.Data.DataManager,
  state: RunState,
): boolean {
  if (!getTutorial(registry).active) return false;
  const rollsLeft = trialRollTarget(state) - state.roll; // this roll included
  return BigInt(rollsLeft) <= goalFor(state) - state.score;
}

/**
 * Whether this roll must come up empty. The Lesser Trial's goal is a single
 * point, so a scoring first roll would clear the trial the moment the tutorial
 * has finished pointing at the seal — skipping the viewport, goal, rolls and
 * rank steps entirely. The run's opening roll is therefore re-rolled until
 * nothing on it scores, so the lesson always runs in its written order.
 *
 * Only the very first roll of the run is held back; from the second onwards the
 * dice are honest again (and `tutorialForcesRoll` guarantees the trial still
 * ends in a clear).
 */
export function tutorialBlocksScore(
  registry: Phaser.Data.DataManager,
  state: RunState,
): boolean {
  if (!getTutorial(registry).active) return false;
  return state.trial === 1 && state.roll === 0;
}

/**
 * Shared entry point for starting a run from the menu / intro: seeds a fresh
 * RunState, arms the tutorial if enabled, and enters the Game scene. Keeps the
 * intro and no-intro paths identical.
 */
export function beginRun(scene: Phaser.Scene): void {
  // Freeze shop eligibility at run start. Unlocks earned during this run are
  // still saved and announced, but only the next run's snapshot can offer them.
  const state = newRun(loadProgress().unlocked);
  initializeRun(state);
  setRun(scene.registry, state);
  beginTutorial(scene.registry);
  saveActiveRun(scene.registry, { scene: "TrialOverview" });
  scene.scene.start("TrialOverview");
}
