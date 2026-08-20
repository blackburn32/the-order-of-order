import type Phaser from "phaser";
import { newRun, setRun, type RunState } from "../state/RunState";
import { loadProgress, loadSettings, saveSettings } from "./SaveData";
import { beginRun as initializeRun } from "../sim/engine";
import { goalFor } from "./Boss";
import { trialRollTarget } from "./Trial";
import { WIN_RANK } from "../config";

// The tutorial steps, in the order they are shown. They follow the run's own
// loop rather than one screen: the route screen teaches the shape of a rank,
// the table teaches a roll, the results screen teaches what a clear pays, and
// the shop teaches spending it. `Done` is the terminal marker.
//
// Every step belongs to exactly one scene, which is what lets each scene render
// the current stage (and only it) without coordinating with the others.
//
// Boss is deliberately last and fires on the first Boss Trial rather than in
// sequence, because it has nothing to point at until one arrives.
export enum TutorialStage {
  Route, // TrialOverview: the three trials of a rank
  RouteBoss, // TrialOverview: the boss card waiting at the end of it
  RouteStart, // TrialOverview: the button that begins the first one
  Score, // Game
  Roll,
  Viewport,
  Goal,
  Rolls,
  Rank,
  Results, // TrialResults: what a clear paid
  Shop, // Shop: spending it
  Boss, // Game, once a Boss Trial is actually in force
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
  [TutorialStage.RouteBoss]:
    "The final trial has it's own quirks, make note of them.",
  [TutorialStage.RouteStart]: "Press here to begin your first trial",
  [TutorialStage.Score]:
    "This is your score, roll a one on any die to score a point.",
  [TutorialStage.Roll]: "Press the seal to roll.",
  [TutorialStage.Viewport]: "Drag and scroll / pinch to move around your dice.",
  [TutorialStage.Goal]:
    "Here is the trial's goal, reach it and the trial ends.",
  [TutorialStage.Rolls]:
    "Here are your remaining rolls, each one left when the round end rewards one gold.",
  [TutorialStage.Rank]: `This is your current rank. Complete rank ${WIN_RANK} to win.`,
  [TutorialStage.Results]: "Clearing a trial pays gold. Spend it in the shop.",
  [TutorialStage.Shop]: "Spend your gold. A pack reveals three; you keep one.",
  [TutorialStage.Boss]: "Be careful, the boss effect is active and will make your task harder. Defeat the boss to advance a rank!",
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
  scene.scene.start("TrialOverview");
}
