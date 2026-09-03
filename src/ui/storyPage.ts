// One page of a story sequence — the intro's chapters and the endings' acts.
//
// Both surfaces tell their story the same way: a title, a framed 4:3 image, a
// paragraph under it, and a control block that must not jump as the copy
// changes from page to page. That shared shape lives here so an ending page and
// an intro page are the same object drawn with different words, and so art
// dropped in later needs no code on either side.

import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { AmbientLayer } from "./AmbientLayer";
import {
  COMPACT_LANDSCAPE_MAX_H,
  compactColumns,
  isCompactLandscape,
} from "./layout";
import { addFelt, fitTextWidth } from "./widgets";

export interface StoryPage {
  title: string;
  blurb: string;
  /** Texture key loaded in BootScene. A page whose art has not been drawn yet
   *  falls back to the placeholder frame. */
  image?: string;
}

export interface StoryFrame {
  /** The backdrop objects the scene slide must hold still. */
  backdrop: Phaser.GameObjects.GameObject[];
  /** Where the control block below the copy starts. */
  blockTop: number;
  /** Horizontal centre the control block lays itself out around. Not always
   *  the middle of the screen: folded, the controls belong to one column. */
  blockX: number;
  /** Width the control block has to work in. */
  blockWidth: number;
  /** The line the control block must stay above. */
  blockBottom: number;
  /**
   * Draw one page's title, art and copy into a container of its own.
   *
   * Everything that changes from chapter to chapter lands in that container and
   * nothing else does, so a page turn slides one object off and the next one
   * in, leaving the room, the button and the dots exactly where they stand.
   */
  page(page: StoryPage): Phaser.GameObjects.Container;
}

/** Air between the bottom of the copy and the top of the control block. */
const BLOCK_GAP = 28;
/** The height a banner button stands at when nothing is squeezing it. Only an
 *  estimate — the button is built by the scene, not here — but it is what the
 *  copy above has to give way to, so the block lands in clear space. */
const BUTTON_NOMINAL_H = 62;
/** The least room the block is ever left with, however short the viewport:
 *  below this the button would be too small to hit. */
const MIN_BUTTON_H = 40;

/** Everything a story page's geometry has to answer, solved once for the
 *  viewport and then shared by every page in the sequence. */
interface StoryGeometry {
  titleStyle: Phaser.Types.GameObjects.Text.TextStyle;
  titleX: number;
  titleY: number;
  /** 0.5 where the title is centred on `titleY`, 0 where it hangs from it. */
  titleOriginY: number;
  titleMaxW: number;
  imgCx: number;
  imgCy: number;
  imgW: number;
  imgH: number;
  blurbStyle: Phaser.Types.GameObjects.Text.TextStyle;
  blurbX: number;
  blurbTop: number;
  blockTop: number;
  blockX: number;
  blockWidth: number;
  blockBottom: number;
}

/** Measures a run of strings in one style off-screen and reports the tallest.
 *  Both compositions reserve bands off type they are not drawing yet. */
type Measure = (
  style: Phaser.Types.GameObjects.Text.TextStyle,
  ...strings: string[]
) => number;

/**
 * Lay out a story sequence: build the room it is told in, solve the geometry
 * every page shares, and hand back a factory for the pages themselves.
 *
 * The whole sequence is measured up front rather than one page at a time. The
 * text band is reserved as tall as the LONGEST blurb in the set, so the button
 * underneath sits at the same height on every page rather than walking up and
 * down as the copy changes length.
 *
 * `blockTail` is what the caller's control block occupies *below* its button —
 * the page dots, and whatever else rides above them. The frame cannot measure a
 * block it does not build, so the caller declares its tail and the copy above
 * stops clear of the whole thing.
 */
export function buildStoryFrame(
  scene: Phaser.Scene,
  pages: readonly StoryPage[],
  ambience: number,
  blockTail = 34,
): StoryFrame {
  const W = scene.scale.width;
  const H = scene.scale.height;
  const cx = W / 2;

  const felt = addFelt(scene);

  // The same living backdrop the menu and the trial screens carry, so the story
  // is told in the room the game is played in. It belongs to the sequence
  // rather than to any one page: the room holds still from the moment the
  // sequence is entered until it is left, and only the pages turn within it.
  const ambient = new AmbientLayer(scene, { ring: true });
  ambient.setPosition(cx, H / 2);
  ambient.setArea(W, H);
  ambient.setProgress(ambience, false);

  // Measure off-screen, then discard.
  const measure: Measure = (style, ...strings) =>
    Math.max(
      ...strings.map((text) => {
        const probe = scene.add.text(0, 0, text, style).setVisible(false);
        const height = probe.height;
        probe.destroy();
        return height;
      }),
    );

  // A handset in landscape has width to spare and no height at all: stacking a
  // title over a picture over a paragraph over a button drives the button
  // through the middle of the paragraph, whatever the picture gives up. Folded,
  // the art takes one column and the words and controls the other.
  //
  // The shared threshold rules out columns below 500px because the denser game
  // screens need the width; a picture and a paragraph go on working in a narrow
  // one, and a short viewport has no other way to hold them — so this screen
  // folds on any short landscape view, as `AnalysisScene` does.
  const compact =
    isCompactLandscape(W, H) || (W > H && H < COMPACT_LANDSCAPE_MAX_H);
  const geometry = compact
    ? compactGeometry(scene, pages, measure, blockTail)
    : stackedGeometry(scene, pages, measure, blockTail);

  const page = (which: StoryPage): Phaser.GameObjects.Container => {
    const parts: Phaser.GameObjects.GameObject[] = [];
    const { imgCx, imgCy, imgW, imgH } = geometry;

    const title = scene.add
      .text(geometry.titleX, geometry.titleY, which.title, geometry.titleStyle)
      .setOrigin(0.5, geometry.titleOriginY)
      .setShadow(0, 3, "#000000", 8, false, true);
    // The font size has a legibility floor, so in a narrow column the clamp
    // stops shrinking the type before the longest title stops overflowing.
    fitTextWidth(title, geometry.titleMaxW);
    parts.push(title);

    if (which.image && scene.textures.exists(which.image)) {
      // Fit the art entirely within the 4:3 frame without distorting it
      // (contain), so it never overflows the outlined region.
      const sprite = scene.add.image(imgCx, imgCy, which.image);
      const scale = Math.min(imgW / sprite.width, imgH / sprite.height);
      sprite.setScale(scale);
      parts.push(
        sprite,
        scene.add
          .rectangle(imgCx, imgCy, imgW, imgH)
          .setStrokeStyle(2, COLORS.gold, 0.4),
      );
    } else {
      // Placeholder 4:3 rectangle for pages without art yet.
      const image = scene.add.rectangle(
        imgCx,
        imgCy,
        imgW,
        imgH,
        COLORS.feltLight,
        0.6,
      );
      image.setStrokeStyle(2, COLORS.gold, 0.4);
      parts.push(
        image,
        scene.add
          .text(imgCx, imgCy, "4 : 3", {
            fontFamily: SERIF,
            fontSize: "18px",
            color: CSS.dim,
            fontStyle: "italic",
          })
          .setOrigin(0.5),
      );
    }

    parts.push(
      scene.add
        .text(
          geometry.blurbX,
          geometry.blurbTop,
          which.blurb,
          geometry.blurbStyle,
        )
        .setOrigin(0.5, 0),
    );

    // The container sits at the origin and its parts keep their screen
    // coordinates, so the page turn is a single x tween over the whole page.
    return scene.add.container(0, 0, parts);
  };

  return {
    backdrop: [felt, ambient],
    blockTop: geometry.blockTop,
    blockX: geometry.blockX,
    blockWidth: geometry.blockWidth,
    blockBottom: geometry.blockBottom,
    page,
  };
}

/**
 * The tall composition: title, picture, paragraph and controls down the middle
 * of the screen.
 *
 * The picture is the part that gives. It is drawn at the proportions the
 * composition wants wherever there is room for them, and where there is not it
 * shrinks — from its top edge down, so it stays tucked under the title — until
 * the paragraph below it clears the control block's band at the foot of the
 * screen.
 */
function stackedGeometry(
  scene: Phaser.Scene,
  pages: readonly StoryPage[],
  measure: Measure,
  blockTail: number,
): StoryGeometry {
  const W = scene.scale.width;
  const H = scene.scale.height;
  const cx = W / 2;

  const titleStyle: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: SERIF,
    fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.05, 26, 52))}px`,
    color: CSS.gold,
    fontStyle: "bold",
  };

  const copyW = Math.min(W - 48, 620);
  const blurbStyle: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: SERIF,
    fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.022, 16, 22))}px`,
    color: CSS.parchment,
    align: "center",
    wordWrap: { width: copyW },
  };
  const maxBlurbH = measure(blurbStyle, ...pages.map((page) => page.blurb));

  // Image sized to fit both width and the vertical band left between the title
  // and the text/controls below, keeping a 4:3 frame.
  const maxImgW = Math.min(W - 48, 560);
  const maxImgH = H * 0.42;
  let imgW = Math.min(maxImgW, maxImgH * (4 / 3));
  let imgH = imgW * (3 / 4);
  let imgCy = H * 0.36;

  // The floor the copy has to clear — the control block's band at the foot of
  // the screen — and the shrink that gets the picture out of its way.
  const blockBottom = H - 16;
  const copyBottom = blockBottom - (BUTTON_NOMINAL_H + blockTail) - BLOCK_GAP;
  const overflow = imgCy + imgH / 2 + 26 + maxBlurbH - copyBottom;
  if (overflow > 0) {
    const imgTop = imgCy - imgH / 2;
    imgH = Math.max(60, imgH - overflow);
    imgW = imgH * (4 / 3);
    imgCy = imgTop + imgH / 2;
  }

  const blurbTop = imgCy + imgH / 2 + 26;

  return {
    titleStyle,
    titleX: cx,
    titleY: H * 0.09,
    titleOriginY: 0.5,
    titleMaxW: copyW,
    imgCx: cx,
    imgCy,
    imgW,
    imgH,
    blurbStyle,
    blurbX: cx,
    blurbTop,
    blockTop: Math.min(
      blurbTop + maxBlurbH + BLOCK_GAP,
      blockBottom - (MIN_BUTTON_H + blockTail),
    ),
    blockX: cx,
    // What `bannerButton` confines itself to when left to its own devices, so
    // the tall layout's buttons are sized exactly as they always were.
    blockWidth: W - 32,
    blockBottom,
  };
}

/**
 * The folded composition: the art down one column, the words and the controls
 * down the other, each filling the full height a short viewport still has.
 *
 * The right-hand column is centred as one block — title, paragraph and the
 * control block's reserved band together — rather than hung from the top, so
 * the words sit level with the picture beside them instead of stranding the
 * bottom of the column empty.
 */
function compactGeometry(
  scene: Phaser.Scene,
  pages: readonly StoryPage[],
  measure: Measure,
  blockTail: number,
): StoryGeometry {
  const columns = compactColumns(scene, { leftFraction: 0.44 });
  const { left, right } = columns;

  // Sized off the column rather than the viewport: a short landscape screen is
  // a wide one, and the tall layout's width-driven type would fill the column
  // edge to edge on its own.
  const titleStyle: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: SERIF,
    fontSize: `${Math.round(Phaser.Math.Clamp(right.width * 0.085, 20, 34))}px`,
    color: CSS.gold,
    fontStyle: "bold",
  };
  const blurbStyle: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: SERIF,
    fontSize: `${Math.round(Phaser.Math.Clamp(right.width * 0.048, 14, 19))}px`,
    color: CSS.parchment,
    align: "center",
    wordWrap: { width: right.width },
  };

  // The titles are set on one line — `fitTextWidth` shrinks the odd long one
  // rather than wrapping it — so any string measures the band they need.
  const titleH = measure(titleStyle, "Mg");
  const maxBlurbH = measure(blurbStyle, ...pages.map((page) => page.blurb));

  const titleGap = 12;
  const blockGap = 16;
  const stackH =
    titleH + titleGap + maxBlurbH + blockGap + BUTTON_NOMINAL_H + blockTail;
  const stackTop = columns.top + Math.max(0, (columns.height - stackH) / 2);
  const blurbTop = stackTop + titleH + titleGap;

  const imgW = Math.min(left.width, columns.height * (4 / 3));

  return {
    titleStyle,
    titleX: right.cx,
    titleY: stackTop,
    titleOriginY: 0,
    titleMaxW: right.width,
    imgCx: left.cx,
    imgCy: columns.top + columns.height / 2,
    imgW,
    imgH: imgW * (3 / 4),
    blurbStyle,
    blurbX: right.cx,
    blurbTop,
    blockTop: Math.min(
      blurbTop + maxBlurbH + blockGap,
      columns.bottom - (MIN_BUTTON_H + blockTail),
    ),
    blockX: right.cx,
    blockWidth: right.width,
    blockBottom: columns.bottom,
  };
}

/** The page dots that close a sequence's control block. Returned so the block
 *  can be rebuilt in place when the page turns. */
export function buildPageDots(
  scene: Phaser.Scene,
  cx: number,
  y: number,
  count: number,
  current: number,
): Phaser.GameObjects.Arc[] {
  const dotGap = 22;
  const dots: Phaser.GameObjects.Arc[] = [];
  for (let i = 0; i < count; i++) {
    const dot = scene.add.circle(
      cx + (i - (count - 1) / 2) * dotGap,
      y,
      5,
      COLORS.gold,
    );
    dot.setAlpha(i === current ? 1 : 0.35);
    dots.push(dot);
  }
  return dots;
}
