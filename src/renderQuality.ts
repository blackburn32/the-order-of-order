import Phaser from "phaser";

/**
 * Core count at or below which a device is assumed unable to carry filter
 * passes and particle systems. Current phones report 8; the budget hardware
 * that actually struggles reports 4 or fewer.
 */
const LOW_CORE_COUNT = 4;

/**
 * Device pixels per CSS pixel, which is the factor the canvas backing store
 * has to be sized by for the game not to be a browser upscale of a low-res
 * image on a phone. Phaser's RESIZE mode sizes the canvas in CSS pixels and
 * gives the element no explicit CSS size, so without this the whole game is
 * drawn at 1x and stretched over 2-3.5x as many physical pixels — soft edges
 * everywhere and mushy text. `installHiDpi` is what actually applies it.
 *
 * Capped, because the cost is quadratic: a 3x buffer is nine times the
 * fragments of a 1x one. Three is the ceiling on capable hardware (past it the
 * gain is invisible at arm's length), two on the same low-core devices that
 * lose filter passes below.
 */
const MAX_DPR = 3;
const LOW_END_MAX_DPR = 2;

export const DPR = Math.min(
  (navigator.hardwareConcurrency ?? 8) <= LOW_CORE_COUNT
    ? LOW_END_MAX_DPR
    : MAX_DPR,
  Math.max(1, window.devicePixelRatio || 1),
);

/**
 * Resolution used by Phaser's internal Text canvases. Scenes lay text out in
 * CSS pixels and the cameras magnify by `DPR` (see `ui/camera`), so a glyph
 * asked for at 18px is resolved onto `18 * DPR` real pixels — anything less
 * here and text is the softest layer on the screen.
 */
export const TEXTURE_RESOLUTION = DPR;

/**
 * How much visual flourish the hardware can afford. This is a *capability*
 * ceiling, not a preference: the player's own Visual Effects setting gates
 * everything on top of it (see `systems/Effects`).
 *
 * - `full`  — WebGL plus cores to spare. Filter passes (glow, shine), particle
 *   bursts, and continuously animated background art are all in budget.
 * - `basic` — a Canvas fallback or a low-core device. Tween- and tint-driven
 *   feedback only; nothing that costs an extra draw call per object.
 */
export type EffectsTier = "basic" | "full";

/**
 * Resolve the effect ceiling for this device. Takes the renderer type actually
 * in use rather than the one requested in the Game config — Phaser falls back
 * to Canvas when WebGL is unavailable, and Phaser 4's filters and particle
 * renderer are WebGL-only, so on that path the budget genuinely isn't there.
 */
export function detectEffectsTier(renderType: number): EffectsTier {
  if (renderType !== Phaser.WEBGL) return "basic";
  const cores = navigator.hardwareConcurrency ?? 8;
  return cores <= LOW_CORE_COUNT ? "basic" : "full";
}

/**
 * The OS-level "reduce motion" accessibility preference. Kept separate from the
 * tier because it constrains a different axis: the tier says what the hardware
 * can draw, this says what the player wants moving. Effects gates shake, drift,
 * and tumble jitter on it while leaving still feedback (count-ups, tints) on.
 */
export function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

/**
 * Phaser 4.2 creates Text textures at resolution 1 unless every TextStyle opts
 * in separately. Install one default before the Game creates its Scene
 * factories, while continuing to respect deliberate per-object overrides.
 */
export function installHighResolutionText(): void {
  const factory = Phaser.GameObjects.GameObjectFactory.prototype;
  const createText = factory.text;

  factory.text = function (
    this: Phaser.GameObjects.GameObjectFactory,
    x: number,
    y: number,
    text: string | string[],
    style: Phaser.Types.GameObjects.Text.TextStyle = {},
  ): Phaser.GameObjects.Text {
    return createText.call(this, x, y, text, {
      ...style,
      resolution: style.resolution ?? TEXTURE_RESOLUTION,
    });
  };
}

/**
 * Render at device resolution while every scene keeps laying itself out in CSS
 * pixels.
 *
 * Phaser 4 has no game-level `resolution`: world units *are* canvas pixels, and
 * three separate places enforce it — the renderer takes both its projection
 * matrix and its GL viewport from `scale.baseSize`, camera scissor boxes are
 * pushed to GL in raw camera units, and a camera carrying a filter allocates
 * its framebuffer at `camera.width x camera.height`. So the canvas cannot
 * simply be enlarged underneath an unchanged world.
 *
 * The split used here puts the seam at the camera instead:
 *
 * - The Scale Manager stays entirely in CSS pixels. `scale.width/height`, the
 *   `displayScale` that converts DOM events into game coordinates, and so every
 *   layout number and every `pointer.x/y` in the game mean the same thing they
 *   did before.
 * - The canvas backing store, the GL viewport and every camera viewport are in
 *   device pixels, and each camera magnifies by `DPR` from an origin of (0, 0)
 *   so that a camera's `scrollX/Y` still names the world point at the top-left
 *   of its viewport.
 *
 * The result is a uniform `DPR` blow-up of exactly the layout the game already
 * had, drawn at full device resolution.
 */
export function installHiDpi(game: Phaser.Game): void {
  // Sizes drift back out of step on their own — Phaser's RESIZE mode rewrites
  // `canvas.width` to CSS pixels on every refresh, `CameraManager` recreates a
  // CSS-sized main camera whenever a scene starts or restarts, and a lost WebGL
  // context restores the renderer to `scale.baseSize`. Rather than chase each of
  // those with its own listener, reconcile once per frame before anything is
  // drawn. Every check below is an integer compare against a live property.
  game.events.on(Phaser.Core.Events.PRE_RENDER, () => {
    const width = Math.round(game.scale.width * DPR);
    const height = Math.round(game.scale.height * DPR);
    syncCanvas(game, width, height);
    for (const scene of game.scene.scenes) syncMainCamera(scene, width, height);
  });
}

function syncCanvas(game: Phaser.Game, width: number, height: number): void {
  const canvas = game.canvas;
  if (canvas.width === width && canvas.height === height) return;

  // Assigning either of these reallocates the drawing buffer, so it happens
  // only on a real change, never as a per-frame refresh.
  canvas.width = width;
  canvas.height = height;
  // RESIZE mode leaves the canvas with no CSS size at all, letting it default
  // to its (now device-pixel) attribute size. Pin it back to the CSS pixels the
  // Scale Manager laid out for.
  canvas.style.width = `${game.scale.width}px`;
  canvas.style.height = `${game.scale.height}px`;

  const renderer = game.renderer;
  if (renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer) {
    renderer.resize(width, height);
  }
}

function syncMainCamera(
  scene: Phaser.Scene,
  width: number,
  height: number,
): void {
  const camera = scene.sys?.cameras?.main;
  if (!camera) return;
  if (
    camera.width === width &&
    camera.height === height &&
    camera.zoomX === DPR &&
    camera.originX === 0 &&
    camera.originY === 0
  ) {
    return;
  }
  camera.setSize(width, height);
  camera.setOrigin(0, 0);
  camera.setZoom(DPR);
}
