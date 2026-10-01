import Phaser from "phaser";

/**
 * A spotlight on the dice an effect paid for standing alone — Counterpoint's
 * and A New Voice's unmatched faces, The Canticle's unrepeated ones. It is the
 * inverse of chain lightning: where the chain says "these dice did it
 * together", the spotlight says "this one stood apart", so the lone dice are
 * lit from above while every other die on screen dims for a beat.
 *
 * Drawn in grid-world coordinates into the grid container above the dice, so it
 * pans, zooms and shakes with the table. Two Graphics carry the whole effect —
 * one for the shade over the crowd, one additive for the light — redrawn per
 * frame while it lives, so its cost does not grow with the number of dice lit.
 */

export interface SpotlightOptions {
  /** A die's drawn edge length in world units, which the halo, the beam and
   *  the shade over each other die are all measured in. */
  dieSize: number;
  color: number;
  /** Whether the halo may breathe. Off under reduced motion: the light simply
   *  comes up and goes down again. */
  motion: boolean;
}

type Point = { x: number; y: number };

/** How long the shade takes to fall and the light to come up. */
const RISE_MS = 140;
/** When the light starts to go, from the start. */
const HOLD_UNTIL_MS = 560;
/** When it has gone. */
const END_MS = 900;
/** How dark the crowd goes at the height of the effect. */
const SHADE_ALPHA = 0.55;
const SHADE_COLOR = 0x07050d;
/** How far above a lit die its beam starts, in die sizes. */
const BEAM_HEIGHT = 3.2;

export class Spotlight {
  private readonly shade: Phaser.GameObjects.Graphics;
  private readonly light: Phaser.GameObjects.Graphics;
  private readonly startedAt: number;
  private destroyed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    parent: Phaser.GameObjects.Container,
    private readonly lit: Point[],
    private readonly crowd: Point[],
    private readonly options: SpotlightOptions,
  ) {
    this.shade = scene.add.graphics();
    this.light = scene.add.graphics();
    this.light.setBlendMode(Phaser.BlendModes.ADD);
    parent.add([this.shade, this.light]);
    this.startedAt = scene.time.now;
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.draw, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    this.draw();
  }

  /** The objects to hide from cameras that should not draw grid content. */
  get objects(): Phaser.GameObjects.GameObject[] {
    return [this.shade, this.light];
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.draw, this);
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    this.shade.destroy();
    this.light.destroy();
  }

  private draw(): void {
    const elapsed = this.scene.time.now - this.startedAt;
    if (elapsed >= END_MS) {
      this.destroy();
      return;
    }
    const level =
      elapsed < RISE_MS
        ? Phaser.Math.Easing.Quadratic.Out(elapsed / RISE_MS)
        : elapsed < HOLD_UNTIL_MS
          ? 1
          : 1 -
            Phaser.Math.Easing.Quadratic.In(
              (elapsed - HOLD_UNTIL_MS) / (END_MS - HOLD_UNTIL_MS),
            );
    const size = this.options.dieSize;
    const color = this.options.color;

    // The crowd: a dark card laid over every die that did not stand alone,
    // rather than a veil over the whole grid with holes cut in it — Graphics
    // cannot cut holes, and this leaves the felt between the dice untouched.
    const shade = this.shade;
    shade.clear();
    shade.fillStyle(SHADE_COLOR, SHADE_ALPHA * level);
    const cover = size * 0.98;
    for (const die of this.crowd) {
      shade.fillRoundedRect(
        die.x - cover / 2,
        die.y - cover / 2,
        cover,
        cover,
        size * 0.16,
      );
    }

    const light = this.light;
    light.clear();
    const breathe = this.options.motion
      ? 1 + 0.05 * Math.sin((elapsed / 1000) * Math.PI * 4)
      : 1;
    for (const die of this.lit) {
      // A soft beam from above, laid down in widening passes so it reads as a
      // cone of light with a bright core. It stops at the die's top edge, so
      // the face it is lighting stays legible.
      const top = die.y - size * BEAM_HEIGHT;
      const foot = die.y - size * 0.5;
      for (const [topHalf, footHalf, alpha] of [
        [0.34, 0.66, 0.05],
        [0.22, 0.5, 0.06],
        [0.1, 0.32, 0.07],
      ] as const) {
        light.fillStyle(color, alpha * level);
        light.fillPoints(
          [
            new Phaser.Math.Vector2(die.x - size * topHalf, top),
            new Phaser.Math.Vector2(die.x + size * topHalf, top),
            new Phaser.Math.Vector2(die.x + size * footHalf, foot),
            new Phaser.Math.Vector2(die.x - size * footHalf, foot),
          ],
          true,
        );
      }
      // The halo: rings hugging the die's outline, fading outward.
      for (const [grow, width, alpha] of [
        [1.06, 0.05, 0.9],
        [1.16, 0.06, 0.45],
        [1.3, 0.08, 0.2],
      ] as const) {
        const edge = size * grow * breathe;
        light.lineStyle(size * width, color, alpha * level);
        light.strokeRoundedRect(
          die.x - edge / 2,
          die.y - edge / 2,
          edge,
          edge,
          size * 0.18 * grow,
        );
      }
    }
  }
}
