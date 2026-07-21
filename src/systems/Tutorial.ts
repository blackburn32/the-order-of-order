import type Phaser from 'phaser';
import { newRun, setRun } from '../state/RunState';
import { loadSettings, saveSettings } from './SaveData';

// The six tutorial steps, in the order the spec lays them out. `Done` is the
// terminal marker once every step has been shown.
export enum TutorialStage {
  Score,
  Roll,
  Target,
  Rolls,
  Round,
  Shop,
  Done
}

export interface TutorialState {
  active: boolean;
  stage: TutorialStage;
}

// Kept in the Phaser registry (like RunState) rather than a scene field, so it
// survives the Game -> Shop -> Game scene transitions the tutorial spans.
const KEY = 'tutorial';

export function getTutorial(registry: Phaser.Data.DataManager): TutorialState {
  return (registry.get(KEY) as TutorialState | undefined) ?? { active: false, stage: TutorialStage.Done };
}

export function setTutorial(registry: Phaser.Data.DataManager, state: TutorialState): void {
  registry.set(KEY, state);
}

/** Arm the tutorial for a fresh run when the player hasn't turned it off. */
export function beginTutorial(registry: Phaser.Data.DataManager): void {
  if (loadSettings().showTutorial) {
    setTutorial(registry, { active: true, stage: TutorialStage.Score });
  } else {
    setTutorial(registry, { active: false, stage: TutorialStage.Done });
  }
}

/** Advance to the next stage (no-op once inactive). */
export function advanceTutorial(registry: Phaser.Data.DataManager): void {
  const t = getTutorial(registry);
  if (!t.active) return;
  const next = t.stage + 1;
  setTutorial(registry, { active: next < TutorialStage.Done, stage: next });
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
 * Shared entry point for starting a run from the menu / intro: seeds a fresh
 * RunState, arms the tutorial if enabled, and enters the Game scene. Keeps the
 * intro and no-intro paths identical.
 */
export function beginRun(scene: Phaser.Scene): void {
  setRun(scene.registry, newRun());
  beginTutorial(scene.registry);
  scene.scene.start('Game');
}
