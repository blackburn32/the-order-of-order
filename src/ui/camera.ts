import Phaser from "phaser";
import { DPR } from "../renderQuality";

/**
 * Cameras are the one part of the game measured in device pixels rather than
 * layout pixels.
 *
 * Everything a scene positions — objects, hit areas, `pointer.x/y`, a camera's
 * own `scrollX/Y` — is in CSS pixels. A camera's *viewport* is not: it is a
 * rectangle of the canvas backing store, which `installHiDpi` sizes at `DPR`
 * times the CSS viewport so the game is drawn at the screen's real resolution.
 * These helpers are the conversion, and every camera in the game goes through
 * one of them.
 *
 * The origin of (0, 0) matters as much as the zoom. Phaser magnifies a camera
 * about `width * originX`, so at the default origin of 0.5 a zoomed camera's
 * `scrollX` stops meaning "the world point at my left edge" and callers have to
 * unpick the half-viewport offset themselves. Pinned to zero, `scrollX/Y` keeps
 * its unzoomed meaning at every zoom level.
 */
function tune(
  camera: Phaser.Cameras.Scene2D.Camera,
  zoom: number,
): Phaser.Cameras.Scene2D.Camera {
  camera.setOrigin(0, 0);
  camera.setZoom(zoom * DPR);
  return camera;
}

/** `scene.cameras.add`, taking the viewport in layout pixels. */
export function addCamera(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
): Phaser.Cameras.Scene2D.Camera {
  const camera = scene.cameras.add(
    Math.round(x * DPR),
    Math.round(y * DPR),
    Math.round(width * DPR),
    Math.round(height * DPR),
  );
  return tune(camera, 1);
}

/** `Camera.setViewport`, taking the viewport in layout pixels. */
export function setCameraViewport(
  camera: Phaser.Cameras.Scene2D.Camera,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  camera.setViewport(
    Math.round(x * DPR),
    Math.round(y * DPR),
    Math.round(width * DPR),
    Math.round(height * DPR),
  );
}

/** `Camera.setSize`, taking the size in layout pixels. */
export function setCameraSize(
  camera: Phaser.Cameras.Scene2D.Camera,
  width: number,
  height: number,
): void {
  camera.setSize(Math.round(width * DPR), Math.round(height * DPR));
}

/** `Camera.setZoom`, taking the magnification the *game* wants on top of the
 *  device-resolution one every camera already carries. */
export function setCameraZoom(
  camera: Phaser.Cameras.Scene2D.Camera,
  zoom: number,
): void {
  camera.setZoom(zoom * DPR);
}
