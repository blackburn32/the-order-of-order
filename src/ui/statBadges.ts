import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { fitTextWidth } from "./widgets";

/**
 * The plate-and-caption grid the analysis screens lead with: a small-caps label
 * over a gold figure, on felt with a hairline gold edge. Built into a container
 * in local coordinates so it sits as readily on a scrolling track as on the
 * scene root.
 */

export interface StatBadge {
  label: string;
  value: string;
}

export interface StatBadgeGridOptions {
  x: number;
  y: number;
  width: number;
  /** Badges across. The caller picks it from the room it has. */
  cols: number;
  /** Height of one badge. Type inside scales with it. */
  height: number;
  badges: StatBadge[];
  gap?: number;
}

export interface StatBadgeGrid {
  container: Phaser.GameObjects.Container;
  /** Height the whole grid took. */
  height: number;
}

export function buildStatBadges(
  scene: Phaser.Scene,
  opts: StatBadgeGridOptions,
): StatBadgeGrid {
  const { width, badges, height } = opts;
  const cols = Math.max(1, opts.cols);
  const gap = opts.gap ?? 6;
  const rows = Math.ceil(badges.length / cols);
  const cellW = (width - gap * (cols - 1)) / cols;
  const container = scene.add.container(opts.x, opts.y);

  badges.forEach((badge, index) => {
    const bx = (index % cols) * (cellW + gap);
    const by = Math.floor(index / cols) * (height + gap);
    const plate = scene.add
      .rectangle(bx, by, cellW, height, COLORS.feltLight, 0.82)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLORS.gold, 0.34);
    const label = scene.add
      .text(
        bx + cellW / 2,
        by + Math.max(4, height * 0.12),
        badge.label.toUpperCase(),
        {
          fontFamily: SERIF,
          fontSize: `${Math.round(Phaser.Math.Clamp(height * 0.2, 8, 11))}px`,
          color: CSS.dim,
        },
      )
      .setOrigin(0.5, 0);
    fitTextWidth(label, cellW - 8);
    const value = scene.add
      .text(bx + cellW / 2, by + height * 0.56, badge.value, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(height * 0.32, 11, 18))}px`,
        color: CSS.goldLight,
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    fitTextWidth(value, cellW - 8);
    container.add([plate, label, value]);
  });

  return { container, height: rows * height + (rows - 1) * gap };
}
