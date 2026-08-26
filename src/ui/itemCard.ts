import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { newRun } from "../state/RunState";
import { describeCriterion, ItemDef } from "../systems/Items";

export interface ItemCardOptions {
  locked: boolean;
  count?: number; // lifetime shop selections (ignored while locked or when caption hidden)
  showCaption?: boolean; // default true; false drops the bottom caption entirely
  displayScale?: number; // render directly at this size instead of scaling the finished Text textures
  // A line printed inside the card's lower half, where the shop prints a price.
  // The trial results screen puts the deed that earned the card there, so the
  // note travels with the card however the screen arranges it — including into
  // a fan, where a caption hanging below the art would fall under a neighbour.
  note?: string;
  // Let type shrink past its usual floors. Cards in a fan overlap, so they are
  // far smaller than a card standing on its own, and floors sized for the
  // latter spill their copy over the parchment at the former's scale. Never
  // below MIN_LEGIBLE_PX — a card too small for legible copy wants `terse`, not
  // copy nobody can read.
  compactType?: boolean;
  // Print the rarity and the name and nothing else. For cards drawn so small
  // that their description and unlock note would collide (see the `copyFits`
  // data flag); the caller is expected to offer some way of reading the rest.
  terse?: boolean;
}

// Text anchor offsets match ShopScene.buildCard so a gallery card reads the
// same as its shop counterpart. The 'card' texture is 260x340 (origin center),
// so its bottom edge sits at +170; the caption hangs just below that.
const RARITY_Y = -148;
// The title hangs from its top edge rather than sitting on its centre, so a
// name long enough for two lines grows down into the gap above the description
// instead of up into the rarity line. Placed so a one-line title lands where a
// centred one at -110 did.
const NAME_TOP = -124;
const DESC_Y = -10;
const NOTE_Y = 118;
const CAPTION_Y = 190;
/** A terse card has the whole face to itself: the rarity hangs from the top
 *  border rather than from a fixed offset sized for the copy below it, and the
 *  name takes the middle. */
const TERSE_RARITY_TOP = -146;

/** Half the height and width of the card's inner ink border — what the copy
 *  printed on the parchment has to stay inside of. */
const INNER_HALF_H = 160;
const INNER_HALF_W = 120;
/** The widest a line may be wrapped to: a few units inside the border, so
 *  wrapped copy stops short of it rather than running up against it. */
const WRAP_CAP = 232;
/** How far one field's box may reach into the next before the two stop reading
 *  as separate lines. A Text object's box is not its ink: it carries the font's
 *  leading above and below the glyphs, so neighbouring boxes touch — and lap a
 *  few pixels — while the copy still sits clearly apart. */
const FIELD_INK_SLACK = 5;
/** No card's copy is worth printing below this, however small the card. */
const MIN_LEGIBLE_PX = 9;

const RARITY_COLOR: Record<ItemDef["rarity"], string> = {
  common: CSS.rarityCommon,
  uncommon: CSS.rarityUncommon,
  rare: CSS.rarityRare,
};

/**
 * A static (non-interactive) item card for the Items gallery. Unlocked cards
 * show the item's real name/rarity/description plus a "Selected N times"
 * caption; locked cards are dimmed with every text field replaced by "???" and
 * the caption showing the unlock hint. Dynamic descriptions (functions of run
 * state) are resolved against a fresh run so they render outside a live game.
 */
export function buildItemCard(
  scene: Phaser.Scene,
  def: ItemDef,
  opts: ItemCardOptions,
): Phaser.GameObjects.Container {
  const scale = opts.displayScale ?? 1;
  // Minimums intentionally preserve the information hierarchy as cards
  // shrink: edge metadata yields the most space, then body copy, then title.
  const floor = (minimum: number) =>
    opts.compactType
      ? Math.min(minimum, Math.max(MIN_LEGIBLE_PX, Math.round(minimum * 0.55)))
      : minimum;
  const sizePx = (native: number, minimum: number) =>
    Math.max(floor(minimum), Math.round(native * scale));
  const fontSize = (native: number, minimum: number) =>
    `${sizePx(native, minimum)}px`;
  // Copy wraps against the size it is actually drawn at rather than the card's,
  // since a font rounded up to the next whole pixel — or held up by its floor —
  // would otherwise break a line that fits at full size. Capped just inside the
  // parchment's inner border, so the extra room never reaches it.
  const wrapWidth = (native: number, px: number, nativePx: number) =>
    Math.min(WRAP_CAP * scale, (native * px) / nativePx);
  const img = scene.add.image(0, 0, "card");
  img.setDisplaySize(260 * scale, 340 * scale);

  const terse = opts.terse ?? false;
  const rarityText = opts.locked ? "???" : def.rarity.toUpperCase();
  const rarity = scene.add
    .text(0, (terse ? TERSE_RARITY_TOP : RARITY_Y) * scale, rarityText, {
      fontFamily: SERIF,
      fontSize: fontSize(13, 8),
      color: opts.locked ? CSS.dim : RARITY_COLOR[def.rarity],
      fontStyle: "bold",
    })
    .setOrigin(0.5, terse ? 0 : 0.5);

  // A terse card prints nothing under the title, so the title takes the middle
  // of the face instead of hanging in the position the description needs it to.
  const namePx = sizePx(26, 16);
  const name = scene.add
    .text(0, terse ? 0 : NAME_TOP * scale, opts.locked ? "???" : def.name, {
      fontFamily: SERIF,
      fontSize: `${namePx}px`,
      color: CSS.ink,
      fontStyle: "bold",
      align: "center",
      wordWrap: { width: wrapWidth(220, namePx, 26) },
    })
    .setOrigin(0.5, terse ? 0.5 : 0);

  const descText = opts.locked
    ? "???"
    : typeof def.desc === "function"
      ? def.desc(newRun())
      : def.desc;
  const descPx = sizePx(19, 12);
  const desc = terse
    ? undefined
    : scene.add
        .text(0, DESC_Y * scale, descText, {
          fontFamily: SERIF,
          fontSize: `${descPx}px`,
          color: CSS.inkSoft,
          align: "center",
          wordWrap: { width: wrapWidth(214, descPx, 19) },
        })
        .setOrigin(0.5);

  // The deed that earned the card, where the shop card prints its price: below
  // the description, clear of the longest of them, and far enough above the
  // bottom border for the two lines the longest deed wraps to.
  const notePx = sizePx(16, 10);
  const note =
    opts.note && !terse
      ? scene.add
          .text(0, NOTE_Y * scale, opts.note, {
            fontFamily: SERIF,
            fontSize: `${notePx}px`,
            color: CSS.inkSoft,
            fontStyle: "italic",
            align: "center",
            wordWrap: { width: wrapWidth(210, notePx, 16) },
          })
          .setOrigin(0.5)
      : undefined;

  // The caption reads the lifetime "Selected N times" (or the unlock hint while
  // locked). Callers that only want the card art — e.g. the inventory, which
  // shows a run-count badge instead — pass showCaption: false to drop it.
  const showCaption = (opts.showCaption ?? true) && !terse;
  const captionText = opts.locked
    ? def.unlock
      ? describeCriterion(def.unlock)
      : "Locked"
    : `Selected ${opts.count ?? 0} time${opts.count === 1 ? "" : "s"}`;
  const caption = showCaption
    ? scene.add
        .text(0, CAPTION_Y * scale, captionText, {
          fontFamily: SERIF,
          fontSize: fontSize(18, 11),
          // The caption hangs below the parchment, on the felt — hence
          // light type where every field inside the card is ink.
          color: opts.locked ? CSS.dim : CSS.parchment,
          fontStyle: opts.locked ? "italic" : "bold",
          align: "center",
          wordWrap: { width: 240 * scale },
        })
        .setOrigin(0.5)
    : undefined;

  const printed = [
    rarity,
    name,
    ...(desc ? [desc] : []),
    ...(note ? [note] : []),
  ];
  const card = scene.add.container(0, 0, [
    img,
    ...printed,
    ...(caption ? [caption] : []),
  ]);
  card.setSize(img.displayWidth, img.displayHeight);
  card.setData("copyFits", copyFits(printed, scale, desc ? descPx : undefined));
  if (opts.locked) card.setAlpha(0.5);
  return card;
}

/**
 * Whether the fields printed on the parchment still read as separate lines:
 * each inside the ink border, each clear of the one below it. A card's art
 * shrinks with whatever space it is given, but its type stops at a floor, so
 * below some size the fields close up and run together — and which size that is
 * depends on how long this item's description happens to run. Recorded on the
 * card as the `copyFits` data flag for callers that can offer an alternative;
 * the trial results screen re-renders its cards `terse` and lets them be opened.
 *
 * The rarity is measured as an obstacle for the name but is not itself held to
 * the border: it is a single floored word set close under the top edge on
 * purpose, and at small scales it is always within a pixel of it.
 */
function copyFits(
  printed: Phaser.GameObjects.Text[],
  scale: number,
  bodyPx?: number,
): boolean {
  // Copy held up by the legibility floor is copy the card no longer has room
  // for, whether or not the fields it is set in still clear one another.
  if (bodyPx !== undefined && bodyPx <= MIN_LEGIBLE_PX) return false;
  let previousBottom = -Infinity;
  for (const field of printed) {
    // Copy is wrapped to fit, so the only thing that reaches the side borders is
    // a word too long to break — measured against the same slack as the gaps,
    // since a Text's reported width rounds up off its glyph metrics.
    if (field.width / 2 > INNER_HALF_W * scale + FIELD_INK_SLACK) return false;
    // Fields are anchored by different origins — the title hangs from its top
    // edge, the rest sit on their centres — so read each one's extent off the
    // origin it was given rather than assuming it is centred.
    const top = field.y - field.height * field.originY;
    if (top < previousBottom - FIELD_INK_SLACK) return false;
    previousBottom = top + field.height;
    if (field !== printed[0] && previousBottom > INNER_HALF_H * scale)
      return false;
  }
  return true;
}
