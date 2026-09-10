import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { setArtScale } from "../art/textures";
import type { Die } from "../systems/Dice";
import type { DiceRegionSummary } from "../systems/DicePool";
import { drawEffectBorder, BORDER_WIDTH } from "./dieBorder";
import { formatCompactCount, formatScore } from "./formatScore";

interface DieTypeRow {
  container: Phaser.GameObjects.Container;
  /** Die art only, so it can rock and bounce without dragging the label with
   *  it. Positioned at the row's icon slot; its children sit around (0, 0). */
  icon: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Image;
  face: Phaser.GameObjects.Image;
  marker: Phaser.GameObjects.Image;
  border: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  die: Die;
  count: number;
  /** Scale from the die's 96-unit design space to this row's icon size. */
  iconScale: number;
  // This row's own rocking motion during a roll — see beginTumble. Mirrors
  // DieSprite: a continuous per-row sine, so the icons rattle out of step.
  wobbleAmplitude: number;
  wobbleRate: number;
  wobblePhase: number;
}

/** One modifier's odds of having hit any single die in the region a card
 *  stands for. See `DiceSummaryCard.showEffects`. */
export interface CardEffectChance {
  color: number;
  /** Fraction of the pool the effect hit, 0..1. */
  chance: number;
  bigPulse: boolean;
}

// Felt kept clear inside each column, and between a die icon and its label.
const ROW_PAD = 4;
const ICON_GAP = 4;
// A second column is only worth taking if the labels still read at close to
// their natural size in it; below this they get squeezed against the
// neighbouring column's die, which is what a single tall column avoids.
const TWO_COLUMN_MIN_LABEL_SCALE = 0.82;
// The thinnest an effect outline may draw on screen. Card icons are a fraction
// of a full die's size, so the 96-space stroke widens to compensate.
const MIN_BORDER_SCREEN_WIDTH = 2.5;
const MAX_EFFECT_ARCS = 3;
// Floors on a row's parts, and the row height the two of them need. A card
// holding more die sizes than fit at this height lists the largest of them and
// counts the rest off in a footer line rather than squeezing them all in.
const MIN_ICON_SIZE = 9;
const MIN_LABEL_SIZE = 7;
const MIN_ROW_HEIGHT = 11;

/**
 * A spatial summary rendered in screen-space even though its position lives in
 * grid-world coordinates. Keeping text at ordinary font sizes avoids generating
 * enormous text textures as camera zoom approaches zero.
 */
export class DiceSummaryCard extends Phaser.GameObjects.Container {
  /**
   * The card's painted surface is separate from its world-space anchor. The
   * outer container keeps cancelling the grid camera zoom, while this inner
   * container is free to glide/fade between summary regions at LOD boundaries.
   */
  private surface: Phaser.GameObjects.Container;
  private background: Phaser.GameObjects.Rectangle;
  private title: Phaser.GameObjects.Text;
  private specials: Phaser.GameObjects.Text;
  /** Stands in for the die sizes a small card has no room to list. */
  private more: Phaser.GameObjects.Text;
  private rows = new Map<number, DieTypeRow>();
  private summarySignature = "";
  private layoutSignature = "";
  /** Everything the layout has to measure text for. Folded into the layout
   *  signature so a changed count re-runs the fit pass, which is what decides
   *  the column split and how far each label has to shrink. */
  private textSignature = "";

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    summary: DiceRegionSummary,
    width: number,
    height: number,
    zoom: number,
  ) {
    super(scene, x, y);
    this.surface = scene.add.container(0, 0);
    this.background = scene.add.rectangle(0, 0, 1, 1, COLORS.feltLight, 0.96);
    this.title = scene.add
      .text(0, 0, "", {
        fontFamily: SERIF,
        color: CSS.goldLight,
        fontSize: "14px",
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    this.specials = scene.add
      .text(0, 0, "", {
        fontFamily: SERIF,
        color: CSS.parchmentDark,
        fontSize: "9px",
        align: "center",
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    this.more = scene.add
      .text(0, 0, "", {
        fontFamily: SERIF,
        color: CSS.parchmentDark,
        fontSize: "9px",
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setVisible(false);
    this.surface.add([this.background, this.title, this.specials, this.more]);
    this.add(this.surface);
    scene.add.existing(this);

    this.setSummary(summary);
    this.setLayout(width, height, zoom);
  }

  /** Update counts and settled representative faces only when dice data changes. */
  setSummary(summary: DiceRegionSummary): void {
    const sides = Object.keys(summary.bySides)
      .map(Number)
      .sort((a, b) => b - a);
    const signature = [
      summary.total,
      summary.maxFaceBonus,
      summary.loaded,
      summary.wildFace,
      ...sides.flatMap((side) => {
        const die = summary.representatives[side];
        return [
          side,
          summary.bySides[side],
          die?.value ?? 0,
          Number(die?.maxFaceBonus ?? false),
          Number(die?.loaded ?? false),
          Number(die?.wildFace ?? false),
        ];
      }),
    ].join("|");
    if (signature === this.summarySignature) return;

    this.summarySignature = signature;
    this.title.setText(`${formatScore(summary.total)} DICE`);

    const specialParts: string[] = [];
    if (summary.maxFaceBonus > 0)
      specialParts.push(`MAX ${formatCompactCount(summary.maxFaceBonus)}`);
    if (summary.loaded > 0)
      specialParts.push(`LOAD ${formatCompactCount(summary.loaded)}`);
    if (summary.wildFace > 0)
      specialParts.push(`WILD ${formatCompactCount(summary.wildFace)}`);
    this.specials
      .setText(specialParts.join("  "))
      .setVisible(specialParts.length > 0);

    const activeSides = new Set(sides);
    for (const [side, row] of this.rows) {
      if (activeSides.has(side)) continue;
      row.container.destroy();
      this.rows.delete(side);
    }

    for (const side of sides) {
      const representative = summary.representatives[side];
      if (!representative) continue;
      let row = this.rows.get(side);
      if (!row) {
        row = this.createRow(representative);
        this.rows.set(side, row);
      }
      row.die = { ...representative };
      row.count = summary.bySides[side];
      row.face.setFrame(`face-${side}-${representative.value}`);
      row.marker.setVisible(representative.maxFaceBonus > 0);
    }

    // Face changes do not affect geometry, but the set of rows, the footer, and
    // any text the layout has to fit to a width all do.
    const textSignature = [
      this.title.text,
      this.specials.visible ? this.specials.text : "",
      ...sides.map((side) => `${side}:${this.rows.get(side)?.count ?? 0}`),
    ].join("|");
    if (textSignature !== this.textSignature) {
      this.textSignature = textSignature;
      this.layoutSignature = "";
    }
  }

  /**
   * Update only cheap transforms while panning/zooming. The container's inverse
   * scale cancels the grid camera's zoom, so children remain normal-sized.
   */
  setLayout(width: number, height: number, zoom: number): void {
    const screenWidth = Math.max(1, width * zoom);
    const screenHeight = Math.max(1, height * zoom);
    this.setScale(1 / zoom);

    const sides = [...this.rows.keys()].sort((a, b) => b - a);
    const layoutSignature = [
      Math.round(screenWidth),
      Math.round(screenHeight),
      sides.join(","),
      this.specials.visible ? 1 : 0,
      this.textSignature,
    ].join("|");
    if (layoutSignature === this.layoutSignature) return;
    this.layoutSignature = layoutSignature;

    const cardWidth = Math.max(1, Math.round(screenWidth) - 5);
    const cardHeight = Math.max(1, Math.round(screenHeight) - 5);
    this.background
      .setSize(cardWidth, cardHeight)
      .setStrokeStyle(2, COLORS.gold, 0.72);

    const titleSize = Math.round(
      Phaser.Math.Clamp(screenHeight * 0.12, 10, 15),
    );
    if (this.title.style.fontSize !== `${titleSize}px`)
      this.title.setFontSize(titleSize);
    this.title.setPosition(0, -cardHeight / 2 + titleSize / 2 + 7);
    fitToWidth(this.title, cardWidth - ROW_PAD * 2);

    const specialsSize = Math.round(
      Phaser.Math.Clamp(screenHeight * 0.075, 7, 10),
    );
    if (this.specials.style.fontSize !== `${specialsSize}px`)
      this.specials.setFontSize(specialsSize);
    this.specials.setPosition(0, cardHeight / 2 - specialsSize / 2 - 6);
    fitToWidth(this.specials, cardWidth - ROW_PAD * 2);

    const contentTop = -cardHeight / 2 + titleSize + 12;
    const contentBottom =
      cardHeight / 2 - (this.specials.visible ? specialsSize + 11 : 6);
    const contentHeight = Math.max(12, contentBottom - contentTop);

    // Two columns only when the labels survive the halved width. A count wide
    // enough to be squeezed is exactly the one that used to run over the top of
    // the next die along, so it takes the whole card instead.
    const columns =
      sides.length > 2 &&
      screenWidth >= 150 &&
      this.labelsFitIn(2, sides, cardWidth, contentHeight)
        ? 2
        : 1;

    const shown = this.sidesShownIn(columns, sides, contentHeight);
    const hiddenCount = sides.length - shown.length;
    this.more.setVisible(hiddenCount > 0);

    const rowCount = laidOutRowCount(shown.length, hiddenCount, columns);
    const metrics = rowMetrics(columns, rowCount, cardWidth, contentHeight);
    const rowHeight = contentHeight / rowCount;
    const iconSize = metrics.iconSize;
    const scale = iconSize / 96;

    for (const [side, row] of this.rows)
      row.container.setVisible(shown.includes(side));

    shown.forEach((side, index) => {
      const row = this.rows.get(side);
      if (!row) return;
      const column = index % columns;
      const rowIndex = Math.floor(index / columns);
      const x = -cardWidth / 2 + metrics.columnWidth * (column + 0.5);
      const y = contentTop + rowHeight * (rowIndex + 0.5);

      // The label is fitted first: its final width is what centres the row, so
      // icon and text together stay inside the column at any count.
      this.fitLabel(row, metrics.labelSize, metrics.labelRoom);
      const contentWidth =
        iconSize + ICON_GAP + row.label.width * row.label.scaleX;
      const iconX = -contentWidth / 2 + iconSize / 2;

      row.container.setPosition(x, y);
      row.icon.setPosition(iconX, 0);
      row.iconScale = scale;
      // `scale` is in the die's 96-unit design space; `setArtScale` converts it
      // to the object scale each texture's own bake resolution asks for.
      setArtScale(row.body.setPosition(0, 0), scale);
      setArtScale(row.face.setPosition(0, -4 * scale), scale);
      setArtScale(row.marker.setPosition(34 * scale, -34 * scale), scale);
      // The outline path is in the same design space, so one plain scale on the
      // Graphics carries the geometry and its stroke together.
      row.border.setScale(scale);
      row.label.setPosition(iconX + iconSize / 2 + ICON_GAP, 0);
    });

    if (hiddenCount > 0) {
      const index = shown.length;
      this.more.setText(`+${hiddenCount} MORE`).setScale(1);
      if (this.more.style.fontSize !== `${metrics.labelSize}px`)
        this.more.setFontSize(metrics.labelSize);
      this.more.setPosition(
        -cardWidth / 2 + metrics.columnWidth * ((index % columns) + 0.5),
        contentTop + rowHeight * (Math.floor(index / columns) + 0.5),
      );
      fitToWidth(this.more, metrics.columnWidth - ROW_PAD * 2);
    }
  }

  /** Flicker each representative icon during the ordinary roll tumble. */
  animateFaces(): void {
    for (const row of this.rows.values()) {
      const faces = row.die.loaded
        ? Math.max(1, row.die.sides - 2)
        : row.die.sides;
      row.face.setFrame(
        `face-${row.die.sides}-${1 + Math.floor(Math.random() * faces)}`,
      );
    }
  }

  /** Give every icon its own rocking motion for the roll about to start, so a
   *  card rattles like the loose dice it stands in for rather than sitting
   *  still while its numbers churn. Mirrors `DieSprite.beginTumble`. */
  beginTumble(): void {
    for (const row of this.rows.values()) {
      row.wobbleAmplitude = Phaser.Math.FloatBetween(0.06, 0.16);
      row.wobbleRate = Phaser.Math.FloatBetween(18, 30);
      row.wobblePhase = Phaser.Math.FloatBetween(0, Math.PI * 2);
    }
  }

  /** Advance every icon's wobble to `elapsed` seconds since the tumble began. */
  tumbleTo(elapsed: number): void {
    for (const row of this.rows.values()) {
      if (row.wobbleAmplitude === 0) continue;
      row.icon.setRotation(
        row.wobbleAmplitude *
          Math.sin(row.wobbleRate * elapsed + row.wobblePhase),
      );
    }
  }

  /** Land the icons square again, with the same overshoot rock a loose die
   *  gets. `delay` staggers this card against the others on screen. */
  settle(delay: number): void {
    for (const row of this.rows.values()) {
      row.wobbleAmplitude = 0;
      if (row.icon.rotation === 0) continue;
      this.scene.tweens.add({
        targets: row.icon,
        rotation: 0,
        duration: 260,
        delay,
        ease: "Back.easeOut",
      });
    }
  }

  /** End the tumble without allocating tweens. */
  snapSettled(): void {
    for (const row of this.rows.values()) {
      row.wobbleAmplitude = 0;
      row.icon.setRotation(0);
    }
  }

  /**
   * Flash effect outlines across this card's icons.
   *
   * A card row stands for thousands of dice, so there is no per-die truth to
   * show. Instead each modifier carries the fraction of the pool it actually
   * hit, and every icon rolls against those odds independently: the outlines
   * then scatter across the visible cards at roughly the density they have in
   * the real grid, rather than every card flashing the same thing at once.
   */
  showEffects(chances: CardEffectChance[]): void {
    if (chances.length === 0) return;
    for (const row of this.rows.values()) {
      const colors: number[] = [];
      let big = false;
      for (const chance of chances) {
        if (Math.random() >= chance.chance) continue;
        // Several modifiers share a colour (most scoring bonuses are gold).
        // Repeating it would only split the outline into identical arcs.
        if (!colors.includes(chance.color)) colors.push(chance.color);
        if (chance.bigPulse) big = true;
      }
      if (colors.length > 0)
        this.pulseRow(row, colors.slice(0, MAX_EFFECT_ARCS), big);
    }
  }

  /** Drop any in-flight flash and square the icons up — used before a relayout
   *  that would otherwise leave a tween fighting the new transforms. */
  clearPulse(): void {
    for (const row of this.rows.values()) {
      this.scene.tweens.killTweensOf(row.icon);
      this.scene.tweens.killTweensOf(row.border);
      row.border.clear();
      row.border.setAlpha(0);
      row.icon.setScale(1);
      row.wobbleAmplitude = 0;
      row.icon.setRotation(0);
    }
  }

  /** Reveal a freshly split card from the screen-space position of its parent. */
  animateArrival(
    fromX: number,
    fromY: number,
    fromScale: number,
    duration: number,
  ): void {
    this.scene.tweens.killTweensOf(this.surface);
    this.surface.setPosition(fromX, fromY).setScale(fromScale).setAlpha(0);
    this.scene.tweens.add({
      targets: this.surface,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      alpha: 1,
      duration,
      ease: "Cubic.easeOut",
    });
  }

  /** Carry an obsolete card into its joined parent before releasing it. */
  animateDeparture(
    toX: number,
    toY: number,
    toScale: number,
    duration: number,
    onComplete: () => void,
  ): void {
    this.scene.tweens.killTweensOf(this.surface);
    this.scene.tweens.add({
      targets: this.surface,
      x: toX,
      y: toY,
      scaleX: toScale,
      scaleY: toScale,
      alpha: 0,
      duration,
      ease: "Cubic.easeInOut",
      onComplete,
    });
  }

  /** Tweens outlive their targets, and a card is destroyed whenever the camera
   *  crosses a region boundary — which a roll's flash can easily still be
   *  running across. */
  override destroy(fromScene?: boolean): void {
    this.scene?.tweens.killTweensOf(this.surface);
    for (const row of this.rows.values()) {
      this.scene?.tweens.killTweensOf(row.icon);
      this.scene?.tweens.killTweensOf(row.border);
    }
    super.destroy(fromScene);
  }

  private pulseRow(row: DieTypeRow, colors: number[], big: boolean): void {
    const g = row.border;
    this.scene.tweens.killTweensOf(g);
    g.setAlpha(1);
    drawEffectBorder(
      g,
      colors,
      Math.max(BORDER_WIDTH, MIN_BORDER_SCREEN_WIDTH / row.iconScale),
    );

    const scale = big ? 1.25 : 1.12;
    this.scene.tweens.add({
      targets: row.icon,
      scaleX: scale,
      scaleY: scale,
      duration: 130,
      yoyo: true,
      ease: "Quad.easeOut",
    });
    this.scene.tweens.add({
      targets: g,
      alpha: 0,
      duration: 420,
      ease: "Quad.easeIn",
    });
  }

  /**
   * Set a row's label to the most detailed count string that fits `labelRoom`,
   * then shrink whatever is left over. Exact counts read best, so they are
   * tried first; a compact form is the fallback before the type size gives way.
   * Returns the scale that had to be applied, which is also what decides
   * whether a two-column split is worth taking.
   */
  private fitLabel(
    row: DieTypeRow,
    labelSize: number,
    labelRoom: number,
  ): number {
    if (row.label.style.fontSize !== `${labelSize}px`)
      row.label.setFontSize(labelSize);
    row.label.setScale(1);
    const exact = `d${row.die.sides} ×${row.count.toLocaleString()}`;
    row.label.setText(exact);
    if (row.label.width > labelRoom) {
      const compact = `d${row.die.sides} ×${formatCompactCount(row.count)}`;
      if (compact !== exact) row.label.setText(compact);
    }
    const scale = Math.min(1, labelRoom / Math.max(1, row.label.width));
    row.label.setScale(scale);
    return scale;
  }

  /**
   * The die sizes this card actually lists under a given column split. A card
   * too short to give every size a legible row keeps the ones the region is
   * mostly made of — the largest counts — and leaves the rest to the `+N MORE`
   * line, rather than stacking rows through one another.
   */
  private sidesShownIn(
    columns: number,
    sides: number[],
    contentHeight: number,
  ): number[] {
    const slots = Math.max(
      1,
      Math.floor(contentHeight / MIN_ROW_HEIGHT) * columns,
    );
    if (sides.length <= slots) return sides;
    return [...sides]
      .sort(
        (a, b) =>
          (this.rows.get(b)?.count ?? 0) - (this.rows.get(a)?.count ?? 0),
      )
      .slice(0, Math.max(1, slots - 1))
      .sort((a, b) => b - a);
  }

  private labelsFitIn(
    columns: number,
    sides: number[],
    cardWidth: number,
    contentHeight: number,
  ): boolean {
    const shown = this.sidesShownIn(columns, sides, contentHeight);
    const rowCount = laidOutRowCount(
      shown.length,
      sides.length - shown.length,
      columns,
    );
    const metrics = rowMetrics(columns, rowCount, cardWidth, contentHeight);
    for (const side of shown) {
      const row = this.rows.get(side);
      if (!row) continue;
      const scale = this.fitLabel(row, metrics.labelSize, metrics.labelRoom);
      if (scale < TWO_COLUMN_MIN_LABEL_SCALE) return false;
    }
    return true;
  }

  private createRow(die: Die): DieTypeRow {
    const container = this.scene.add.container(0, 0);
    const icon = this.scene.add.container(0, 0);
    const body = this.scene.add.image(0, 0, `die-${die.sides}`);
    const face = this.scene.add.image(
      0,
      0,
      "die-atlas",
      `face-${die.sides}-${die.value}`,
    );
    const marker = this.scene.add.image(0, 0, "pip-gold");
    const border = this.scene.add.graphics();
    border.setAlpha(0);
    icon.add([body, face, marker, border]);
    const label = this.scene.add
      .text(0, 0, "", {
        fontFamily: SERIF,
        color: CSS.parchment,
        fontSize: "10px",
        fontStyle: "bold",
      })
      .setOrigin(0, 0.5);
    container.add([icon, label]);
    this.surface.add(container);
    return {
      container,
      icon,
      body,
      face,
      marker,
      border,
      label,
      die: { ...die },
      count: 0,
      iconScale: 1,
      wobbleAmplitude: 0,
      wobbleRate: 0,
      wobblePhase: 0,
    };
  }
}

/** Rows the content area is divided into, counting the `+N MORE` line as one. */
function laidOutRowCount(
  shown: number,
  hidden: number,
  columns: number,
): number {
  return Math.max(1, Math.ceil((shown + (hidden > 0 ? 1 : 0)) / columns));
}

/** Geometry one row gets under a given column split. Shared by the fit test and
 *  the pass that applies the winning split, so the two cannot disagree. */
function rowMetrics(
  columns: number,
  rowCount: number,
  cardWidth: number,
  contentHeight: number,
): {
  columnWidth: number;
  iconSize: number;
  labelSize: number;
  labelRoom: number;
} {
  const columnWidth = cardWidth / columns;
  const rowHeight = contentHeight / rowCount;
  const inner = Math.max(8, columnWidth - ROW_PAD * 2);
  // The icon never takes more than a bit under half the column, so whatever the
  // count turns out to be, the label always has the larger share to sit in.
  const iconSize = Phaser.Math.Clamp(
    Math.min(rowHeight - 3, columnWidth * 0.34, inner * 0.45),
    MIN_ICON_SIZE,
    40,
  );
  return {
    columnWidth,
    iconSize,
    // Bounded by the row as well as by the icon: a card holding more sizes than
    // it has height for would otherwise stack labels through one another.
    labelSize: Math.round(
      Phaser.Math.Clamp(
        Math.min(iconSize * 0.42, rowHeight * 0.62),
        MIN_LABEL_SIZE,
        13,
      ),
    ),
    labelRoom: Math.max(6, inner - iconSize - ICON_GAP),
  };
}

/** Shrink a centred text object until it sits inside `maxWidth`. */
function fitToWidth(text: Phaser.GameObjects.Text, maxWidth: number): void {
  text.setScale(1);
  if (text.width > maxWidth) text.setScale(maxWidth / text.width);
}
