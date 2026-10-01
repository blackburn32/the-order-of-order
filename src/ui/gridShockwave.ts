import Phaser from "phaser";

/**
 * A shockwave rolling out from the seal across the grid each time the roll
 * callout lands a multiplier, sized by that multiplier's own factor: a ×2 is a
 * ripple, Lucky Seven's ×7 a wave. The dice swell as the front passes over
 * them, so the multiplier reads as something that happened to the whole table
 * rather than only to the number in the callout.
 *
 * The ring is drawn in grid-world coordinates inside the grid container, so the
 * grid camera clips it to the table — seen from the dice, the wave arrives from
 * the seal's side of the frame. Every wave shares one Graphics and one pass over
 * the dice per frame, however many overlap.
 */

/** A die the wave can lift — see DieSprite.poseLift. */
export interface Liftable {
  x: number;
  y: number;
  active: boolean;
  poseLift(amount: number): void;
}

export interface ShockwaveOptions {
  /** World units per screen pixel, so the ring keeps its on-screen weight at
   *  any grid zoom. */
  worldPerPixel: number;
  color: number;
  /** How far the wave has to travel to have crossed everything on screen. */
  reach: number;
}

interface Wave {
  x: number;
  y: number;
  startedAt: number;
  strength: number;
}

/** How long a wave takes to cross the whole grid. */
const CROSS_MS = 560;
/** The width of the swell around the front, in screen pixels. */
const FRONT_WIDTH_PX = 70;
/** The largest swell one wave gives a die, as a fraction of its size. */
const MAX_LIFT = 0.14;
/** Ceiling on the swell overlapping waves can add up to. */
const MAX_TOTAL_LIFT = 0.2;

export class GridShockwave {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly waves: Wave[] = [];
  private readonly lifted = new Set<Liftable>();
  private destroyed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    parent: Phaser.GameObjects.Container,
    private readonly dice: () => Iterable<Liftable>,
    private readonly options: ShockwaveOptions,
  ) {
    this.graphics = scene.add.graphics();
    this.graphics.setBlendMode(Phaser.BlendModes.ADD);
    parent.add(this.graphics);
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.draw, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
  }

  /** The object to hide from cameras that should not draw grid content. */
  get object(): Phaser.GameObjects.Graphics {
    return this.graphics;
  }

  get idle(): boolean {
    return this.waves.length === 0;
  }

  /**
   * Send a wave out from `origin` (grid-world). `factor` is the multiplier it
   * stands for; strength grows with its logarithm, so a ×7 reads as a much
   * bigger event than a ×2 without a ×1000 engine blowing the grid apart.
   */
  send(origin: { x: number; y: number }, factor: number): void {
    if (this.destroyed || !(factor > 1)) return;
    const strength = Phaser.Math.Clamp(Math.log(factor) / Math.log(7), 0.3, 1);
    this.waves.push({
      x: origin.x,
      y: origin.y,
      startedAt: this.scene.time.now,
      strength,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.draw, this);
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    this.settleDice();
    this.graphics.destroy();
  }

  private draw(): void {
    const now = this.scene.time.now;
    const { reach, worldPerPixel, color } = this.options;
    const speed = reach / CROSS_MS;
    const g = this.graphics;
    g.clear();

    for (let i = this.waves.length - 1; i >= 0; i--) {
      if (now - this.waves[i].startedAt > CROSS_MS * 1.25) {
        this.waves.splice(i, 1);
      }
    }
    if (this.waves.length === 0) {
      this.settleDice();
      return;
    }

    for (const wave of this.waves) {
      const t = (now - wave.startedAt) / CROSS_MS;
      const radius = Math.max(1, reach * t);
      const fade = Math.max(0, 1 - Math.max(0, t - 0.55) / 0.7);
      // A wide faint band, the ring itself, and a thin bright leading edge.
      g.lineStyle(
        worldPerPixel * 26 * wave.strength,
        color,
        0.12 * fade * wave.strength,
      );
      // Canvas throws on a negative radius, which the band trailing the
      // front would have for the wave's first few frames.
      g.strokeCircle(wave.x, wave.y, Math.max(0, radius - worldPerPixel * 10));
      g.lineStyle(worldPerPixel * 7, color, 0.55 * fade);
      g.strokeCircle(wave.x, wave.y, radius);
      g.lineStyle(worldPerPixel * 2, 0xffffff, 0.8 * fade);
      g.strokeCircle(wave.x, wave.y, radius + worldPerPixel * 2);
    }

    const width = FRONT_WIDTH_PX * worldPerPixel;
    for (const die of this.dice()) {
      if (!die.active) continue;
      let lift = 0;
      for (const wave of this.waves) {
        const front = speed * (now - wave.startedAt);
        const d = Math.hypot(die.x - wave.x, die.y - wave.y);
        const u = (d - front) / width;
        if (Math.abs(u) < 2.5)
          lift += MAX_LIFT * wave.strength * Math.exp(-u * u);
      }
      lift = Math.min(MAX_TOTAL_LIFT, lift);
      if (lift > 0.002) {
        die.poseLift(lift);
        this.lifted.add(die);
      } else if (this.lifted.delete(die)) {
        die.poseLift(0);
      }
    }
  }

  /** Put every die the waves touched back at its resting size. */
  private settleDice(): void {
    for (const die of this.lifted) if (die.active) die.poseLift(0);
    this.lifted.clear();
  }
}
