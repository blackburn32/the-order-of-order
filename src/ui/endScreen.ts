import Phaser from "phaser";
import { SERIF } from "../art/palette";
import { compactColumns } from "./layout";
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
  },
): void {
  const columns = compactColumns(scene, { leftFraction: 0.55 });
  const { left, right } = columns;

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
  y += title.height;
  body.forEach((text, i) => {
    y += gaps[i];
    text.setY(y);
    y += text.height;
  });

  stackBannerButtons(scene, right, columns, opts.actions);
}
