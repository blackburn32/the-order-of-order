import type Phaser from "phaser";
import { trialComplete } from "../sim/engine";
import type { RunState } from "../state/RunState";

/** The GameScene members the reels drive.
 *
 *  As in `shopLoop.ts`, the studio reaches past `private` rather than widening
 *  the scene's own API: a reel presses the seal a player would press and then
 *  watches the scene's own roll flag, so the whole performance — tumble, score,
 *  any growth, re-layout — stays the scene's, and this file stays a script.
 */
interface GameSceneInternals extends Phaser.Scene {
  state: RunState;
  rolling: boolean;
  onRoll(): void;
}

/** What one roll costs in wall-clock: ~530ms of tumble, ~420ms of effects, and
 *  GameScene's own ~700ms hold on the result. A reel waits on the scene's flag
 *  rather than on this number — it is here so the published lengths below are
 *  honest, and as the per-roll timeout. */
const ROLL_BUDGET_MS = 1900;

export interface RollReelConfig {
  /** Rolls the reel makes. */
  readonly rolls: number;
  /** Stillness before the first press, so the clip opens on a settled grid
   *  rather than on a die already in the air. The recorder holds its own lead-in
   *  before it calls `play()`, and that lead sits in front of this one. */
  readonly openingMs: number;
  /** The pause between one roll finishing and the next press. GameScene already
   *  rests ~700ms on a settled roll before it clears `rolling`; this is the
   *  extra beat on top, which is what makes each roll read as a beat of its own
   *  rather than as one long stutter of dice. */
  readonly betweenRollsMs: number;
  /** The rest on the final roll's result, before the recorder stops. */
  readonly closingMs: number;
}

/** Grid growth: four rolls of a Genesis build, watched from 24 dice to 102.
 *
 *  Four is what the fixture can show without changing what the clip is about.
 *  Genesis adds 20 dice a roll, so the grid walks 24 → 42 → 62 → 82 → 102 and
 *  stops short of the 150-die callout threshold: every stage still draws real
 *  faces and floats its own GENESIS labels. The trial's goal is 53,000 and four
 *  rolls score about 1,200 of it, so the trial cannot end mid-reel either.
 *
 *  The grid it ends on is four times the size of the one it opens on, so this
 *  clip cannot loop on an identical frame the way the late-grid reel does; its
 *  long closing rest is the only thing separating the last stage from the jump
 *  back to 24 dice. */
export const GRID_GROWTH_REEL: RollReelConfig = {
  rolls: 4,
  openingMs: 350,
  betweenRollsMs: 500,
  closingMs: 1300,
};

/** Late grid: three rolls of a 168-die Order, and the reel the site's closing
 *  clip is cut from.
 *
 *  The grid neither grows nor shrinks here, and the fixture's opening faces are
 *  the ones this reel's last roll lands on (see `alignToReelClose` in
 *  `presets.ts`), so the clip's last frame and its first frame draw the same
 *  168 dice. Only the HUD's score and roll counter differ across the seam.
 *
 *  Its holds are deliberately shorter than the grid reel's and roughly match its
 *  own between-roll gap: at the loop point the viewer sees this reel's closing
 *  rest and the recorder's lead-in back to back, and a seam that rests longer
 *  than the beats around it reads as the clip stopping rather than looping. */
export const LATE_GRID_REEL: RollReelConfig = {
  rolls: 3,
  openingMs: 200,
  betweenRollsMs: 650,
  closingMs: 700,
};

/** Total wall-clock a reel needs, so the recorder does not carry a second,
 *  drifting copy of the pacing. */
export function rollReelDuration(config: RollReelConfig): number {
  return (
    config.openingMs +
    config.rolls * (ROLL_BUDGET_MS + config.betweenRollsMs) -
    config.betweenRollsMs +
    config.closingMs
  );
}

export interface RollReelProgress {
  readonly log: readonly string[];
  readonly error: string | null;
  readonly done: boolean;
}

let progress: { log: string[]; error: string | null; done: boolean } = {
  log: [],
  error: null,
  done: false,
};
/** Restarting a preset abandons any reel still running against the old scene. */
let generation = 0;

export function rollReelProgress(): RollReelProgress {
  return progress;
}

export function resetRollReel(): void {
  generation += 1;
  progress = { log: [], error: null, done: false };
}

/** Perform a reel against the live GameScene. A roll that could not be made is
 *  recorded rather than thrown: the recorder is already sampling the canvas by
 *  the time this runs, so it has to be reported after the clip instead of
 *  interrupting it. */
export async function playRollReel(
  game: Phaser.Game,
  config: RollReelConfig,
  onBeat?: (label: string) => void,
): Promise<void> {
  const mine = ++generation;
  progress = { log: [], error: null, done: false };
  const scene = gameScene(game);
  if (!scene) {
    progress.error = "the Game scene is not running";
    return;
  }

  await hold(scene, config.openingMs);
  for (let index = 0; index < config.rolls; index++) {
    if (generation !== mine) return;
    const label = `roll ${index + 1} of ${config.rolls}`;
    onBeat?.(label);
    // The reel would otherwise press into a trial that has no rolls left, and
    // GameScene would answer by resolving the trial and leaving for the shop —
    // a take that ends somewhere else entirely.
    if (trialComplete(scene.state)) {
      progress.error = `${label}: the trial is already over`;
      return;
    }
    scene.onRoll();
    const settled = await settle(scene, mine);
    if (generation !== mine) return;
    if (!settled) {
      progress.error = `${label}: the roll did not settle in ${ROLL_BUDGET_MS}ms`;
      return;
    }
    progress.log.push(`${label} — ${scene.state.dice.length} dice`);
    const last = index === config.rolls - 1;
    await hold(scene, last ? config.closingMs : config.betweenRollsMs);
  }
  progress.done = true;
}

/** Wait for GameScene to finish the roll it is making — it clears `rolling`
 *  once the dice have settled, the score has been presented and any grown grid
 *  has been re-laid. Polled on the scene's own clock, so the reel and the
 *  animation it is pacing against cannot drift apart. */
async function settle(
  scene: GameSceneInternals,
  mine: number,
): Promise<boolean> {
  const step = 50;
  for (let waited = 0; waited <= ROLL_BUDGET_MS; waited += step) {
    await hold(scene, step);
    if (generation !== mine) return false;
    if (!scene.rolling) return true;
  }
  return false;
}

function hold(scene: GameSceneInternals, ms: number): Promise<void> {
  return new Promise((resolve) => {
    scene.time.delayedCall(ms, resolve);
  });
}

function gameScene(game: Phaser.Game): GameSceneInternals | null {
  return game.scene.getScene("Game") as GameSceneInternals | null;
}
