// How a card answers the pointer.
//
// Every screen that lays out cards the player can take used to answer a hover by
// growing the card a percent or two. That reads well in a mockup and badly on a
// real screen: a card is a parchment texture with Text objects laid on it, and
// Text is a texture too — baked at the size it was created at. Scaling the
// container resamples all of it, so the copy on the card goes soft for exactly
// as long as the pointer is over the one card the player is trying to read.
//
// So a hover is a change of LIGHT rather than of size. An additive wash the
// shape of the card's own face is switched on above the parchment and below the
// copy: the card brightens, every glyph stays on its own pixel, and nothing
// moves. It costs one hidden image per card and no tween.

import Phaser from "phaser";
import { COLORS } from "../art/palette";

/** How strongly the wash lifts the parchment. Additive, so this is a good deal
 *  brighter than the same figure would be as a plain overlay — enough that the
 *  card is unmistakably the one under the pointer, short of looking selected. */
const HOVER_ALPHA = 0.16;

export interface CardHoverOptions {
  /** The card's own face, which the wash is cut to the shape and size of.
   *  Defaults to the container's first child, which is the parchment on every
   *  card in the game. */
  face?: Phaser.GameObjects.Image;
  /** Strength of the wash, for a card drawn on something other than parchment. */
  alpha?: number;
}

/**
 * Light `card` while the pointer is over it.
 *
 * The caller still owns the hit area and the click — this only adds the
 * feedback, so a screen can decide separately which of its cards are takeable.
 * Safe to call on a container whose face is missing; it simply does nothing
 * rather than guessing at a shape to wash.
 */
export function attachCardHover(
  scene: Phaser.Scene,
  card: Phaser.GameObjects.Container,
  opts: CardHoverOptions = {},
): void {
  const face =
    opts.face ??
    (card.list.find((child) => child instanceof Phaser.GameObjects.Image) as
      Phaser.GameObjects.Image | undefined);
  if (!face) return;

  const wash = scene.add
    .image(face.x, face.y, face.texture.key)
    .setDisplaySize(face.displayWidth, face.displayHeight)
    .setTint(COLORS.goldLight)
    .setAlpha(opts.alpha ?? HOVER_ALPHA)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setVisible(false);

  // Above the parchment so it lights it, below the copy so the ink is not
  // washed out along with it.
  card.addAt(wash, card.list.indexOf(face) + 1);

  card.on("pointerover", () => wash.setVisible(true));
  card.on("pointerout", () => wash.setVisible(false));
  // A card taken by a pointer that never leaves it (a tap on a touch screen)
  // would otherwise be destroyed with its wash still lit, and the next screen
  // built in its place would inherit a hover nobody is performing.
  card.on("pointerdown", () => wash.setVisible(false));
}
