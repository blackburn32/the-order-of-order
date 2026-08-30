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

export interface StoryFrame {
  /** The backdrop objects the scene slide must hold still. */
  backdrop: Phaser.GameObjects.GameObject[];
  /** Where the control block below the copy starts. */
  blockTop: number;
  /**
   * Draw one page's title, art and copy into a container of its own.
   *
   * Everything that changes from chapter to chapter lands in that container and
   * nothing else does, so a page turn slides one object off and the next one
   * in, leaving the room, the button and the dots exactly where they stand.
   */
  page(page: StoryPage): Phaser.GameObjects.Container;
}

/**
 * Lay out a story sequence: build the room it is told in, solve the geometry
 * every page shares, and hand back a factory for the pages themselves.
 *
 * The whole sequence is measured up front rather than one page at a time. The
 * text band is reserved as tall as the LONGEST blurb in the set, so the button
 * underneath sits at the same height on every page rather than walking up and
 * down as the copy changes length.
 */
export function buildStoryFrame(
  scene: Phaser.Scene,
  pages: readonly StoryPage[],
  ambience: number,
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

  const titleY = H * 0.09;
  const titleStyle: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: SERIF,
    fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.05, 26, 52))}px`,
    color: CSS.gold,
    fontStyle: "bold",
  };

  // Image sized to fit both width and the vertical band left between the title
  // and the text/controls below, keeping a 4:3 frame.
  const maxImgW = Math.min(W - 48, 560);
  const maxImgH = H * 0.42;
  const imgW = Math.min(maxImgW, maxImgH * (4 / 3));
  const imgH = imgW * (3 / 4);
  const imgCy = H * 0.36;

  const blurbStyle: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: SERIF,
    fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.022, 16, 22))}px`,
    color: CSS.parchment,
    align: "center",
    wordWrap: { width: Math.min(W - 48, 620) },
  };
  const blurbTop = imgCy + imgH / 2 + 26;

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

  const page = (which: StoryPage): Phaser.GameObjects.Container => {
    const parts: Phaser.GameObjects.GameObject[] = [];

    parts.push(
      scene.add
        .text(cx, titleY, which.title, titleStyle)
        .setOrigin(0.5)
        .setShadow(0, 3, "#000000", 8, false, true),
    );

    if (which.image && scene.textures.exists(which.image)) {
      // Fit the art entirely within the 4:3 frame without distorting it
      // (contain), so it never overflows the outlined region.
      const sprite = scene.add.image(cx, imgCy, which.image);
      const scale = Math.min(imgW / sprite.width, imgH / sprite.height);
      sprite.setScale(scale);
      parts.push(
        sprite,
        scene.add
          .rectangle(cx, imgCy, imgW, imgH)
          .setStrokeStyle(2, COLORS.gold, 0.4),
      );
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
      parts.push(
        image,
        scene.add
          .text(cx, imgCy, "4 : 3", {
            fontFamily: SERIF,
            fontSize: "18px",
            color: CSS.dim,
            fontStyle: "italic",
          })
          .setOrigin(0.5),
      );
    }

    parts.push(
      scene.add.text(cx, blurbTop, which.blurb, blurbStyle).setOrigin(0.5, 0),
    );

    // The container sits at the origin and its parts keep their screen
    // coordinates, so the page turn is a single x tween over the whole page.
    return scene.add.container(0, 0, parts);
  };

  // The control block sits just under the reserved text band with a little
  // padding, clamped so the whole of it stays on short screens.
  return {
    backdrop: [felt, ambient],
    blockTop: Math.min(blurbTop + maxBlurbH + 28, H - 150),
    page,
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
