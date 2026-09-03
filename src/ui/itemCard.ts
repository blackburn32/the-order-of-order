import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { afflictionSigilTexture, softenedSigilTexture } from "../art/textures";
import { newRun } from "../state/RunState";
import type { AfflictionId } from "../systems/Afflictions";
import { afflictionOf, describeCriterion, ItemDef } from "../systems/Items";
import { buildRichCopy, inkBox, isMarked } from "./richCopy";

export interface ItemCardOptions {
  locked: boolean;
  count?: number; // lifetime shop selections (ignored while locked or when caption hidden)
  // How many of this item the player holds. Above one, the card prints the
  // tally on its face; one or none prints nothing, since a lone card saying
  // "x1" would be every card in the collection saying it.
  copies?: number;
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

/** The copies tally: point size, and the floor it stops shrinking at. Set at
 *  the body copy's size — it is a figure the player is meant to read at a
 *  glance across a shelf of cards, not a footnote. */
const COPIES_PX = 20;
const COPIES_MIN_PX = 12;
/** Room left around the tally's ink inside its plate. */
const COPIES_PAD_X = 9;
const COPIES_PAD_Y = 7;
/** Where the parchment stops inside the gold frame, and with what corner. The
 *  frame is a 4-unit stroke laid along a box inset 2 units from the card's edge
 *  with a 12-unit corner, so the bare parchment inside it runs to ±126/±166 and
 *  turns on a radius of 10. The tally is set flush into that corner: its two
 *  outer edges lie along the frame and its corner shares the frame's arc
 *  centre, so the two meet exactly rather than nearly. */
const COPIES_EDGE_X = 126;
const COPIES_EDGE_Y = 166;
const COPIES_RADIUS = 10;
/** The weight and wash of the parchment's inner ink border, which the tally's
 *  plate borrows for its own outline. The plate is set over that border and
 *  takes its corner over, so drawn in the border's own line it reads as the
 *  border stepping around the tally rather than as a sticker laid on top. */
const BORDER_WEIGHT = 2;
const BORDER_ALPHA = 0.6;

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

/** A cursed card keeps its strength signal and adds the warning beside it. */
export const CURSED_LABEL = "CURSED";

/** How wide the seal is drawn on a card at rest, and where its centre sits.
 *  The sigil's ink stops just inside its own texture, so at this size it lands
 *  a little inside the parchment's ink border (±120) rather than on it. Set low
 *  of the card's centre so the stamp reads as struck under the title. */
const SEAL_SIZE = 238;
const SEAL_Y = 6;
/** The seal is a mark on the parchment, not a picture on it: faint enough that
 *  the description stays the first thing read, dark enough that the card is
 *  never mistaken for an ordinary one. The sigil textures already vary their
 *  own stroke alpha, so this scales a drawing that is not flat to begin with.
 *  Set a little above where the sharp mark sat, since the softening spreads the
 *  same ink over a wider stroke and would otherwise cost the seal its weight. */
const SEAL_ALPHA = 0.7;

/**
 * The seal stamped on a cursed card: the sigil of the drawback it inflicts,
 * laid on the parchment behind every line of copy.
 *
 * A card that carries no affliction gets nothing — which is not only the
 * ordinary cards. `betrayal` and the King's Demands arrive as drawbacks with no
 * item behind them, so the id is looked up rather than passed, and any card that
 * can name its affliction can be sealed with it.
 *
 * The mark is stamped in its softened copy rather than its sharp one: at card
 * size the sigils' thin strokes otherwise sit in the same frequency band as the
 * serif they are printed under, and the copy goes muddy where the two cross.
 * See `softenedSigilTexture`.
 */
export function buildCursedSeal(
  scene: Phaser.Scene,
  id: AfflictionId,
  scale: number,
): Phaser.GameObjects.Image {
  const seal = scene.add.image(
    0,
    SEAL_Y * scale,
    softenedSigilTexture(scene, afflictionSigilTexture(id)),
  );
  seal.setDisplaySize(SEAL_SIZE * scale, SEAL_SIZE * scale);
  seal.setTint(COLORS.cursedSeal);
  seal.setAlpha(SEAL_ALPHA);
  return seal;
}

/** The rarity line's text and colour, given whether the item is cursed. */
export function rarityMark(
  rarity: ItemDef["rarity"],
  cursed: boolean,
): { text: string; color: string; curse?: { text: string; color: string } } {
  return {
    text: rarity.toUpperCase(),
    color: RARITY_COLOR[rarity],
    curse: cursed
      ? { text: ` · ${CURSED_LABEL}`, color: CSS.cursed }
      : undefined,
  };
}

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
  // A locked card gives nothing away, its curse included.
  const cursed = (def.cursed ?? false) && !opts.locked;
  const afflictionId = cursed ? afflictionOf(def) : null;
  const seal = afflictionId
    ? buildCursedSeal(scene, afflictionId, scale)
    : undefined;

  const terse = opts.terse ?? false;
  const mark = rarityMark(def.rarity, cursed);
  const rarity = scene.add
    .text(
      0,
      (terse ? TERSE_RARITY_TOP : RARITY_Y) * scale,
      opts.locked ? "???" : mark.text,
      {
        fontFamily: SERIF,
        fontSize: fontSize(13, 8),
        color: opts.locked ? CSS.dim : mark.color,
        fontStyle: "bold",
      },
    )
    .setOrigin(0.5, terse ? 0 : 0.5);
  const curseMark =
    !opts.locked && mark.curse
      ? scene.add
          .text(0, rarity.y, mark.curse.text, {
            fontFamily: SERIF,
            fontSize: fontSize(13, 8),
            color: mark.curse.color,
            fontStyle: "bold",
          })
          .setOrigin(0, terse ? 0 : 0.5)
      : undefined;
  if (curseMark) {
    const totalWidth = rarity.width + curseMark.width;
    rarity.setOrigin(0, terse ? 0 : 0.5).setX(-totalWidth / 2);
    curseMark.setX(rarity.x + rarity.width);
  }

  // A duplicate's tally is set into the top-right corner of the ink border,
  // on the rarity line's free shoulder. A locked card gives nothing away, this
  // included.
  const copies = opts.locked ? 1 : (opts.copies ?? 1);
  const tally =
    copies > 1
      ? buildCopiesMark(scene, copies, scale, sizePx(COPIES_PX, COPIES_MIN_PX))
      : undefined;

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
  const descWrap = wrapWidth(214, descPx, 19);
  // A description carrying an upgrade figure is set in more than one face, so
  // it is laid out by richCopy rather than as a Text; both come back centred on
  // DESC_Y and sized to the block they fill, so the card places and measures
  // either the same way.
  const desc = terse
    ? undefined
    : isMarked(descText)
      ? buildRichCopy(scene, descText, {
          fontFamily: SERIF,
          fontSizePx: descPx,
          color: CSS.inkSoft,
          wrapWidth: descWrap,
        }).setY(DESC_Y * scale)
      : scene.add
          .text(0, DESC_Y * scale, descText, {
            fontFamily: SERIF,
            fontSize: `${descPx}px`,
            color: CSS.inkSoft,
            align: "center",
            wordWrap: { width: descWrap },
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

  // A rich description is a Container, which carries no origin of its own; it
  // is laid out centred on its position, so that is what the fit check reads.
  const printed: PrintedField[] = [
    rarity,
    ...(curseMark ? [curseMark] : []),
    name,
    ...(desc
      ? [{ y: desc.y, width: desc.width, height: desc.height, originY: 0.5 }]
      : []),
    ...(note ? [note] : []),
  ];
  // The tally is not among the printed fields: like the rarity it shares a
  // line with, it is set close under the top edge on purpose, and it stacks
  // beside the copy rather than above it.
  const card = scene.add.container(0, 0, [
    img,
    ...(seal ? [seal] : []),
    rarity,
    ...(curseMark ? [curseMark] : []),
    ...(tally ? [tally] : []),
    name,
    ...(desc ? [desc] : []),
    ...(note ? [note] : []),
    ...(caption ? [caption] : []),
  ]);
  card.setSize(img.displayWidth, img.displayHeight);
  card.setData("copyFits", copyFits(printed, scale, desc ? descPx : undefined));
  if (opts.locked) card.setAlpha(0.5);
  return card;
}

/**
 * The tally a card carries when the player holds more than one of it, set into
 * the top-right corner of the gold frame and returned in the card's own
 * coordinates so the caller only has to add it. It sits over the inner ink
 * border, whose corner it takes over — drawn in that border's own line and
 * weight, so the border reads as stepping around the tally.
 *
 * The plate is drawn around the tally's *ink* rather than around its Text box:
 * Phaser sizes that box from a fixed reference string, so a figure with neither
 * ascender nor descender sits high inside it, and a plate fitted to the box
 * would print the figure above its own centre.
 */
function buildCopiesMark(
  scene: Phaser.Scene,
  copies: number,
  scale: number,
  px: number,
): Phaser.GameObjects.Container {
  const text = `x${copies}`;
  const ink = inkBox(`bold ${px}px ${SERIF}`, text);
  const w = ink.width + Math.max(4, COPIES_PAD_X * scale) * 2;
  const h = ink.height + Math.max(3, COPIES_PAD_Y * scale) * 2;
  // The frame's corner, which the plate's outer corner is; the free corners
  // take the same radius so the plate reads as one shape.
  const radius = Math.min(Math.max(2, COPIES_RADIUS * scale), h / 2, w / 2);
  const plate = scene.add.graphics();
  plate.fillStyle(COLORS.parchmentDark, 1);
  plate.fillRoundedRect(-w / 2, -h / 2, w, h, radius);
  plate.lineStyle(
    Math.max(1, BORDER_WEIGHT * scale),
    COLORS.inkSoft,
    BORDER_ALPHA,
  );
  plate.strokeRoundedRect(-w / 2, -h / 2, w, h, radius);
  const label = scene.add
    .text(0, ink.dy, text, {
      fontFamily: SERIF,
      fontSize: `${px}px`,
      color: CSS.ink,
      fontStyle: "bold",
    })
    .setOrigin(0.5);
  const mark = scene.add.container(
    COPIES_EDGE_X * scale - w / 2,
    -COPIES_EDGE_Y * scale + h / 2,
    [plate, label],
  );
  mark.setSize(w, h);
  return mark;
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
/** One field's printed extent, as `copyFits` reads it. Text objects carry these
 *  already; a field laid out some other way supplies its own. */
interface PrintedField {
  y: number;
  width: number;
  height: number;
  originY: number;
}

function copyFits(
  printed: PrintedField[],
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
