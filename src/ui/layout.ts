import Phaser from "phaser";

/** True when the current viewport is taller than it is wide. */
export function isPortrait(scene: Phaser.Scene): boolean {
  return scene.scale.height > scene.scale.width;
}

/**
 * Wires `fn` to run on RESIZE, collapsing any further RESIZE events that
 * arrive before the next tick into a single call — a window drag can fire
 * several RESIZE events per frame, and without this a scene with an O(dice)
 * rebuild would redo that work many times over for one drag gesture.
 * Returns an unsubscribe function; callers are responsible for calling it on
 * shutdown.
 */
export function onResizeCoalesced(
  scene: Phaser.Scene,
  fn: () => void,
): () => void {
  let queued = false;
  const handler = () => {
    if (queued) return;
    queued = true;
    scene.time.delayedCall(0, () => {
      queued = false;
      fn();
    });
  };
  scene.scale.on(Phaser.Scale.Events.RESIZE, handler);
  return () => scene.scale.off(Phaser.Scale.Events.RESIZE, handler);
}

/**
 * Destroys every game object in the scene, for a screen that rebuilds itself
 * from scratch. `children.removeAll(true)` reads like this but is not: its
 * argument is `skipCallback`, so the objects come off the display list still
 * alive and still registered with the scene's input plugin — where they go on
 * being hit-tested by every camera, at coordinates from a layout that is no
 * longer on screen, and swallow presses meant for the rebuilt UI.
 */
export function destroyAllChildren(scene: Phaser.Scene): void {
  // Over a copy: destroy() removes the object from the list being iterated.
  for (const child of [...scene.children.list]) child.destroy();
}

/**
 * Runs `build` now and again every time the game viewport is resized (window
 * resize, orientation change, fullscreen toggle), coalesced via
 * `onResizeCoalesced`. Each rebuild wipes and redraws the scene's whole
 * display list, so scenes stay simple: one layout function, driven off
 * `scene.scale.width/height`, instead of a maze of reposition-in-place
 * logic. Only appropriate for scenes whose display list is small/bounded —
 * see `GameScene`/`ShopScene` for the reposition-in-place approach used
 * where the display list can be O(dice).
 */
export function responsive(scene: Phaser.Scene, build: () => void): void {
  build();

  const off = onResizeCoalesced(scene, () => {
    destroyAllChildren(scene);
    build();
  });
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, off);
}

/**
 * A viewport too short for the stacked/portrait composition but wide enough to
 * split into two columns — a handset held in landscape, or a squat desktop
 * window. Scenes that have a compact-landscape variant (`ShopScene`,
 * `GameScene`) all gate it on this, so a device flips both screens at once.
 *
 * The gate is an aspect ratio rather than an absolute width: a 640x360 handset
 * in landscape is far too short to stack, but sits under any width floor
 * generous enough to be meaningful on desktop, so a width-only test left small
 * phones in the portrait layout however they were turned. The modest width
 * floor only rules out viewports where two columns would each be unusable.
 */
export const COMPACT_LANDSCAPE_MAX_H = 508;
export const COMPACT_LANDSCAPE_MIN_W = 500;
export const COMPACT_LANDSCAPE_MIN_RATIO = 1.35;

export function isCompactLandscape(width: number, height: number): boolean {
  return (
    height < COMPACT_LANDSCAPE_MAX_H &&
    width >= COMPACT_LANDSCAPE_MIN_W &&
    width / height >= COMPACT_LANDSCAPE_MIN_RATIO
  );
}

/** Outer margin and gutter of the compact-landscape column frame. Every screen
 *  that folds uses the same two numbers, so a device that flips them all at
 *  once folds them onto one grid rather than six near-misses. */
export const COMPACT_MARGIN = 16;
const COMPACT_GUTTER = 18;

export interface Column {
  /** Left edge. */
  x: number;
  /** Horizontal centre — what centred content lays itself out around. */
  cx: number;
  width: number;
  /** Right edge. */
  right: number;
}

export interface ColumnSplit {
  left: Column;
  right: Column;
  /** The band both columns fill. */
  top: number;
  bottom: number;
  height: number;
}

export interface ColumnSplitOptions {
  /** Top of the band; defaults to the outer margin. Screens that keep a
   *  full-width header line pass its rule's y plus a little air. */
  top?: number;
  /** Bottom of the band; defaults to the viewport less the outer margin. */
  bottom?: number;
  /** Share of the usable width (gutter excluded) the left column takes. */
  leftFraction?: number;
}

/**
 * The two-column frame the compact-landscape screens fold into. A short
 * landscape viewport has width to spare and no height at all, so the screens
 * that stack a masthead, a body and a column of buttons put the buttons — or
 * whichever part scrolls — beside the rest instead of below it.
 *
 * Only meaningful when `isCompactLandscape` is true; the callers all gate on
 * it, so a device folds every screen at the same moment.
 */
export function compactColumns(
  scene: Phaser.Scene,
  opts: ColumnSplitOptions = {},
): ColumnSplit {
  const W = scene.scale.width;
  const H = scene.scale.height;
  const top = opts.top ?? COMPACT_MARGIN;
  const bottom = opts.bottom ?? H - COMPACT_MARGIN;
  const usable = Math.max(0, W - COMPACT_MARGIN * 2 - COMPACT_GUTTER);
  const leftW = Math.round(usable * (opts.leftFraction ?? 0.5));
  const column = (x: number, width: number): Column => ({
    x,
    cx: x + width / 2,
    width,
    right: x + width,
  });

  return {
    left: column(COMPACT_MARGIN, leftW),
    right: column(COMPACT_MARGIN + leftW + COMPACT_GUTTER, usable - leftW),
    top,
    bottom,
    height: Math.max(0, bottom - top),
  };
}
