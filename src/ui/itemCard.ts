import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { newRun } from "../state/RunState";
import { describeCriterion, ItemDef } from "../systems/Items";

export interface ItemCardOptions {
  locked: boolean;
  count?: number; // lifetime shop selections (ignored while locked or when caption hidden)
  showCaption?: boolean; // default true; false drops the bottom caption entirely
  displayScale?: number; // render directly at this size instead of scaling the finished Text textures
}

// Text anchor offsets match ShopScene.buildCard so a gallery card reads the
// same as its shop counterpart. The 'card' texture is 260x340 (origin center),
// so its bottom edge sits at +170; the caption hangs just below that.
const RARITY_Y = -148;
const NAME_Y = -110;
const DESC_Y = -10;
const CAPTION_Y = 190;

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
  const fontSize = (native: number, minimum: number) =>
    `${Math.max(minimum, Math.round(native * scale))}px`;
  const img = scene.add.image(0, 0, "card");
  img.setDisplaySize(260 * scale, 340 * scale);

  const rarityText = opts.locked ? "???" : def.rarity.toUpperCase();
  const rarity = scene.add
    .text(0, RARITY_Y * scale, rarityText, {
      fontFamily: SERIF,
      fontSize: fontSize(13, 8),
      color: opts.locked ? CSS.dim : RARITY_COLOR[def.rarity],
      fontStyle: "bold",
    })
    .setOrigin(0.5);

  const name = scene.add
    .text(0, NAME_Y * scale, opts.locked ? "???" : def.name, {
      fontFamily: SERIF,
      fontSize: fontSize(26, 16),
      color: CSS.ink,
      fontStyle: "bold",
      align: "center",
      wordWrap: { width: 220 * scale },
    })
    .setOrigin(0.5);

  const descText = opts.locked
    ? "???"
    : typeof def.desc === "function"
      ? def.desc(newRun())
      : def.desc;
  const desc = scene.add
    .text(0, DESC_Y * scale, descText, {
      fontFamily: SERIF,
      fontSize: fontSize(19, 12),
      color: CSS.inkSoft,
      align: "center",
      wordWrap: { width: 214 * scale },
    })
    .setOrigin(0.5);

  // The caption reads the lifetime "Selected N times" (or the unlock hint while
  // locked). Callers that only want the card art — e.g. the inventory, which
  // shows a run-count badge instead — pass showCaption: false to drop it.
  const showCaption = opts.showCaption ?? true;
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

  const children = [img, rarity, name, desc, ...(caption ? [caption] : [])];
  const card = scene.add.container(0, 0, children);
  card.setSize(img.displayWidth, img.displayHeight);
  if (opts.locked) card.setAlpha(0.5);
  return card;
}
