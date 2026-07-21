import Phaser from 'phaser';
import { Die } from '../systems/Dice';

const BORDER_WIDTH = 5;

/** Points tracing the die's rounded-rect outline, clockwise from the top-left,
 *  sampled finely enough that a color split lands close to its exact fraction. */
const BORDER_PATH = buildBorderPath();
const BORDER_LENGTH = pathLength(BORDER_PATH);

function buildBorderPath(): { x: number; y: number }[] {
  const hw = 47;
  const hh = 47;
  const r = 15;
  const pts: { x: number; y: number }[] = [];
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 4));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
    }
  };
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  };
  line(-hw + r, -hh, hw - r, -hh);
  arc(hw - r, -hh + r, -Math.PI / 2, 0);
  line(hw, -hh + r, hw, hh - r);
  arc(hw - r, hh - r, 0, Math.PI / 2);
  line(hw - r, hh, -hw + r, hh);
  arc(-hw + r, hh - r, Math.PI / 2, Math.PI);
  line(-hw, hh - r, -hw, -hh + r);
  arc(-hw + r, -hh + r, Math.PI, Math.PI * 1.5);
  pts.push({ x: -hw + r, y: -hh }); // close the loop
  return pts;
}

function pathLength(pts: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

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

  constructor(scene: Phaser.Scene, x: number, y: number, die: Die) {
    super(scene, x, y);
    this.die = die;

    this.bodyImage = scene.add.image(0, 0, `die-${die.sides}`);
    this.typeImage = scene.add.image(0, 36, 'die-atlas', `label-d${die.sides}`);
    // Placeholder frame; showFace() below sets the real one immediately.
    this.faceImage = scene.add.image(0, -4, 'die-atlas', `face-${die.sides}-1`);
    this.add([this.bodyImage, this.typeImage, this.faceImage]);

    if (die.maxFaceBonus) {
      this.marker = scene.add.image(34, -34, 'pip-gold');
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

  /** Flash the die's border to signal one or more triggered effects, plus a
   *  scale bounce. With multiple effects the border is split into equal-length
   *  arcs — one color each — so a die that both scores and matches on Snake Eyes
   *  reads as half-and-half. `big` gives a stronger bounce (Rollplayer jackpot). */
  pulseEffects(colors: number[], big = false): void {
    if (colors.length === 0) return;

    const g = this.effectBorder;
    this.scene.tweens.killTweensOf(g);
    g.clear();
    g.setAlpha(1);

    const segment = BORDER_LENGTH / colors.length;
    let colorIndex = 0;
    let travelled = 0;
    g.lineStyle(BORDER_WIDTH, colors[0], 1);
    g.beginPath();
    g.moveTo(BORDER_PATH[0].x, BORDER_PATH[0].y);
    for (let i = 1; i < BORDER_PATH.length; i++) {
      const prev = BORDER_PATH[i - 1];
      const cur = BORDER_PATH[i];
      travelled += Math.hypot(cur.x - prev.x, cur.y - prev.y);
      g.lineTo(cur.x, cur.y);
      if (colorIndex < colors.length - 1 && travelled >= segment * (colorIndex + 1)) {
        g.strokePath();
        colorIndex++;
        g.lineStyle(BORDER_WIDTH, colors[colorIndex], 1);
        g.beginPath();
        g.moveTo(cur.x, cur.y);
      }
    }
    g.strokePath();

    const scale = big ? 1.25 : 1.12;
    this.scene.tweens.add({
      targets: this,
      scaleX: this.scaleX * scale,
      scaleY: this.scaleY * scale,
      duration: 130,
      yoyo: true,
      ease: 'Quad.easeOut'
    });
    this.scene.tweens.add({
      targets: g,
      alpha: 0,
      duration: 420,
      ease: 'Quad.easeIn'
    });
  }

  /** Stop an in-flight pulse tween without waiting for it to finish — the
   *  tween's own scale writes would otherwise fight a relayout's setScale(). */
  clearPulse(): void {
    this.scene.tweens.killTweensOf(this);
    this.scene.tweens.killTweensOf(this.effectBorder);
    this.effectBorder.clear();
    this.effectBorder.setAlpha(0);
  }
}
