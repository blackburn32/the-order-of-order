// The mark a lost run carries in the Hall, in the gutter where a won run wears
// its medal. Drawn from shapes for the same reason the medal is: one function
// at any size, and nothing to load.

import Phaser from "phaser";

const STONE = 0x8a8494;
const STONE_DARK = 0x4e4958;
const EARTH = 0x3a2f24;

/**
 * A headstone centred on (x, y), `size` tall from its foot to the top of its
 * arch: a round-shouldered slab with a cross cut into its face, standing on a
 * low mound of earth.
 */
export function buildTombstone(
  scene: Phaser.Scene,
  x: number,
  y: number,
  size: number,
  alpha = 1,
): Phaser.GameObjects.Container {
  const g = scene.add.graphics();
  const w = size * 0.62;
  const h = size * 0.86;
  const top = -size / 2;
  const foot = top + h;
  const r = w / 2;

  // The mound, drawn first so the slab stands in it.
  g.fillStyle(EARTH, alpha);
  g.fillEllipse(0, foot, size * 0.95, size * 0.26);

  // The slab: a rectangle under a half-circle, outlined a shade darker.
  g.fillStyle(STONE, alpha);
  g.fillRect(-r, top + r, w, h - r);
  g.fillCircle(0, top + r, r);
  g.lineStyle(Math.max(1, size * 0.06), STONE_DARK, alpha);
  g.beginPath();
  g.moveTo(-r, foot);
  g.lineTo(-r, top + r);
  g.arc(0, top + r, r, Math.PI, 0);
  g.lineTo(r, foot);
  g.strokePath();

  // The cross, cut in.
  const bar = Math.max(1, size * 0.08);
  const crossX = 0;
  const crossTop = top + h * 0.22;
  const crossH = h * 0.5;
  g.fillStyle(STONE_DARK, alpha);
  g.fillRect(crossX - bar / 2, crossTop, bar, crossH);
  g.fillRect(crossX - w * 0.26, crossTop + crossH * 0.28, w * 0.52, bar);

  return scene.add.container(x, y, [g]);
}
