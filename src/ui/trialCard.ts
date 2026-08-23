import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { SIGIL_TEXTURE_KEYS } from "../art/textures";
import { fx } from "../systems/Effects";
import { fitTextWidth } from "./widgets";

/**
 * One card of the route shown on the Trial Overview.
 *
 * The card's job is to answer two questions before the player commits to a
 * trial: how many points clears it, and how many rolls they get to find them.
 * Both were previously a `Goal: 48 / Rolls: 7` label pair set in the body size,
 * which read as metadata rather than as the terms of the trial. Each is now a
 * stat block — a small caps label, the number at display size, and a line of
 * plain English underneath saying what the number is — laid out the same way
 * the in-game HUD plaques set GOAL and SCORE.
 *
 * Everything is flowed rather than placed at fixed fractions of the card
 * (`flowBlocks`), and the composition steps down through `VARIANTS` until one
 * fits the card it was given — the same card has to work at 345x370 on a
 * desktop and 375x140 in a portrait stack.
 */

/** What a card shows. The scene resolves the numbers and the rank's boss; this
 *  module only lays them out. */
export interface TrialCardData {
  /** Roman numeral marking this trial's place in the rank: I, II, III. */
  ordinal: string;
  title: string;
  /** Pre-formatted, since goals reach scientific notation in endless. */
  goal: string;
  rolls: string;
  /** The rank's modifier — on the Boss Trial's card only. */
  curse?: { name: string; desc: string };
}

export interface TrialCardStatus {
  complete: boolean;
  current: boolean;
  boss: boolean;
  /** Position in the row, for the staggered entrance. */
  index: number;
}

// What each number actually is, in words. The short pair is for the side-by-side
// composition, where a caption has half a card's width and wrapping one line of
// explanation onto two lines of ragged type costs more than the words are worth.
const GOAL_CAPTION = "points needed to clear";
const GOAL_CAPTION_SHORT = "points to clear";
const ROLLS_CAPTION = "rolls to reach it";
const ROLLS_CAPTION_SHORT = "rolls to do it";
const CURSE_HEADING = "THIS TRIAL'S CURSE";

/** How far a trial's name may be shrunk to hold it on one line before wrapping
 *  it is the better answer. Names are two short words, so a few percent is
 *  nearly always enough — and one line keeps the three cards' heads level. */
const TITLE_MIN_FIT = 0.72;

/** Ordinals for the three slots of a rank. */
export const TRIAL_ORDINALS = ["I", "II", "III"] as const;

/**
 * Compositions tried in order, richest first, until one fits the card's
 * height. Cards are only rebuilt on a resize, so building a variant and
 * throwing it away is cheaper than trying to predict wrapped text metrics.
 *
 * Every column composition sorts before every row one, so "which orientation
 * did this card end up in" is a single index comparison — see
 * `ROW_VARIANT_START`.
 */
interface Variant {
  /** Goal above Rolls, or the two side by side. */
  stats: "column" | "row";
  /** The plain-English line under each number. */
  captions: boolean;
  /** The die-marked hairline under the trial's name. */
  rule: boolean;
  /** What the curse does, under its name. Boss cards only, and the last thing
   *  dropped before the captions: the trial's opening banner says it again. */
  curseDesc: boolean;
}

const VARIANTS: Variant[] = [
  { stats: "column", captions: true, rule: true, curseDesc: true },
  { stats: "column", captions: true, rule: false, curseDesc: true },
  { stats: "row", captions: true, rule: true, curseDesc: true },
  { stats: "row", captions: true, rule: false, curseDesc: true },
  { stats: "row", captions: true, rule: false, curseDesc: false },
  { stats: "row", captions: false, rule: false, curseDesc: false },
];

/** First composition that sets the two numbers side by side. */
const ROW_VARIANT_START = VARIANTS.findIndex((v) => v.stats === "row");

/** How the card's fill decides the colour of everything drawn on it. */
interface CardPalette {
  /** The trial's name. */
  ink: string;
  /** Labels, captions and the cleared footer. */
  soft: string;
  /** The two numbers, and the ordinal in its badge. */
  accent: string;
  /** Hairlines, dividers and the ordinal badge's ring. */
  rule: number;
  /** Fill behind the ordinal numeral. */
  badgeFill: number;
  contentAlpha: number;
}

/**
 * A measured piece of the card, positioned by its top edge. `flex` is this
 * block's share of whatever height the card has left over once every block and
 * its minimum gap is accounted for — that leftover is what used to sit as a
 * void in the card's lower two thirds.
 */
interface Block {
  height: number;
  /** Minimum space above this block; ignored on the first. */
  gapBefore: number;
  flex: number;
  place(top: number): void;
}

/**
 * Lay blocks down the band between `top` and `bottom`, sharing any slack out by
 * `flex`. When the band is too short the minimum gaps are closed proportionally
 * instead of letting blocks overlap — the variant ladder makes that rare, but a
 * long boss description on a short card can still get there.
 */
function flowBlocks(
  blocks: Block[],
  top: number,
  bottom: number,
  tailFlex: number,
): void {
  const content = blocks.reduce((sum, b) => sum + b.height, 0);
  const gaps = blocks.slice(1).reduce((sum, b) => sum + b.gapBefore, 0);
  const slack = bottom - top - content - gaps;
  const flexTotal = blocks.reduce((sum, b) => sum + b.flex, 0) + tailFlex;
  const squeeze = slack < 0 && gaps > 0 ? Math.min(1, -slack / gaps) : 0;

  let y = top;
  blocks.forEach((block, i) => {
    if (i > 0) y += block.gapBefore * (1 - squeeze);
    if (slack > 0 && flexTotal > 0) y += (slack * block.flex) / flexTotal;
    block.place(y);
    y += block.height;
  });
}

/** Height a set of blocks needs before any slack is shared out. */
function requiredHeight(blocks: Block[]): number {
  return blocks.reduce(
    (sum, b, i) => sum + b.height + (i > 0 ? b.gapBefore : 0),
    0,
  );
}

/** A built card, and the composition it settled on. The three cards of a rank
 *  have to agree on that composition — see `buildTrialCardRow`. */
export interface TrialCardHandle {
  /** Index into `VARIANTS`; higher is a plainer composition. */
  variant: number;
  destroy(): void;
}

/**
 * Build the three cards of a rank so their numbers read the same way round.
 *
 * Each card takes the richest composition its own content fits, but the Boss
 * Trial's card also carries the rank's curse, so it is always the tightest of
 * the three — and a row where one card stacks GOAL over ROLLS while its
 * neighbour sets them side by side reads as a mistake. Only the *orientation*
 * is shared: if any card had to go side by side, they all do. The captions and
 * the rule are left to each card, so a boss dropping them on a short viewport
 * costs its two neighbours nothing.
 */
export function buildTrialCardRow(
  scene: Phaser.Scene,
  cards: {
    x: number;
    y: number;
    w: number;
    h: number;
    trial: number;
    data: TrialCardData;
    status: TrialCardStatus;
  }[],
): void {
  const built = cards.map((card) =>
    buildTrialCard(
      scene,
      card.x,
      card.y,
      card.w,
      card.h,
      card.trial,
      card.data,
      card.status,
    ),
  );
  const floor = built.some((c) => c.variant >= ROW_VARIANT_START)
    ? ROW_VARIANT_START
    : 0;
  // Nothing has rendered yet — this all runs inside one `build()` — so a card
  // rebuilt here is not a visible flicker, just a discarded first attempt.
  built.forEach((handle, i) => {
    if (handle.variant >= floor) return;
    handle.destroy();
    const card = cards[i];
    buildTrialCard(
      scene,
      card.x,
      card.y,
      card.w,
      card.h,
      card.trial,
      card.data,
      card.status,
      floor,
    );
  });
}

/**
 * Build one route card, at the richest composition from `minVariant` onwards
 * that its content fits. Prefer `buildTrialCardRow`, which keeps a rank's three
 * cards in step.
 */
function buildTrialCard(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  trial: number,
  data: TrialCardData,
  status: TrialCardStatus,
  minVariant = 0,
): TrialCardHandle {
  const upcoming = !status.complete && !status.current;
  const muted = status.complete && !status.boss;
  // The current card drops to the table's own felt color so it reads as a
  // window onto the board rather than another parchment slip; boss cards were
  // already dark. Both then need ivory type instead of ink.
  const onDark = status.boss || status.current;
  const fill = status.boss
    ? 0x2a1622
    : status.current
      ? COLORS.felt
      : muted
        ? 0x605e64
        : COLORS.parchment;
  // Boss cards retain their wax-and-gold hierarchy. Ordinary cleared cards
  // lose their gold edge so they read as history rather than another choice.
  const border = status.boss
    ? status.complete
      ? COLORS.gold
      : status.current
        ? COLORS.goldLight
        : COLORS.waxRed
    : status.complete
      ? 0x918e96
      : status.current
        ? COLORS.goldLight
        : COLORS.inkSoft;
  const cardAlpha = status.boss
    ? status.complete
      ? 0.78
      : 0.96
    : status.complete
      ? 0.84
      : upcoming
        ? 0.42
        : 0.9;

  const palette: CardPalette = {
    ink: onDark ? CSS.ivory : muted ? "#d0cbc2" : CSS.ink,
    soft: onDark ? CSS.parchmentDark : muted ? "#aaa6ad" : CSS.inkSoft,
    // The numbers are the reason the card exists, so they take the card's
    // brightest colour rather than the body colour the labels sit in.
    accent: onDark ? CSS.goldLight : muted ? "#f0ece7" : CSS.ink,
    rule: onDark ? COLORS.gold : muted ? 0xaaa6ad : COLORS.inkSoft,
    badgeFill: onDark
      ? COLORS.feltDark
      : muted
        ? 0x4c4a51
        : COLORS.parchmentDark,
    contentAlpha: status.boss ? 1 : muted ? 0.7 : upcoming ? 0.5 : 1,
  };

  const card = scene.add
    .rectangle(x, y, w, h, fill, cardAlpha)
    .setStrokeStyle(status.current ? 4 : 2, border, status.current ? 1 : 0.72)
    .setDepth(3);

  // Something for the type to sit on, so the space the stat blocks spread into
  // is not bare fill. A cleared trial takes the wax seal, pressed across the
  // whole card the way a stamp lands on a page — which is also what got the
  // seal off the trial's name, where a corner-sized one used to overlap it.
  // Every other card takes a sigil, picked off the trial number so it holds
  // still across resizes.
  const watermarkAlpha = status.complete
    ? status.boss
      ? 0.2
      : 0.1
    : onDark
      ? 0.075
      : 0.05;
  const watermarkSpan = Math.min(w, h) * (status.complete ? 0.68 : 0.82);
  const watermark = scene.add
    .image(
      x,
      y,
      status.complete
        ? "seal"
        : SIGIL_TEXTURE_KEYS[trial % SIGIL_TEXTURE_KEYS.length],
    )
    .setDisplaySize(watermarkSpan, watermarkSpan)
    .setTint(
      status.complete
        ? status.boss
          ? COLORS.gold
          : 0xd8d4da
        : onDark
          ? COLORS.gold
          : COLORS.ink,
    )
    .setAlpha(watermarkAlpha)
    .setRotation(status.complete ? -0.16 : 0)
    .setDepth(3.2);

  const padX = Phaser.Math.Clamp(w * 0.06, 8, 18);
  const padY = Phaser.Math.Clamp(h * 0.055, 6, 18);
  const innerH = h - padY * 2;

  let blocks: Block[] = [];
  let content: Phaser.GameObjects.GameObject[] = [];
  let variant = minVariant;
  for (; variant < VARIANTS.length; variant++) {
    const built = buildContent(
      scene,
      x,
      y,
      w,
      h,
      padX,
      data,
      status,
      palette,
      VARIANTS[variant],
    );
    blocks = built.blocks;
    content = built.objects;
    // The last variant is the floor: take it whether it fits or not.
    if (requiredHeight(blocks) <= innerH || variant === VARIANTS.length - 1) {
      break;
    }
    for (const object of content) object.destroy();
  }

  flowBlocks(blocks, y - h / 2 + padY, y + h / 2 - padY, 0.9);

  if (fx.motion) {
    card.setAlpha(0).setScale(0.94);
    watermark.setAlpha(0);
    scene.tweens.add({
      targets: card,
      alpha: cardAlpha,
      scaleX: 1,
      scaleY: 1,
      duration: 340,
      delay: 70 * status.index,
      ease: "Back.easeOut",
    });
    scene.tweens.add({
      targets: watermark,
      alpha: watermarkAlpha,
      duration: 520,
      delay: 70 * status.index + 120,
      ease: "Quad.easeOut",
    });
  }

  return {
    variant,
    destroy: () => {
      for (const object of [card, watermark, ...content]) {
        // The entrance tweens outlive their targets otherwise, and would go on
        // writing alpha into a destroyed object.
        scene.tweens.killTweensOf(object);
        object.destroy();
      }
    },
  };
}

interface CardContent {
  blocks: Block[];
  objects: Phaser.GameObjects.GameObject[];
}

function buildContent(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  padX: number,
  data: TrialCardData,
  status: TrialCardStatus,
  palette: CardPalette,
  variant: Variant,
): CardContent {
  const objects: Phaser.GameObjects.GameObject[] = [];
  const keep = <T extends Phaser.GameObjects.GameObject>(object: T): T => {
    objects.push(object);
    return object;
  };
  // Type is sized against whichever of the card's two dimensions is the
  // binding one, so a wide-and-short portrait card and a narrow-and-tall
  // landscape one both stay in proportion.
  const size = (wFrac: number, hFrac: number, min: number, max: number) =>
    Phaser.Math.Clamp(Math.min(w * wFrac, h * hFrac), min, max);

  const innerW = w - padX * 2;
  const blocks: Block[] = [];

  // ---- head: ordinal badge, the trial's name, and the cleared seal ---------
  const titleSize = size(0.11, 0.14, 14, 27);
  const badgeR = Phaser.Math.Clamp(Math.min(w * 0.075, h * 0.07), 8, 16);
  const showBadge = w >= 120;
  // Reserved on both shoulders, so the badge on the left does not push the
  // name off the card's axis.
  const shoulder = showBadge ? badgeR * 2 : 0;

  const titleWidth = Math.max(w * 0.46, innerW - shoulder * 2 - 14);
  const title = keep(
    scene.add
      .text(x, y, data.title, {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: palette.ink,
        fontStyle: "bold",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(4)
      .setAlpha(palette.contentAlpha),
  );
  if (title.width > titleWidth) {
    if (titleWidth / title.width >= TITLE_MIN_FIT) {
      fitTextWidth(title, titleWidth);
    } else {
      title.setWordWrapWidth(titleWidth);
    }
  }

  const badge = showBadge
    ? keep(buildOrdinalBadge(scene, data.ordinal, badgeR, palette))
    : undefined;

  const headH = Math.max(title.height, badgeR * 2);
  blocks.push({
    height: headH,
    gapBefore: 0,
    flex: 0,
    place: (top) => {
      const cy = top + headH / 2;
      title.setPosition(x, cy);
      badge?.setPosition(x - w / 2 + padX + badgeR, cy);
    },
  });

  if (variant.rule) {
    const rule = keep(scene.add.graphics().setDepth(4));
    const half = Math.min(innerW * 0.42, 96);
    rule.lineStyle(1.5, palette.rule, 0.55);
    rule.lineBetween(-half, 0, -8, 0);
    rule.lineBetween(8, 0, half, 0);
    // The same lozenge the masthead's rule carries, so the card reads as part
    // of the same set of marks.
    rule.fillStyle(palette.rule, 0.8);
    rule.fillPoints(
      [
        new Phaser.Math.Vector2(0, -3.5),
        new Phaser.Math.Vector2(3.5, 0),
        new Phaser.Math.Vector2(0, 3.5),
        new Phaser.Math.Vector2(-3.5, 0),
      ],
      true,
    );
    rule.setAlpha(palette.contentAlpha);
    blocks.push({
      height: 1,
      gapBefore: Phaser.Math.Clamp(h * 0.02, 4, 9),
      flex: 0.4,
      place: (top) => rule.setPosition(x, top),
    });
  }

  // ---- the two numbers ----------------------------------------------------
  const labelSize = size(0.055, 0.05, 9, 13);
  const captionSize = size(0.055, 0.048, 10, 14);
  const column = variant.stats === "column";
  const valueSize = column
    ? size(0.17, 0.15, 19, 42)
    : size(0.115, 0.13, 17, 34);
  const statGapBefore = Phaser.Math.Clamp(h * 0.018, 4, 9);

  const stat = (label: string, value: string, caption: string, maxW: number) =>
    buildStat(
      scene,
      keep,
      label,
      value,
      variant.captions ? caption : "",
      maxW,
      { label: labelSize, value: valueSize, caption: captionSize },
      palette,
      column ? 3 : 2,
    );

  if (column) {
    const goal = stat("GOAL", data.goal, GOAL_CAPTION, innerW);
    const rolls = stat("ROLLS", data.rolls, ROLLS_CAPTION, innerW);
    const divider = keep(scene.add.graphics().setDepth(4));
    divider.lineStyle(1, palette.rule, 0.28);
    const dashHalf = Math.min(innerW * 0.34, 78);
    for (let dx = -dashHalf; dx < dashHalf; dx += 11) {
      divider.lineBetween(dx, 0, Math.min(dx + 6, dashHalf), 0);
    }
    divider.setAlpha(palette.contentAlpha);

    blocks.push({
      height: goal.height,
      gapBefore: statGapBefore,
      flex: 1,
      place: (top) => goal.place(x, top),
    });
    blocks.push({
      height: 1,
      gapBefore: statGapBefore,
      flex: 0.7,
      place: (top) => divider.setPosition(x, top),
    });
    blocks.push({
      height: rolls.height,
      gapBefore: statGapBefore,
      flex: 0.7,
      place: (top) => rolls.place(x, top),
    });
  } else {
    const gap = Phaser.Math.Clamp(w * 0.05, 10, 24);
    const colW = (innerW - gap) / 2;
    const goal = stat("GOAL", data.goal, GOAL_CAPTION_SHORT, colW);
    const rolls = stat("ROLLS", data.rolls, ROLLS_CAPTION_SHORT, colW);
    const rowH = Math.max(goal.height, rolls.height);
    const divider = keep(scene.add.graphics().setDepth(4));
    divider.lineStyle(1, palette.rule, 0.3);
    divider.lineBetween(0, 0, 0, rowH);
    divider.setAlpha(palette.contentAlpha);

    blocks.push({
      height: rowH,
      gapBefore: statGapBefore,
      flex: 1,
      place: (top) => {
        goal.place(x - gap / 2 - colW / 2, top);
        rolls.place(x + gap / 2 + colW / 2, top);
        divider.setPosition(x, top);
      },
    });
  }

  // ---- the boss's curse ---------------------------------------------------
  if (data.curse) {
    blocks.push(
      buildCurseBand(
        scene,
        keep,
        x,
        h,
        innerW,
        variant.curseDesc ? data.curse : { name: data.curse.name, desc: "" },
        palette,
        {
          heading: size(0.05, 0.045, 8, 12),
          name: size(0.075, 0.065, 12, 18),
          desc: size(0.058, 0.05, 10, 14),
        },
      ),
    );
  }

  // Only cleared trials earn a footer line; the seal already carries it
  // visually, so it is the first thing to go when the card runs short.
  if (status.complete && variant.captions) {
    const footer = keep(
      scene.add
        .text(x, y, "CLEARED", {
          fontFamily: SERIF,
          fontSize: `${size(0.055, 0.05, 10, 14)}px`,
          color: palette.soft,
          fontStyle: "bold",
          letterSpacing: 3,
        })
        .setOrigin(0.5)
        .setDepth(4)
        .setAlpha(palette.contentAlpha),
    );
    blocks.push({
      height: footer.height,
      gapBefore: Phaser.Math.Clamp(h * 0.025, 4, 12),
      flex: 0.6,
      place: (top) => footer.setPosition(x, top + footer.height / 2),
    });
  }

  return { blocks, objects };
}

/** One number with its label above and its plain-English line below. */
interface StatPart {
  height: number;
  /** Positions the group centred on `cx`, with its top edge at `top`. */
  place(cx: number, top: number): void;
}

function buildStat(
  scene: Phaser.Scene,
  keep: <T extends Phaser.GameObjects.GameObject>(object: T) => T,
  label: string,
  value: string,
  caption: string,
  maxW: number,
  sizes: { label: number; value: number; caption: number },
  palette: CardPalette,
  letterSpacing: number,
): StatPart {
  const labelText = keep(
    scene.add
      .text(0, 0, label, {
        fontFamily: SERIF,
        fontSize: `${sizes.label}px`,
        color: palette.soft,
        fontStyle: "bold",
        letterSpacing,
      })
      .setOrigin(0.5)
      .setDepth(4)
      .setAlpha(palette.contentAlpha),
  );
  const valueText = keep(
    scene.add
      .text(0, 0, value, {
        fontFamily: SERIF,
        fontSize: `${sizes.value}px`,
        color: palette.accent,
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(4)
      .setAlpha(palette.contentAlpha),
  );
  // Endless goals reach scientific notation; shrink rather than spill into the
  // neighbouring column, the same way the HUD handles a large score.
  fitTextWidth(valueText, maxW * 0.96);

  const captionText = caption
    ? keep(
        scene.add
          .text(0, 0, caption, {
            fontFamily: SERIF,
            fontSize: `${sizes.caption}px`,
            color: palette.soft,
            fontStyle: "italic",
            align: "center",
            wordWrap: { width: maxW * 0.96 },
          })
          .setOrigin(0.5)
          .setDepth(4)
          .setAlpha(palette.contentAlpha),
      )
    : undefined;

  const labelGap = 1;
  const captionGap = 2;
  const height =
    labelText.height +
    labelGap +
    valueText.height +
    (captionText ? captionGap + captionText.height : 0);

  return {
    height,
    place: (cx, top) => {
      let cursor = top;
      labelText.setPosition(cx, cursor + labelText.height / 2);
      cursor += labelText.height + labelGap;
      valueText.setPosition(cx, cursor + valueText.height / 2);
      cursor += valueText.height + captionGap;
      captionText?.setPosition(cx, cursor + captionText.height / 2);
    },
  };
}

/** The wax-red band at the foot of a Boss Trial's card: what the modifier is
 *  called, and what it does, under a heading that says what it is. Framed
 *  rather than set loose, so it reads as a warning attached to this trial and
 *  not as more of the card's body copy. */
function buildCurseBand(
  scene: Phaser.Scene,
  keep: <T extends Phaser.GameObjects.GameObject>(object: T) => T,
  x: number,
  cardH: number,
  innerW: number,
  curse: { name: string; desc: string },
  palette: CardPalette,
  sizes: { heading: number; name: number; desc: number },
): Block {
  const wrap = innerW - 18;
  const heading = keep(
    scene.add
      .text(0, 0, CURSE_HEADING, {
        fontFamily: SERIF,
        fontSize: `${sizes.heading}px`,
        color: "#c99a92",
        fontStyle: "bold",
        letterSpacing: 2,
      })
      .setOrigin(0.5)
      .setDepth(4),
  );
  fitTextWidth(heading, wrap);
  const name = keep(
    scene.add
      .text(0, 0, curse.name, {
        fontFamily: SERIF,
        fontSize: `${sizes.name}px`,
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(4),
  );
  fitTextWidth(name, wrap);
  const desc = curse.desc
    ? keep(
        scene.add
          .text(0, 0, curse.desc, {
            fontFamily: SERIF,
            fontSize: `${sizes.desc}px`,
            color: CSS.parchment,
            align: "center",
            wordWrap: { width: wrap },
          })
          .setOrigin(0.5)
          .setDepth(4),
      )
    : undefined;

  const bandPad = Phaser.Math.Clamp(cardH * 0.03, 4, 8);
  const height =
    bandPad * 2 +
    heading.height +
    2 +
    name.height +
    (desc ? 3 + desc.height : 0);

  const band = keep(scene.add.graphics().setDepth(3.5));
  band.fillStyle(COLORS.waxRedDark, 0.5);
  band.fillRoundedRect(-innerW / 2, 0, innerW, height, 6);
  band.lineStyle(1, COLORS.waxRed, 0.8);
  band.strokeRoundedRect(-innerW / 2, 0, innerW, height, 6);
  for (const text of [heading, name, desc]) {
    text?.setAlpha(palette.contentAlpha);
  }
  band.setAlpha(palette.contentAlpha);

  return {
    height,
    gapBefore: 8,
    flex: 0.8,
    place: (top) => {
      band.setPosition(x, top);
      let cursor = top + bandPad;
      heading.setPosition(x, cursor + heading.height / 2);
      cursor += heading.height + 2;
      name.setPosition(x, cursor + name.height / 2);
      cursor += name.height + 3;
      desc?.setPosition(x, cursor + desc.height / 2);
    },
  };
}

/** The step marker at a card's head: I, II or III set in a ring. Three of them
 *  across the row are what make the cards read as a route rather than as three
 *  unrelated panels. */
function buildOrdinalBadge(
  scene: Phaser.Scene,
  ordinal: string,
  radius: number,
  palette: CardPalette,
): Phaser.GameObjects.Container {
  const ring = scene.add
    .circle(0, 0, radius, palette.badgeFill, 0.55)
    .setStrokeStyle(1.5, palette.rule, 0.75);
  const text = scene.add
    .text(0, 0, ordinal, {
      fontFamily: SERIF,
      fontSize: `${Math.max(9, Math.round(radius * 1.05))}px`,
      color: palette.accent,
      fontStyle: "bold",
    })
    .setOrigin(0.5);
  return scene.add
    .container(0, 0, [ring, text])
    .setDepth(4)
    .setAlpha(palette.contentAlpha);
}
