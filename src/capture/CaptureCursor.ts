import Phaser from "phaser";
import { COLORS } from "../art/palette";

/** How long the pointer dips into a press, and back out of it. */
const PRESS_DIP_MS = 90;
/** The ring a press leaves behind. */
const RIPPLE_MS = 420;
const RIPPLE_RADIUS = 38;

/** The arrow, drawn once at this size and scaled to taste. Points run from the
 *  tip clockwise: the two shoulders, the notch between the barbs, then the tail
 *  barb and back up the left edge. */
const ARROW: readonly [number, number][] = [
  [0, 0],
  [0, 21.5],
  [5.4, 16.4],
  [8.9, 25],
  [13.1, 23.2],
  [9.6, 14.8],
  [16.4, 14.2],
];
/** Drawn large. The reel is watched as a small embedded loop on a landing page,
 *  where a pointer at its true on-screen size disappears. */
const ARROW_SCALE = 1.95;

/** A pointer drawn into the game canvas, in a scene of its own.
 *
 *  It has to be its own scene rather than an object in the one it is pointing
 *  at: the shop wipes and rebuilds its entire display list on every purchase and
 *  every reroll, which would take the cursor with it. A scene above the shop
 *  also puts the pointer over the booster overlay without competing for depth.
 *
 *  A recorder captures the game canvas alone, so a real mouse cursor — or any
 *  DOM element over the canvas — would not appear in the clip at all. */
export class CaptureCursorScene extends Phaser.Scene {
  private pointer!: Phaser.GameObjects.Container;
  private ripples!: Phaser.GameObjects.Container;

  constructor() {
    super("CaptureCursor");
  }

  create(): void {
    this.ripples = this.add.container(0, 0);
    this.pointer = this.add.container(0, 0, [
      // A soft dark copy offset under the arrow lifts it off both the felt and
      // a parchment card, neither of which it can be sure to contrast with.
      this.arrow(3, 4, 0x000000, 0.38, false),
      // Ivory rather than parchment: the pointer spends half the reel over the
      // cards, which are parchment, and has to stay a separate object from them.
      this.arrow(0, 0, COLORS.ivory, 1, true),
    ]);
    this.pointer.setVisible(false);
  }

  /** Put the pointer somewhere with no travel — the pose a clip starts from. */
  park(x: number, y: number): void {
    this.tweens.killTweensOf(this.pointer);
    this.pointer.setPosition(x, y).setScale(1).setVisible(true);
  }

  /** Carry the pointer over to a target along a shallow arc. A straight line
   *  between two buttons reads as a machine moving a sprite; the bow, and the
   *  ease in and out of rest, read as a hand. */
  moveTo(x: number, y: number, durationMs: number): Promise<void> {
    const from = { x: this.pointer.x, y: this.pointer.y };
    if (!this.pointer.visible) {
      this.park(x, y);
      return Promise.resolve();
    }
    const dx = x - from.x;
    const dy = y - from.y;
    const distance = Math.hypot(dx, dy);
    // Bow the path to the side, capped so a long reach across the shop does not
    // swing out of frame.
    const bow = Math.min(46, distance * 0.16);
    const path = new Phaser.Curves.QuadraticBezier(
      new Phaser.Math.Vector2(from.x, from.y),
      new Phaser.Math.Vector2(
        (from.x + x) / 2 - (dy / (distance || 1)) * bow,
        (from.y + y) / 2 + (dx / (distance || 1)) * bow,
      ),
      new Phaser.Math.Vector2(x, y),
    );
    const at = new Phaser.Math.Vector2();
    return new Promise((resolve) => {
      this.tweens.addCounter({
        from: 0,
        to: 1,
        duration: durationMs,
        ease: "Sine.easeInOut",
        onUpdate: (tween) => {
          path.getPoint(tween.getValue() ?? 0, at);
          this.pointer.setPosition(at.x, at.y);
        },
        onComplete: () => resolve(),
      });
    });
  }

  /** Dip the pointer and leave a ring behind it, on the frame the press lands. */
  press(): void {
    if (!this.pointer.visible) return;
    this.tweens.killTweensOf(this.pointer);
    this.tweens.add({
      targets: this.pointer,
      scaleX: 0.84,
      scaleY: 0.84,
      duration: PRESS_DIP_MS,
      yoyo: true,
      ease: "Quad.easeOut",
    });

    const ring = this.add
      .circle(this.pointer.x, this.pointer.y, 6)
      .setStrokeStyle(2.5, COLORS.goldLight, 0.95);
    this.ripples.add(ring);
    this.tweens.add({
      targets: ring,
      radius: RIPPLE_RADIUS,
      alpha: 0,
      duration: RIPPLE_MS,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  private arrow(
    dx: number,
    dy: number,
    color: number,
    alpha: number,
    outline: boolean,
  ): Phaser.GameObjects.Graphics {
    const g = this.add.graphics({ x: dx, y: dy });
    g.fillStyle(color, alpha);
    if (outline) g.lineStyle(1.4, COLORS.ink, 0.95);
    g.beginPath();
    ARROW.forEach(([x, y], index) => {
      const px = x * ARROW_SCALE;
      const py = y * ARROW_SCALE;
      if (index === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    });
    g.closePath();
    g.fillPath();
    if (outline) g.strokePath();
    return g;
  }
}
