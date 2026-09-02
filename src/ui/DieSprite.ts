import Phaser from "phaser";
import { artImage } from "../art/textures";
import { drawEffectBorder } from "./dieBorder";
import { Die } from "../systems/Dice";

/** How long a newly won die takes to reach its full size in the grid. */
const SPAWN_MS = 260;
/** The fraction of its final size a die starts at when it pops in. Small
 *  enough to read as arriving rather than as a die that was already there
 *  twitching, large enough that the face is legible the whole way up. */
const SPAWN_START_SCALE = 0.3;

/** A die in the grid: ivory body, baked face (pips/numeral), type label. */
export class DieSprite extends Phaser.GameObjects.Container {
  die: Die;
  private bodyImage: Phaser.GameObjects.Image;
  private faceImage: Phaser.GameObjects.Image;
  private typeImage: Phaser.GameObjects.Image;
  private marker?: Phaser.GameObjects.Image;
  // Border overlay for effect flashes. Created up front (not lazily) so the
  // windowed grid camera's ignore-list snapshot covers it like the other children.
  private effectBorder: Phaser.GameObjects.Graphics;
  // This die's own rocking motion during a roll — see beginTumble. Zero
  // amplitude means "not tumbling", which is also the state a die created
  // mid-roll starts in, so it simply sits still rather than snapping in.
  private wobbleAmplitude = 0;
  private wobbleRate = 0;
  private wobblePhase = 0;
  // The pop-in, while it lasts — see spawnIn. Held because the grid relays out
  // under a spawning die (every pan frame does), and because an effect pulse
  // landing on one has to wait it out rather than bounce from a half-grown
  // scale it would then yoyo back to.
  private spawnTween?: Phaser.Tweens.Tween;
  private spawnScale = 1;
  private spawnEndsAt = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, die: Die) {
    super(scene, x, y);
    this.die = die;

    // The offsets are in the die's own 96-unit design space, which is also
    // what `artImage` draws these at whatever resolution they were baked at.
    this.bodyImage = artImage(scene, 0, 0, `die-${die.sides}`);
    this.typeImage = artImage(scene, 0, 36, "die-atlas", `label-d${die.sides}`);
    // Placeholder frame; showFace() below sets the real one immediately.
    this.faceImage = artImage(scene, 0, -4, "die-atlas", `face-${die.sides}-1`);
    this.add([this.bodyImage, this.typeImage, this.faceImage]);

    if (die.maxFaceBonus) {
      this.marker = artImage(scene, 34, -34, "pip-gold");
      this.add(this.marker);
    }

    this.effectBorder = scene.add.graphics();
    this.effectBorder.setAlpha(0);
    this.add(this.effectBorder);

    this.showFace(die.value > 0 ? die.value : null);
    scene.add.existing(this);
  }

  /** Update body texture/label/face after the die type changed (shrink). */
  refreshType(): void {
    this.bodyImage.setTexture(`die-${this.die.sides}`);
    this.typeImage.setFrame(`label-d${this.die.sides}`);
    this.showFace(this.die.value > 0 ? this.die.value : null);
  }

  /** Show a face value; null hides the face (unrolled die). Just a frame
   *  swap on the baked atlas — no GameObjects created or destroyed. */
  showFace(value: number | null): void {
    if (value === null) {
      this.faceImage.setVisible(false);
      return;
    }
    this.faceImage.setVisible(true).setFrame(`face-${this.die.sides}-${value}`);
  }

  /**
   * Grow a newly won die into its cell instead of having it appear at full
   * size. `scale` is the layout scale the grid wants it at — the same value a
   * reposition would have set — and `delay` staggers a batch so a handful of
   * dice arrives as a ripple rather than as one flash.
   *
   * Alpha and scale start applied immediately, before any delay, so a die
   * waiting its turn in the ripple is not visible sitting at full size.
   */
  spawnIn(scale: number, delay = 0): void {
    this.spawnTween?.remove();
    this.spawnScale = scale;
    this.spawnEndsAt = this.scene.time.now + delay + SPAWN_MS;
    this.setScale(scale * SPAWN_START_SCALE);
    this.setAlpha(0);
    this.spawnTween = this.scene.tweens.add({
      targets: this,
      scaleX: scale,
      scaleY: scale,
      alpha: 1,
      duration: SPAWN_MS,
      delay,
      ease: "Back.easeOut",
      onComplete: () => {
        this.spawnTween = undefined;
      },
    });
  }

  /** How much of the pop-in is still to come, in ms. */
  private spawnRemaining(): number {
    if (!this.spawnTween) return 0;
    return Math.max(0, this.spawnEndsAt - this.scene.time.now);
  }

  /** Flash the die's border to signal one or more triggered effects, plus a
   *  scale bounce. With multiple effects the border is split into equal-length
   *  arcs — one color each — so a die that both scores and matches on Snake Eyes
   *  reads as half-and-half. `big` gives a stronger bounce (Rollplayer jackpot). */
  pulseEffects(colors: number[], big = false): void {
    if (colors.length === 0) return;

    // A die still popping in bounces once it has finished growing: a yoyo
    // started now would return it to the half-grown scale it happened to be
    // at, and leave it stranded there.
    const delay = this.spawnRemaining();
    const base = this.spawnTween ? this.spawnScale : this.scaleX;

    const g = this.effectBorder;
    this.scene.tweens.killTweensOf(g);
    g.setAlpha(0);
    drawEffectBorder(g, colors);

    const scale = big ? 1.25 : 1.12;
    this.scene.tweens.add({
      targets: this,
      scaleX: base * scale,
      scaleY: base * scale,
      duration: 130,
      delay,
      yoyo: true,
      ease: "Quad.easeOut",
    });
    this.scene.tweens.add({
      targets: g,
      alpha: { from: 1, to: 0 },
      duration: 420,
      delay,
      ease: "Quad.easeIn",
    });
  }

  /**
   * Give this die its own rocking motion for the roll about to start.
   *
   * The wobble is a continuous sine rather than a fresh random angle per
   * tumble tick: the ticks are 70ms apart, so re-randomising on each one made
   * the grid chatter between unrelated angles instead of rattling. Amplitude,
   * rate, and phase are all per-die, so the dice rock out of step with each
   * other and the grid reads as a handful of dice rather than one object.
   *
   * Rotation is the only transform safe to drive here — position and scale are
   * owned by the grid layout, which can re-run mid-roll (a spawn or a shrink)
   * and would snap either of them back.
   */
  beginTumble(): void {
    this.wobbleAmplitude = Phaser.Math.FloatBetween(0.06, 0.16);
    this.wobbleRate = Phaser.Math.FloatBetween(18, 30);
    this.wobblePhase = Phaser.Math.FloatBetween(0, Math.PI * 2);
  }

  /** Advance the wobble to `elapsed` seconds since the tumble began. Driven
   *  from the scene's update loop, so the motion is smooth at whatever frame
   *  rate the device is actually managing. */
  tumbleTo(elapsed: number): void {
    if (this.wobbleAmplitude === 0) return;
    this.setRotation(
      this.wobbleAmplitude *
        Math.sin(this.wobbleRate * elapsed + this.wobblePhase),
    );
  }

  /**
   * Land the die square again. Callers stagger `delay` across the grid so the
   * dice settle as a ripple rather than all at once; the overshoot ease gives
   * each one a small rock as it comes to rest.
   */
  settle(delay: number): void {
    this.wobbleAmplitude = 0;
    if (this.rotation === 0) return;
    this.scene.tweens.add({
      targets: this,
      rotation: 0,
      duration: 260,
      delay,
      ease: "Back.easeOut",
    });
  }

  /** End the tumble without allocating a tween. Large grids use one shared
   *  landing cue instead of animating every die independently. */
  snapSettled(): void {
    this.wobbleAmplitude = 0;
    this.setRotation(0);
  }

  /** Stop an in-flight pulse tween without waiting for it to finish — the
   *  tween's own scale writes would otherwise fight a relayout's setScale().
   *  Also squares up a die caught mid-settle, since killing that tween would
   *  otherwise strand it at whatever angle it had reached. */
  clearPulse(): void {
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.killTweensOf(this.effectBorder);
    this.effectBorder.clear();
    this.effectBorder.setAlpha(0);
    // The kill above takes any pop-in with it, which would leave the die
    // stranded small and invisible. The caller owns the scale (it sets it
    // right after), so only the fade has to be undone here.
    this.spawnTween = undefined;
    this.setAlpha(1);
    this.snapSettled();
  }
}
