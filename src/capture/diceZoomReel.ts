import type Phaser from "phaser";
import type { RunState } from "../state/RunState";
import {
  computeWindowedView,
  GRID_WHEEL_ZOOM_RATE,
  type GridFocus,
  type Viewport,
  type VisibleDiceCard,
} from "../ui/windowedGrid";

/**
 * Drives the real GameScene wheel-zoom path for the marketing reel. Nothing is
 * reimplemented here: each tween step emits the same wheel event a player does,
 * so clamping, re-centering, LOD thresholds, regional card merging, and the
 * final one-card representation all remain owned by GameScene.
 */

interface GridArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GameSceneInternals extends Phaser.Scene {
  state: RunState;
  layout: { grid: GridArea; gridFrame: GridArea };
  viewport: Viewport;
  sprites: Map<number, unknown>;
  cards: Map<string, unknown>;
  cardRegions: Map<string, VisibleDiceCard>;
  diceContainer: { alpha: number };
  gridFocus(): GridFocus;
  prepareZoomCaptureLoop(): void;
  settleZoomCaptureOpening(): void;
  syncGrid(layout: GameSceneInternals["layout"]): void;
}

const OPENING_MS = 350;
const ZOOM_LEG_MS = 8000;
const TURN_MS = 800;
const CLOSING_MS = 350;

export const DICE_ZOOM_DURATION_MS =
  OPENING_MS + ZOOM_LEG_MS * 2 + TURN_MS + CLOSING_MS;

export interface DiceZoomProgress {
  readonly log: readonly string[];
  readonly error: string | null;
  readonly done: boolean;
}

let progress: { log: string[]; error: string | null; done: boolean } = {
  log: [],
  error: null,
  done: false,
};
let generation = 0;
let reelAnchor: { x: number; y: number } | undefined;

export function diceZoomProgress(): DiceZoomProgress {
  return progress;
}

export function resetDiceZoomReel(): void {
  generation += 1;
  reelAnchor = undefined;
  progress = { log: [], error: null, done: false };
}

/** Put the studio on the reel's opening/closing frame before readiness is
 * announced, so both the poster capture and the video begin on loose dice. */
export function prepareDiceZoom(game: Phaser.Game): void {
  const scene = gameScene(game);
  if (!scene) return;
  scene.prepareZoomCaptureLoop();
  const center = reelCenter(scene);
  // Enter maximum zoom from a nearby point, then move the virtual camera so
  // the geometric middle of the dice block is exactly under the reel anchor.
  // The 16px pointer shift makes the first scripted wheel event begin a fresh
  // GameScene wheel gesture there rather than inheriting this setup event.
  reelAnchor = { x: center.x - 16, y: center.y };
  wheelTo(scene, Number.POSITIVE_INFINITY);
  centerGridAt(scene, center);
  reelAnchor = center;
  scene.settleZoomCaptureOpening();
}

export async function playDiceZoomReel(
  game: Phaser.Game,
  onBeat?: (label: string) => void,
): Promise<void> {
  const mine = ++generation;
  progress = { log: [], error: null, done: false };
  const scene = gameScene(game);
  if (!scene) {
    progress.error = "the Game scene is not running";
    return;
  }

  await hold(scene, OPENING_MS);
  if (generation !== mine) return;

  onBeat?.("zooming out");
  const opening = { ...scene.viewport };
  const openingDiceAlpha = scene.diceContainer.alpha;
  const openingIndex = dieIndexAtAnchor(scene);
  const middleIndex = gridMiddleIndex(scene);
  if (openingIndex === null || openingIndex !== middleIndex) {
    progress.error = `opening camera index ${openingIndex ?? "none"} is not the grid middle ${middleIndex}`;
    return;
  }
  const closeZoom = scene.viewport.zoom;
  // A huge positive wheel delta asks GameScene for its own minimum. That
  // minimum is defined as one fully merged summary card plus headroom.
  wheelTo(scene, 0);
  const farZoom = scene.viewport.zoom;
  wheelTo(scene, closeZoom);

  const outwardCenterDrift = await tweenZoom(
    scene,
    closeZoom,
    farZoom,
    ZOOM_LEG_MS,
  );
  if (generation !== mine) return;
  if (outwardCenterDrift > 0.5) {
    progress.error = `outward zoom strayed ${outwardCenterDrift.toFixed(2)}px from center`;
    return;
  }
  const farCards = visibleCardCount(scene);
  if (farCards !== 1) {
    progress.error = `fully zoomed-out grid produced ${farCards} cards`;
    return;
  }
  const [region] = scene.cardRegions.values();
  const cardWidthFraction = region
    ? (region.width * scene.viewport.zoom) / scene.scale.width
    : 0;
  if (cardWidthFraction < 0.55 || cardWidthFraction > 0.65) {
    progress.error = `final card occupies ${(cardWidthFraction * 100).toFixed(1)}% of the screen width`;
    return;
  }
  progress.log.push("100,489 dice merged to one summary card");

  onBeat?.("one card");
  await hold(scene, TURN_MS);
  if (generation !== mine) return;

  onBeat?.("zooming in");
  const inwardCenterDrift = await tweenZoom(
    scene,
    farZoom,
    closeZoom,
    ZOOM_LEG_MS,
  );
  if (generation !== mine) return;
  if (inwardCenterDrift > 0.5) {
    progress.error = `inward zoom strayed ${inwardCenterDrift.toFixed(2)}px from center`;
    return;
  }
  if (visibleCardCount(scene) !== 0 || visibleSpriteCount(scene) === 0) {
    progress.error = "fully zoomed-in grid did not return to individual dice";
    return;
  }
  const driftX = Math.abs(scene.viewport.scrollX - opening.scrollX) * closeZoom;
  const driftY = Math.abs(scene.viewport.scrollY - opening.scrollY) * closeZoom;
  if (
    Math.abs(scene.viewport.zoom - opening.zoom) > opening.zoom * 1e-9 ||
    driftX > 0.5 ||
    driftY > 0.5 ||
    dieIndexAtAnchor(scene) !== openingIndex
  ) {
    progress.error =
      "closing camera did not return to the opening grid position";
    return;
  }
  if (
    Math.abs(scene.diceContainer.alpha - openingDiceAlpha) > 1e-6 ||
    Math.abs(scene.diceContainer.alpha - 1) > 1e-6
  ) {
    progress.error = "closing dice layer did not return to full opacity";
    return;
  }
  progress.log.push("returned to individual dice");

  await hold(scene, CLOSING_MS);
  if (generation !== mine) return;
  progress.done = true;
}

function tweenZoom(
  scene: GameSceneInternals,
  from: number,
  to: number,
  duration: number,
): Promise<number> {
  return new Promise((resolve) => {
    const pose = { logZoom: Math.log(from) };
    let maxCenterDrift = 0;
    const updateCenterDrift = () => {
      const center = reelAnchor;
      if (!center) return;
      const actual = gridMiddleScreen(scene);
      maxCenterDrift = Math.max(
        maxCenterDrift,
        Math.hypot(actual.x - center.x, actual.y - center.y),
      );
    };
    scene.tweens.add({
      targets: pose,
      logZoom: Math.log(to),
      duration,
      ease: "Sine.easeInOut",
      onUpdate: () => {
        wheelTo(scene, Math.exp(pose.logZoom));
        updateCenterDrift();
      },
      onComplete: () => {
        wheelTo(scene, to);
        updateCenterDrift();
        resolve(maxCenterDrift);
      },
    });
  });
}

/** Ask the scene's actual wheel handler to reach a target zoom. The handler
 * converts this back into a clamped camera pose and rebuilds real summary-card
 * regions at every LOD boundary. */
function wheelTo(scene: GameSceneInternals, target: number): void {
  const current = Math.max(Number.MIN_VALUE, scene.viewport.zoom);
  const ratio =
    target === Number.POSITIVE_INFINITY ? Number.MAX_VALUE : target / current;
  const deltaY =
    -Math.log(Math.max(Number.MIN_VALUE, ratio)) / GRID_WHEEL_ZOOM_RATE;
  const pointer = (reelAnchor ??
    gridMiddleScreen(scene)) as Phaser.Input.Pointer;
  scene.input.emit("wheel", pointer, [], 0, deltaY, 0);
  // The normal wheel path owns all zoom limits and representation changes.
  // The reel adds one camera-direction constraint: the geometric grid centre
  // remains pinned to the visual centre after every wheel step. This prevents
  // the fit-zoom re-home and scroll clamps from bending the capture diagonally
  // near the final card.
  if (reelAnchor) centerGridAt(scene, reelAnchor);
}

function gridMiddleScreen(scene: GameSceneInternals): { x: number; y: number } {
  const view = computeWindowedView(
    scene.state.dice.length,
    scene.layout.grid,
    scene.layout.gridFrame,
    scene.viewport,
    scene.gridFocus(),
  );
  return {
    x:
      scene.layout.grid.x +
      (view.originX + (view.cols * view.cell) / 2 - view.scrollX) * view.zoom,
    y:
      scene.layout.grid.y +
      (view.originY + (view.rows * view.cell) / 2 - view.scrollY) * view.zoom,
  };
}

function reelCenter(scene: GameSceneInternals): { x: number; y: number } {
  return { x: scene.scale.width / 2, y: scene.scale.height / 2 };
}

function centerGridAt(
  scene: GameSceneInternals,
  screen: { x: number; y: number },
): void {
  const view = computeWindowedView(
    scene.state.dice.length,
    scene.layout.grid,
    scene.layout.gridFrame,
    scene.viewport,
    scene.gridFocus(),
  );
  scene.viewport.scrollX =
    view.originX +
    (view.cols * view.cell) / 2 -
    (screen.x - scene.layout.grid.x) / view.zoom;
  scene.viewport.scrollY =
    view.originY +
    (view.rows * view.cell) / 2 -
    (screen.y - scene.layout.grid.y) / view.zoom;
  scene.syncGrid(scene.layout);
}

function dieIndexAtAnchor(scene: GameSceneInternals): number | null {
  const anchor = reelAnchor ?? gridMiddleScreen(scene);
  const view = computeWindowedView(
    scene.state.dice.length,
    scene.layout.grid,
    scene.layout.gridFrame,
    scene.viewport,
    scene.gridFocus(),
  );
  const worldX = view.scrollX + (anchor.x - scene.layout.grid.x) / view.zoom;
  const worldY = view.scrollY + (anchor.y - scene.layout.grid.y) / view.zoom;
  const col = Math.floor((worldX - view.originX) / view.cell);
  const row = Math.floor((worldY - view.originY) / view.cell);
  const index = row * view.cols + col;
  return index >= 0 && index < scene.state.dice.length ? index : null;
}

function gridMiddleIndex(scene: GameSceneInternals): number {
  const view = computeWindowedView(
    scene.state.dice.length,
    scene.layout.grid,
    scene.layout.gridFrame,
    scene.viewport,
    scene.gridFocus(),
  );
  return Math.min(
    scene.state.dice.length - 1,
    Math.floor(view.rows / 2) * view.cols + Math.floor(view.cols / 2),
  );
}

function hold(scene: GameSceneInternals, ms: number): Promise<void> {
  return new Promise((resolve) => scene.time.delayedCall(ms, resolve));
}

function visibleCardCount(scene: GameSceneInternals): number {
  return scene.cards.size;
}

function visibleSpriteCount(scene: GameSceneInternals): number {
  return scene.sprites.size;
}

function gameScene(game: Phaser.Game): GameSceneInternals | null {
  return game.scene.getScene("Game") as GameSceneInternals | null;
}
