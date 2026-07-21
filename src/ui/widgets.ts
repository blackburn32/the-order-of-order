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

/** Parchment banner button with hover/press feedback. */
export function bannerButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  onClick: () => void
): Phaser.GameObjects.Container {
  const img = scene.add.image(0, 0, 'btn');
  const text = scene.add
    .text(0, 0, label, { fontFamily: SERIF, fontSize: '26px', color: CSS.ink })
    .setOrigin(0.5);
  const container = scene.add.container(x, y, [img, text]);
  container.setSize(img.width, img.height);
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
 * can drop it into a scroll content container or reposition it.
 */
export function checkboxRow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  initial: boolean,
  onChange: (value: boolean) => void,
  boxSize = 26
): Phaser.GameObjects.Container {
  let value = initial;

  const box = scene.add.rectangle(0, 0, boxSize, boxSize, COLORS.feltLight, 0.35).setOrigin(0, 0.5);
  box.setStrokeStyle(2, COLORS.ink, 0.9);
  const check = scene.add
    .rectangle(boxSize / 2, 0, boxSize * 0.5, boxSize * 0.5, COLORS.gold)
    .setOrigin(0.5)
    .setVisible(value);
  const text = scene.add
    .text(boxSize + 14, 0, label, { fontFamily: SERIF, fontSize: '22px', color: CSS.ink })
    .setOrigin(0, 0.5);

  // Origin the container on the box's left edge, then shift so the whole row
  // reads as centered on x.
  const rowW = boxSize + 14 + text.width;
  const container = scene.add.container(x - rowW / 2, y, [box, check, text]);
  container.setSize(rowW, Math.max(boxSize, text.height));
  container.setInteractive(
    new Phaser.Geom.Rectangle(0, -container.height / 2, rowW, container.height),
    Phaser.Geom.Rectangle.Contains
  );
  container.input!.cursor = 'pointer';
  container.on('pointerdown', () => {
    value = !value;
    check.setVisible(value);
    audio.click();
    onChange(value);
  });
  return container;
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
