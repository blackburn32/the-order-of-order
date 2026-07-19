import Phaser from 'phaser';

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
export function onResizeCoalesced(scene: Phaser.Scene, fn: () => void): () => void {
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
    scene.children.removeAll(true);
    build();
  });
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, off);
}
