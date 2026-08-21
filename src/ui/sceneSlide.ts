import Phaser from "phaser";
import { fx } from "../systems/Effects";
import { AmbientLayer } from "./AmbientLayer";

const SLIDE_MS = 360;

type SlideObject = Phaser.GameObjects.GameObject &
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

/** Bring only a scene's interface in from the left. Felt, sigils, motes, and
 * lighting passed in `stationary` remain fixed, making successive scenes feel
 * like different arrangements in the same room.
 *
 * `arrived` runs once the interface has come to rest — and immediately when
 * there is no slide to wait for — so a scene can hold deferred work (see the
 * Codex's card top-up) until the frames the entrance needs are its own. */
export function slideSceneIn(
  scene: Phaser.Scene,
  stationary: Phaser.GameObjects.GameObject[] = [],
  arrived?: () => void,
): void {
  if (!fx.motion) {
    arrived?.();
    return;
  }
  const targets = slideTargets(scene, stationary);
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
  scene.input.enabled = false;
  const handoffAmbient = () => {
    for (const object of stationary) {
      if (object instanceof AmbientLayer) object.queueMorphHandoff();
    }
  };
  const targets = slideTargets(scene, stationary);
  const distance = scene.scale.width;
  let remaining = targets.length;
  if (remaining === 0) {
    handoffAmbient();
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
        if (remaining === 0) {
          handoffAmbient();
          complete();
        }
      },
    });
  }
}
