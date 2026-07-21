import Phaser from 'phaser';
import { CSS, SERIF } from '../art/palette';
import { newRun } from '../state/RunState';
import { describeCriterion, ItemDef } from '../systems/Items';

export interface ItemCardOptions {
  locked: boolean;
  count?: number; // lifetime shop selections (ignored while locked or when caption hidden)
  showCaption?: boolean; // default true; false drops the bottom caption entirely
}

// Text anchor offsets match ShopScene.buildCard so a gallery card reads the
// same as its shop counterpart. The 'card' texture is 260x340 (origin center),
// so its bottom edge sits at +170; the caption hangs just below that.
const RARITY_Y = -148;
const NAME_Y = -110;
const DESC_Y = -10;
const COST_Y = 128;
const CAPTION_Y = 190;

const RARITY_COLOR: Record<ItemDef['rarity'], string> = {
  common: CSS.rarityCommon,
  uncommon: CSS.rarityUncommon,
  rare: CSS.rarityRare
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
  opts: ItemCardOptions
): Phaser.GameObjects.Container {
  const img = scene.add.image(0, 0, 'card');

  const rarityText = opts.locked ? '???' : def.rarity.toUpperCase();
  const rarity = scene.add
    .text(0, RARITY_Y, rarityText, {
      fontFamily: SERIF,
      fontSize: '13px',
      color: opts.locked ? CSS.dim : RARITY_COLOR[def.rarity],
      fontStyle: 'bold'
    })
    .setOrigin(0.5);

  const name = scene.add
    .text(0, NAME_Y, opts.locked ? '???' : def.name, {
      fontFamily: SERIF,
      fontSize: '26px',
      color: CSS.ink,
      fontStyle: 'bold',
      align: 'center',
      wordWrap: { width: 220 }
    })
    .setOrigin(0.5);

  const descText = opts.locked
    ? '???'
    : typeof def.desc === 'function'
      ? def.desc(newRun())
      : def.desc;
  const desc = scene.add
    .text(0, DESC_Y, descText, {
      fontFamily: SERIF,
      fontSize: '19px',
      color: CSS.inkSoft,
      align: 'center',
      wordWrap: { width: 214 }
    })
    .setOrigin(0.5);

  const costLabel = def.cost === 0 ? 'Free' : `${def.cost} point${def.cost > 1 ? 's' : ''}`;
  const cost = scene.add
    .text(0, COST_Y, opts.locked ? '???' : costLabel, {
      fontFamily: SERIF,
      fontSize: '24px',
      color: opts.locked ? CSS.dim : CSS.gold,
      fontStyle: 'bold'
    })
    .setOrigin(0.5);

  // The caption reads the lifetime "Selected N times" (or the unlock hint while
  // locked). Callers that only want the card art — e.g. the inventory, which
  // shows a run-count badge instead — pass showCaption: false to drop it.
  const showCaption = opts.showCaption ?? true;
  const captionText = opts.locked
    ? def.unlock
      ? describeCriterion(def.unlock)
      : 'Locked'
    : `Selected ${opts.count ?? 0} time${opts.count === 1 ? '' : 's'}`;
  const caption = showCaption
    ? scene.add
        .text(0, CAPTION_Y, captionText, {
          fontFamily: SERIF,
          fontSize: '18px',
          color: opts.locked ? CSS.inkSoft : CSS.ink,
          fontStyle: opts.locked ? 'italic' : 'bold',
          align: 'center',
          wordWrap: { width: 240 }
        })
        .setOrigin(0.5)
    : undefined;

  const children = [img, rarity, name, desc, cost, ...(caption ? [caption] : [])];
  const card = scene.add.container(0, 0, children);
  card.setSize(img.width, img.height);
  if (opts.locked) card.setAlpha(0.5);
  return card;
}
