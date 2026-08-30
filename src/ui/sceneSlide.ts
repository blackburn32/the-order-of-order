import Phaser from "phaser";
import { fx } from "../systems/Effects";
import { AmbientLayer } from "./AmbientLayer";

const SLIDE_MS = 360;
const OVERLAY_FADE_MS = 240;

export type SlideObject = Phaser.GameObjects.GameObject &
  Phaser.GameObjects.Components.Transform;

function containsStationaryObject(
  object: Phaser.GameObjects.GameObject,
  stationary: Set<Phaser.GameObjects.GameObject>,
): boolean {
  if (stationary.has(object)) return true;
  if (!(object instanceof Phaser.GameObjects.Container)) return false;
  return object.list.some((child) =>
    containsStationaryObject(child, stationary),
  );
}

/** Find the largest movable display objects. A container normally moves as a
 * unit; when it contains a pinned backdrop (Game's dice container also owns
 * its AmbientLayer), descend just far enough to move its other children. */
function slideTargets(
  scene: Phaser.Scene,
  stationaryObjects: Phaser.GameObjects.GameObject[],
): SlideObject[] {
  const stationary = new Set(stationaryObjects);
  const targets: SlideObject[] = [];
  const visit = (object: Phaser.GameObjects.GameObject) => {
    if (stationary.has(object)) return;
    if (
      object instanceof Phaser.GameObjects.Container &&
      containsStationaryObject(object, stationary)
    ) {
      object.list.forEach(visit);
      return;
    }
    if ("x" in object && "y" in object) targets.push(object as SlideObject);
  };
  scene.children.list.forEach(visit);
  return targets;
}

/** Move an explicit set of objects in from off the left edge, restoring the
 * scene's input lock once they arrive. The whole-scene entrance is one caller;
 * a story sequence turning a page is the other, where the set is just the page.
 *
 * `arrived` runs once they have come to rest — and immediately when there is no
 * slide to wait for — so a caller can hold deferred work (see the Codex's card
 * top-up) until the frames the entrance needs are its own. */
export function slideObjectsIn(
  scene: Phaser.Scene,
  targets: readonly SlideObject[],
  arrived?: () => void,
): void {
  if (!fx.motion) {
    arrived?.();
    return;
  }
  const distance = scene.scale.width;
  const inputWasEnabled = scene.input.enabled;
  scene.input.enabled = false;

  let remaining = targets.length;
  if (remaining === 0) {
    scene.input.enabled = inputWasEnabled;
    arrived?.();
    return;
  }
  for (const target of targets) {
    const destinationX = target.x;
    target.x = destinationX - distance;
    scene.tweens.add({
      targets: target,
      x: destinationX,
      duration: SLIDE_MS,
      ease: "Cubic.easeOut",
      onComplete: () => {
        remaining -= 1;
        if (remaining === 0) {
          scene.input.enabled = inputWasEnabled;
          arrived?.();
        }
      },
    });
  }
}

/** Send an explicit set of objects off the right edge, holding input closed
 * behind them: whatever replaces them owns re-arming it. */
export function slideObjectsOut(
  scene: Phaser.Scene,
  targets: readonly SlideObject[],
  complete: () => void,
): void {
  if (!fx.motion) {
    complete();
    return;
  }
  scene.input.enabled = false;
  const distance = scene.scale.width;
  let remaining = targets.length;
  if (remaining === 0) {
    complete();
    return;
  }
  for (const target of targets) {
    scene.tweens.add({
      targets: target,
      x: target.x + distance,
      duration: SLIDE_MS,
      ease: "Cubic.easeIn",
      onComplete: () => {
        remaining -= 1;
        if (remaining === 0) complete();
      },
    });
  }
}

/** Bring only a scene's interface in from the left. Felt, sigils, motes, and
 * lighting passed in `stationary` remain fixed, making successive scenes feel
 * like different arrangements in the same room. */
export function slideSceneIn(
  scene: Phaser.Scene,
  stationary: Phaser.GameObjects.GameObject[] = [],
  arrived?: () => void,
): void {
  if (!fx.motion) {
    arrived?.();
    return;
  }
  slideObjectsIn(scene, slideTargets(scene, stationary), arrived);
}

/** Send only the current interface to the right, leaving the room behind it
 * completely still until the next scene's interface arrives. */
export function slideSceneOut(
  scene: Phaser.Scene,
  complete: () => void,
  stationary: Phaser.GameObjects.GameObject[] = [],
): void {
  if (!fx.motion) {
    complete();
    return;
  }
  slideObjectsOut(scene, slideTargets(scene, stationary), () => {
    for (const object of stationary) {
      if (object instanceof AmbientLayer) object.queueMorphHandoff();
    }
    complete();
  });
}

/** Bring an overlay's room over the live scene beneath it. The felt crossfades
 *  while the sigil and interface take the standard scene entrance, so clipped
 *  content rendered by secondary cameras participates without needing to
 *  animate camera alpha independently. */
export function slideOverlayIn(
  scene: Phaser.Scene,
  felt: Phaser.GameObjects.Image,
  arrived?: () => void,
): void {
  if (!fx.motion) {
    arrived?.();
    return;
  }

  felt.setAlpha(0);
  scene.tweens.add({
    targets: felt,
    alpha: 1,
    duration: OVERLAY_FADE_MS,
    ease: "Quad.easeOut",
  });
  slideSceneIn(scene, [felt], arrived);
}

/** Reverse `slideOverlayIn`: expose the still-running scene underneath as the
 *  overlay's sigil and interface leave to the right. */
export function slideOverlayOut(
  scene: Phaser.Scene,
  felt: Phaser.GameObjects.Image,
  complete: () => void,
): void {
  if (!fx.motion) {
    complete();
    return;
  }

  scene.tweens.add({
    targets: felt,
    alpha: 0,
    duration: OVERLAY_FADE_MS,
    delay: SLIDE_MS - OVERLAY_FADE_MS,
    ease: "Quad.easeIn",
  });
  slideSceneOut(scene, complete, [felt]);
}
