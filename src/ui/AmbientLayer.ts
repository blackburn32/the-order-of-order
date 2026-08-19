import Phaser from "phaser";
import { COLORS } from "../art/palette";
import { SIGIL_INK_RADIUS, SIGIL_RING_INNER_INK_RADIUS } from "../art/textures";
import { fx } from "../systems/Effects";

/** Motes drifting behind the dice. Small enough a phone won't notice them,
 *  enough that the table never looks like a flat fill. */
const MOTE_COUNT = 14;

/** How much of the grid viewport's shorter side the sigil spans. */
const SIGIL_FRACTION = 0.92;

/** Sigil opacity at an empty score and at the round's target. */
const SIGIL_ALPHA_IDLE = 0.05;
const SIGIL_ALPHA_MET = 0.2;

/** Clear felt between the sigil's outermost stroke and the ring's innermost
 *  one, in screen pixels. */
const RING_GAP = 80;

/** How long the outer ring takes to come back around, and the inner sigil's
 *  own period. Deliberately not equal: with the ring already turning against
 *  the sigil, matching periods would make the pair read as one rigid object
 *  reflected, where a slower outer sweep reads as two independent mechanisms. */
const SIGIL_SPIN_MS = 120_000;
const RING_SPIN_MS = 165_000;

export interface AmbientOptions {
  /** Draw the outer ring as well, enclosing the sigil in a counter-turning
   *  band. Off by default: in-game the layer sits inside the grid viewport,
   *  where a second ring would be mostly cropped away. */
  ring?: boolean;
}

/**
 * The living backdrop behind the dice grid: a slowly turning sigil, optionally
 * enclosed by a counter-turning outer ring, plus a scatter of drifting motes.
 *
 * Both are driven by round progress rather than being pure decoration — the
 * sigil brightens and spins faster as the score climbs toward the round's
 * target, and turns red once the last roll arrives with the target still out
 * of reach. The player reads how the round is going from the background
 * without looking at the HUD.
 *
 * **Why this lives inside the grid container.** The grid is drawn by its own
 * camera, which paints an opaque felt backdrop over the whole grid area (see
 * `GameScene.ensureGridCamera`) — anything behind that camera is invisible
 * there. So the layer is parented to the grid container, and `GameScene`
 * re-anchors it to the camera's world centre at the inverse of its zoom on
 * every pan/zoom step, which keeps it pinned and constant-sized on screen
 * while the dice scroll past it.
 */
export class AmbientLayer extends Phaser.GameObjects.Container {
  private sigil: Phaser.GameObjects.Image;
  private ring?: Phaser.GameObjects.Image;
  private motes: Phaser.GameObjects.Image[] = [];
  private spin?: Phaser.Tweens.Tween;
  private ringSpin?: Phaser.Tweens.Tween;
  private areaW = 0;
  private areaH = 0;

  constructor(scene: Phaser.Scene, options: AmbientOptions = {}) {
    super(scene, 0, 0);

    this.sigil = scene.add
      .image(0, 0, "sigil")
      .setTint(COLORS.gold)
      .setAlpha(SIGIL_ALPHA_IDLE);
    this.add(this.sigil);

    if (options.ring) {
      this.ring = scene.add
        .image(0, 0, "sigil-ring")
        .setTint(COLORS.gold)
        .setAlpha(SIGIL_ALPHA_IDLE);
      this.add(this.ring);
    }

    if (fx.rich) {
      for (let i = 0; i < MOTE_COUNT; i++) {
        const mote = scene.add
          .image(0, 0, "spark")
          .setTint(COLORS.glow)
          .setBlendMode(Phaser.BlendModes.ADD);
        this.motes.push(mote);
        this.add(mote);
      }
    }

    // A still sigil still adds depth, so the basic tier keeps it — only the
    // rotation and the drift, which cost a tween each per frame, are held back
    // for hardware (and players) that can carry them.
    if (fx.rich && fx.motion) {
      this.spin = scene.tweens.add({
        targets: this.sigil,
        rotation: Math.PI * 2,
        duration: SIGIL_SPIN_MS,
        repeat: -1,
        ease: "Linear",
      });
      if (this.ring) {
        this.ringSpin = scene.tweens.add({
          targets: this.ring,
          rotation: -Math.PI * 2,
          duration: RING_SPIN_MS,
          repeat: -1,
          ease: "Linear",
        });
      }
    }

    scene.add.existing(this);
  }

  /** Size the layer to the grid viewport, in screen pixels. Called on the
   *  first layout and on every resize. */
  setArea(width: number, height: number): void {
    // Called from every pan and zoom step, where the area hasn't changed —
    // re-scattering there would restart every mote tween several times a frame.
    if (width === this.areaW && height === this.areaH) return;
    this.areaW = width;
    this.areaH = height;
    const span = Math.min(width, height) * SIGIL_FRACTION;
    this.sigil.setDisplaySize(span, span);
    if (this.ring) {
      // Size the ring from the gap outwards rather than from the viewport
      // inwards: what has to hold at every width is the band of clear felt
      // between the two, so solve for the display size that puts the ring's
      // innermost stroke exactly RING_GAP beyond the sigil's outermost one.
      // On a landscape viewport that pushes the ring's top and bottom past the
      // edges — intended, it frames the screen there and closes at the corners.
      const ringSpan = (span * SIGIL_INK_RADIUS + RING_GAP * 2) / SIGIL_RING_INNER_INK_RADIUS;
      this.ring.setDisplaySize(ringSpan, ringSpan);
    }
    this.scatterMotes();
  }

  /**
   * Report how the round is going. `progress` is score over the round's target,
   * clamped to 0..1; `danger` means the rolls have run out with the target
   * unmet, which recolours the whole layer.
   */
  setProgress(progress: number, danger: boolean): void {
    const p = Phaser.Math.Clamp(progress, 0, 1);
    // Ease the alpha so the last stretch before the target is where the
    // background visibly comes alive, rather than creeping up linearly.
    const eased = p * p;
    const alpha = SIGIL_ALPHA_IDLE + (SIGIL_ALPHA_MET - SIGIL_ALPHA_IDLE) * eased;
    this.sigil.setAlpha(alpha);
    this.sigil.setTint(danger ? COLORS.waxRed : COLORS.gold);
    this.ring?.setAlpha(alpha).setTint(danger ? COLORS.waxRed : COLORS.gold);
    for (const mote of this.motes) {
      mote.setTint(danger ? COLORS.waxRed : COLORS.glow);
    }
    // Retiming the running tween beats restarting it: the sigil accelerates
    // smoothly from wherever it currently is instead of snapping to a new
    // rotation each time the score changes.
    if (this.spin) this.spin.timeScale = 1 + eased * 4;
    if (this.ringSpin) this.ringSpin.timeScale = 1 + eased * 4;
  }

  private scatterMotes(): void {
    if (this.motes.length === 0) return;
    const halfW = this.areaW / 2;
    const halfH = this.areaH / 2;
    for (const mote of this.motes) {
      this.scene.tweens.killTweensOf(mote);
      const x = Phaser.Math.FloatBetween(-halfW, halfW);
      const y = Phaser.Math.FloatBetween(-halfH, halfH);
      const size = Phaser.Math.FloatBetween(3, 9);
      mote.setPosition(x, y).setDisplaySize(size, size).setAlpha(0);

      if (!fx.motion) {
        mote.setAlpha(0.18);
        continue;
      }
      // Each mote runs its own slow rise and its own fade, deliberately out of
      // phase, so the field never pulses as one.
      this.scene.tweens.add({
        targets: mote,
        y: y - Phaser.Math.FloatBetween(30, 90),
        duration: Phaser.Math.Between(6000, 14000),
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      this.scene.tweens.add({
        targets: mote,
        alpha: Phaser.Math.FloatBetween(0.15, 0.4),
        duration: Phaser.Math.Between(1800, 4200),
        delay: Phaser.Math.Between(0, 3000),
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
  }

  /** The looping tweens outlive a plain container destroy — they hold their
   *  own references to the children and would keep writing to them. */
  override destroy(fromScene?: boolean): void {
    this.spin?.remove();
    this.spin = undefined;
    this.ringSpin?.remove();
    this.ringSpin = undefined;
    for (const mote of this.motes) this.scene?.tweens.killTweensOf(mote);
    this.motes = [];
    super.destroy(fromScene);
  }
}
