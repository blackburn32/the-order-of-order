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
