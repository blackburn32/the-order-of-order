import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import type { Die } from "../systems/Dice";
import type { DiceRegionSummary } from "../systems/DicePool";

interface DieTypeRow {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Image;
  face: Phaser.GameObjects.Image;
  marker: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  die: Die;
}

/**
 * A spatial summary rendered in screen-space even though its position lives in
 * grid-world coordinates. Keeping text at ordinary font sizes avoids generating
 * enormous text textures as camera zoom approaches zero.
 */
export class DiceSummaryCard extends Phaser.GameObjects.Container {
  private background: Phaser.GameObjects.Rectangle;
  private title: Phaser.GameObjects.Text;
  private specials: Phaser.GameObjects.Text;
  private rows = new Map<number, DieTypeRow>();
  private summarySignature = "";
  private layoutSignature = "";

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
    this.add([this.background, this.title, this.specials]);
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

    const previousSides = [...this.rows.keys()].sort((a, b) => b - a).join(",");
    const previousSpecialsVisible = this.specials.visible;
    this.summarySignature = signature;
    this.title.setText(`${summary.total.toLocaleString()} DICE`);

    const specialParts: string[] = [];
    if (summary.maxFaceBonus > 0)
      specialParts.push(`MAX ${summary.maxFaceBonus.toLocaleString()}`);
    if (summary.loaded > 0)
      specialParts.push(`LOAD ${summary.loaded.toLocaleString()}`);
    if (summary.wildFace > 0)
      specialParts.push(`WILD ${summary.wildFace.toLocaleString()}`);
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
      row.label.setText(`d${side} ×${summary.bySides[side].toLocaleString()}`);
      row.face.setFrame(`face-${side}-${representative.value}`);
      row.marker.setVisible(representative.maxFaceBonus > 0);
    }

    // Face/count changes do not affect geometry. Re-layout only when the set of
    // rows or footer visibility changed.
    if (
      previousSides !== sides.join(",") ||
      previousSpecialsVisible !== this.specials.visible
    ) {
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
    const columns = sides.length > 2 && screenWidth >= 150 ? 2 : 1;
    const rowCount = Math.max(1, Math.ceil(sides.length / columns));
    const layoutSignature = [
      Math.round(screenWidth),
      Math.round(screenHeight),
      columns,
      sides.join(","),
      this.specials.visible ? 1 : 0,
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

    const specialsSize = Math.round(
      Phaser.Math.Clamp(screenHeight * 0.075, 7, 10),
    );
    if (this.specials.style.fontSize !== `${specialsSize}px`)
      this.specials.setFontSize(specialsSize);
    this.specials.setPosition(0, cardHeight / 2 - specialsSize / 2 - 6);

    const contentTop = -cardHeight / 2 + titleSize + 12;
    const contentBottom =
      cardHeight / 2 - (this.specials.visible ? specialsSize + 11 : 6);
    const contentHeight = Math.max(12, contentBottom - contentTop);
    const columnWidth = cardWidth / columns;
    const rowHeight = contentHeight / rowCount;
    const iconSize = Phaser.Math.Clamp(
      Math.min(rowHeight - 3, columnWidth * 0.34),
      14,
      40,
    );
    const labelSize = Math.round(Phaser.Math.Clamp(iconSize * 0.42, 7, 13));

    sides.forEach((side, index) => {
      const row = this.rows.get(side);
      if (!row) return;
      const column = index % columns;
      const rowIndex = Math.floor(index / columns);
      const x = -cardWidth / 2 + columnWidth * (column + 0.5);
      const y = contentTop + rowHeight * (rowIndex + 0.5);
      const rowWidth = Math.min(columnWidth - 8, iconSize + 72);
      const iconX = -rowWidth / 2 + iconSize / 2;
      const scale = iconSize / 96;

      row.container.setPosition(x, y);
      row.body.setPosition(iconX, 0).setScale(scale);
      row.face.setPosition(iconX, -4 * scale).setScale(scale);
      row.marker.setPosition(iconX + 34 * scale, -34 * scale).setScale(scale);
      if (row.label.style.fontSize !== `${labelSize}px`)
        row.label.setFontSize(labelSize);
      row.label.setPosition(iconX + iconSize / 2 + 4, 0);
    });
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

  private createRow(die: Die): DieTypeRow {
    const container = this.scene.add.container(0, 0);
    const body = this.scene.add.image(0, 0, `die-${die.sides}`);
    const face = this.scene.add.image(
      0,
      0,
      "die-atlas",
      `face-${die.sides}-${die.value}`,
    );
    const marker = this.scene.add.image(0, 0, "pip-gold");
    const label = this.scene.add
      .text(0, 0, "", {
        fontFamily: SERIF,
        color: CSS.parchment,
        fontSize: "10px",
        fontStyle: "bold",
      })
      .setOrigin(0, 0.5);
    container.add([body, face, marker, label]);
    this.add(container);
    return {
      container,
      body,
      face,
      marker,
      label,
      die: { ...die },
    };
  }
}
