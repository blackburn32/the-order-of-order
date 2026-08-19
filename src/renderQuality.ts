import Phaser from "phaser";

/**
 * Resolution used by Phaser's internal Text canvases. Two is a useful upper
 * bound on mobile: it materially sharpens text that is scaled by a Container or
 * Camera without the texture-memory cost of rendering at a phone's full 3x/4x
 * device pixel ratio.
 */
export const TEXTURE_RESOLUTION = Math.min(
  2,
  Math.max(1, window.devicePixelRatio || 1),
);

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
 * Core count at or below which a device is assumed unable to carry filter
 * passes and particle systems. Current phones report 8; the budget hardware
 * that actually struggles reports 4 or fewer.
 */
const LOW_CORE_COUNT = 4;

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
