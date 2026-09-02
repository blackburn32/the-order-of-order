import Phaser from "phaser";

export const BORDER_WIDTH = 5;

/** Points tracing the die's rounded-rect outline, clockwise from the top-left,
 *  sampled finely enough that a color split lands close to its exact fraction.
 *  Expressed in the die's own 96-unit design space, so anything drawing it at
 *  another size scales the Graphics rather than rebuilding the path. */
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

/**
 * Stroke the die outline into `g`, split into one equal-length arc per color,
 * so a die that both scores and matches on Snake Eyes reads as half-and-half.
 * `width` is in the same 96-unit space as the path: a caller drawing at a
 * smaller scale passes a proportionally larger width to keep the line visible.
 */
export function drawEffectBorder(
  g: Phaser.GameObjects.Graphics,
  colors: number[],
  width = BORDER_WIDTH,
): void {
  g.clear();
  if (colors.length === 0) return;

  const segment = BORDER_LENGTH / colors.length;
  let colorIndex = 0;
  let travelled = 0;
  g.lineStyle(width, colors[0], 1);
  g.beginPath();
  g.moveTo(BORDER_PATH[0].x, BORDER_PATH[0].y);
  for (let i = 1; i < BORDER_PATH.length; i++) {
    const prev = BORDER_PATH[i - 1];
    const cur = BORDER_PATH[i];
    travelled += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    g.lineTo(cur.x, cur.y);
    if (
      colorIndex < colors.length - 1 &&
      travelled >= segment * (colorIndex + 1)
    ) {
      g.strokePath();
      colorIndex++;
      g.lineStyle(width, colors[colorIndex], 1);
      g.beginPath();
      g.moveTo(cur.x, cur.y);
    }
  }
  g.strokePath();
}
