import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { addPanel, bannerButton } from "../ui/widgets";
import { responsive } from "../ui/layout";
import { combinePointsByItem, PointEntry } from "../systems/ItemPoints";
import { formatScore } from "../ui/formatScore";

/** What to chart. Either the run's raw point maps (Game Over / Victory / local
 *  Hall, which keep the dice-vs-bonus split) or a pre-combined list (a global
 *  Hall row, whose metadata carries only per-item totals). */
export interface AnalysisData {
  /** Scene key whose input to re-enable when this overlay closes. */
  returnTo: string;
  title?: string;
  subtitle?: string;
  dicePoints?: Record<string, number>;
  itemPoints?: Record<string, number>;
  entries?: { id: string; label: string; points: number }[];
}

/**
 * A per-run "which items earned the points" bar chart, launched as an overlay on
 * top of Game Over / Victory / Hall (like InitialsPromptScene): it dims and
 * blocks the base scene, draws a ranked horizontal bar chart, and closes back to
 * it. Bars split base rolling points (from the dice an item provided) from the
 * item's own bonus/multiplier payouts where that split is known.
 */
export class AnalysisScene extends Phaser.Scene {
  private returnTo = "Menu";
  private title = "Run Analysis";
  private subtitle = "";
  private entries: PointEntry[] = [];

  constructor() {
    super("Analysis");
  }

  init(data: AnalysisData): void {
    this.returnTo = data.returnTo;
    this.title = data.title ?? "Run Analysis";
    if (data.entries) {
      // Pre-combined (global row): totals only, no dice/bonus split.
      this.entries = [...data.entries]
        .map((e) => ({
          id: e.id,
          label: e.label,
          dice: 0,
          bonus: 0,
          points: e.points,
        }))
        .sort((a, b) => b.points - a.points);
    } else {
      this.entries = combinePointsByItem(
        data.dicePoints,
        data.itemPoints,
      ).filter((e) => e.points > 0);
    }
    const total = this.entries.reduce((s, e) => s + e.points, 0);
    this.subtitle =
      data.subtitle ?? (total > 0 ? `${formatScore(total)} points total` : "");
  }

  create(): void {
    const base = this.scene.get(this.returnTo);
    if (base) base.input.enabled = false;

    responsive(this, () => this.build());

    this.input.keyboard?.on("keydown-ESC", this.close, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off("keydown-ESC", this.close, this);
      const b = this.scene.get(this.returnTo);
      if (b) b.input.enabled = true;
    });
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const cy = H / 2;

    // Dim, interactive backdrop that swallows taps meant for the base scene.
    this.add
      .rectangle(cx, cy, W, H, COLORS.feltDark, 0.72)
      .setInteractive()
      .on("pointerdown", () => {});

    const panelW = Math.min(W - 32, 760);
    const panelH = Math.min(H - 32, 640);
    const panelTop = cy - panelH / 2;
    const panelLeft = cx - panelW / 2;
    addPanel(this, cx, cy, panelW, panelH);

    this.add
      .text(cx, panelTop + panelH * 0.06, this.title, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(panelW * 0.05, 22, 36))}px`,
        color: CSS.ink,
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    if (this.subtitle) {
      this.add
        .text(cx, panelTop + panelH * 0.115, this.subtitle, {
          fontFamily: SERIF,
          fontSize: "16px",
          color: CSS.ink,
          fontStyle: "italic",
        })
        .setOrigin(0.5);
    }

    const closeY = panelTop + panelH - Math.min(56, panelH * 0.1);
    const chartTop = panelTop + panelH * 0.17;
    const chartBottom = closeY - Math.min(60, panelH * 0.11);
    this.drawChart(panelLeft, panelW, chartTop, chartBottom);

    bannerButton(this, cx, closeY, "Close", () => this.close(), panelW * 0.6);
  }

  private drawChart(
    panelLeft: number,
    panelW: number,
    top: number,
    bottom: number,
  ): void {
    const pad = panelW * 0.08;
    const left = panelLeft + pad;
    const right = panelLeft + panelW - pad;
    const width = right - left;

    if (this.entries.length === 0) {
      this.add
        .text(
          (left + right) / 2,
          (top + bottom) / 2,
          "No points recorded for this run.",
          {
            fontFamily: SERIF,
            fontSize: "18px",
            color: CSS.dim,
            fontStyle: "italic",
          },
        )
        .setOrigin(0.5);
      return;
    }

    // Fit as many rows as the space allows (min row height keeps bars legible).
    const rowH = 30;
    const maxRows = Math.max(1, Math.floor((bottom - top) / rowH));
    const shown = this.entries.slice(0, maxRows);
    const hasSplit = shown.some((e) => e.dice > 0 && e.bonus > 0);

    const labelW = Math.min(150, width * 0.32);
    const valueW = 84;
    const trackX = left + labelW + 8;
    const trackW = Math.max(20, right - valueW - 8 - trackX);
    const max = Math.max(1, ...shown.map((e) => e.points));
    const barH = Math.min(14, rowH * 0.5);

    shown.forEach((e, i) => {
      const y = top + i * rowH + rowH / 2;

      this.add
        .text(left, y, e.label, {
          fontFamily: SERIF,
          fontSize: "15px",
          color: CSS.ink,
        })
        .setOrigin(0, 0.5)
        .setFixedSize(labelW, 0)
        .setCrop(0, 0, labelW, 40);

      // Track then fill. When the split is known, draw the dice portion (gold)
      // and the bonus/multiplier portion (green) as adjacent segments.
      this.add
        .rectangle(trackX, y, trackW, barH, COLORS.feltLight, 0.35)
        .setOrigin(0, 0.5);
      const total = e.dice + e.bonus > 0 ? e.dice + e.bonus : e.points;
      const diceW = (e.dice / max) * trackW;
      const bonusW = (e.bonus / max) * trackW;
      if (e.dice > 0 && e.bonus > 0) {
        this.add
          .rectangle(trackX, y, diceW, barH, COLORS.gold)
          .setOrigin(0, 0.5);
        this.add
          .rectangle(trackX + diceW, y, bonusW, barH, COLORS.glowGreen)
          .setOrigin(0, 0.5);
      } else {
        const w = (e.points / max) * trackW;
        this.add.rectangle(trackX, y, w, barH, COLORS.gold).setOrigin(0, 0.5);
      }
      void total;

      this.add
        .text(right, y, formatScore(e.points), {
          fontFamily: SERIF,
          fontSize: "15px",
          color: CSS.ink,
        })
        .setOrigin(1, 0.5);
    });

    // Legend for the split + an overflow note.
    const notes: string[] = [];
    if (hasSplit)
      notes.push(
        "gold = points from this item’s dice · green = its bonus/multiplier",
      );
    if (this.entries.length > shown.length)
      notes.push(`+${this.entries.length - shown.length} more`);
    if (notes.length) {
      this.add
        .text((left + right) / 2, bottom + 6, notes.join("   ·   "), {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.dim,
        })
        .setOrigin(0.5, 0);
    }
  }

  private close(): void {
    this.scene.stop();
  }
}
