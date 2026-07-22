import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { audio } from '../systems/Audio';

/** Felt tabletop background, stretched to cover the current viewport. */
export function addFelt(scene: Phaser.Scene): Phaser.GameObjects.Image {
  const { width, height } = scene.scale;
  return scene.add.image(width / 2, height / 2, 'felt').setDisplaySize(width, height);
}

/** Parchment panel sized to an explicit display box (non-uniform scale is fine — procedural art). */
export function addPanel(scene: Phaser.Scene, cx: number, cy: number, w: number, h: number): Phaser.GameObjects.Image {
  return scene.add.image(cx, cy, 'panel').setDisplaySize(w, h);
}

/** Parchment banner button with hover/press feedback. Pass `maxWidth` to shrink
 *  the whole button uniformly when the parchment would be wider than the space
 *  available (e.g. a narrow settings panel). */
export function bannerButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  onClick: () => void,
  maxWidth?: number
): Phaser.GameObjects.Container {
  const img = scene.add.image(0, 0, 'btn');
  const text = scene.add
    .text(0, 0, label, { fontFamily: SERIF, fontSize: '26px', color: CSS.ink })
    .setOrigin(0.5);
  const container = scene.add.container(x, y, [img, text]);
  container.setSize(img.width, img.height);
  if (maxWidth !== undefined && img.width > maxWidth) {
    container.setScale(maxWidth / img.width);
  }
  container.setInteractive({ useHandCursor: true });
  container.on('pointerover', () => img.setTint(0xfff2c8));
  container.on('pointerout', () => img.clearTint());
  container.on('pointerdown', () => {
    audio.click();
    onClick();
  });
  return container;
}

/**
 * A labelled checkbox row centered on (x, y): a gold check in an ink-bordered
 * box to the left, the label to its right. Tapping anywhere on the row toggles
 * it, plays a click, and reports the new value. Returns the container so callers
 * can drop it into a scroll content container or reposition it. The returned
 * container carries `setChecked` so callers can reflect state changed elsewhere
 * (e.g. fullscreen toggled with Esc/F11) without firing `onChange`.
 */
export interface CheckboxRow extends Phaser.GameObjects.Container {
  setChecked(value: boolean): void;
}

/** Optional color overrides so a row reads on either background: the defaults
 *  suit a parchment panel (ink text, ink border); pass light values to place
 *  the row on the dark felt (e.g. the intro). */
export interface CheckboxRowStyle {
  textColor?: string;
  boxStroke?: number;
}

export function checkboxRow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  initial: boolean,
  onChange: (value: boolean) => void,
  boxSize = 26,
  style: CheckboxRowStyle = {}
): CheckboxRow {
  let value = initial;
  const textColor = style.textColor ?? CSS.ink;
  const boxStroke = style.boxStroke ?? COLORS.ink;

  const box = scene.add.rectangle(0, 0, boxSize, boxSize, COLORS.feltLight, 0.35).setOrigin(0, 0.5);
  box.setStrokeStyle(2, boxStroke, 0.9);
  const check = scene.add
    .rectangle(boxSize / 2, 0, boxSize * 0.5, boxSize * 0.5, COLORS.gold)
    .setOrigin(0.5)
    .setVisible(value);
  const text = scene.add
    .text(boxSize + 14, 0, label, { fontFamily: SERIF, fontSize: '22px', color: textColor })
    .setOrigin(0, 0.5);

  // Origin the container on the box's left edge, then shift so the whole row
  // reads as centered on x.
  const rowW = boxSize + 14 + text.width;
  // Pad the hit area vertically so clicks land anywhere across the box or the
  // label, not just on the thin band the glyphs occupy.
  const hitH = Math.max(boxSize, text.height) + 20;
  const container = scene.add.container(x - rowW / 2, y, [box, check, text]);
  container.setSize(rowW, hitH);
  container.setInteractive(
    new Phaser.Geom.Rectangle(0, -hitH / 2, rowW, hitH),
    Phaser.Geom.Rectangle.Contains
  );
  container.input!.cursor = 'pointer';
  container.on('pointerdown', () => {
    value = !value;
    check.setVisible(value);
    audio.click();
    onChange(value);
  });

  const row = container as CheckboxRow;
  row.setChecked = (v: boolean) => {
    value = v;
    check.setVisible(value);
  };
  return row;
}

/** Floating score text that drifts up and fades. Returns the Text so callers
 *  that render through a secondary camera (e.g. a windowed dice grid) can
 *  exclude it from that camera and keep it above everything. */
export function floatText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  message: string,
  color: string = CSS.goldLight,
  size = 30
): Phaser.GameObjects.Text {
  const text = scene.add
    .text(x, y, message, {
      fontFamily: SERIF,
      fontSize: `${size}px`,
      color,
      fontStyle: 'bold',
      stroke: '#0d0a12',
      strokeThickness: 4
    })
    .setOrigin(0.5)
    .setDepth(50);
  scene.tweens.add({
    targets: text,
    y: y - 70,
    alpha: 0,
    duration: 1100,
    ease: 'Quad.easeOut',
    onComplete: () => text.destroy()
  });
  return text;
}

/** Centered announcement banner that slides in, holds, and fades. Returns
 *  its GameObjects — see `floatText` for why. */
export function showBanner(scene: Phaser.Scene, message: string, holdMs = 1100): Phaser.GameObjects.GameObject[] {
  const cx = scene.scale.width / 2;
  const cy = scene.scale.height / 2;
  const img = scene.add.image(cx, cy, 'banner').setDepth(90).setAlpha(0);
  const text = scene.add
    .text(cx, cy, message, { fontFamily: SERIF, fontSize: '34px', color: CSS.goldLight })
    .setOrigin(0.5)
    .setDepth(91)
    .setAlpha(0);
  scene.tweens.add({
    targets: [img, text],
    alpha: 1,
    duration: 200,
    onComplete: () => {
      scene.tweens.add({
        targets: [img, text],
        alpha: 0,
        delay: holdMs,
        duration: 300,
        onComplete: () => {
          img.destroy();
          text.destroy();
        }
      });
    }
  });
  return [img, text];
}

/** Vertical spacing between stacked banners (px), on top of the banner height. */
const BANNER_GAP = 14;

/**
 * A vertically-stacked queue of announcement banners. Where a bare `showBanner`
 * always lands at scene center — so two firing at once overlap — a stack lays
 * its live banners out in a column centered on the scene and smoothly reflows
 * them as banners come and go, so nothing ever overlaps. Each banner fades in,
 * holds, and fades out independently; when one leaves, the survivors slide to
 * close the gap.
 *
 * The owning scene passes a `register` callback so freshly-created banner
 * objects can be routed through its overlay camera (see GameScene.overlay);
 * scenes that don't window their content can omit it.
 */
export class BannerStack {
  private entries: { container: Phaser.GameObjects.Container; slotH: number }[] = [];

  constructor(
    private scene: Phaser.Scene,
    private register: (objs: Phaser.GameObjects.GameObject[]) => void = () => {}
  ) {}

  /** Push a banner onto the stack. `detail`, when given, is rendered as a
   *  smaller second line beneath the headline. */
  push(message: string, opts: { holdMs?: number; detail?: string } = {}): void {
    const scene = this.scene;
    const holdMs = opts.holdMs ?? 1100;
    const hasDetail = !!opts.detail;

    const img = scene.add.image(0, 0, 'banner');
    const title = scene.add
      .text(0, hasDetail ? -13 : 0, message, { fontFamily: SERIF, fontSize: '30px', color: CSS.goldLight })
      .setOrigin(0.5);
    const container = scene.add.container(scene.scale.width / 2, scene.scale.height / 2, [img, title]);
    let detailW = 0;
    if (opts.detail) {
      const detail = scene.add
        .text(0, 17, opts.detail, { fontFamily: SERIF, fontSize: '19px', color: CSS.parchment })
        .setOrigin(0.5);
      container.add(detail);
      detailW = detail.width;
    }
    // Shrink uniformly to fit narrow (portrait/mobile) viewports rather than
    // overflow the sides — driven by whichever is widest, the parchment strip
    // or a long text line, since the text isn't confined to the strip.
    const contentW = Math.max(img.width, title.width, detailW);
    const maxW = scene.scale.width - 40;
    const scale = contentW > maxW ? maxW / contentW : 1;
    container.setScale(scale).setDepth(90).setAlpha(0);

    const entry = { container, slotH: img.height * scale + BANNER_GAP };
    this.entries.push(entry);
    this.register([container]);
    this.layout();

    scene.tweens.add({ targets: container, alpha: 1, duration: 200 });
    scene.time.delayedCall(200 + holdMs, () => {
      scene.tweens.add({
        targets: container,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          container.destroy();
          this.entries = this.entries.filter((e) => e !== entry);
          this.layout();
        }
      });
    });
  }

  /** Reflow live banners into a centered column, tweening each to its slot. */
  private layout(): void {
    const anchorY = this.scene.scale.height / 2;
    const totalH = this.entries.reduce((sum, e) => sum + e.slotH, 0);
    let top = anchorY - totalH / 2;
    for (const e of this.entries) {
      const targetY = top + e.slotH / 2;
      this.scene.tweens.add({ targets: e.container, y: targetY, duration: 200, ease: 'Cubic.out' });
      top += e.slotH;
    }
  }
}
