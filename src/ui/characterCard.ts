// The card a character is chosen from.
//
// Built on the same 260x340 parchment the item cards use (`ui/itemCard`), and
// laid out to the same anchors, so the selection screen reads as part of the
// same game rather than as a menu bolted in front of it. What differs is the
// middle: an item card prints a description there, a character card shows the
// novice, with the one rule they change written under them.
//
// A locked card follows the item gallery's locked treatment exactly — dimmed
// art, "???" where the name goes, and the condition that opens it printed below
// the parchment on the felt — because a player who has seen one locked card in
// this game has learned how to read every other.

import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import {
  CHARACTERS,
  describeCharacterUnlock,
  type CharacterId,
} from "../systems/Characters";

/** The card texture's own size, which every offset here is in terms of. */
export const CHARACTER_CARD_W = 260;
export const CHARACTER_CARD_H = 340;

/** Where the art sits: a square panel filling the card's upper portion.
 *
 *  Square so the three characters are framed identically whatever their build —
 *  the bake fits each one into a transparent square for exactly this reason,
 *  which also means the art's own edges ARE the panel's edges, with no
 *  whitespace of its own to stand in for a margin.
 *
 *  So the margin is spent here. The parchment's inner ink border runs to ±120
 *  and ±160, and the panel is inset ART_INSET inside the nearer of those — the
 *  top — rather than sized to fill it. At 196 the art cleared the border by two
 *  units and read as pressed against it. */
const ART_INSET = 18;
const ART_Y = -58;
const ART_SIZE = 2 * (160 - ART_INSET + ART_Y);

/** The name, hung under the art rather than centred on a line of its own, so a
 *  long name grows down into the gap above the ability instead of up into the
 *  art. */
const NAME_TOP = 48;
/** The ability line's centre, and the width it wraps to — a few units inside
 *  the parchment's inner border, so wrapped copy stops short of the ink rather
 *  than running up against it. */
const ABILITY_Y = 108;
const ABILITY_WRAP = 218;
/** The caption hangs below the parchment, on the felt — the same place an item
 *  card prints its unlock hint. */
const CAPTION_Y = 190;
/**
 * How far past the card's own bottom edge (+170) that caption can reach, in card
 * units, allowing for it wrapping to two lines.
 *
 * Declared for the SCREEN rather than used here: a card is laid out as a
 * 260x340 rectangle, so a hand of them planned by `planChoiceLayout` knows
 * nothing about a line hanging below the last row — and at phone sizes that
 * line lands flush against the bottom of the viewport, or just off it. The
 * scene reserves this much under the hand so the condition always has somewhere
 * to sit. Item cards have the same overhang and no such problem, because every
 * screen that fans them (`TributeScene`) turns their caption off.
 */
export const CHARACTER_CARD_TAIL = CAPTION_Y + 32 - CHARACTER_CARD_H / 2;

/** How faint a locked character is drawn. Enough to read the silhouette and see
 *  that somebody is there; not enough to make out who. */
const LOCKED_ART_ALPHA = 0.22;
const LOCKED_ART_TINT = 0x2b2438;

export interface CharacterCardOptions {
  locked: boolean;
  /** Render directly at this size rather than scaling finished Text textures,
   *  which is what keeps the type crisp as the screen shrinks the hand. */
  displayScale?: number;
}

/** No card's copy is worth printing below this, however small the card. */
const MIN_LEGIBLE_PX = 9;

/**
 * One character's card. Non-interactive — the screen that deals them owns the
 * hit area and the hover, exactly as `TributeScene` does for its drawbacks.
 */
export function buildCharacterCard(
  scene: Phaser.Scene,
  id: CharacterId,
  opts: CharacterCardOptions,
): Phaser.GameObjects.Container {
  const scale = opts.displayScale ?? 1;
  const who = CHARACTERS[id];
  const sizePx = (native: number, minimum: number) =>
    Math.max(Math.min(minimum, MIN_LEGIBLE_PX), Math.round(native * scale));
  const fontSize = (native: number, minimum: number) =>
    `${sizePx(native, minimum)}px`;

  const card = scene.add.image(0, 0, "card");
  card.setDisplaySize(CHARACTER_CARD_W * scale, CHARACTER_CARD_H * scale);

  // The art is square and the source is baked square, so one display size
  // frames every character on the same floor line without per-character
  // constants (see scripts/build-game-character-art.mjs).
  const art = scene.add.image(0, ART_Y * scale, who.art);
  art.setDisplaySize(ART_SIZE * scale, ART_SIZE * scale);
  if (opts.locked) {
    art.setAlpha(LOCKED_ART_ALPHA);
    art.setTint(LOCKED_ART_TINT);
  }

  const name = scene.add
    .text(0, NAME_TOP * scale, opts.locked ? "???" : who.name, {
      fontFamily: SERIF,
      fontSize: fontSize(26, 14),
      color: opts.locked ? CSS.dim : CSS.ink,
      fontStyle: "bold",
      align: "center",
      wordWrap: { width: ABILITY_WRAP * scale },
    })
    .setOrigin(0.5, 0);

  // A locked card gives nothing away — not the name, not the rule. What it owes
  // the player is the condition, and that goes below, on the felt.
  const ability = scene.add
    .text(0, ABILITY_Y * scale, opts.locked ? "" : who.ability, {
      fontFamily: SERIF,
      fontSize: fontSize(15, 10),
      color: CSS.inkSoft,
      align: "center",
      wordWrap: { width: ABILITY_WRAP * scale },
    })
    .setOrigin(0.5);

  const caption = scene.add
    .text(
      0,
      CAPTION_Y * scale,
      opts.locked ? describeCharacterUnlock(id) : "",
      {
        fontFamily: SERIF,
        fontSize: fontSize(16, 10),
        color: CSS.dim,
        fontStyle: "italic",
        align: "center",
        wordWrap: { width: 240 * scale },
      },
    )
    .setOrigin(0.5);

  const container = scene.add.container(0, 0, [
    card,
    art,
    name,
    ability,
    caption,
  ]);
  container.setSize(card.displayWidth, card.displayHeight);
  return container;
}
