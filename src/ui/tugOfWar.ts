// The duel's tug of war: one rope, the Order of Order holding one end and the
// Order of Disorder the other, with a knot that the leader drives into the
// other side's half.
//
// The mirror duel is the one trial where the two numbers on screen are always
// close — the rival is the player's own grid, so the totals track each other
// roll for roll — and by the final rank they are also huge. Printed in
// scientific notation, 4.12e18 against 4.13e18 is two near-identical strings,
// and the question the duel actually asks ("who is ahead, and by how much?")
// has to be answered by squinting at the third digit. The rope answers it
// directly.
//
// The knot's travel is logarithmic in the relative lead, not linear in each
// side's share of the total: a linear share would sit at 49.9% for the whole
// duel, because the lead that decides it is usually a fraction of a percent.
// On this scale a 0.1% lead already moves the knot visibly, 1% moves it about
// a sixth of the rope, and only a rout pins it to an end.

import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { fx } from "../systems/Effects";
import { formatScore } from "./formatScore";

/** How hard small leads are amplified. A relative lead of 1/K reaches ~10% of
 *  the knot's travel; a lead equal to the trailing total reaches all of it. */
const LEAD_GAIN = 1000;
/** Fixed-point precision for reading the relative lead out of two bigints. */
const LEAD_PRECISION = 1_000_000_000n;

const PULL_MS = 520;

/**
 * Where the knot sits, from -1 (the Order of Disorder has pulled it all the way)
 * through 0 (level) to +1 (the player has). Measured on the relative lead —
 * the gap over the trailing total — so the reading is the same at any scale.
 */
export function tugBalance(score: bigint, rival: bigint): number {
  if (score === rival) return 0;
  const lead = score > rival ? score - rival : rival - score;
  const trailing = score > rival ? rival : score;
  const sign = score > rival ? 1 : -1;
  if (trailing <= 0n) return sign;
  const relative = Number((lead * LEAD_PRECISION) / trailing) / 1e9;
  const pull = Math.log1p(LEAD_GAIN * relative) / Math.log1p(LEAD_GAIN);
  return sign * Math.min(1, pull);
}

/**
 * The lead in words a few characters wide: how much bigger the leader's total
 * is than the trailer's, as a percentage while that reads well and as a
 * multiple once it doesn't. Unsigned — the caller colours it by side.
 */
export function tugLeadCopy(score: bigint, rival: bigint): string {
  if (score === rival) return "LEVEL";
  const high = score > rival ? score : rival;
  const low = score > rival ? rival : score;
  if (low <= 0n) return "";
  const percent = Number(((high - low) * LEAD_PRECISION) / low) / 1e7;
  if (percent < 0.01) return "<0.01%";
  if (percent < 1) return `${percent.toFixed(2)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  if (percent < 900) return `${Math.round(percent)}%`;
  return `×${formatScore(high / low)}`;
}

export interface TugCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which end the player holds. The HUD keeps the Order of Disorder's total to
 *  the left of the player's, the showdown sets the player's down on the left;
 *  each rope is drawn to match the numbers it sits under. */
export type TugPlayerSide = "left" | "right";

export class TugOfWarBar {
  readonly container: Phaser.GameObjects.Container;
  private rope: Phaser.GameObjects.Graphics;
  private label: Phaser.GameObjects.Text;
  private cell: TugCell;
  /** Where the knot is drawn, and where it is headed. */
  private shown = 0;
  private target = 0;
  private copy = "LEVEL";
  private copyColor = CSS.parchment;
  private pull?: Phaser.Tweens.Tween;
  private read = false;

  constructor(
    private scene: Phaser.Scene,
    cell: TugCell,
    private playerSide: TugPlayerSide = "left",
  ) {
    this.cell = cell;
    this.rope = scene.add.graphics();
    this.label = scene.add
      .text(0, 0, "", {
        fontFamily: SERIF,
        fontSize: "11px",
        color: CSS.parchment,
        fontStyle: "bold",
      })
      .setOrigin(0.5, 1);
    this.container = scene.add.container(cell.x, cell.y, [
      this.rope,
      this.label,
    ]);
    this.layout(cell);
  }

  layout(cell: TugCell): void {
    this.cell = cell;
    this.container.setPosition(cell.x, cell.y);
    this.label.setFontSize(Phaser.Math.Clamp(cell.h * 0.48, 9, 13));
    this.draw();
  }

  /**
   * Pull the knot to the reading for these two totals. The first reading lands
   * where it belongs; later ones are hauled there, after `delayMs` so the rope
   * moves when the score plaque does rather than ahead of it.
   */
  setReading(score: bigint, rival: bigint, delayMs = 0): void {
    const target = tugBalance(score, rival);
    const copy = tugLeadCopy(score, rival);
    const color =
      score === rival ? CSS.parchment : score > rival ? CSS.goldLight : CSS.red;
    const first = !this.read;
    this.read = true;
    if (
      !first &&
      target === this.target &&
      copy === this.copy &&
      color === this.copyColor
    )
      return;
    this.target = target;
    this.pull?.remove();
    this.pull = undefined;

    const settle = () => {
      this.copy = copy;
      this.copyColor = color;
    };
    if (first || !fx.motion) {
      settle();
      this.shown = target;
      this.draw();
      return;
    }
    const from = this.shown;
    this.pull = this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      delay: Math.max(0, delayMs),
      duration: PULL_MS,
      ease: "Back.easeOut",
      onStart: settle,
      onUpdate: (tween) => {
        if (!this.container.active) return;
        this.shown = from + (target - from) * (tween.getValue() ?? 0);
        this.draw();
      },
      onComplete: () => {
        this.pull = undefined;
      },
    });
  }

  private draw(): void {
    if (!this.container.active) return;
    const { w, h } = this.cell;
    const g = this.rope;
    const half = w / 2;
    const thick = Phaser.Math.Clamp(h * 0.28, 4, 8);
    const ropeY = h / 2 - thick / 2 - 1;
    const playerLeft = this.playerSide === "left";
    // A lead pushes the knot away from the leader, into the other side's end.
    const knotX =
      Phaser.Math.Clamp(this.shown, -1, 1) * half * (playerLeft ? 1 : -1);

    g.clear();
    // The rope: each side's colour runs from its own end to the knot —
    // whoever holds more of it is ahead.
    g.fillStyle(COLORS.feltDark, 0.75);
    g.fillRoundedRect(-half - 2, ropeY - thick / 2 - 2, w + 4, thick + 4, 4);
    g.fillStyle(playerLeft ? COLORS.gold : COLORS.waxRed, 0.95);
    g.fillRect(-half, ropeY - thick / 2, half + knotX, thick);
    g.fillStyle(playerLeft ? COLORS.waxRed : COLORS.gold, 0.95);
    g.fillRect(knotX, ropeY - thick / 2, half - knotX, thick);
    // The mid-line the knot is pulled across.
    g.lineStyle(1, COLORS.parchment, 0.55);
    g.lineBetween(0, ropeY - thick / 2 - 3, 0, ropeY + thick / 2 + 3);
    // The knot.
    const k = thick / 2 + 3;
    g.fillStyle(COLORS.ivory, 1);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(knotX, ropeY - k),
        new Phaser.Math.Vector2(knotX + k * 0.75, ropeY),
        new Phaser.Math.Vector2(knotX, ropeY + k),
        new Phaser.Math.Vector2(knotX - k * 0.75, ropeY),
      ],
      true,
    );
    g.lineStyle(1, COLORS.feltDark, 0.9);
    g.strokePoints(
      [
        new Phaser.Math.Vector2(knotX, ropeY - k),
        new Phaser.Math.Vector2(knotX + k * 0.75, ropeY),
        new Phaser.Math.Vector2(knotX, ropeY + k),
        new Phaser.Math.Vector2(knotX - k * 0.75, ropeY),
      ],
      true,
    );

    // The lead rides the knot, held inside the rope's ends.
    this.label.setText(this.copy).setColor(this.copyColor);
    const room = half - this.label.width / 2;
    this.label.setPosition(
      Phaser.Math.Clamp(knotX, -room, room),
      ropeY - k - 1,
    );
  }

  destroy(): void {
    this.pull?.remove();
    this.pull = undefined;
    this.container.destroy();
  }
}
