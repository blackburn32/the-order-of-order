import Phaser from "phaser";
import { COLORS } from "../art/palette";
import { MARK_PLAIN, MARK_STRONG, MARK_STRUCK } from "../systems/Items";

/**
 * Card copy that needs more than one face inside a single wrapped paragraph.
 * The only such copy today is an upgrade figure (see `upgrade` in
 * systems/Items): the value the card gives now, struck out, followed by the
 * value another copy would buy, in bold.
 *
 * A Phaser Text is one face from end to end, so marked copy is laid out here
 * instead. The paragraph is wrapped by hand against the same width and by the
 * same greedy rule Phaser's own `basicWordWrap` uses, so a marked line breaks
 * where an unmarked one would; each run of a single face becomes its own Text;
 * and the struck runs are slashed through. What comes back is a Container sized
 * to the block it fills and centred on its position, so a card can place and
 * measure it exactly as it did the Text it replaces.
 */

export interface CopyStyle {
  fontFamily: string;
  /** The size the copy is drawn at, in pixels. */
  fontSizePx: number;
  color: string;
  /** The width the paragraph wraps against, as Phaser's `wordWrap` uses it. */
  wrapWidth: number;
}

/** Whether a string carries face marks, and so has to be set by
 *  `buildRichCopy` rather than as a plain Text. */
export function isMarked(text: string): boolean {
  return (
    text.includes(MARK_STRUCK) ||
    text.includes(MARK_STRONG) ||
    text.includes(MARK_PLAIN)
  );
}

/** How copy is set. The two are independent so the pair stays open to a struck
 *  bold figure, even though nothing prints one today. */
interface Face {
  struck: boolean;
  strong: boolean;
}

const PLAIN: Face = { struck: false, strong: false };
const STRUCK: Face = { struck: true, strong: false };
const STRONG: Face = { struck: false, strong: true };

const sameFace = (a: Face, b: Face) =>
  a.struck === b.struck && a.strong === b.strong;

/** A run of copy set in one face, with the width it measures at. */
interface Segment {
  text: string;
  face: Face;
  width: number;
}

interface Line {
  segments: Segment[];
  width: number;
}

/** Measuring happens before any Text exists, so it is done against a canvas of
 *  our own — the same 2D `measureText` Phaser lays its own text out with. */
let measureContext: CanvasRenderingContext2D | undefined;
function measurer(): CanvasRenderingContext2D {
  if (!measureContext) {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("no 2d context for text measurement");
    measureContext = context;
  }
  return measureContext;
}

/** The CSS font a face is drawn in, built the way Phaser's TextStyle builds its
 *  own — style, then size, then family — so both measure the same glyphs. */
function fontFor(face: Face, style: CopyStyle): string {
  return `${face.strong ? "bold " : ""}${style.fontSizePx}px ${style.fontFamily}`;
}

function widthOf(text: string, face: Face, style: CopyStyle): number {
  const context = measurer();
  context.font = fontFor(face, style);
  return context.measureText(text).width;
}

/** The marked string as characters carrying the face they are set in, with the
 *  marks themselves consumed. */
function faced(text: string): { char: string; face: Face }[] {
  let face = PLAIN;
  const out: { char: string; face: Face }[] = [];
  for (const char of text) {
    if (char === MARK_STRUCK) face = STRUCK;
    else if (char === MARK_STRONG) face = STRONG;
    else if (char === MARK_PLAIN) face = PLAIN;
    else out.push({ char, face });
  }
  return out;
}

/** Neighbouring characters of one face become one run, which is then measured
 *  whole: a run's width is not the sum of its letters', and only whole runs are
 *  ever drawn. */
function runs(
  chars: { char: string; face: Face }[],
  style: CopyStyle,
): Segment[] {
  const segments: Segment[] = [];
  for (const { char, face } of chars) {
    const last = segments[segments.length - 1];
    if (last && sameFace(last.face, face)) last.text += char;
    else segments.push({ text: char, face, width: 0 });
  }
  for (const segment of segments) {
    segment.width = widthOf(segment.text, segment.face, style);
  }
  return segments;
}

/**
 * Greedy word wrap, following Phaser's `basicWordWrap`: a word is carried to
 * the next line once it no longer fits the room left, and the first word of a
 * line is never carried however long it runs. Words are measured in the faces
 * they are actually set in, so a bold figure claims the room it will occupy.
 */
function wrap(text: string, style: CopyStyle): Line[] {
  const spaceWidth = widthOf(" ", PLAIN, style);
  const lines: Line[] = [];

  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    // Split at spaces first, so a word never straddles a line break, then
    // resolve each word into the runs it is set in.
    const words: { char: string; face: Face }[][] = [[]];
    for (const entry of faced(paragraph)) {
      if (entry.char === " ") words.push([]);
      else words[words.length - 1].push(entry);
    }

    let line: Line = { segments: [], width: 0 };
    let spaceLeft = style.wrapWidth;
    lines.push(line);

    words.forEach((word, index) => {
      const segments = runs(word, style);
      const wordWidth = segments.reduce((sum, s) => sum + s.width, 0);
      const claimed =
        index === words.length - 1 ? wordWidth : wordWidth + spaceWidth;
      if (claimed > spaceLeft && line.segments.length > 0) {
        line = { segments: [], width: 0 };
        lines.push(line);
        spaceLeft = style.wrapWidth;
      }
      // The space that separated this word from the one before it is only
      // printed where the two ended up on the same line.
      if (line.segments.length > 0) {
        line.segments.push({ text: " ", face: PLAIN, width: spaceWidth });
        line.width += spaceWidth;
      }
      line.segments.push(...segments);
      line.width += wordWidth;
      spaceLeft -= claimed;
    });
  }

  // A word and the space before it arrive as separate runs, so fold each line
  // back down to one segment per face before any of it is drawn.
  for (const line of lines) {
    const merged: Segment[] = [];
    for (const segment of line.segments) {
      const last = merged[merged.length - 1];
      if (last && sameFace(last.face, segment.face)) last.text += segment.text;
      else merged.push({ ...segment });
    }
    for (const segment of merged) {
      segment.width = widthOf(segment.text, segment.face, style);
    }
    line.segments = merged;
    line.width = merged.reduce((sum, s) => sum + s.width, 0);
  }

  return lines;
}

/**
 * A struck figure is cancelled with a diagonal slash in wax red rather than a
 * horizontal rule in the copy's own ink. A rule at x-height is easy to miss on
 * a two-character figure — on a lone `1` it barely outruns the digit, and in
 * the card's serif it reads as part of the glyph. A slash crosses the figure's
 * whole box at an angle nothing in the type does, and the red says "cancelled"
 * before the shape has been read at all.
 */
const SLASH_COLOR = COLORS.waxRed;
/** The point size divided by this is how thick the slash is drawn. */
const SLASH_WEIGHT = 8;
/** How far past the figure the slash runs, as a share of the point size, so it
 *  reads as a mark struck over the figure rather than a glyph of its own. */
const SLASH_OVERSHOOT = 0.14;
/** Share of the point size taken as the ink height of a struck run, for the
 *  rare engine that reports no glyph bounds. Roughly a digit's cap height. */
const FALLBACK_INK = 0.7;

/** The string Phaser's TextStyle sizes every Text's canvas from, whatever the
 *  Text actually says (`TextStyle.testString`). */
const BOX_STRING = "|MÉqgy";

/** Where a single line's ink sits inside the box Phaser draws it in, and how
 *  big that ink is. */
export interface InkBox {
  /** Add to a Text's y — with `setOrigin(0.5)` — to land its ink, rather than
   *  its box, on the point it is meant to sit on. */
  dy: number;
  width: number;
  height: number;
}

/**
 * Measure one line's ink against the font it will be drawn in. A Text's box is
 * sized from `BOX_STRING` and not from what is printed in it, so it carries the
 * room an accented capital and a descender would need whether or not the line
 * has either; `setOrigin(0.5)` centres that box, which leaves a short string —
 * a numeral, a word set in figures with neither ascender nor descender —
 * sitting high inside it. Anything drawn around such a line (here, a lozenge)
 * has to be placed against its ink instead.
 */
export function inkBox(font: string, text: string): InkBox {
  const context = measurer();
  context.font = font;
  const box = context.measureText(BOX_STRING);
  const ink = context.measureText(text);
  if (!ink.actualBoundingBoxAscent) {
    const size = Number.parseFloat(font) || 0;
    return { dy: 0, width: ink.width, height: size * FALLBACK_INK };
  }
  // Both are measured from the same baseline, which sits `box.ascent` below
  // the top of the box.
  const boxCentre =
    (box.actualBoundingBoxAscent + box.actualBoundingBoxDescent) / 2;
  const inkCentre =
    box.actualBoundingBoxAscent -
    (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2;
  return {
    dy: boxCentre - inkCentre,
    width: ink.width,
    height: ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent,
  };
}

export function buildRichCopy(
  scene: Phaser.Scene,
  text: string,
  style: CopyStyle,
): Phaser.GameObjects.Container {
  const lines = wrap(text, style);
  const context = measurer();

  // Every run is drawn first and placed second: the line height and the
  // baseline within it come off the font's own metrics, which only exist once
  // Phaser has measured the font.
  const drawn = lines.map((line) =>
    line.segments.map((segment) =>
      scene.add
        .text(0, 0, segment.text, {
          fontFamily: style.fontFamily,
          fontSize: `${style.fontSizePx}px`,
          color: style.color,
          ...(segment.face.strong ? { fontStyle: "bold" } : {}),
        })
        .setOrigin(0, 0.5),
    ),
  );

  const all = drawn.flat();
  // A one-line Text carrying neither padding nor stroke is exactly one line box
  // tall and draws its baseline an ascent below its top — the same two figures
  // Phaser lays its own paragraphs out with.
  const lineHeight = Math.max(...all.map((t) => t.height));
  const ascent = Math.max(...all.map((t) => t.getTextMetrics().ascent));
  const blockHeight = lineHeight * lines.length;
  const blockWidth = Math.max(...lines.map((line) => line.width));

  const slashes = scene.add.graphics();
  slashes.lineStyle(
    Math.max(1, Math.round(style.fontSizePx / SLASH_WEIGHT)),
    SLASH_COLOR,
    1,
  );
  const overshoot = style.fontSizePx * SLASH_OVERSHOOT;

  lines.forEach((line, row) => {
    const centreY = -blockHeight / 2 + lineHeight * (row + 0.5);
    const baseline = centreY - lineHeight / 2 + ascent;
    // Each line is centred within the block, as `align: center` would set it.
    let x = -line.width / 2;
    line.segments.forEach((segment, column) => {
      drawn[row][column].setPosition(x, centreY);
      if (segment.face.struck) {
        // Drawn across the ink the run actually puts on the line rather than
        // across its box: a Text's box carries the font's leading, and a slash
        // sized to that would start and end in white space.
        context.font = fontFor(segment.face, style);
        const metrics = context.measureText(segment.text);
        const ink =
          metrics.actualBoundingBoxAscent || style.fontSizePx * FALLBACK_INK;
        // Foot of the figure on the left, shoulder on the right — the direction
        // a pen crosses something out.
        slashes.lineBetween(
          x - overshoot,
          baseline + overshoot,
          x + segment.width + overshoot,
          baseline - ink - overshoot,
        );
      }
      x += segment.width;
    });
  });

  const copy = scene.add.container(0, 0, [...all, slashes]);
  copy.setSize(blockWidth, blockHeight);
  return copy;
}
