import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { DIE_EFFECT_STYLE } from "../art/dieArt";
import { dieBodyTexture } from "../art/textures";
import {
  DIE_EFFECT_DETAIL,
  DIE_EFFECT_LABEL,
  DIE_EFFECT_SOURCE,
  type DieEffect,
} from "../systems/DieEffects";
import type { VigilGroup } from "../systems/GrowthEngines";
import { ITEMS } from "../systems/Items";
import { formatScore } from "./formatScore";
import { formatVigilGrowth, vigilGrowthLog10, vigilScored } from "./vigilTally";
import { addCamera } from "./camera";

/** What a tooltip describes: a kind of die, the effects it carries, and
 *  optionally how many of it there are and The Vigil's tallies among them. */
export interface DieTooltipContent {
  sides: number;
  effects: readonly DieEffect[];
  count?: number;
  /** The dice that have scored under The Vigil, grouped by tally. Dice the
   *  groups leave out of `count` have not scored yet. */
  vigil?: readonly VigilGroup[];
}

const WIDTH = 290;
const PAD = 12;
const SWATCH = 22;
/** Kept clear between the pointer and the panel, so the panel never sits
 *  under the cursor and flickers the hover off. */
const OFFSET = 18;
const DEPTH = 10_000;
/** The most distinct tallies listed before the rest are counted off. */
const VIGIL_LINES = 3;

const ITEM_NAMES = new Map<string, string>(
  ITEMS.map((item) => [item.id, item.name]),
);

/**
 * A panel that spells out what a die's shading means — each effect's swatch,
 * its rule, and the card it came from — shown beside the pointer while it is
 * over a die. The shading tells dice apart at a glance; this is where the
 * player learns what each shade does.
 *
 * One per scene. It draws through a camera of its own, above every other.
 */
export class DieTooltip {
  private scene: Phaser.Scene;
  private panel?: Phaser.GameObjects.Container;
  // Draws the panel and nothing else, created last so it renders over every
  // other camera the scene has — a list clipped by a camera of its own is
  // drawn after the main one, and would otherwise paint over the tooltip.
  private camera?: Phaser.Cameras.Scene2D.Camera;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.hide());
  }

  /**
   * Show the tooltip while the pointer is over `target`. The target is made
   * interactive if it is not already, without a hand cursor — hovering to
   * read a die the player cannot pick is exactly the case this is for.
   * `content` is read on every hover, so it may describe a die that changes.
   */
  attach(
    target: Phaser.GameObjects.GameObject,
    content: () => DieTooltipContent,
  ): void {
    if (!target.input) target.setInteractive();
    target.on("pointerover", (p: Phaser.Input.Pointer) =>
      this.show(content(), p),
    );
    target.on("pointermove", (p: Phaser.Input.Pointer) => this.place(p));
    target.on("pointerout", () => this.hide());
    target.on("pointerdown", () => this.hide());
    target.once(Phaser.GameObjects.Events.DESTROY, () => this.hide());
  }

  hide(): void {
    this.panel?.destroy();
    this.panel = undefined;
    if (this.camera) this.scene.cameras?.remove(this.camera);
    this.camera = undefined;
  }

  private show(content: DieTooltipContent, pointer: Phaser.Input.Pointer) {
    this.hide();
    const scene = this.scene;
    const panel = scene.add.container(0, 0).setDepth(DEPTH);
    const parts: (Phaser.GameObjects.Text | Phaser.GameObjects.Image)[] = [];
    let y = PAD;

    const title = scene.add
      .text(
        PAD,
        y,
        `d${content.sides}` +
          (content.count !== undefined
            ? `  ×${formatScore(content.count)}`
            : ""),
        {
          fontFamily: SERIF,
          fontSize: "17px",
          color: CSS.goldLight,
          fontStyle: "bold",
        },
      )
      .setOrigin(0, 0);
    parts.push(title);
    y += title.height + 6;

    if (content.effects.length === 0) {
      const none = scene.add.text(PAD, y, "No modifiers — an ordinary die.", {
        fontFamily: SERIF,
        fontSize: "14px",
        color: CSS.parchmentDark,
        fontStyle: "italic",
      });
      parts.push(none);
      y += none.height;
    }

    content.effects.forEach((effect, i) => {
      if (i > 0) y += 10;
      const color = DIE_EFFECT_STYLE[effect].color;
      const textX = PAD + SWATCH + 8;
      const textW = WIDTH - textX - PAD;
      const swatch = scene.add
        .image(
          PAD + SWATCH / 2,
          y + SWATCH / 2,
          dieBodyTexture(scene, 1, [effect], false),
        )
        .setDisplaySize(SWATCH, SWATCH);
      const name = scene.add.text(textX, y, DIE_EFFECT_LABEL[effect], {
        fontFamily: SERIF,
        fontSize: "15px",
        color: `#${color.toString(16).padStart(6, "0")}`,
        fontStyle: "bold",
      });
      const detail = scene.add.text(
        textX,
        y + name.height + 1,
        DIE_EFFECT_DETAIL[effect],
        {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.parchment,
          wordWrap: { width: textW },
        },
      );
      const source = scene.add.text(
        textX,
        detail.y + detail.height + 1,
        `from ${ITEM_NAMES.get(DIE_EFFECT_SOURCE[effect]) ?? DIE_EFFECT_SOURCE[effect]}`,
        {
          fontFamily: SERIF,
          fontSize: "12px",
          color: CSS.dim,
          fontStyle: "italic",
        },
      );
      parts.push(swatch, name, detail, source);
      y = Math.max(y + SWATCH, source.y + source.height);
    });

    const vigil = vigilLines(content);
    if (vigil.length > 0) {
      y += 10;
      const head = scene.add.text(PAD, y, "The Vigil", {
        fontFamily: SERIF,
        fontSize: "15px",
        color: CSS.gold,
        fontStyle: "bold",
      });
      parts.push(head);
      y += head.height + 1;
      for (const line of vigil) {
        const text = scene.add.text(PAD, y, line, {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.parchment,
          wordWrap: { width: WIDTH - PAD * 2 },
        });
        parts.push(text);
        y += text.height + 1;
      }
    }

    const height = y + PAD;
    // As wide as its longest line, up to the width the copy wraps at.
    const width = Math.min(
      WIDTH,
      PAD +
        Math.max(
          ...parts.map((part) => {
            return part.x + part.displayWidth * (1 - part.originX);
          }),
        ),
    );
    const bg = scene.add.graphics();
    bg.fillStyle(COLORS.feltDark, 0.96);
    bg.fillRoundedRect(0, 0, width, height, 10);
    bg.lineStyle(1.5, COLORS.gold, 0.8);
    bg.strokeRoundedRect(0, 0, width, height, 10);
    panel.add([bg, ...parts]);
    panel.setSize(width, height);

    for (const camera of scene.cameras.cameras) camera.ignore(panel);
    this.camera = addCamera(scene, 0, 0, scene.scale.width, scene.scale.height);
    this.camera.ignore(scene.children.list.filter((obj) => obj !== panel));

    this.panel = panel;
    this.place(pointer);
  }

  /** Beside the pointer, flipped to whichever side has the room, and kept on
   *  screen. */
  private place(pointer: Phaser.Input.Pointer): void {
    const panel = this.panel;
    if (!panel) return;
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const w = panel.width;
    const h = panel.height;
    let x = pointer.x + OFFSET;
    if (x + w > W - 8) x = pointer.x - OFFSET - w;
    let y = pointer.y + OFFSET;
    if (y + h > H - 8) y = pointer.y - OFFSET - h;
    panel.setPosition(
      Phaser.Math.Clamp(x, 8, Math.max(8, W - w - 8)),
      Phaser.Math.Clamp(y, 8, Math.max(8, H - h - 8)),
    );
  }
}

function times(n: number): string {
  return n === 1 ? "once" : `${formatScore(n)} times`;
}

/** The Vigil's part of a tooltip, a line at a time: what the dice described
 *  have scored under it and how far that has grown their points. Empty when
 *  none of them has scored. */
function vigilLines(content: DieTooltipContent): string[] {
  const groups = (content.vigil ?? []).filter((group) => group.count > 0);
  if (groups.length === 0) return [];
  const tallied = groups.reduce((sum, group) => sum + group.count, 0);
  const total = Math.max(content.count ?? tallied, tallied);
  const growth = (scores: readonly number[]) =>
    formatVigilGrowth(vigilGrowthLog10(scores));

  if (groups.length === 1 && tallied === total) {
    const { scores } = groups[0];
    const scored = times(vigilScored(scores));
    return [
      `${total === 1 ? "Scored" : "Each scored"} ${scored} · points grow ${growth(scores)}`,
    ];
  }

  // The longest vigils lead: they are the dice the tally is worth reading for.
  const sorted = [...groups].sort(
    (a, b) =>
      vigilGrowthLog10(b.scores) - vigilGrowthLog10(a.scores) ||
      b.count - a.count,
  );
  const lines = sorted
    .slice(0, VIGIL_LINES)
    .map(
      (group) =>
        `×${formatScore(group.count)} scored ${times(vigilScored(group.scores))} · ${growth(group.scores)}`,
    );
  const rest = sorted.slice(VIGIL_LINES);
  if (rest.length > 0) {
    const dice = rest.reduce((sum, group) => sum + group.count, 0);
    lines.push(
      `×${formatScore(dice)} more across ${rest.length} lesser tallies`,
    );
  }
  if (total > tallied) {
    lines.push(`×${formatScore(total - tallied)} not yet scored`);
  }
  return lines;
}
