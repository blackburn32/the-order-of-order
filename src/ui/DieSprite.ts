import Phaser from 'phaser';
import { COLORS } from '../art/palette';
import { Die } from '../systems/Dice';

/** A die in the grid: ivory body, baked face (pips/numeral), type label. */
export class DieSprite extends Phaser.GameObjects.Container {
  die: Die;
  private bodyImage: Phaser.GameObjects.Image;
  private faceImage: Phaser.GameObjects.Image;
  private typeImage: Phaser.GameObjects.Image;
  private marker?: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, x: number, y: number, die: Die) {
    super(scene, x, y);
    this.die = die;

    this.bodyImage = scene.add.image(0, 0, `die-${die.sides}`);
    this.typeImage = scene.add.image(0, 36, 'die-atlas', `label-d${die.sides}`);
    // Placeholder frame; showFace() below sets the real one immediately.
    this.faceImage = scene.add.image(0, -4, 'die-atlas', `face-${die.sides}-1`);
    this.add([this.bodyImage, this.typeImage, this.faceImage]);

    if (die.rollplayer) {
      this.marker = scene.add.image(34, -34, 'pip-gold');
      this.add(this.marker);
    }

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

  /** Gold pulse when this die scored; stronger for a Rollplayer jackpot. */
  pulse(jackpot = false): void {
    this.bodyImage.setTint(jackpot ? COLORS.goldLight : COLORS.glow);
    this.scene.tweens.add({
      targets: this,
      scaleX: this.scaleX * (jackpot ? 1.25 : 1.12),
      scaleY: this.scaleY * (jackpot ? 1.25 : 1.12),
      duration: 130,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => this.bodyImage.clearTint()
    });
  }

  /** Stop an in-flight pulse tween without waiting for it to finish — the
   *  tween's own scale writes would otherwise fight a relayout's setScale(). */
  clearPulse(): void {
    this.scene.tweens.killTweensOf(this);
    this.bodyImage.clearTint();
  }
}
