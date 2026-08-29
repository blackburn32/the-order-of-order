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
import { addFelt } from "./widgets";

export interface StoryPage {
  title: string;
  blurb: string;
  /** Texture key loaded in BootScene. A page whose art has not been drawn yet
   *  falls back to the placeholder frame. */
  image?: string;
}

export interface StoryPageLayout {
  /** The backdrop objects the scene slide must hold still. */
  backdrop: Phaser.GameObjects.GameObject[];
  /** Where the control block below the copy starts. */
  blockTop: number;
}

/**
 * Draw one page and report where the controls below it go.
 *
 * `pages` is the whole sequence, not just the one being drawn: the text band is
 * reserved as tall as the LONGEST blurb in the set, so the button underneath
 * sits at the same height on every page rather than walking up and down as the
 * copy changes length.
 */
export function buildStoryPage(
  scene: Phaser.Scene,
  page: StoryPage,
  pages: readonly StoryPage[],
  ambience: number,
): StoryPageLayout {
  const W = scene.scale.width;
  const H = scene.scale.height;
  const cx = W / 2;

  const felt = addFelt(scene);

  // The same living backdrop the menu and the trial screens carry, so the story
  // is told in the room the game is played in. Rebuilt with the rest of the
  // display list on each page turn, which re-draws the glyph — at this
  // brightness that reads as the room shifting between chapters.
  const ambient = new AmbientLayer(scene, { ring: true });
  ambient.setPosition(cx, H / 2);
  ambient.setArea(W, H);
  ambient.setProgress(ambience, false);

  scene.add
    .text(cx, H * 0.09, page.title, {
      fontFamily: SERIF,
      fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.05, 26, 52))}px`,
      color: CSS.gold,
      fontStyle: "bold",
    })
    .setOrigin(0.5)
    .setShadow(0, 3, "#000000", 8, false, true);

  // Image sized to fit both width and the vertical band left between the title
  // and the text/controls below, keeping a 4:3 frame.
  const maxImgW = Math.min(W - 48, 560);
  const maxImgH = H * 0.42;
  const imgW = Math.min(maxImgW, maxImgH * (4 / 3));
  const imgH = imgW * (3 / 4);
  const imgCy = H * 0.36;

  if (page.image && scene.textures.exists(page.image)) {
    // Fit the art entirely within the 4:3 frame without distorting it
    // (contain), so it never overflows the outlined region.
    const sprite = scene.add.image(cx, imgCy, page.image);
    const scale = Math.min(imgW / sprite.width, imgH / sprite.height);
    sprite.setScale(scale);
    scene.add
      .rectangle(cx, imgCy, imgW, imgH)
      .setStrokeStyle(2, COLORS.gold, 0.4);
  } else {
    // Placeholder 4:3 rectangle for pages without art yet.
    const image = scene.add.rectangle(
      cx,
      imgCy,
      imgW,
      imgH,
      COLORS.feltLight,
      0.6,
    );
    image.setStrokeStyle(2, COLORS.gold, 0.4);
    scene.add
      .text(cx, imgCy, "4 : 3", {
        fontFamily: SERIF,
        fontSize: "18px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5);
  }

  const blurbStyle: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: SERIF,
    fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.022, 16, 22))}px`,
    color: CSS.parchment,
    align: "center",
    wordWrap: { width: Math.min(W - 48, 620) },
  };
  const blurbTop = imgCy + imgH / 2 + 26;
  scene.add.text(cx, blurbTop, page.blurb, blurbStyle).setOrigin(0.5, 0);

  // Reserve a text band as tall as the *longest* blurb so the controls below
  // sit at the same y on every page — the button shouldn't jump as the copy
  // changes. (Measure off-screen, then discard.)
  const maxBlurbH = Math.max(
    ...pages.map((other) => {
      const probe = scene.add
        .text(0, 0, other.blurb, blurbStyle)
        .setVisible(false);
      const h = probe.height;
      probe.destroy();
      return h;
    }),
  );

  // The control block sits just under the reserved text band with a little
  // padding, clamped so the whole of it stays on short screens.
  return {
    backdrop: [felt, ambient],
    blockTop: Math.min(blurbTop + maxBlurbH + 28, H - 150),
  };
}

/** The page dots that close a sequence's control block. */
export function buildPageDots(
  scene: Phaser.Scene,
  cx: number,
  y: number,
  count: number,
  current: number,
): void {
  const dotGap = 22;
  for (let i = 0; i < count; i++) {
    const dot = scene.add.circle(
      cx + (i - (count - 1) / 2) * dotGap,
      y,
      5,
      COLORS.gold,
    );
    dot.setAlpha(i === current ? 1 : 0.35);
  }
}
