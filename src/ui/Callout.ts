import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { addPanel, bannerButton } from './widgets';

export interface CalloutOptions {
  /** Screen-space rectangle of the element being pointed at. */
  anchor: Phaser.Geom.Rectangle;
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
 * A tutorial spotlight: dims the screen with four bands around `anchor`
 * (leaving the anchor lit and, by default, still interactive), draws a gold
 * highlight around it, and shows a parchment callout on whichever side has the
 * most room. Phaser rectangles can't have holes, so the "hole" is the gap the
 * four bands leave — see the band math below.
 */
export function showCallout(scene: Phaser.Scene, opts: CalloutOptions): CalloutHandle {
  const W = scene.scale.width;
  const H = scene.scale.height;
  const objects: Phaser.GameObjects.GameObject[] = [];

  const a = opts.anchor;
  const ax0 = Phaser.Math.Clamp(a.x - PAD, 0, W);
  const ay0 = Phaser.Math.Clamp(a.y - PAD, 0, H);
  const ax1 = Phaser.Math.Clamp(a.x + a.width + PAD, 0, W);
  const ay1 = Phaser.Math.Clamp(a.y + a.height + PAD, 0, H);

  // Four dim bands tiling the screen minus the anchor rect. Each swallows input
  // (topOnly is on, so they block whatever sits beneath them).
  const band = (x: number, y: number, w: number, h: number) => {
    if (w <= 0 || h <= 0) return;
    const r = scene.add.rectangle(x, y, w, h, DIM_COLOR, DIM_ALPHA).setOrigin(0, 0).setDepth(DIM_DEPTH);
    r.setInteractive(); // swallow clicks on the dimmed area
    objects.push(r);
  };
  band(0, 0, W, ay0); // top
  band(0, ay1, W, H - ay1); // bottom
  band(0, ay0, ax0, ay1 - ay0); // left
  band(ax1, ay0, W - ax1, ay1 - ay0); // right

  // Optionally block the anchor itself (a transparent lid at the same depth).
  if (opts.interactiveAnchor === false) {
    const lid = scene.add
      .rectangle(ax0, ay0, ax1 - ax0, ay1 - ay0, DIM_COLOR, 0.001)
      .setOrigin(0, 0)
      .setDepth(DIM_DEPTH);
    lid.setInteractive();
    objects.push(lid);
  }

  // Gold highlight around the spotlit element.
  const hilite = scene.add
    .rectangle((ax0 + ax1) / 2, (ay0 + ay1) / 2, ax1 - ax0, ay1 - ay0)
    .setStrokeStyle(3, COLORS.gold, 0.9)
    .setDepth(HILITE_DEPTH);
  objects.push(hilite);

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

  const acx = (ax0 + ax1) / 2;
  const acy = (ay0 + ay1) / 2;
  const space = { above: ay0, below: H - ay1, left: ax0, right: W - ax1 };
  const side = (Object.keys(space) as (keyof typeof space)[]).reduce((best, k) =>
    space[k] > space[best] ? k : best
  );

  let px = acx;
  let py = acy;
  const gap = 18;
  if (side === 'below') py = ay1 + panelH / 2 + gap;
  else if (side === 'above') py = ay0 - panelH / 2 - gap;
  else if (side === 'right') px = ax1 + panelW / 2 + gap;
  else px = ax0 - panelW / 2 - gap;
  px = Phaser.Math.Clamp(px, panelW / 2 + 10, W - panelW / 2 - 10);
  py = Phaser.Math.Clamp(py, panelH / 2 + 10, H - panelH / 2 - 10);

  const panel = addPanel(scene, px, py, panelW, panelH).setDepth(PANEL_DEPTH);
  objects.push(panel);
  body.setPosition(px, py - panelH / 2 + 18);
  objects.push(body);

  if (opts.onContinue) {
    const btn = bannerButton(scene, px, py + panelH / 2 - 30, 'Continue', () => opts.onContinue!());
    btn.setScale(0.7);
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
