import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { addPanel, bannerButton } from './widgets';

export interface CalloutOptions {
  /** Screen-space rectangle of the element being pointed at. Pass several when
   *  one step is about more than one region (the shop's cards *and* its
   *  boosters): every rect stays lit, and the panel is kept clear of all. */
  anchor: Phaser.Geom.Rectangle | Phaser.Geom.Rectangle[];
  /** Body copy shown in the parchment panel. */
  text: string;
  /** When provided, a "Continue" button is shown that invokes this. */
  onContinue?: () => void;
  /** Leave the anchor open to input (default true). Set false to also block
   *  the anchor — e.g. a step that must be dismissed via Continue only. */
  interactiveAnchor?: boolean;
}

export interface CalloutHandle {
  destroy(): void;
  /** Every GameObject the callout created, so a caller can e.g. exclude them
   *  from a secondary camera. */
  objects: Phaser.GameObjects.GameObject[];
}

const DIM_DEPTH = 100;
const HILITE_DEPTH = 101;
const PANEL_DEPTH = 102;
const TEXT_DEPTH = 103;
const BUTTON_DEPTH = 104;
const DIM_COLOR = COLORS.feltDark;
const DIM_ALPHA = 0.72;
const PAD = 8;

/**
 * A tutorial spotlight: dims the screen around `anchor` (leaving it lit and, by
 * default, still interactive), draws a gold highlight around it, and shows a
 * parchment callout in the roomiest spot that covers none of it. Phaser
 * rectangles can't have holes, so the "hole" is the gap the dim bands leave —
 * see the band math below.
 */
export function showCallout(scene: Phaser.Scene, opts: CalloutOptions): CalloutHandle {
  const W = scene.scale.width;
  const H = scene.scale.height;
  const objects: Phaser.GameObjects.GameObject[] = [];

  // Every lit region, padded and clipped to the viewport. Anything the padding
  // pushed off screen entirely is dropped rather than left as a sliver.
  const holes = (Array.isArray(opts.anchor) ? opts.anchor : [opts.anchor])
    .map(a => {
      const x0 = Phaser.Math.Clamp(a.x - PAD, 0, W);
      const y0 = Phaser.Math.Clamp(a.y - PAD, 0, H);
      const x1 = Phaser.Math.Clamp(a.x + a.width + PAD, 0, W);
      const y1 = Phaser.Math.Clamp(a.y + a.height + PAD, 0, H);
      return new Phaser.Geom.Rectangle(x0, y0, x1 - x0, y1 - y0);
    })
    .filter(r => r.width > 0 && r.height > 0);

  const band = (x: number, y: number, w: number, h: number) => {
    if (w <= 0 || h <= 0) return;
    const r = scene.add.rectangle(x, y, w, h, DIM_COLOR, DIM_ALPHA).setOrigin(0, 0).setDepth(DIM_DEPTH);
    r.setInteractive(); // swallow clicks on the dimmed area
    objects.push(r);
  };

  // Dim bands tiling the screen minus every hole: slice the viewport along all
  // hole edges and keep the cells no hole covers, which for a single anchor is
  // exactly the old top/bottom/left/right frame. Neighbouring cells in a row
  // merge into one band, so a two-hole step still costs a handful of rects
  // rather than a grid of them. Each swallows input (topOnly is on, so they
  // block whatever sits beneath them).
  const edges = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const xs = edges([0, W, ...holes.flatMap(h => [h.x, h.right])]);
  const ys = edges([0, H, ...holes.flatMap(h => [h.y, h.bottom])]);
  for (let row = 0; row < ys.length - 1; row++) {
    const top = ys[row];
    const height = ys[row + 1] - top;
    const mid = top + height / 2;
    let runX: number | undefined; // left edge of the dim run being extended
    for (let col = 0; col < xs.length - 1; col++) {
      const cellLit = holes.some(h => Phaser.Geom.Rectangle.Contains(h, (xs[col] + xs[col + 1]) / 2, mid));
      if (!cellLit && runX === undefined) runX = xs[col];
      if (cellLit && runX !== undefined) {
        band(runX, top, xs[col] - runX, height);
        runX = undefined;
      }
    }
    if (runX !== undefined) band(runX, top, W - runX, height);
  }

  for (const h of holes) {
    // Optionally block the hole itself (a transparent lid at the same depth).
    if (opts.interactiveAnchor === false) {
      const lid = scene.add
        .rectangle(h.x, h.y, h.width, h.height, DIM_COLOR, 0.001)
        .setOrigin(0, 0)
        .setDepth(DIM_DEPTH);
      lid.setInteractive();
      objects.push(lid);
    }

    // Gold highlight around the spotlit element.
    const hilite = scene.add
      .rectangle(h.centerX, h.centerY, h.width, h.height)
      .setStrokeStyle(3, COLORS.gold, 0.9)
      .setDepth(HILITE_DEPTH);
    objects.push(hilite);
  }

  // Callout panel: sized to its text, placed on the side of the anchor with the
  // most free space, clamped to the viewport.
  const panelW = Phaser.Math.Clamp(W * 0.5, 220, 360);
  const wrapW = panelW - 40;
  const hasButton = !!opts.onContinue;
  const body = scene.add
    .text(0, 0, opts.text, {
      fontFamily: SERIF,
      fontSize: '18px',
      color: CSS.ink,
      align: 'center',
      wordWrap: { width: wrapW }
    })
    .setOrigin(0.5, 0)
    .setDepth(TEXT_DEPTH);
  const buttonBand = hasButton ? 64 : 0;
  const panelH = body.height + 36 + buttonBand;

  const spotlit =
    holes.length > 0
      ? holes.reduce((all, h) => Phaser.Geom.Rectangle.Union(all, h), holes[0])
      : new Phaser.Geom.Rectangle(W / 2, H / 2, 0, 0);

  // The panel rect a given center would occupy once clamped into the viewport,
  // and how much of the lit regions it would cover there.
  const placed = (x: number, y: number) =>
    new Phaser.Geom.Rectangle(
      Phaser.Math.Clamp(x, panelW / 2 + 10, W - panelW / 2 - 10) - panelW / 2,
      Phaser.Math.Clamp(y, panelH / 2 + 10, H - panelH / 2 - 10) - panelH / 2,
      panelW,
      panelH
    );
  const covers = (r: Phaser.Geom.Rectangle) =>
    holes.reduce((sum, h) => {
      const i = Phaser.Geom.Rectangle.Intersection(h, r);
      return sum + i.width * i.height;
    }, 0);

  // Candidates in preference order: clear of each side of the lit area, roomiest
  // side first, then a coarse sweep of the viewport for steps whose lit regions
  // leave no room on any one side. The first that covers nothing wins, so a
  // single-anchor step still lands on its roomiest side as it always has.
  const gap = 18;
  const space = { above: spotlit.y, below: H - spotlit.bottom, left: spotlit.x, right: W - spotlit.right };
  const sideSpot: Record<keyof typeof space, [number, number]> = {
    above: [spotlit.centerX, spotlit.y - panelH / 2 - gap],
    below: [spotlit.centerX, spotlit.bottom + panelH / 2 + gap],
    left: [spotlit.x - panelW / 2 - gap, spotlit.centerY],
    right: [spotlit.right + panelW / 2 + gap, spotlit.centerY]
  };
  const candidates = (Object.keys(space) as (keyof typeof space)[])
    .sort((a, b) => space[b] - space[a])
    .map(side => sideSpot[side]);
  const SWEEP = 4;
  for (let row = 0; row <= SWEEP; row++) {
    for (let col = 0; col <= SWEEP; col++) {
      candidates.push([(W * col) / SWEEP, (H * row) / SWEEP]);
    }
  }

  let spot = placed(candidates[0][0], candidates[0][1]);
  let spotCover = covers(spot);
  for (const [x, y] of candidates.slice(1)) {
    if (spotCover === 0) break;
    const r = placed(x, y);
    const c = covers(r);
    if (c < spotCover) {
      spot = r;
      spotCover = c;
    }
  }
  const px = spot.centerX;
  const py = spot.centerY;

  const panel = addPanel(scene, px, py, panelW, panelH).setDepth(PANEL_DEPTH);
  objects.push(panel);
  body.setPosition(px, py - panelH / 2 + 18);
  objects.push(body);

  if (opts.onContinue) {
    // 0.7 of the parchment is the look on a roomy viewport; on a narrow one the
    // panel is the tighter constraint, so take whichever is smaller.
    const btnMaxW = Math.min(panelW - 40, 340 * 0.7);
    const btn = bannerButton(scene, px, py + panelH / 2 - 30, 'Continue', () => opts.onContinue!(), btnMaxW);
    btn.setDepth(BUTTON_DEPTH);
    objects.push(btn);
  }

  return {
    objects,
    destroy() {
      for (const o of objects) o.destroy();
    }
  };
}
