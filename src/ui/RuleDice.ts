import Phaser from 'phaser';
import { COLORS } from '../art/palette';
import { fx } from '../systems/Effects';

/**
 * The dice shown on the masthead rule, left to right: d4, d6, d8. Each is the
 * bare silhouette of its die type — the same shape language `buildDice` uses
 * for the real dice, down to the octagon's half-step rotation.
 *
 * `radiusRatio` trades off against the polygon's area: at a shared circumradius
 * a triangle carries barely half the ink an octagon does and reads as the runt
 * of the row, so the smaller shapes are grown to even them out by eye.
 */
const SHAPES = [
  { sides: 3, rotationDeg: -90, radiusRatio: 1.25 }, // d4
  { sides: 4, rotationDeg: -45, radiusRatio: 1.12 }, // d6
  { sides: 8, rotationDeg: -112.5, radiusRatio: 1.0 } // d8
];

/** Mean gap between rolls, and how far either side of it a gap may land. */
const ROLL_INTERVAL_MS = 8000;
const ROLL_JITTER_MS = 1000;

/** How long one shape takes to come back around. */
const ROLL_MS = 620;

/** Centre-to-centre spacing, as a multiple of a shape's nominal size. */
const SPACING_RATIO = 1.6;

/** Matches the lozenge this row replaced, so the ornament still reads as part
 *  of the rule rather than as three objects sitting on it. */
const SHAPE_ALPHA = 0.75;

/**
 * The row of die-shaped marks set into the menu's masthead rule.
 *
 * Every eight seconds or so one of them rolls — a single decelerating turn
 * through a full circle. Which one is random, except that it's never the one
 * that went last: back-to-back repeats read as a stuck animation rather than
 * as chance.
 */
export class RuleDice extends Phaser.GameObjects.Container {
  private shapes: Phaser.GameObjects.Container[] = [];
  private lastRolled = -1;
  private nextRoll?: Phaser.Time.TimerEvent;

  constructor(scene: Phaser.Scene, x: number, y: number, size: number) {
    super(scene, x, y);

    const spacing = size * SPACING_RATIO;
    const offset = (SHAPES.length - 1) / 2;

    SHAPES.forEach((shape, i) => {
      // Each mark gets its own container so the spin has something to turn
      // that isn't the graphics' own coordinate space — the points are baked
      // around a local origin of (0, 0), which is exactly what makes the
      // rotation land on the shape's centre.
      const holder = scene.add.container((i - offset) * spacing, 0);
      const g = scene.add.graphics();
      g.fillStyle(COLORS.gold, SHAPE_ALPHA);
      g.fillPoints(polygonPoints((size / 2) * shape.radiusRatio, shape.sides, shape.rotationDeg), true);
      holder.add(g);
      this.add(holder);
      this.shapes.push(holder);
    });

    // Lets the caller break its rule around the row without re-deriving the
    // spacing arithmetic.
    this.setSize(spacing * (SHAPES.length - 1) + size, size);

    if (fx.motion) this.scheduleNext();
    scene.add.existing(this);
  }

  private scheduleNext(): void {
    const delay = ROLL_INTERVAL_MS + Phaser.Math.Between(-ROLL_JITTER_MS, ROLL_JITTER_MS);
    this.nextRoll = this.scene.time.delayedCall(delay, () => {
      this.roll();
      this.scheduleNext();
    });
  }

  private roll(): void {
    // Any shape but the one that went last.
    const candidates = this.shapes.map((_, i) => i).filter((i) => i !== this.lastRolled);
    const index = candidates[Phaser.Math.Between(0, candidates.length - 1)];
    this.lastRolled = index;

    const holder = this.shapes[index];
    this.scene.tweens.killTweensOf(holder);
    holder.setRotation(0);
    this.scene.tweens.add({
      targets: holder,
      rotation: Math.PI * 2,
      duration: ROLL_MS,
      ease: 'Cubic.easeOut',
      // A full turn ends where it started, but leaving the rotation at 2π
      // would make the next roll's `setRotation(0)` snap visibly.
      onComplete: () => holder.setRotation(0)
    });
  }

  /** The scheduled roll and an in-flight spin both outlive a plain container
   *  destroy, and `responsive` rebuilds the menu by destroying the display
   *  list without shutting the scene down — so nothing else clears them. */
  override destroy(fromScene?: boolean): void {
    this.nextRoll?.remove();
    this.nextRoll = undefined;
    for (const holder of this.shapes) this.scene?.tweens.killTweensOf(holder);
    this.shapes = [];
    super.destroy(fromScene);
  }
}

/**
 * Regular-polygon vertices around a local origin of (0, 0), recentred on the
 * shape's own bounding box.
 *
 * Vertices generated from a circumradius are centred on the circumcentre,
 * which for an odd-sided polygon is not where the ink looks centred: a
 * point-up triangle hangs a full quarter of its radius below its circumcentre,
 * so leaving it uncorrected sits it visibly high of the rule and of its two
 * neighbours. The even-sided shapes are already symmetric and shift by zero.
 */
function polygonPoints(radius: number, sides: number, rotationDeg: number): Phaser.Math.Vector2[] {
  const points: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = Phaser.Math.DegToRad(rotationDeg + (360 / sides) * i);
    points.push(new Phaser.Math.Vector2(radius * Math.cos(angle), radius * Math.sin(angle)));
  }

  const ys = points.map((p) => p.y);
  const shiftY = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const point of points) point.y -= shiftY;
  return points;
}
