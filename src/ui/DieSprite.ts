import Phaser from "phaser";
import { artBakeScale, artImage } from "../art/textures";
import {
  DIE_CENTER,
  FACE_OFFSET_Y,
  LABEL_OFFSET_Y,
  drawDieBody,
  drawDiePip,
  drawDieStrike,
  faceLabelStyle,
  faceNumeralOffset,
  faceNumeralStyle,
} from "../art/dieArt";
import { drawEffectBorder } from "./dieBorder";
import { COLORS } from "../art/palette";
import { Die, isVoiceDie } from "../systems/Dice";

/** How long a newly won die takes to reach its full size in the grid. */
export const SPAWN_MS = 260;
/** The fraction of its final size a die starts at when it pops in. Small
 *  enough to read as arriving rather than as a die that was already there
 *  twitching, large enough that the face is legible the whole way up. */
const SPAWN_START_SCALE = 0.3;
/** How long a die that shattered or burned takes to leave the grid. */
export const DEPART_MS = 240;
/** The fraction of its size a departing die has collapsed to when it vanishes. */
const DEPART_END_SCALE = 0.2;

/** How faded an inert die is. Enough to drop it behind the dice that still
 *  count, not so much that its face stops being readable — the player is meant
 *  to see the 1 it wasted, which is the whole sting of the affliction. */
const INERT_ALPHA = 0.5;

/**
 * How far past its baked resolution a die may be drawn before it swaps to the
 * live Graphics/Text it is baked from (see `setMagnification`).
 *
 * Not 1. A bilinear upscale of a few percent is invisible, and a threshold that
 * tight would hand the sharp path every die in a grid sitting a hair over its
 * bake for no gain the player can see. A quarter over is about where the gold
 * border starts to read as soft rather than as antialiased.
 */
const SHARP_THRESHOLD = 1.25;

/**
 * Ceiling on the resolution a live glyph is rasterized at.
 *
 * The face numeral is designed at 34px, so this is a ~550px canvas per die —
 * past the point where more resolution is visible at any sane viewing distance,
 * and a guard against a pathological zoom asking for a canvas the size of a
 * texture atlas.
 */
const MAX_SHARP_RESOLUTION = 16;

/** A corner pip: gold top-right on a die whose highest face always scores
 *  (Rollplayer, Centurion, Ascension), blue top-left on one of A New Voice's
 *  dice, which scores when alone on its face. */
interface Pip {
  baked: Phaser.GameObjects.Image;
  sharp?: Phaser.GameObjects.Graphics;
  wanted: boolean;
}

const PIPS = {
  gold: { x: 34, key: "pip-gold", color: COLORS.gold },
  voice: { x: -34, key: "pip-voice", color: COLORS.voicePip },
} as const;

type PipKind = keyof typeof PIPS;

/** A die in the grid: ivory body, baked face (pips/numeral), type label. */
export class DieSprite extends Phaser.GameObjects.Container {
  die: Die;
  private bodyImage: Phaser.GameObjects.Image;
  private faceImage: Phaser.GameObjects.Image;
  private typeImage: Phaser.GameObjects.Image;
  private pips: Partial<Record<PipKind, Pip>> = {};
  // The cross an inert die wears (see setInert), hidden on every other die.
  private strikeImage: Phaser.GameObjects.Image;
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
  // Whether this die is currently struck out. Held because the pop-in and the
  // pulse both write `alpha`, and an inert die does not rest at 1.
  private inert = false;
  // The face currently shown, so a swap between the two representations below
  // can hand the new one the value the old one was displaying.
  private faceValue: number | null = null;

  // The live, resolution-independent counterparts of the baked children above,
  // built only once this die is drawn large enough to need them — see
  // setMagnification. A die that never leaves the baked path never pays for
  // them, which is the whole reason they are not created up front.
  private sharpBody?: Phaser.GameObjects.Graphics;
  private sharpFace?: Phaser.GameObjects.Text;
  private sharpLabel?: Phaser.GameObjects.Text;
  private sharpStrike?: Phaser.GameObjects.Graphics;
  // Whether this die is drawn past what its baked art can serve. Starts false:
  // until told otherwise a die is at its designed size under an unzoomed
  // camera, which is how every screen outside the grid draws one.
  private sharp = false;
  // Resolution the live glyphs were last rasterized at, so a pan that leaves
  // the magnification alone does not re-render every face on screen.
  private sharpResolution = 0;

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

    this.syncPips();

    // Over the face, under the effect border, so a die that is both inert and
    // flashing still reads as struck out. Built for every die rather than on
    // demand: it is one Image sharing the atlas every die is already batching
    // with, and an affliction can strike any die in the grid.
    this.strikeImage = artImage(scene, 0, 0, "die-atlas", "strike");
    this.strikeImage.setVisible(false);
    this.add(this.strikeImage);

    this.effectBorder = scene.add.graphics();
    this.effectBorder.setAlpha(0);
    this.add(this.effectBorder);

    this.showFace(die.value > 0 ? die.value : null);
    scene.add.existing(this);
  }

  /**
   * Mark this die inert, or clear the mark.
   *
   * An inert die is one an affliction has struck off the grid's books: it still
   * rolls, and the face it lands on is still shown, but nothing reads it (see
   * Afflictions.inertDiceCount). So it is drawn as it is scored — faded, with a
   * red cross laid over the face — rather than hidden or left blank, because the
   * player has to be able to count what the affliction is costing them.
   */
  setInert(inert: boolean): void {
    if (inert === this.inert) return;
    this.inert = inert;
    this.strikeImage.setVisible(!this.sharp && inert);
    this.sharpStrike?.setVisible(this.sharp && inert);
    this.setAlpha(inert ? INERT_ALPHA : 1);
  }

  /** Update body texture/label/face after the die type changed (shrink). */
  refreshType(): void {
    this.bodyImage.setTexture(`die-${this.die.sides}`);
    this.typeImage.setFrame(`label-d${this.die.sides}`);
    this.syncPips();
    if (this.sharp) this.drawSharp();
    this.showFace(this.die.value > 0 ? this.die.value : null);
  }

  /** Show a face value; null hides the face (unrolled die). On the baked path
   *  this is just a frame swap on the shared atlas — no GameObjects created or
   *  destroyed, which is what keeps a rolling grid cheap. */
  showFace(value: number | null): void {
    this.faceValue = value;
    if (value === null) {
      this.faceImage.setVisible(false);
      this.sharpFace?.setVisible(false);
      return;
    }
    if (this.sharp && this.sharpFace) {
      this.sharpFace.setVisible(true).setText(String(value));
      return;
    }
    this.faceImage.setVisible(true).setFrame(`face-${this.die.sides}-${value}`);
  }

  /**
   * Tell this die how large it is about to be drawn, in device pixels per
   * designed pixel — its layout scale, times the grid camera's magnification,
   * times `DPR`.
   *
   * Past its baked resolution a die stops drawing itself from `die-N` and
   * `die-atlas` and draws the same shapes and glyphs live instead. Graphics and
   * Text are vector sources the renderer resolves at the camera's own scale, so
   * they are exact at any zoom, where a baked texture can only be a bilinear
   * upscale of a fixed grid of texels.
   *
   * Baking higher is not the alternative it looks like. The grid's zoom floor
   * is derived from the viewport (see `minGridZoom`), so a lone die on a desktop
   * monitor is already drawn six times its designed size and a larger screen
   * simply asks for more — there is no fixed scale that covers it. The atlas is
   * the binding constraint either way: 151 faces on a 76px grid is a 988px
   * texture at 1:1, and the scale this would need puts it past both
   * `MAX_TEXTURE_SIZE` and any sane memory budget. Drawing live costs nothing
   * until a die is actually large, and a large die is one the viewport can only
   * fit a few of.
   */
  setMagnification(magnification: number): void {
    // One decision for the whole die rather than one per child: the body and
    // the glyphs come from different textures, and `fitAtlasScale` can bake the
    // atlas a step below the bodies, but a vector body carrying a soft numeral
    // would read worse than either side of the swap taken cleanly.
    const baked = Math.min(
      artBakeScale(`die-${this.die.sides}`),
      artBakeScale("die-atlas"),
    );
    const sharp = magnification > baked * SHARP_THRESHOLD;
    const resolution = sharp
      ? Phaser.Math.Clamp(Math.ceil(magnification), 1, MAX_SHARP_RESOLUTION)
      : 0;
    if (sharp === this.sharp && resolution === this.sharpResolution) return;

    this.sharp = sharp;
    this.sharpResolution = resolution;
    if (sharp) this.buildSharp();
    this.applyRepresentation();
  }

  /** Build the live children, once, the first time this die needs them. */
  private buildSharp(): void {
    if (this.sharpBody) return;
    const scene = this.scene;

    // The baked body is a 96x96 texture drawn centred, so the design space
    // `drawDieBody` works in starts a half-die up and to the left of the
    // sprite's own origin.
    this.sharpBody = scene.add.graphics();
    this.sharpBody.setPosition(-DIE_CENTER, -DIE_CENTER);

    // Both glyphs are placed where their baked frames put them: the label's
    // canvas centres on the frame centre, the numeral's is pushed down by the
    // offset that lands its *ink* there (see `drawSharp`).
    this.sharpLabel = scene.add.text(0, LABEL_OFFSET_Y, "", {}).setOrigin(0.5);
    this.sharpFace = scene.add.text(0, 0, "", {}).setOrigin(0.5);

    this.sharpStrike = scene.add.graphics();
    drawDieStrike(this.sharpStrike);

    for (const kind of Object.keys(this.pips) as PipKind[])
      this.pips[kind]!.sharp = this.sharpPip(kind);

    this.addSharp();
  }

  /** The live counterpart of a pip, drawn where its baked image sits. */
  private sharpPip(kind: PipKind): Phaser.GameObjects.Graphics {
    const pip = this.scene.add.graphics();
    pip.setPosition(PIPS[kind].x, -34);
    drawDiePip(pip, PIPS[kind].color);
    return pip;
  }

  /**
   * Show the pips this die has earned and hide the rest. Re-read on every
   * refresh rather than fixed at construction: the grid re-points a sprite at
   * other dice as it shifts, and Ascension marks a die the grid already holds.
   * A pip is built the first time a die wants one and kept after, hidden.
   */
  private syncPips(): void {
    const wants: Record<PipKind, boolean> = {
      gold: this.die.maxFaceBonus > 0,
      voice: isVoiceDie(this.die),
    };
    let added = false;
    for (const kind of Object.keys(PIPS) as PipKind[]) {
      let pip = this.pips[kind];
      if (!pip && wants[kind]) {
        pip = {
          baked: artImage(this.scene, PIPS[kind].x, -34, PIPS[kind].key),
          wanted: true,
        };
        this.add(pip.baked);
        if (this.sharpBody) {
          pip.sharp = this.sharpPip(kind);
          this.add(pip.sharp);
        }
        this.pips[kind] = pip;
        added = true;
      }
      if (!pip) continue;
      pip.wanted = wants[kind];
      pip.baked.setVisible(pip.wanted && !this.sharp);
      pip.sharp?.setVisible(pip.wanted && this.sharp);
    }
    // A late pip was appended above the strike and the effect border, which are
    // drawn over every other part of the die.
    if (added && this.strikeImage) {
      this.bringToTop(this.strikeImage);
      if (this.sharpStrike) this.bringToTop(this.sharpStrike);
      this.bringToTop(this.effectBorder);
    }
  }

  /** Add the live children, in the baked children's own stacking order. */
  private addSharp(): void {
    this.add(
      [
        this.sharpBody,
        this.sharpLabel,
        this.sharpFace,
        ...Object.values(this.pips).map((pip) => pip.sharp),
        this.sharpStrike,
      ].filter((child) => child !== undefined),
    );
    // They were appended above the effect border, which is drawn over every
    // other part of the die.
    this.bringToTop(this.effectBorder);
  }

  /** Redraw the live children for the current die type and resolution. */
  private drawSharp(): void {
    const sides = this.die.sides;
    const resolution = Math.max(1, this.sharpResolution);

    if (this.sharpBody) {
      this.sharpBody.clear();
      drawDieBody(this.sharpBody, sides);
    }

    this.sharpLabel
      ?.setStyle(faceLabelStyle(sides, 1, resolution))
      .setText(`d${sides}`);

    this.sharpFace
      ?.setStyle(faceNumeralStyle(1, resolution))
      .setY(FACE_OFFSET_Y + faceNumeralOffset(sides));
  }

  /** Show exactly one of the two representations. */
  private applyRepresentation(): void {
    const sharp = this.sharp;
    if (sharp) this.drawSharp();

    this.bodyImage.setVisible(!sharp);
    this.typeImage.setVisible(!sharp);
    for (const pip of Object.values(this.pips)) {
      pip.baked.setVisible(pip.wanted && !sharp);
      pip.sharp?.setVisible(pip.wanted && sharp);
    }
    this.sharpBody?.setVisible(sharp);
    this.sharpLabel?.setVisible(sharp);

    this.strikeImage.setVisible(!sharp && this.inert);
    this.sharpStrike?.setVisible(sharp && this.inert);

    // Re-runs the face through whichever path is now live.
    this.showFace(this.faceValue);
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
      alpha: this.inert ? INERT_ALPHA : 1,
      duration: SPAWN_MS,
      delay,
      ease: "Back.easeOut",
      onComplete: () => {
        this.spawnTween = undefined;
      },
    });
  }

  /**
   * One frame of the same pop-in, driven from outside. A grid past the
   * individually-animated threshold can win thousands of dice at once, and one
   * tween apiece would cost more than the arrival it animates — so the scene
   * runs a single tween over the batch and poses each die here instead.
   * `elapsed` is ms since this die's own start; negative means still waiting.
   */
  poseSpawn(scale: number, elapsed: number): void {
    const t = Phaser.Math.Clamp(elapsed / SPAWN_MS, 0, 1);
    const eased = Phaser.Math.Easing.Back.Out(t);
    this.setScale(
      scale * (SPAWN_START_SCALE + (1 - SPAWN_START_SCALE) * eased),
    );
    this.setAlpha((this.inert ? INERT_ALPHA : 1) * Math.min(1, eased));
  }

  /**
   * One frame of this die leaving the grid — the pop-in run backwards: a small
   * swell, then a collapse to nothing as it fades. Driven from the scene's
   * shared reflow tween for the same reason `poseSpawn` is. `elapsed` is ms
   * since this die's own start; negative means it has not begun to go.
   */
  poseDeparture(scale: number, elapsed: number): void {
    const t = Phaser.Math.Clamp(elapsed / DEPART_MS, 0, 1);
    const eased = Phaser.Math.Easing.Back.In(t);
    this.setScale(scale * (1 - (1 - DEPART_END_SCALE) * eased));
    this.setAlpha(
      (this.inert ? INERT_ALPHA : 1) * (1 - Phaser.Math.Easing.Quadratic.In(t)),
    );
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
    // right after), so only the fade has to be undone here — back to whatever
    // this die's resting alpha is, which for an inert one is not full.
    this.spawnTween = undefined;
    this.setAlpha(this.inert ? INERT_ALPHA : 1);
    this.snapSettled();
  }
}
