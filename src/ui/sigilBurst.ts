import Phaser from "phaser";

/**
 * The Order's sigil flaring off a die that rolled its top face — Windfall's and
 * Royal Seal's dice. It is the sigil turning behind the table, stamped over the
 * die and swelling outward as it turns and fades, so the moment reads as the
 * table itself answering the roll.
 *
 * Drawn here rather than taken from the sigil textures: those are inked for a
 * backdrop hundreds of pixels across, and shrunk to a die their lines fall
 * under a pixel wide. One Graphics carries every burst of a roll, in grid-world
 * coordinates inside the grid container, so it pans, zooms and shakes with the
 * table. The caller hands it only the dice that are pulsing this roll, which
 * bounds how many there can ever be.
 */

export interface SigilBurstOptions {
  /** A die's drawn edge length in world units; every radius and line weight
   *  is measured in it. */
  dieSize: number;
  color: number;
  /** Whether the sigil may swell and turn. Off under reduced motion: it holds
   *  its size and simply fades. */
  motion: boolean;
}

/** How long one burst lasts. */
const BURST_MS = 620;
/** Stagger between bursts, so several at once ripple rather than flash. */
const STAGGER_MS = 45;
const MAX_STAGGER_MS = 220;
/** The sigil's outer radius at the start and end of a burst, in die sizes. */
const FROM_RADIUS = 0.42;
const TO_RADIUS = 1.05;
const TICKS = 12;

interface Burst {
  x: number;
  y: number;
  startMs: number;
  spin: number;
}

export class SigilBurst {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly bursts: Burst[];
  private readonly startedAt: number;
  private readonly endsAt: number;
  private destroyed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    parent: Phaser.GameObjects.Container,
    points: { x: number; y: number }[],
    private readonly options: SigilBurstOptions,
  ) {
    this.graphics = scene.add.graphics();
    parent.add(this.graphics);
    this.bursts = points.map((point, index) => ({
      ...point,
      startMs: Math.min(MAX_STAGGER_MS, index * STAGGER_MS),
      // Each sigil starts at its own angle and some turn the other way, so a
      // handful at once do not read as one stamp copied about.
      spin: index % 2 === 0 ? 1 : -1,
    }));
    this.startedAt = scene.time.now;
    this.endsAt =
      Math.max(0, ...this.bursts.map((burst) => burst.startMs)) + BURST_MS;
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.draw, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    this.draw();
  }

  /** The object to hide from cameras that should not draw grid content. */
  get object(): Phaser.GameObjects.Graphics {
    return this.graphics;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.draw, this);
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    this.graphics.destroy();
  }

  private draw(): void {
    const elapsed = this.scene.time.now - this.startedAt;
    if (elapsed >= this.endsAt) {
      this.destroy();
      return;
    }
    const g = this.graphics;
    g.clear();
    const { dieSize: size, color, motion } = this.options;
    for (const burst of this.bursts) {
      const t = (elapsed - burst.startMs) / BURST_MS;
      if (t < 0 || t >= 1) continue;
      const grow = motion ? Phaser.Math.Easing.Cubic.Out(t) : 0.5;
      const radius = size * (FROM_RADIUS + (TO_RADIUS - FROM_RADIUS) * grow);
      // A bright stamp that holds for a moment, then fades as it spreads.
      const alpha =
        t < 0.15 ? 1 : 1 - Phaser.Math.Easing.Quadratic.In((t - 0.15) / 0.85);
      const angle =
        burst.spin * (burst.startMs / 100 + (motion ? 0.9 * grow : 0));
      drawSigil(g, burst.x, burst.y, radius, angle, size, color, alpha);
    }
  }
}

/** The sigil's figure: a double ring, a tick ring between them, and a
 *  hexagram inside — the table's own sigil, simplified to read at die size. */
function drawSigil(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  angle: number,
  size: number,
  color: number,
  alpha: number,
): void {
  const heavy = size * 0.045;
  const light = size * 0.025;

  // A soft wide pass under the figure, so it carries over a pale die face as
  // well as over the felt.
  g.lineStyle(heavy * 3, color, 0.18 * alpha);
  g.strokeCircle(x, y, radius);

  g.lineStyle(heavy, color, 0.95 * alpha);
  g.strokeCircle(x, y, radius);
  g.lineStyle(light, color, 0.7 * alpha);
  g.strokeCircle(x, y, radius * 0.86);

  for (let i = 0; i < TICKS; i++) {
    const a = angle + (Math.PI * 2 * i) / TICKS;
    const inner = i % 3 === 0 ? 0.74 : 0.8;
    g.lineStyle(i % 3 === 0 ? heavy : light, color, 0.85 * alpha);
    g.lineBetween(
      x + Math.cos(a) * radius * inner,
      y + Math.sin(a) * radius * inner,
      x + Math.cos(a) * radius * 0.86,
      y + Math.sin(a) * radius * 0.86,
    );
  }

  g.lineStyle(light, color, 0.8 * alpha);
  for (const offset of [-Math.PI / 2, Math.PI / 2]) {
    const points: Phaser.Math.Vector2[] = [];
    for (let i = 0; i < 3; i++) {
      const a = angle + offset + (Math.PI * 2 * i) / 3;
      points.push(
        new Phaser.Math.Vector2(
          x + Math.cos(a) * radius * 0.66,
          y + Math.sin(a) * radius * 0.66,
        ),
      );
    }
    g.strokePoints(points, true, true);
  }
}
