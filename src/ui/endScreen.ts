import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { describeCharacterDeed, type CharacterId } from "../systems/Characters";
import {
  buildCharacterCard,
  CHARACTER_CARD_H,
  CHARACTER_CARD_TAIL,
  CHARACTER_CARD_W,
} from "./characterCard";
import { compactColumns } from "./layout";
import { buildMedal } from "./medal";
import { BannerAction, fitTextWidth, stackBannerButtons } from "./widgets";

/** One line of the verdict block: the run's outcome, its rank, its score. */
export interface EndScreenLine {
  text: string;
  /** Size the line is set at when there is room for it; it shrinks from here
   *  to fit the column. */
  size: number;
  color: string;
  italic?: boolean;
  bold?: boolean;
  /** Extra clear space above this line, marking a break in the accounting. */
  gapBefore?: number;
}

/**
 * The folded arrangement the two run-end screens share: the verdict and its
 * accounting centred in one column, the ways on stacked in the other.
 *
 * Stacked, both screens run six lines of type into three banner buttons — on a
 * short landscape viewport the buttons collide with each other and with the
 * text above them, whatever the pitch. Only the compact composition lives here:
 * the two screens' tall layouts are hand-spaced against their own content and
 * have no such problem.
 */
export function buildCompactEndScreen(
  scene: Phaser.Scene,
  opts: {
    title: string;
    titleColor: string;
    lines: EndScreenLine[];
    actions: BannerAction[];
    /** The run's rank (systems/GoalTiers.runRank), drawn as a medal behind
     *  the title; -1 or absent draws none. */
    medal?: number;
    /** Characters the run unlocked. Their cards take the near half of the
     *  right-hand column, and the ways on the far half. */
    novices?: CharacterId[];
  },
): void {
  const novices = opts.novices ?? [];
  const columns = compactColumns(scene, {
    leftFraction: novices.length > 0 ? 0.38 : 0.55,
  });
  const { left } = columns;
  let right = columns.right;
  if (novices.length > 0) {
    const cardsW = Math.round(right.width * 0.5);
    buildNoviceUnlocks(scene, novices, {
      cx: right.x + cardsW / 2,
      top: columns.top,
      bottom: columns.bottom,
      width: cardsW,
    });
    const x = right.x + cardsW + 12;
    const width = right.right - x;
    right = { x, cx: x + width / 2, width, right: right.right };
  }

  // Sized to keep the verdict on one line in the column: wrapping "The Order
  // Is Complete" across two reads as a stumble rather than as a headline.
  const titleSize = Math.round(Phaser.Math.Clamp(left.width * 0.085, 20, 34));
  const title = scene.add
    .text(left.cx, 0, opts.title, {
      fontFamily: SERIF,
      fontSize: `${titleSize}px`,
      color: opts.titleColor,
      fontStyle: "bold",
      align: "center",
      wordWrap: { width: left.width },
    })
    .setOrigin(0.5, 0)
    .setShadow(0, 4, "#000000", 10, false, true);
  fitTextWidth(title, left.width);

  const body = opts.lines.map((line) =>
    scene.add
      .text(left.cx, 0, line.text, {
        fontFamily: SERIF,
        fontSize: `${line.size}px`,
        color: line.color,
        fontStyle: line.italic ? "italic" : line.bold ? "bold" : undefined,
        align: "center",
        wordWrap: { width: left.width },
      })
      .setOrigin(0.5, 0),
  );

  // Laid out at y 0 first: the block's height is the sum of what the lines
  // actually measured (several of them wrap), and it can only be centred in
  // the column once that is known.
  const gaps = opts.lines.map((line) => line.gapBefore ?? 6);
  const blockH =
    title.height +
    body.reduce((sum, text, i) => sum + gaps[i] + text.height, 0);

  let y = columns.top + Math.max(0, (columns.height - blockH) / 2);
  title.setY(y);
  const medal = buildMedal(
    scene,
    left.cx,
    y + title.height / 2,
    title.height * 1.1,
    opts.medal ?? -1,
  );
  if (medal) scene.children.moveBelow(medal, title);
  y += title.height;
  body.forEach((text, i) => {
    y += gaps[i];
    text.setY(y);
    y += text.height;
  });

  stackBannerButtons(scene, right, columns, opts.actions);
}

/**
 * Where a tall end screen puts things when the run unlocked a character.
 *
 * A screen wide enough to spare a column gives the cards one of their own on
 * the right and slides the verdict left to make room. A narrower one keeps the
 * verdict centred, packs it closer to the top, and sets the cards between it
 * and the ways on. `wrap` is the width the verdict's long lines may run to;
 * `top` and `step` are where its title sits and the pitch of the lines below.
 */
export function endScreenFrame(
  W: number,
  H: number,
  novices: readonly CharacterId[],
): {
  cx: number;
  wrap: number;
  top: number;
  step: number;
  side?: { cx: number; width: number };
} {
  const roomy = { top: H * 0.2, step: Math.min(H * 0.09, 60) };
  if (novices.length === 0)
    return { cx: W / 2, wrap: Math.min(900, W - 60), ...roomy };
  if (W < SIDE_COLUMN_MIN_W)
    return {
      cx: W / 2,
      wrap: Math.min(900, W - 60),
      top: H * 0.13,
      step: Math.min(H * 0.075, 52),
    };
  const sideW = Math.min(460, W * 0.32);
  const mainW = W - sideW - 40;
  return {
    cx: mainW / 2 + 10,
    wrap: Math.min(820, mainW - 40),
    ...roomy,
    side: { cx: W - sideW / 2 - 24, width: sideW },
  };
}

/** Below this width the verdict and a column of cards no longer fit side by
 *  side, and the cards go between the verdict and the buttons instead. */
const SIDE_COLUMN_MIN_W = 960;

/**
 * The cards of the characters a run unlocked, fitted into `region`: a heading,
 * each novice's own selection card with the deed that opened it beneath, and
 * when they can be picked. The same cards the selection screen deals, shown
 * the way the results screen shows a newly unlocked item.
 */
export function buildNoviceUnlocks(
  scene: Phaser.Scene,
  ids: readonly CharacterId[],
  region: { cx: number; top: number; bottom: number; width: number },
): void {
  if (ids.length === 0) return;
  const n = ids.length;
  const headingSize = Phaser.Math.Clamp(region.width * 0.06, 12, 20);
  const footSize = Phaser.Math.Clamp(region.width * 0.045, 11, 15);
  const gap = 12;
  const chromeH = headingSize + 10 + 6 + footSize;
  const unitH = CHARACTER_CARD_H + CHARACTER_CARD_TAIL;
  const scale = Phaser.Math.Clamp(
    Math.min(
      (region.bottom - region.top - chromeH) / unitH,
      (region.width - (n - 1) * gap) / (n * CHARACTER_CARD_W),
    ),
    0.3,
    1,
  );
  const blockH = chromeH + unitH * scale;
  const top =
    region.top + Math.max(0, (region.bottom - region.top - blockH) / 2);

  const heading = scene.add
    .text(
      region.cx,
      top + headingSize / 2,
      n === 1 ? "NEW NOVICE UNLOCKED" : "NEW NOVICES UNLOCKED",
      {
        fontFamily: SERIF,
        fontSize: `${headingSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
      },
    )
    .setOrigin(0.5);
  fitTextWidth(heading, region.width);

  const cardW = CHARACTER_CARD_W * scale;
  const cardsY = top + headingSize + 10 + (CHARACTER_CARD_H * scale) / 2;
  const totalW = n * cardW + (n - 1) * gap;
  ids.forEach((id, i) => {
    buildCharacterCard(scene, id, {
      locked: false,
      note: describeCharacterDeed(id),
      displayScale: scale,
    }).setPosition(
      region.cx - totalW / 2 + cardW / 2 + i * (cardW + gap),
      cardsY,
    );
  });

  const foot = scene.add
    .text(
      region.cx,
      cardsY +
        (CHARACTER_CARD_H / 2 + CHARACTER_CARD_TAIL - 18) * scale +
        6 +
        footSize / 2,
      "Available next run.",
      {
        fontFamily: SERIF,
        fontSize: `${footSize}px`,
        color: CSS.dim,
        fontStyle: "italic",
      },
    )
    .setOrigin(0.5);
  fitTextWidth(foot, region.width);
}
