import Phaser from "phaser";
import { polygonPoints } from "./geometry";
import { COLORS, CSS, DIE_BORDER, SERIF } from "./palette";
import type { DieEffect } from "../systems/DieEffects";

/**
 * The die's appearance, in the die's own 96-unit design space and nothing else.
 *
 * Two things draw a die, and they have to agree to the pixel: `art/textures`
 * bakes these shapes and glyphs into `die-N` / `die-atlas` at boot, and
 * `ui/DieSprite` draws them live as Graphics and Text when the grid magnifies a
 * die past the resolution those textures were baked at (see `dieSharpness`).
 * Keeping both callers on one definition is the whole point of this file — a
 * die that changed shape or shifted its numeral when the player zoomed in would
 * be worse than a soft one.
 *
 * Every measurement here is in *designed* pixels. The bake multiplies them by
 * its bake scale; the live path leaves them alone and lets the object's own
 * scale and the camera do the work.
 */

/** The box one die occupies, and its centre. `buildDice` bakes a texture this
 *  size, so an `artImage` of it centres design point (48, 48) on the sprite. */
export const DIE_SIZE = 96;
export const DIE_CENTER = 48;

/** The cell one baked face or type label occupies. Only the atlas needs this —
 *  it is the packing grid, not a property of the art. */
export const FACE_CELL = 76;

/** Type sizes the face numeral and the "dN" label are designed at. */
export const FACE_NUMERAL_PX = 34;
export const FACE_LABEL_PX = 13;

/** Where the face numeral and the type label sit relative to the die's centre.
 *  `DieSprite` positions its baked images at these offsets, so the live glyphs
 *  have to start from the same two numbers. */
export const FACE_OFFSET_Y = -4;
export const LABEL_OFFSET_Y = 36;

/** The cross an inert die wears: how far each arm reaches from the die's centre,
 *  and how thick it is drawn. Sized to cross the body with a margin inside its
 *  rounded corners, and to stay clear of the `FACE_CELL` the atlas packs it
 *  into. */
export const STRIKE_REACH = 30;
export const STRIKE_WIDTH = 6;

/** Optical lift applied to a face numeral, as a fraction of the digit's own
 *  height — see `numeralYOffset`. The d6 is the one die whose numeral sits in
 *  the upper, undivided half of a square body, where the extra lift read as
 *  simply too high. */
const NUMERAL_LIFT = 0.15;
const NUMERAL_LIFT_D6 = 0;

/**
 * Draw one die body into `g`, in a 96x96 box with its top-left at the origin,
 * shaped by side count so the grid reads at a glance: d1/d2 coin, d4 triangle,
 * d6 square, d8/d10 octagon, d20+ hex.
 *
 * A die carrying per-die effects (see `systems/DieEffects`) swaps its ivory for
 * each effect's shade and texture — one vertical slice of the body per effect,
 * so a die carrying two reads as half one, half the other. `plate` keeps a
 * clear patch behind the type; pass false for an icon drawn without a face.
 *
 * Lays down fill and stroke only — no transform of its own — so the bake can
 * scale the Graphics before generating a texture from it and the live path can
 * scale it to the die's layout size, both from this one path.
 */
export function drawDieBody(
  g: Phaser.GameObjects.Graphics,
  sides: number,
  effects: readonly DieEffect[] = [],
  plate = true,
): void {
  const border = DIE_BORDER[sides];
  const cx = DIE_CENTER;
  const outline = dieOutline(sides);

  if (effects.length === 0) {
    // A plain die keeps its exact curves; the outline is only an approximation
    // of the coin and the rounded square, good enough to clip textures to.
    g.fillStyle(COLORS.ivory, 1);
    if (sides <= 2) g.fillCircle(cx, COIN_CY, 36);
    else if (sides === 6) g.fillRoundedRect(0, 0, 96, 96, 18);
    else g.fillPoints(outline, true);
  } else {
    drawEffectFill(g, sides, outline, effects, plate);
  }

  if (sides <= 2) {
    // Coin: sits a touch high so the "d1"/"d2" label below has clear air.
    const scy = COIN_CY;
    g.fillStyle(0xffffff, 0.1);
    g.fillEllipse(cx - 9, scy - 12, 26, 15);
    g.lineStyle(5, border, 1);
    g.strokeCircle(cx, scy, 33.5);
  } else if (sides === 4) {
    // Point-up triangle, flat base, so the label sits clear beneath it.
    g.fillStyle(0xffffff, 0.1);
    g.fillEllipse(cx - 8, 34, 24, 14);
    g.lineStyle(5, border, 1);
    strokeClosed(g, outline);
  } else if (sides === 6) {
    g.fillStyle(0x000000, 0.08);
    g.fillRoundedRect(6, 58, 84, 32, { tl: 0, tr: 0, bl: 14, br: 14 });
    g.lineStyle(5, border, 1);
    g.strokeRoundedRect(2.5, 2.5, 91, 91, 16);
  } else {
    g.fillStyle(0xffffff, 0.1);
    g.fillEllipse(cx - 9, 28, 24, 14);
    g.lineStyle(5, border, 1);
    strokeClosed(g, outline);
  }
}

/**
 * Stroke a closed polygon outline. Phaser's WebGL renderer never joins a closed
 * path's last segment back onto its first, so `strokePoints(pts, true)` leaves a
 * notch at the starting vertex — invisible in the canvas-baked texture, but
 * plain on the live bodies a magnified die draws. Running the path one segment
 * past its start lets that corner get the same join as every other.
 */
function strokeClosed(
  g: Phaser.GameObjects.Graphics,
  pts: Phaser.Math.Vector2[],
): void {
  g.strokePoints([...pts, pts[0], pts[1]], false, false);
}

/** Where a coin (d1/d2) sits: a touch high, so its label has clear air. */
const COIN_CY = 42;

/**
 * The die body's filled silhouette as one convex polygon in the 96-unit design
 * space. Convex on purpose: it is also the window every effect texture is
 * clipped to, and clipping against a convex polygon is a few lines.
 */
export function dieOutline(sides: number): Phaser.Math.Vector2[] {
  if (sides <= 2) return polygonPoints(DIE_CENTER, COIN_CY, 36, 48);
  if (sides === 4) return polygonPoints(DIE_CENTER, 44, 46, 3, -90);
  if (sides === 6) return roundedRectPoints(0, 0, 96, 96, 18);
  if (sides === 8 || sides === 10)
    return polygonPoints(DIE_CENTER, 40, 40, 8, -90 - 22.5);
  return polygonPoints(DIE_CENTER, 40, 43, 6, 0);
}

function roundedRectPoints(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): Phaser.Math.Vector2[] {
  const pts: Phaser.Math.Vector2[] = [];
  const corners: [number, number, number][] = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ];
  for (const [ccx, ccy, start] of corners) {
    for (let i = 0; i <= 6; i++) {
      const a = Phaser.Math.DegToRad(start + (90 * i) / 6);
      pts.push(
        new Phaser.Math.Vector2(ccx + r * Math.cos(a), ccy + r * Math.sin(a)),
      );
    }
  }
  return pts;
}

// --- Effect shades -----------------------------------------------------------

type Pt = { x: number; y: number };
type Pattern =
  | "lattice"
  | "stripes"
  | "rays"
  | "dots"
  | "waves"
  | "checks"
  | "bars"
  | "chevrons"
  | "columns";

/**
 * What each effect looks like: a shade laid over the body and a texture drawn
 * on it in a deeper tone of the same colour. Every effect differs from every
 * other in both, so neither colour alone nor texture alone has to carry the
 * distinction — which matters to a colour-blind player, and on a d1 coin whose
 * face leaves little texture showing. The three highest-face effects share the
 * gold family on purpose: they are one idea at three strengths.
 */
export const DIE_EFFECT_STYLE: Record<
  DieEffect,
  { color: number; pattern: Pattern }
> = {
  windfall4: { color: 0xf08a2c, pattern: "lattice" },
  windfall2: { color: 0xe8c040, pattern: "stripes" },
  ascension: { color: 0xf7e39a, pattern: "rays" },
  royalSeal: { color: 0xd9556a, pattern: "dots" },
  voice: { color: 0x6fa8e6, pattern: "waves" },
  wild: { color: 0x72c66c, pattern: "checks" },
  loaded: { color: 0x9aa6b4, pattern: "bars" },
  ballast: { color: 0xa47a52, pattern: "chevrons" },
  anvil: { color: 0x4fbcae, pattern: "columns" },
};

/** How far toward an effect's colour its shade takes the ivory body. */
const SHADE_MIX = 0.62;
/** How far toward black an effect's texture is taken from its colour. */
const TEXTURE_DARKEN = 0.3;
const TEXTURE_ALPHA = 0.55;
/** How far toward an effect's colour the clear plate under the numeral goes:
 *  enough to belong to the slice it sits in, not so much that the ink on it
 *  loses contrast. */
const PLATE_MIX = 0.2;

/**
 * The untextured plates a shaded die keeps clear behind its type, so the
 * numeral (and, on a d6, the "d6" printed on the body) is never read through a
 * pattern. Sized per shape to sit inside the body with a margin of texture
 * still showing around it; the numeral's centre is `FACE_OFFSET_Y` above the
 * die's centre on every shape.
 */
function platesFor(sides: number): Pt[][] {
  // Centred on the digits' ink rather than on `FACE_OFFSET_Y`: every face but
  // the d6's is lifted a little above that point (see `numeralYOffset`), and a
  // plate centred below its numeral reads as having slipped.
  const cy = DIE_CENTER + FACE_OFFSET_Y - numeralInkLift(sides);
  if (sides <= 2) return [ellipsePoints(DIE_CENTER, cy, 22, 22)];
  if (sides === 4) return [ellipsePoints(DIE_CENTER, cy, 18, 18)];
  if (sides === 6)
    return [
      ellipsePoints(DIE_CENTER, cy, 28, 25),
      roundedRectPoints(
        DIE_CENTER - 17,
        DIE_CENTER + LABEL_OFFSET_Y - 8,
        34,
        16,
        8,
      ),
    ];
  if (sides === 8 || sides === 10)
    return [ellipsePoints(DIE_CENTER, cy, 28, 23)];
  return [ellipsePoints(DIE_CENTER, cy, 31, 23)];
}

/** Fill `outline` with one slice per effect, each its shade plus texture, and
 *  a clear plate behind the type. */
function drawEffectFill(
  g: Phaser.GameObjects.Graphics,
  sides: number,
  outline: Pt[],
  effects: readonly DieEffect[],
  plate: boolean,
): void {
  const slices: Pt[][] = [];
  const xs = outline.map((p) => p.x);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const span = (right - left) / effects.length;
  effects.forEach((effect, i) => {
    // A slice is the outline cut to one vertical band. The first and last
    // bands overshoot the body so rounding never leaves a hairline of ivory.
    const x0 = i === 0 ? -10 : left + span * i;
    const x1 = i === effects.length - 1 ? 106 : left + span * (i + 1);
    const slice = clipPolygon(outline, [
      { x: x0, y: -10 },
      { x: x1, y: -10 },
      { x: x1, y: 106 },
      { x: x0, y: 106 },
    ]);
    slices[i] = slice;
    if (slice.length < 3) return;
    const style = DIE_EFFECT_STYLE[effect];
    g.fillStyle(mixColor(COLORS.ivory, style.color, SHADE_MIX), 1);
    g.fillPoints(slice, true);
    g.fillStyle(mixColor(style.color, 0x000000, TEXTURE_DARKEN), TEXTURE_ALPHA);
    for (const shape of patternShapes(style.pattern)) {
      const clipped = clipPolygon(shape, slice);
      if (clipped.length >= 3) g.fillPoints(clipped, true);
    }
  });
  // A seam between slices, so two neighbouring textures read as two effects
  // rather than one busy one.
  if (effects.length > 1) {
    g.lineStyle(1.5, COLORS.ink, 0.35);
    for (let i = 1; i < effects.length; i++) {
      const x = left + span * i;
      const seam = clipPolygon(outline, [
        { x: x - 0.01, y: -10 },
        { x: x + 0.01, y: -10 },
        { x: x + 0.01, y: 106 },
        { x: x - 0.01, y: 106 },
      ]);
      if (seam.length < 2) continue;
      const ys = seam.map((p) => p.y);
      g.lineBetween(x, Math.min(...ys), x, Math.max(...ys));
    }
  }
  // The plates go down last, over the seams too: a seam through the numeral
  // is as hard to read past as a texture. Each is cut to the slices so a
  // mixed die keeps its halves right through the plate.
  // An icon that carries no numeral (a list's die, a badge's swatch) has
  // nothing to keep clear, and a blank plate would only hide the texture.
  if (!plate) return;
  const plates = platesFor(sides);
  effects.forEach((effect, i) => {
    const slice = slices[i];
    if (!slice || slice.length < 3) return;
    const color = DIE_EFFECT_STYLE[effect].color;
    g.fillStyle(mixColor(COLORS.ivory, color, PLATE_MIX), 1);
    for (const plate of plates) {
      const clipped = clipPolygon(plate, slice);
      if (clipped.length >= 3) g.fillPoints(clipped, true);
    }
  });
  g.lineStyle(1.5, COLORS.ink, 0.28);
  for (const plate of plates)
    g.strokePoints(
      plate.map((p) => new Phaser.Math.Vector2(p.x, p.y)),
      true,
      true,
    );
}

/** Every convex piece of a texture, laid over the whole 96x96 box. The caller
 *  clips each piece to the slice it is filling. */
function patternShapes(pattern: Pattern): Pt[][] {
  const shapes: Pt[][] = [];
  switch (pattern) {
    case "stripes":
      for (let o = -96; o < 192; o += 16) shapes.push(band(o, 7, 45));
      break;
    case "lattice":
      for (let o = -96; o < 192; o += 15) {
        shapes.push(band(o, 4.5, 45));
        shapes.push(band(o, 4.5, -45));
      }
      break;
    case "rays": {
      const cy = 44;
      const rays = 16;
      for (let i = 0; i < rays; i += 2) {
        const a0 = (Math.PI * 2 * i) / rays;
        const a1 = (Math.PI * 2 * (i + 1)) / rays;
        shapes.push([
          { x: DIE_CENTER, y: cy },
          { x: DIE_CENTER + Math.cos(a0) * 90, y: cy + Math.sin(a0) * 90 },
          { x: DIE_CENTER + Math.cos(a1) * 90, y: cy + Math.sin(a1) * 90 },
        ]);
      }
      break;
    }
    case "dots":
      for (let row = 0; row * 13 < 110; row++) {
        const y = row * 13 + 2;
        for (let x = row % 2 ? 6.5 : 0; x < 104; x += 13)
          shapes.push(circlePoints(x, y, 3.6));
      }
      break;
    case "waves":
      for (let y = 4; y < 104; y += 14) {
        // One wave line as a run of short quads, each convex, so the clipper
        // can take them one at a time.
        const steps = 24;
        const wave = (x: number) => y + Math.sin((x / 96) * Math.PI * 4) * 3.5;
        for (let i = 0; i < steps; i++) {
          const xa = (i * 100) / steps - 2;
          const xb = ((i + 1) * 100) / steps - 2;
          shapes.push([
            { x: xa, y: wave(xa) - 2.2 },
            { x: xb, y: wave(xb) - 2.2 },
            { x: xb, y: wave(xb) + 2.2 },
            { x: xa, y: wave(xa) + 2.2 },
          ]);
        }
      }
      break;
    case "checks": {
      const cell = 12;
      for (let row = 0; row * cell < 96; row++)
        for (let col = row % 2; col * cell < 96; col += 2)
          shapes.push(rect(col * cell, row * cell, cell, cell));
      break;
    }
    case "bars":
      for (let y = 3; y < 100; y += 16) shapes.push(rect(-4, y, 104, 7));
      break;
    case "columns":
      for (let x = 3; x < 100; x += 14) shapes.push(rect(x, -4, 5, 104));
      break;
    case "chevrons":
      // Pointing down: the weight under a ballasted die.
      for (let y = -12; y < 104; y += 16) {
        for (let x = -6; x < 100; x += 24) {
          shapes.push([
            { x, y },
            { x: x + 5, y },
            { x: x + 17, y: y + 8 },
            { x: x + 12, y: y + 8 },
          ]);
          shapes.push([
            { x: x + 12, y: y + 8 },
            { x: x + 17, y: y + 8 },
            { x: x + 29, y },
            { x: x + 24, y },
          ]);
        }
      }
      break;
  }
  return shapes;
}

/** A straight band `width` thick across the whole box at `angleDeg`, offset
 *  `offset` along the box's diagonal. */
function band(offset: number, width: number, angleDeg: number): Pt[] {
  const a = Phaser.Math.DegToRad(angleDeg);
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // Normal to the band, and a centre on the line through the box.
  const nx = -dy;
  const ny = dx;
  const cx = DIE_CENTER + nx * (offset - DIE_CENTER);
  const cy = DIE_CENTER + ny * (offset - DIE_CENTER);
  const reach = 160;
  const h = width / 2;
  return [
    { x: cx - dx * reach + nx * h, y: cy - dy * reach + ny * h },
    { x: cx + dx * reach + nx * h, y: cy + dy * reach + ny * h },
    { x: cx + dx * reach - nx * h, y: cy + dy * reach - ny * h },
    { x: cx - dx * reach - nx * h, y: cy - dy * reach - ny * h },
  ];
}

function rect(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < 40; i++) {
    const a = (Math.PI * 2 * i) / 40;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

function circlePoints(cx: number, cy: number, r: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * 2 * i) / 12;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

/**
 * Sutherland–Hodgman: the part of `subject` inside the convex polygon `clip`.
 * Either winding is accepted for `clip`.
 */
function clipPolygon(subject: Pt[], clip: Pt[]): Phaser.Math.Vector2[] {
  let area = 0;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area >= 0 ? 1 : -1;
  let output: Pt[] = subject;
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p: Pt) =>
      sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= 0;
    const cross = (p: Pt, q: Pt): Pt => {
      const d1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const d2 = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
      const t = d1 / (d1 - d2);
      return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    };
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) output.push(cross(prev, cur));
        output.push(cur);
      } else if (inside(prev)) {
        output.push(cross(prev, cur));
      }
    }
  }
  return output.map((p) => new Phaser.Math.Vector2(p.x, p.y));
}

/** `a` taken `t` of the way toward `b`, channel by channel. */
function mixColor(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

/** The cross an inert die wears, centred on the origin. */
export function drawDieStrike(g: Phaser.GameObjects.Graphics): void {
  g.lineStyle(STRIKE_WIDTH, COLORS.waxRed, 1);
  g.lineBetween(-STRIKE_REACH, -STRIKE_REACH, STRIKE_REACH, STRIKE_REACH);
  g.lineBetween(STRIKE_REACH, -STRIKE_REACH, -STRIKE_REACH, STRIKE_REACH);
}

/**
 * Phaser sizes a Text object's canvas from a fixed reference string
 * (`TextStyle.testString`, `"|MÉqgy"`) via `actualBoundingBoxAscent/Descent`,
 * not the string actually being rendered — so a digit-only glyph (no
 * descenders, and usually a shorter ascent than "É") ends up ink-off-center
 * within that canvas, and `setOrigin(0.5)` only centers the *canvas*, not
 * the glyph. Measure both against the real font to compute the exact draw
 * offset that lands the glyph's own ink at the target point, instead of
 * guessing a fixed pixel nudge.
 */
function numeralYOffset(
  fontSize: number,
  bold: boolean,
  liftFraction: number,
): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = `${bold ? "bold " : ""}${fontSize}px ${SERIF}`;

  const ref = ctx.measureText("|MÉqgy"); // matches Phaser's TextStyle.testString
  const refAscent = ref.actualBoundingBoxAscent;
  const refDescent = ref.actualBoundingBoxDescent;

  const digits = ctx.measureText("0123456789");
  const digitAscent = digits.actualBoundingBoxAscent;
  const digitDescent = digits.actualBoundingBoxDescent;

  const canvasCenter = (refAscent + refDescent) / 2;
  const glyphCenter = refAscent - (digitAscent - digitDescent) / 2;
  const inkCenteringOffset = canvasCenter - glyphCenter;

  // Ink-centering alone still read as slightly low — nudge further up by a
  // fraction of the digit's own rendered height for a more pleasing (if not
  // strictly mathematical) center.
  const numberHeight = digitAscent + digitDescent;
  const opticalLift = numberHeight * liftFraction;

  return inkCenteringOffset - opticalLift;
}

/** How far above `FACE_OFFSET_Y` a face numeral's ink is centred, in designed
 *  pixels: the optical lift `numeralYOffset` applies, measured against the
 *  same font. Measured once and kept, since plates are baked on demand. */
const inkLiftCache = new Map<number, number>();
function numeralInkLift(sides: number): number {
  const lift = sides === 6 ? NUMERAL_LIFT_D6 : NUMERAL_LIFT;
  let cached = inkLiftCache.get(lift);
  if (cached === undefined) {
    const ctx = document.createElement("canvas").getContext("2d");
    let height = FACE_NUMERAL_PX * 0.7;
    if (ctx) {
      ctx.font = `bold ${FACE_NUMERAL_PX}px ${SERIF}`;
      const digits = ctx.measureText("0123456789");
      height = digits.actualBoundingBoxAscent + digits.actualBoundingBoxDescent;
    }
    cached = height * lift;
    inkLiftCache.set(lift, cached);
  }
  return cached;
}

/**
 * How far a face numeral's *canvas* has to be pushed below the point its ink
 * should centre on, at `scale` times the designed type size.
 *
 * Measured rather than scaled from a designed constant because the metrics
 * `numeralYOffset` reads come back from the browser's own rasterizer, which is
 * free to hint a 34px face and a 238px one slightly differently.
 */
export function faceNumeralOffset(sides: number, scale = 1): number {
  return numeralYOffset(
    FACE_NUMERAL_PX * scale,
    true,
    sides === 6 ? NUMERAL_LIFT_D6 : NUMERAL_LIFT,
  );
}

/**
 * Style for a face numeral at `scale` times its designed size.
 *
 * `resolution` is the caller's, because the two callers want opposite things.
 * The bake wants 1: the glyph is already being rendered at `scale` times its
 * designed size into a target that is one atlas pixel to one texture pixel, and
 * asking for `DPR` on top would rasterize at another factor of three and then
 * minify it back down — a 3:1 bilinear minification with no mipmap samples 4 of
 * every 9 texels, and a *worse* face than drawing it 1:1. The live path wants
 * the magnification the camera is about to apply, which is the whole reason it
 * exists.
 */
export function faceNumeralStyle(
  scale: number,
  resolution: number,
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    fontFamily: SERIF,
    fontSize: `${FACE_NUMERAL_PX * scale}px`,
    color: CSS.ink,
    fontStyle: "bold",
    resolution,
  };
}

/** Style for a "dN" type label at `scale` times its designed size.
 *
 *  The d6 label sits inside the light ivory die body, so dark soft ink reads
 *  well. Every other die puts its label below the shape on the dark felt, where
 *  that same ink is nearly invisible — use a light parchment tone there. */
export function faceLabelStyle(
  sides: number,
  scale: number,
  resolution: number,
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    fontFamily: SERIF,
    fontSize: `${FACE_LABEL_PX * scale}px`,
    color: sides === 6 ? CSS.inkSoft : CSS.parchment,
    resolution,
  };
}
