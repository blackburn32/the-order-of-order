import Phaser from "phaser";
import { polygonPoints } from "./geometry";
import { COLORS, CSS, DIE_BORDER, SERIF } from "./palette";

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
 * Lays down fill and stroke only — no transform of its own — so the bake can
 * scale the Graphics before generating a texture from it and the live path can
 * scale it to the die's layout size, both from this one path.
 */
export function drawDieBody(
  g: Phaser.GameObjects.Graphics,
  sides: number,
): void {
  const border = DIE_BORDER[sides];
  const cx = DIE_CENTER;

  if (sides <= 2) {
    // Coin: sits a touch high so the "d1"/"d2" label below has clear air.
    const scy = 42;
    g.fillStyle(COLORS.ivory, 1);
    g.fillCircle(cx, scy, 36);
    g.fillStyle(0xffffff, 0.1);
    g.fillEllipse(cx - 9, scy - 12, 26, 15);
    g.lineStyle(5, border, 1);
    g.strokeCircle(cx, scy, 33.5);
  } else if (sides === 4) {
    // Point-up triangle, flat base, so the label sits clear beneath it.
    const pts = polygonPoints(cx, 44, 46, 3, -90);
    g.fillStyle(COLORS.ivory, 1);
    g.fillPoints(pts, true);
    g.fillStyle(0xffffff, 0.1);
    g.fillEllipse(cx - 8, 34, 24, 14);
    g.lineStyle(5, border, 1);
    g.strokePoints(pts, true, true);
  } else if (sides === 6) {
    g.fillStyle(COLORS.ivory, 1);
    g.fillRoundedRect(0, 0, 96, 96, 18);
    g.fillStyle(0x000000, 0.08);
    g.fillRoundedRect(6, 58, 84, 32, { tl: 0, tr: 0, bl: 14, br: 14 });
    g.lineStyle(5, border, 1);
    g.strokeRoundedRect(2.5, 2.5, 91, 91, 16);
  } else if (sides === 8 || sides === 10) {
    const pts = polygonPoints(cx, 40, 40, 8, -90 - 22.5);
    g.fillStyle(COLORS.ivory, 1);
    g.fillPoints(pts, true);
    g.fillStyle(0xffffff, 0.1);
    g.fillEllipse(cx - 9, 28, 24, 14);
    g.lineStyle(5, border, 1);
    g.strokePoints(pts, true, true);
  } else {
    // d20+: flat-top/flat-bottom hex, the classic "d20 icon" silhouette.
    const pts = polygonPoints(cx, 40, 43, 6, 0);
    g.fillStyle(COLORS.ivory, 1);
    g.fillPoints(pts, true);
    g.fillStyle(0xffffff, 0.1);
    g.fillEllipse(cx - 9, 28, 24, 14);
    g.lineStyle(5, border, 1);
    g.strokePoints(pts, true, true);
  }
}

/** The cross an inert die wears, centred on the origin. */
export function drawDieStrike(g: Phaser.GameObjects.Graphics): void {
  g.lineStyle(STRIKE_WIDTH, COLORS.waxRed, 1);
  g.lineBetween(-STRIKE_REACH, -STRIKE_REACH, STRIKE_REACH, STRIKE_REACH);
  g.lineBetween(STRIKE_REACH, -STRIKE_REACH, -STRIKE_REACH, STRIKE_REACH);
}

/** The gold marker a max-face die wears, centred on the origin. Matches the
 *  baked `pip-gold`, which is a 12x12 texture holding a radius-5 circle. */
export function drawDiePip(g: Phaser.GameObjects.Graphics): void {
  g.fillStyle(COLORS.gold, 1);
  g.fillCircle(0, 0, 5);
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
