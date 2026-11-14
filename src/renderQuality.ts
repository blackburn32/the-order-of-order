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

const DEVICE_DPR = Math.min(
  (navigator.hardwareConcurrency ?? 8) <= LOW_CORE_COUNT
    ? LOW_END_MAX_DPR
    : MAX_DPR,
  Math.max(1, window.devicePixelRatio || 1),
);

/**
 * The player's Text Size setting (Settings, stored as `uiScale` in the
 * settings key): how much larger than designed the whole interface draws.
 *
 * It works by giving every scene a smaller viewport to lay out in — the page
 * divided by the scale — and enlarging the result to fill the page (see
 * `installUiScale`). Every scene already lays itself out from
 * `scale.width/height`, so text, buttons and touch targets all grow together
 * and nothing overlaps that would not at that smaller size. The backing store
 * stays at device resolution, so it costs no extra fill and stays sharp.
 *
 * Read once, at load, because every texture is baked at `DPR`; changing it
 * takes a restart. Capped so the layout viewport's short side stays at 320
 * CSS pixels or more, the smallest the layouts are drawn for.
 */
export const UI_SCALE_STEPS = [1, 1.15, 1.3, 1.5] as const;
const MIN_LAYOUT_SIDE = 320;

function storedUiScale(): number {
  try {
    const raw = localStorage.getItem("ooo_settings_v2");
    const value = raw
      ? Number((JSON.parse(raw) as { uiScale?: unknown }).uiScale)
      : 1;
    return Number.isFinite(value) ? value : 1;
  } catch {
    return 1;
  }
}

export const UI_SCALE = Math.max(
  1,
  Math.min(
    storedUiScale(),
    UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1],
    Math.min(window.innerWidth, window.innerHeight) / MIN_LAYOUT_SIDE,
  ),
);

/** Backing-store pixels per layout pixel: the device's density, times the
 *  interface scale. Everything that sizes the canvas, a camera or a baked
 *  texture goes through this one number. */
export const DPR = DEVICE_DPR * UI_SCALE;

/** Lay the game out in a viewport `UI_SCALE` times smaller than the page and
 *  enlarge it to fill the page. Run before the Game is created, so its first
 *  measurement is the scaled one. Phaser maps pointer positions through the
 *  canvas's on-screen rectangle, so input follows without help. */
export function installUiScale(parent: HTMLElement | null): void {
  if (!parent || UI_SCALE === 1) return;
  parent.style.width = `${100 / UI_SCALE}%`;
  parent.style.height = `${100 / UI_SCALE}%`;
  parent.style.transform = `scale(${UI_SCALE})`;
  parent.style.transformOrigin = "0 0";

  // Phaser measures its parent with getBoundingClientRect, which reports the
  // enlarged, on-screen size. The layout size is the one wanted: divide it
  // back out before Phaser compares it with what it has.
  const manager = Phaser.Scale.ScaleManager.prototype as unknown as {
    getParentBounds: (this: { parent?: HTMLElement }) => boolean;
  };
  const getParentBounds = manager.getParentBounds;
  manager.getParentBounds = function (this: { parent?: HTMLElement }) {
    const el = this.parent;
    if (!el) return getParentBounds.call(this);
    const measure = el.getBoundingClientRect;
    el.getBoundingClientRect = function (this: HTMLElement) {
      const rect = measure.call(this);
      return new DOMRect(
        rect.x,
        rect.y,
        rect.width / UI_SCALE,
        rect.height / UI_SCALE,
      );
    };
    try {
      return getParentBounds.call(this);
    } finally {
      delete (el as Partial<HTMLElement>).getBoundingClientRect;
    }
  };
}

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
  installPointerToCameraScaling();

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
  // RESIZE mode leaves the canvas with no CSS size at all, letting it default
  // to its (now device-pixel) attribute size. Pin it back to the CSS pixels the
  // Scale Manager laid out for.
  const styleWidth = `${game.scale.width}px`;
  const styleHeight = `${game.scale.height}px`;

  const resized = canvas.width !== width || canvas.height !== height;
  const restyled =
    canvas.style.width !== styleWidth || canvas.style.height !== styleHeight;
  if (!resized && !restyled) return;

  if (resized) {
    // Assigning either of these reallocates the drawing buffer, so it happens
    // only on a real change, never as a per-frame refresh.
    canvas.width = width;
    canvas.height = height;

    const renderer = game.renderer;
    if (renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer) {
      renderer.resize(width, height);
    }
  }

  canvas.style.width = styleWidth;
  canvas.style.height = styleHeight;
  syncInputBounds(game);
}

/**
 * Re-measure the canvas rectangle the Scale Manager converts DOM events
 * against, because the line above just invalidated it.
 *
 * `updateScale` writes `canvas.width/height` and nothing else: in stock Phaser
 * the attribute size *is* the layout size, so measuring straight afterwards in
 * `refresh` is sound. Pinning an explicit CSS size takes that over — the
 * measurement `refresh` already took this frame describes the canvas as it was
 * before the resize, leaving `canvasBounds` and `displayScale` a frame behind
 * every time the window changes shape.
 *
 * A stale box is wrong in two ways at once, because the canvas is centred in
 * its parent: presses are both offset by half the size change and scaled by the
 * ratio between the two sizes. Growing a phone viewport by the height of the
 * browser chrome lands a press a little off its control, which is why this
 * surfaces as a bug in the Fullscreen setting; a rotate lands it nowhere near.
 *
 * `refresh` would re-measure, but it also re-emits RESIZE to every scene, and
 * this runs from inside the render step. Redoing just the two lines that depend
 * on the canvas box is enough, and Phaser recomputes both the same way.
 */
function syncInputBounds(game: Phaser.Game): void {
  const scale = game.scale;
  scale.updateBounds();
  scale.displayScale.set(
    scale.baseSize.width / scale.canvasBounds.width,
    scale.baseSize.height / scale.canvasBounds.height,
  );
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

/**
 * Teach Phaser's input pipeline the unit split the comment above describes.
 *
 * Pointer positions arrive in layout pixels — the Scale Manager is deliberately
 * left in CSS pixels so that they do. But the two places where Phaser compares
 * a pointer against a camera assume both are measured the same way, and since
 * `ui/camera` puts every viewport in device pixels and magnifies by `DPR`, they
 * are not. Scaling the pointer on the way in is the whole correction:
 *
 * - `CameraManager.getCamerasBelowPointer` tests the pointer against each
 *   camera's viewport rectangle. A scrolling pane's camera sits `DPR` times
 *   further down the screen than the layout says, so the pane it belongs to
 *   would take input for a band near the top of the screen instead of its own.
 * - `Camera.getWorldPoint` is the single conversion behind `InputManager`'s
 *   hit test, `Pointer.worldX/worldY` and `positionToCamera`. Given layout
 *   pixels against a `DPR`-zoomed camera it returns a world point `DPR` times
 *   closer to the camera's top-left than the finger actually was — a press
 *   landing up and to the left of itself, by more the further down the screen
 *   it goes, and by different amounts across a portrait and a landscape layout
 *   because the same control sits at a different distance from the origin.
 *
 * Both keep layout-pixel signatures afterwards, so `pointer.worldX` and every
 * `setInteractive` hit area stay in the units the scenes lay themselves out in.
 */
let pointerScalingInstalled = false;

function installPointerToCameraScaling(): void {
  if (pointerScalingInstalled) return;
  pointerScalingInstalled = true;

  const cameraManager = Phaser.Cameras.Scene2D.CameraManager.prototype;
  const getCamerasBelowPointer = cameraManager.getCamerasBelowPointer;
  // Only `x` and `y` are read off the pointer, so a scaled stand-in is enough
  // to reuse Phaser's own visible/inputEnabled/viewport tests unchanged.
  const scaled = { x: 0, y: 0 } as unknown as Phaser.Input.Pointer;

  cameraManager.getCamerasBelowPointer = function (
    this: Phaser.Cameras.Scene2D.CameraManager,
    pointer: Phaser.Input.Pointer,
  ): Phaser.Cameras.Scene2D.Camera[] {
    scaled.x = pointer.x * DPR;
    scaled.y = pointer.y * DPR;
    return getCamerasBelowPointer.call(this, scaled);
  };

  // Declared on BaseCamera and not overridden by Camera, so the one patch
  // covers every camera in the game.
  const baseCamera = Phaser.Cameras.Scene2D.BaseCamera.prototype;
  const getWorldPoint = baseCamera.getWorldPoint;

  baseCamera.getWorldPoint = function <O extends Phaser.Math.Vector2>(
    this: Phaser.Cameras.Scene2D.BaseCamera,
    x: number,
    y: number,
    output?: O,
  ): O {
    return getWorldPoint.call(this, x * DPR, y * DPR, output) as O;
  };
}
