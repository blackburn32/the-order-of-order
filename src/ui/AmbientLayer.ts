import Phaser from "phaser";
import { COLORS } from "../art/palette";
import {
  randomSigilRingTexture,
  randomSigilTexture,
  SIGIL_INK_RADIUS,
  SIGIL_RING_INNER_INK_RADIUS,
} from "../art/textures";
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

const MORPH_MS = 560;
const MORPH_EXPIRY_MS = 500;

interface AmbientMorphSnapshot {
  sigilTexture: string;
  ringTexture?: string;
  sigilRotation: number;
  ringRotation?: number;
  sigilAlpha: number;
  ringAlpha?: number;
  sigilTint: number;
  ringTint?: number;
  capturedAt: number;
}

let pendingMorph: AmbientMorphSnapshot | undefined;

function takePendingMorph(): AmbientMorphSnapshot | undefined {
  const snapshot = pendingMorph;
  pendingMorph = undefined;
  if (!snapshot || Date.now() - snapshot.capturedAt > MORPH_EXPIRY_MS) {
    return undefined;
  }
  return snapshot;
}

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
 * The layer belongs to the room rather than any content viewport. GameScene's
 * dice camera is transparent, so dice can pan and zoom over this same fixed
 * backdrop without making the play area look like a separate inset panel.
 */
export class AmbientLayer extends Phaser.GameObjects.Container {
  private sigil: Phaser.GameObjects.Image;
  private ring?: Phaser.GameObjects.Image;
  private motes: Phaser.GameObjects.Image[] = [];
  private spin?: Phaser.Tweens.Tween;
  private ringSpin?: Phaser.Tweens.Tween;
  private morphSigil?: Phaser.GameObjects.Image;
  private morphRing?: Phaser.GameObjects.Image;
  private morphStart?: Phaser.Time.TimerEvent;
  private morphCleanup?: Phaser.Time.TimerEvent;
  private areaW = 0;
  private areaH = 0;

  constructor(scene: Phaser.Scene, options: AmbientOptions = {}) {
    super(scene, 0, 0);

    this.sigil = scene.add
      .image(0, 0, randomSigilTexture())
      .setTint(COLORS.gold)
      .setAlpha(SIGIL_ALPHA_IDLE);
    this.add(this.sigil);

    if (options.ring) {
      this.ring = scene.add
        .image(0, 0, randomSigilRingTexture())
        .setTint(COLORS.gold)
        .setAlpha(SIGIL_ALPHA_IDLE);
      this.add(this.ring);
    }

    const previous = fx.motion ? takePendingMorph() : undefined;
    if (previous) {
      this.morphSigil = scene.add
        .image(0, 0, previous.sigilTexture)
        .setTint(previous.sigilTint)
        .setAlpha(previous.sigilAlpha)
        .setRotation(previous.sigilRotation);
      this.add(this.morphSigil);
      if (previous.ringTexture) {
        this.morphRing = scene.add
          .image(0, 0, previous.ringTexture)
          .setTint(previous.ringTint ?? COLORS.gold)
          .setAlpha(previous.ringAlpha ?? previous.sigilAlpha)
          .setRotation(previous.ringRotation ?? 0);
        this.add(this.morphRing);
      }
      // Callers size and colour the layer immediately after construction.
      // Waiting one scene tick lets the morph use those final values instead
      // of flashing through the constructor's idle defaults.
      this.morphStart = scene.time.delayedCall(0, () => this.startMorph());
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
    this.morphSigil?.setDisplaySize(span, span);
    const ringSpan =
      (span * SIGIL_INK_RADIUS + RING_GAP * 2) / SIGIL_RING_INNER_INK_RADIUS;
    if (this.ring) {
      // Size the ring from the gap outwards rather than from the viewport
      // inwards: what has to hold at every width is the band of clear felt
      // between the two, so solve for the display size that puts the ring's
      // innermost stroke exactly RING_GAP beyond the sigil's outermost one.
      // On a landscape viewport that pushes the ring's top and bottom past the
      // edges — intended, it frames the screen there and closes at the corners.
      this.ring.setDisplaySize(ringSpan, ringSpan);
    }
    this.morphRing?.setDisplaySize(ringSpan, ringSpan);
    this.scatterMotes();
  }

  /** Preserve the visible glyph just before this scene is replaced. The next
   * AmbientLayer consumes it once, using it as the first frame of its morph. */
  queueMorphHandoff(): void {
    pendingMorph = {
      sigilTexture: this.sigil.texture.key,
      ringTexture: this.ring?.texture.key,
      sigilRotation: this.sigil.rotation,
      ringRotation: this.ring?.rotation,
      sigilAlpha: this.sigil.alpha,
      ringAlpha: this.ring?.alpha,
      sigilTint: this.sigil.tintTopLeft,
      ringTint: this.ring?.tintTopLeft,
      capturedAt: Date.now(),
    };
  }

  private startMorph(): void {
    this.morphStart = undefined;
    if (!this.morphSigil) return;

    const sigilAlpha = this.sigil.alpha;
    const sigilScaleX = this.sigil.scaleX;
    const sigilScaleY = this.sigil.scaleY;
    this.sigil.setAlpha(0).setScale(sigilScaleX * 0.9, sigilScaleY * 0.9);
    this.scene.tweens.add({
      targets: this.sigil,
      alpha: sigilAlpha,
      scaleX: sigilScaleX,
      scaleY: sigilScaleY,
      duration: MORPH_MS,
      ease: "Sine.easeInOut",
    });

    if (this.ring) {
      const ringAlpha = this.ring.alpha;
      const ringScaleX = this.ring.scaleX;
      const ringScaleY = this.ring.scaleY;
      this.ring.setAlpha(0).setScale(ringScaleX * 0.94, ringScaleY * 0.94);
      this.scene.tweens.add({
        targets: this.ring,
        alpha: ringAlpha,
        scaleX: ringScaleX,
        scaleY: ringScaleY,
        duration: MORPH_MS,
        ease: "Sine.easeInOut",
      });
    }

    const oldScaleX = this.morphSigil.scaleX;
    const oldScaleY = this.morphSigil.scaleY;
    this.scene.tweens.add({
      targets: this.morphSigil,
      alpha: 0,
      scaleX: oldScaleX * 1.08,
      scaleY: oldScaleY * 1.08,
      rotation: this.morphSigil.rotation + 0.08,
      duration: MORPH_MS,
      ease: "Sine.easeInOut",
    });
    if (this.morphRing) {
      const oldRingScaleX = this.morphRing.scaleX;
      const oldRingScaleY = this.morphRing.scaleY;
      this.scene.tweens.add({
        targets: this.morphRing,
        alpha: 0,
        scaleX: oldRingScaleX * 1.04,
        scaleY: oldRingScaleY * 1.04,
        rotation: this.morphRing.rotation - 0.06,
        duration: MORPH_MS,
        ease: "Sine.easeInOut",
      });
    }
    this.morphCleanup = this.scene.time.delayedCall(MORPH_MS, () => {
      this.morphSigil?.destroy();
      this.morphRing?.destroy();
      this.morphSigil = undefined;
      this.morphRing = undefined;
      this.morphCleanup = undefined;
    });
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
    const alpha =
      SIGIL_ALPHA_IDLE + (SIGIL_ALPHA_MET - SIGIL_ALPHA_IDLE) * eased;
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
    this.morphStart?.remove();
    this.morphStart = undefined;
    this.morphCleanup?.remove();
    this.morphCleanup = undefined;
    if (this.morphSigil) this.scene?.tweens.killTweensOf(this.morphSigil);
    if (this.morphRing) this.scene?.tweens.killTweensOf(this.morphRing);
    this.morphSigil = undefined;
    this.morphRing = undefined;
    for (const mote of this.motes) this.scene?.tweens.killTweensOf(mote);
    this.motes = [];
    super.destroy(fromScene);
  }
}
