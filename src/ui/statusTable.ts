import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import type { DieTooltip } from "./dieTooltip";
import type { StatusIcon, StatusRow } from "./statusRows";

const ROW_H = 20;
const PAD_X = 8;
const PAD_Y = 4;
const ICON = 14;
const ICON_GAP = 6;
const NAME_PX = 13;
const VALUE_PX = 14;
/** The scrollbar's lane down the plate's right edge, when it has one. */
const BAR_W = 3;
const BAR_LANE = 9;

/** How tall the table stands with `rows` rows showing, plate included. */
export function statusTableHeight(rows: number): number {
  return rows > 0 ? rows * ROW_H + PAD_Y * 2 : 0;
}

/** How many rows fit in `maxHeight`; never fewer than one. */
export function statusRowsThatFit(maxHeight: number): number {
  return Math.max(1, Math.floor((maxHeight - PAD_Y * 2) / ROW_H));
}

interface DrawnRow {
  name: Phaser.GameObjects.Text;
  value: Phaser.GameObjects.Text;
  icon: Phaser.GameObjects.Graphics;
  hit: Phaser.GameObjects.Zone;
}

/**
 * The game screen's status table: a stack of rows in the bottom-left corner —
 * Sacred numbers on top, then whatever the run owns that has a state worth
 * reading between rolls. Each row is an icon, a name and a short value;
 * hovering one (or holding it, on a touch screen) opens the tooltip that
 * spells out the rest.
 *
 * Anchored by its bottom-left corner and grown upward, up to the height the
 * scene allows it. Rows past that scroll, a row at a time, by the wheel or a
 * drag, with a thin bar to say how far; scrolling moves the rows it already
 * built rather than building new ones.
 *
 * Rebuilt only when what it shows changes: every row is a fresh pair of Text
 * objects, and a roll that changed nothing here should not pay to rasterize
 * them again.
 */
export class StatusTable {
  readonly container: Phaser.GameObjects.Container;
  private rows: StatusRow[] = [];
  private shown = "";
  private drawn: DrawnRow[] = [];
  private bar?: Phaser.GameObjects.Graphics;
  /** The first row showing, and how many rows show at once. */
  private offset = 0;
  private window = 0;
  /** The plate, in the container's own coordinates. */
  private plate = new Phaser.Geom.Rectangle();
  private drag?: { y: number; offset: number };

  constructor(
    private scene: Phaser.Scene,
    private tooltip: DieTooltip,
    x: number,
    bottom: number,
    /** The widest the table may draw; a row past it shrinks its type. */
    private maxWidth: number,
    /** The tallest it may stand; rows past it scroll. */
    private maxHeight: number,
  ) {
    this.container = scene.add.container(x, bottom);

    const onWheel = (
      p: Phaser.Input.Pointer,
      _over: unknown,
      _dx: number,
      dy: number,
    ) => {
      if (dy !== 0 && this.contains(p.x, p.y))
        this.scrollTo(this.offset + Math.sign(dy));
    };
    const onDown = (p: Phaser.Input.Pointer) => {
      this.drag = this.contains(p.x, p.y)
        ? { y: p.y, offset: this.offset }
        : undefined;
    };
    const onMove = (p: Phaser.Input.Pointer) => {
      if (!this.drag || !p.isDown) return;
      this.scrollTo(this.drag.offset - Math.round((p.y - this.drag.y) / ROW_H));
    };
    const onUp = () => (this.drag = undefined);
    scene.input.on("wheel", onWheel);
    scene.input.on("pointerdown", onDown);
    scene.input.on("pointermove", onMove);
    scene.input.on("pointerup", onUp);
    this.container.once(Phaser.GameObjects.Events.DESTROY, () => {
      scene.input.off("wheel", onWheel);
      scene.input.off("pointerdown", onDown);
      scene.input.off("pointermove", onMove);
      scene.input.off("pointerup", onUp);
    });
  }

  /** Whether a screen point is over the table — the scene keeps its own
   *  gestures (the grid's pan and zoom) off it. */
  contains(x: number, y: number): boolean {
    return (
      this.drawn.length > 0 &&
      this.plate.contains(x - this.container.x, y - this.container.y)
    );
  }

  /** Show `rows`; the tooltips always read the latest. */
  setRows(rows: StatusRow[]): void {
    this.rows = rows;
    const key = rows
      .map((row) => `${row.id}\u0000${row.name}\u0000${row.value}`)
      .join("\u0001");
    if (key === this.shown) return;
    this.shown = key;
    this.build();
  }

  private build(): void {
    const scene = this.scene;
    this.container.removeAll(true);
    this.drawn = [];
    this.bar = undefined;
    if (this.rows.length === 0) return;

    this.window = Math.min(this.rows.length, statusRowsThatFit(this.maxHeight));
    const scrolls = this.rows.length > this.window;
    const textX = PAD_X + ICON + ICON_GAP;
    const room = this.maxWidth - textX - PAD_X - (scrolls ? BAR_LANE : 0);
    const built = this.rows.map((row) => {
      const name = scene.add
        .text(textX, 0, `${row.name}:`, {
          fontFamily: SERIF,
          fontSize: `${NAME_PX}px`,
          color: CSS.parchmentDark,
          fontStyle: "italic",
        })
        .setOrigin(0, 0.5);
      const value = scene.add
        .text(0, 0, row.value, {
          fontFamily: SERIF,
          fontSize: `${VALUE_PX}px`,
          color: CSS.ivory,
        })
        .setOrigin(0, 0.5);
      // A row too wide for the corner gives up type size, the value first:
      // the name is the part the eye finds the row by.
      const fits = (px: number) =>
        name.width + 5 + value.width * (px / VALUE_PX) <= room;
      let px = VALUE_PX;
      while (px > 10 && !fits(px)) px -= 1;
      if (px !== VALUE_PX) value.setFontSize(px);
      if (name.width + 5 + value.width > room)
        name.setFontSize(
          Math.max(
            9,
            Math.floor((NAME_PX * (room - value.width - 5)) / name.width),
          ),
        );
      value.x = name.x + name.width + 5;
      const icon = scene.add.graphics({ x: PAD_X + ICON / 2 });
      drawStatusIcon(icon, row.icon, ICON);
      return { name, value, icon };
    });

    // As wide as the widest row, whether or not it is scrolled into view, so
    // the plate holds still while the rows move.
    const width = Math.min(
      this.maxWidth,
      Math.max(...built.map((row) => row.value.x + row.value.width)) +
        PAD_X +
        (scrolls ? BAR_LANE : 0),
    );
    const height = statusTableHeight(this.window);
    this.plate.setTo(0, -height, width, height);
    const plate = scene.add.graphics();
    plate.fillStyle(COLORS.feltDark, 0.62);
    plate.fillRoundedRect(0, -height, width, height, 6);
    plate.lineStyle(1, COLORS.gold, 0.28);
    plate.strokeRoundedRect(0, -height, width, height, 6);
    this.container.add(plate);

    built.forEach((row, i) => {
      // The whole width of the row answers the pointer, not just its letters.
      const hit = scene.add
        .zone(0, 0, width - (scrolls ? BAR_LANE : 0), ROW_H)
        .setOrigin(0, 0);
      this.tooltip.attach(hit, () => this.rows[i].tooltip);
      this.container.add([row.icon, row.name, row.value, hit]);
      this.drawn.push({ ...row, hit });
    });
    if (scrolls) {
      this.bar = scene.add.graphics();
      this.container.add(this.bar);
    }
    this.scrollTo(this.offset);
  }

  /** Show the rows from `offset` down, held inside the list. */
  private scrollTo(offset: number): void {
    const last = Math.max(0, this.rows.length - this.window);
    this.offset = Phaser.Math.Clamp(offset, 0, last);
    const top = this.plate.y + PAD_Y;
    this.drawn.forEach((row, i) => {
      const slot = i - this.offset;
      const showing = slot >= 0 && slot < this.window;
      const y = top + slot * ROW_H + ROW_H / 2;
      // A row out of view is hidden rather than moved off the plate: hidden,
      // its hit zone stops answering the pointer too.
      for (const part of [row.name, row.value, row.icon]) {
        part.setVisible(showing);
        part.y = y;
      }
      row.hit.setVisible(showing);
      row.hit.y = y - ROW_H / 2;
    });
    if (this.bar) {
      const trackX = this.plate.right - BAR_LANE / 2 - BAR_W / 2;
      const trackY = this.plate.y + 5;
      const trackH = this.plate.height - 10;
      const thumbH = Math.max(10, (trackH * this.window) / this.rows.length);
      const thumbY =
        trackY + ((trackH - thumbH) * this.offset) / Math.max(1, last);
      this.bar.clear();
      this.bar.fillStyle(COLORS.gold, 0.18);
      this.bar.fillRoundedRect(trackX, trackY, BAR_W, trackH, BAR_W / 2);
      this.bar.fillStyle(COLORS.gold, 0.75);
      this.bar.fillRoundedRect(trackX, thumbY, BAR_W, thumbH, BAR_W / 2);
    }
  }
}

// ---- icons ---------------------------------------------------------------------

const v = (x: number, y: number) => new Phaser.Math.Vector2(x, y);

/** One of the status table's glyphs, centred on the graphics' origin and
 *  `size` across. Drawn rather than baked: they are a handful of shapes, and
 *  a vector keeps them sharp at any DPR without a texture to warm. */
export function drawStatusIcon(
  g: Phaser.GameObjects.Graphics,
  icon: StatusIcon,
  size: number,
): void {
  const s = size / 16;
  const P = (x: number, y: number) => v(x * s, y * s);
  switch (icon) {
    case "sacred": {
      // A four-pointed star: the Order's light on a die face.
      const points: Phaser.Math.Vector2[] = [];
      for (let k = 0; k < 8; k += 1) {
        const r = k % 2 === 0 ? 7.5 : 2.4;
        const a = (k * Math.PI) / 4 - Math.PI / 2;
        points.push(P(Math.cos(a) * r, Math.sin(a) * r));
      }
      g.fillStyle(COLORS.goldLight, 1);
      g.fillPoints(points, true);
      return;
    }
    case "bonus": {
      g.lineStyle(1.5 * s, COLORS.gold, 1);
      g.strokeCircle(0, 0, 6.5 * s);
      g.fillStyle(COLORS.goldLight, 1);
      g.fillRect(-3.5 * s, -0.9 * s, 7 * s, 1.8 * s);
      g.fillRect(-0.9 * s, -3.5 * s, 1.8 * s, 7 * s);
      return;
    }
    case "flat": {
      // A short stack of coins.
      g.fillStyle(COLORS.gold, 1);
      for (const y of [4, 0, -4])
        g.fillRoundedRect(-6 * s, (y - 1.6) * s, 12 * s, 3.2 * s, 1.5 * s);
      g.fillStyle(COLORS.goldLight, 1);
      g.fillRoundedRect(-6 * s, -5.6 * s, 12 * s, 1.6 * s, 0.8 * s);
      return;
    }
    case "rhythm": {
      // Two chevrons, one beat after another.
      g.lineStyle(2 * s, COLORS.glowGreen, 1);
      g.strokePoints([P(-6, -5), P(-1, 0), P(-6, 5)], false);
      g.strokePoints([P(0, -5), P(5, 0), P(0, 5)], false);
      return;
    }
    case "bell": {
      g.fillStyle(COLORS.goldLight, 1);
      g.fillPoints(
        [
          ...cubic(P(-6, 4.5), P(-5, 2), P(-5.5, -6.5), P(0, -6.5)),
          ...cubic(P(0, -6.5), P(5.5, -6.5), P(5, 2), P(6, 4.5)),
        ],
        true,
      );
      g.fillCircle(0, 6 * s, 1.8 * s);
      g.fillRect(-0.8 * s, -8 * s, 1.6 * s, 2 * s);
      return;
    }
    case "weight": {
      // A kettlebell: a heavy body and its handle.
      g.lineStyle(1.8 * s, COLORS.parchmentDark, 1);
      g.beginPath();
      g.arc(0, -3 * s, 3.6 * s, Math.PI * 1.05, Math.PI * 1.95);
      g.strokePath();
      g.fillStyle(COLORS.parchmentDark, 1);
      g.fillCircle(0, 2.5 * s, 5.5 * s);
      return;
    }
    case "coin":
    case "endowment": {
      g.fillStyle(COLORS.goldLight, 1);
      g.fillCircle(0, 0, 7 * s);
      g.lineStyle(1.2 * s, COLORS.inkSoft, 1);
      g.strokeCircle(0, 0, 4.8 * s);
      if (icon === "endowment") {
        // The purse that grows: an arrow struck on the coin.
        g.fillStyle(COLORS.inkSoft, 1);
        g.fillTriangle(0, -3.5 * s, -2.6 * s, 0, 2.6 * s, 0);
        g.fillRect(-0.8 * s, 0, 1.6 * s, 3.5 * s);
      }
      return;
    }
    case "cell": {
      // A barred window.
      g.lineStyle(1.6 * s, COLORS.parchmentDark, 1);
      g.strokeRect(-5.5 * s, -6.5 * s, 11 * s, 13 * s);
      g.lineBetween(-1.8 * s, -6.5 * s, -1.8 * s, 6.5 * s);
      g.lineBetween(1.8 * s, -6.5 * s, 1.8 * s, 6.5 * s);
      return;
    }
    case "candle": {
      g.fillStyle(COLORS.ivory, 1);
      g.fillRect(-2.5 * s, -1.5 * s, 5 * s, 9 * s);
      g.fillStyle(COLORS.glow, 1);
      g.fillPoints(flame(s * 0.42, 0, -5 * s), true);
      return;
    }
    case "cross": {
      g.fillStyle(COLORS.goldLight, 1);
      g.fillRect(-1.2 * s, -7.5 * s, 2.4 * s, 15 * s);
      g.fillRect(-5 * s, -3.5 * s, 10 * s, 2.4 * s);
      return;
    }
    case "resonance": {
      // A struck point and the rings it sends out.
      g.fillStyle(COLORS.goldLight, 1);
      g.fillCircle(-4.5 * s, 0, 1.8 * s);
      g.lineStyle(1.5 * s, COLORS.goldLight, 1);
      for (const r of [4, 7.5]) {
        g.beginPath();
        g.arc(-4.5 * s, 0, r * s, -Math.PI / 3.2, Math.PI / 3.2);
        g.strokePath();
      }
      return;
    }
    case "hourglass": {
      g.fillStyle(COLORS.parchmentDark, 1);
      g.fillTriangle(-4.5 * s, -6 * s, 4.5 * s, -6 * s, 0, 0);
      g.fillTriangle(-4.5 * s, 6 * s, 4.5 * s, 6 * s, 0, 0);
      g.fillRect(-6 * s, -7.5 * s, 12 * s, 1.6 * s);
      g.fillRect(-6 * s, 5.9 * s, 12 * s, 1.6 * s);
      return;
    }
    case "note": {
      g.fillStyle(COLORS.ivory, 1);
      g.fillEllipse(-2 * s, 4.5 * s, 6.5 * s, 4.6 * s);
      g.fillRect(0.6 * s, -7 * s, 1.5 * s, 11.5 * s);
      g.fillTriangle(2 * s, -7 * s, 6 * s, -3 * s, 2 * s, -3 * s);
      return;
    }
    case "crown": {
      // A crown gone grey in the fire.
      const points = [
        P(-7, 5),
        P(-7, -4),
        P(-3.5, 0),
        P(0, -6),
        P(3.5, 0),
        P(7, -4),
        P(7, 5),
      ];
      g.fillStyle(0x9b8f84, 1);
      g.fillPoints(points, true);
      g.lineStyle(1 * s, COLORS.gold, 1);
      g.strokePoints(points, true);
      return;
    }
    case "fire": {
      g.fillStyle(0xd9572b, 1);
      g.fillPoints(flame(s, 0, 0), true);
      g.fillStyle(COLORS.glow, 1);
      g.fillPoints(flame(s * 0.5, 0, 3.2 * s), true);
      return;
    }
  }
}

/** A flame's outline, 16 units tall at scale 1 with its base at `y0 + 7s`:
 *  a round belly that leans into a flicked tip. */
function flame(s: number, x0: number, y0: number): Phaser.Math.Vector2[] {
  const at = (x: number, y: number) => v(x0 + x * s, y0 + y * s);
  return [
    ...cubic(at(0, 7.5), at(7, 7.5), at(6.5, -2), at(0.5, -8.5)),
    ...cubic(at(0.5, -8.5), at(-1.5, -4), at(-7.5, -1), at(0, 7.5)),
  ];
}

function cubic(
  p0: Phaser.Math.Vector2,
  p1: Phaser.Math.Vector2,
  p2: Phaser.Math.Vector2,
  p3: Phaser.Math.Vector2,
  steps = 10,
): Phaser.Math.Vector2[] {
  const out: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(
      v(
        a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        a * p0.y + b * p1.y + c * p2.y + d * p3.y,
      ),
    );
  }
  return out;
}
