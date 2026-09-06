import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { rankOf, trialInRank } from "../config";
import {
  histogramMedian,
  loadItemAnalysis,
  type ItemLifetimeAnalysis,
} from "../systems/ItemAnalytics";
import { itemValueMeta, type ItemValueMeta } from "../systems/ItemValue";
import { ITEMS, type ItemDef, type ShopItemId } from "../systems/Items";
import { loadProgress } from "../systems/SaveData";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { AmbientLayer } from "../ui/AmbientLayer";
import { formatCompactCount, formatScore } from "../ui/formatScore";
import {
  compactColumns,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
import { buildSceneHeader } from "../ui/sceneHeader";
import { slideOverlayIn, slideOverlayOut } from "../ui/sceneSlide";
import { addFelt, bannerButton, fitTextWidth } from "../ui/widgets";

interface ItemAnalysisData {
  returnTo: string;
  itemId: ShopItemId;
}

interface ChartLine {
  id: string;
  color: number;
  points: { x: number; y: number }[];
  swatch: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
}

const LINE_COLORS = [
  0xe6c65a, 0x86e07a, 0x72b7e8, 0xd98fe8, 0xff8b72, 0x69d6c5, 0xf2a65a,
  0xcfd6df, 0xe66fa8, 0xa8d672,
];
const REVEAL_MS = 560;

/** Lifetime detail opened from a Codex card. It deliberately shares the run
 * analysis chart language: a left-to-right reveal, compact keys, and direct
 * hover/touch emphasis. Here each line is one of the item's ten best runs. */
export class ItemAnalysisScene extends Phaser.Scene {
  private returnTo = "Items";
  private item!: ItemDef;
  private stats!: ItemLifetimeAnalysis;
  private meta!: ItemValueMeta;
  private purchaseCount = 0;
  private felt?: Phaser.GameObjects.Image;
  private chart?: Phaser.GameObjects.Graphics;
  private lines: ChartLine[] = [];
  private hovered?: string;
  private chartT = 1;
  private revealTween?: Phaser.Tweens.Tween;
  private leaving = false;

  constructor() {
    super("ItemAnalysis");
  }

  init(data: ItemAnalysisData): void {
    this.returnTo = data.returnTo;
    this.item = ITEMS.find((item) => item.id === data.itemId) ?? ITEMS[0];
    this.stats = loadItemAnalysis(this.item.id);
    this.meta = itemValueMeta(this.item.id);
    this.purchaseCount = loadProgress().selectionCounts[this.item.id] ?? 0;
  }

  create(): void {
    const base = this.scene.get(this.returnTo);
    if (base) base.input.enabled = false;
    this.leaving = false;
    this.build();
    if (this.felt) slideOverlayIn(this, this.felt, () => this.armReveal());
    else this.armReveal();

    const off = onResizeCoalesced(this, () => {
      this.revealTween?.remove();
      destroyAllChildren(this);
      this.lines = [];
      this.hovered = undefined;
      this.build();
      this.drawChart(1);
    });
    this.input.keyboard?.on("keydown-ESC", this.close, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.revealTween?.remove();
      this.input.keyboard?.off("keydown-ESC", this.close, this);
      const under = this.scene.get(this.returnTo);
      if (under) under.input.enabled = true;
    });
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    this.felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(W / 2, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(0.55, false);
    this.chart = this.add.graphics();
    this.lines = [];

    if (isCompactLandscape(W, H)) this.buildCompact();
    else this.buildStacked();
    this.drawChart(fx.motion ? 0 : 1);
  }

  private subtitle(): string {
    if (this.stats.runs === 0)
      return "Complete a run with this item to begin detailed analysis.";
    return `${this.stats.runs} analyzed run${this.stats.runs === 1 ? "" : "s"} · best ten shown`;
  }

  private buildStacked(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const header = buildSceneHeader(this, {
      title: this.item.name,
      subtitle: this.subtitle(),
      y: Math.max(42, Math.min(78, H * 0.1)),
      width: Math.min(W - 28, 720),
    });
    const close = bannerButton(
      this,
      cx,
      H - 14 - 35,
      "Close",
      () => this.close(),
      Math.min(W - 32, 300),
      70,
    );
    const badgeTop = header.bottom + 12;
    const badgeWidth = Math.min(W - 28, 780);
    const cols = W < 420 ? 2 : 3;
    const badgeBottom = this.buildBadges(
      cx - badgeWidth / 2,
      badgeTop,
      badgeWidth,
      cols,
      H < 680 ? 48 : 56,
    );
    this.buildChart(
      cx - Math.min(W - 32, 860) / 2,
      badgeBottom + 14,
      Math.min(W - 32, 860),
      Math.max(96, close.y - close.height / 2 - 16 - (badgeBottom + 14)),
    );
  }

  private buildCompact(): void {
    const columns = compactColumns(this, { leftFraction: 0.42 });
    const { left, right } = columns;
    const header = buildSceneHeader(this, {
      title: this.item.name,
      subtitle: this.subtitle(),
      x: left.cx,
      y: columns.top + 22,
      width: left.width,
    });
    const closeH = Math.min(58, Math.max(36, columns.height * 0.18));
    const close = bannerButton(
      this,
      left.cx,
      columns.bottom - closeH / 2,
      "Close",
      () => this.close(),
      left.width,
      closeH,
    );
    const badgeTop = header.bottom + 7;
    const badgeRoom = Math.max(72, close.y - close.height / 2 - 7 - badgeTop);
    this.buildBadges(
      left.x,
      badgeTop,
      left.width,
      2,
      Math.max(22, (badgeRoom - 10) / 3),
    );
    this.buildChart(right.x, columns.top, right.width, columns.height);
  }

  private buildBadges(
    x: number,
    y: number,
    width: number,
    cols: number,
    height: number,
  ): number {
    const pickup = histogramMedian(this.stats.pickupTrials, true);
    const copies = histogramMedian(this.stats.purchasesPerRun);
    const winRate = this.stats.runs
      ? Math.round((this.stats.wins / this.stats.runs) * 100)
      : undefined;
    const badges = [
      {
        label: "Times purchased",
        value: formatCompactCount(this.purchaseCount),
      },
      {
        label: this.meta.badgeLabel,
        value: this.stats.runs ? formatScore(this.stats.totalValue) : "—",
      },
      {
        label: "Gold spent",
        value: this.stats.runs
          ? `${formatCompactCount(this.stats.goldSpent)} gold`
          : "—",
      },
      {
        label: "Runs won / lost",
        value:
          winRate === undefined
            ? "—"
            : `${this.stats.wins}–${this.stats.losses} · ${winRate}%`,
      },
      {
        label: "Median first pickup",
        value:
          pickup === undefined
            ? "—"
            : `Rank ${rankOf(pickup)} · Trial ${trialInRank(pickup)}`,
      },
      {
        label: "Median purchases / run",
        value:
          copies === undefined
            ? "—"
            : `×${copies.toLocaleString(undefined, { maximumFractionDigits: 1 })}`,
      },
    ];
    const gap = 6;
    const rows = Math.ceil(badges.length / cols);
    const cellW = (width - gap * (cols - 1)) / cols;
    badges.forEach((badge, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const bx = x + col * (cellW + gap);
      const by = y + row * (height + gap);
      this.add
        .rectangle(bx, by, cellW, height, COLORS.feltLight, 0.82)
        .setOrigin(0, 0)
        .setStrokeStyle(1, COLORS.gold, 0.34);
      const label = this.add
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
      const value = this.add
        .text(bx + cellW / 2, by + height * 0.56, badge.value, {
          fontFamily: SERIF,
          fontSize: `${Math.round(Phaser.Math.Clamp(height * 0.32, 11, 18))}px`,
          color: CSS.goldLight,
          fontStyle: "bold",
        })
        .setOrigin(0.5);
      fitTextWidth(value, cellW - 8);
    });
    return y + rows * height + (rows - 1) * gap;
  }

  private buildChart(
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const curves = this.stats.topRuns;
    const frame = this.add.graphics();
    const title = this.add
      .text(x, y, this.meta.chartTitle, {
        fontFamily: SERIF,
        fontSize: "14px",
        color: CSS.parchment,
        fontStyle: "bold",
      })
      .setOrigin(0, 0);
    fitTextWidth(title, width);
    if (curves.length === 0) {
      const empty = this.add
        .text(x + width / 2, y + height / 2, "No analyzed runs yet", {
          fontFamily: SERIF,
          fontSize: "18px",
          color: CSS.dim,
          fontStyle: "italic",
        })
        .setOrigin(0.5);
      fitTextWidth(empty, width - 24);
      return;
    }

    const legendCols = Math.max(1, Math.min(5, Math.floor(width / 132)));
    const legendRows = Math.ceil(curves.length / legendCols);
    const legendH = legendRows * 16 + 5;
    const plotTop = y + 24;
    const plotH = Math.max(52, height - 24 - legendH - 17);
    const plotBottom = plotTop + plotH;
    const peak = Math.max(1, ...curves.map((curve) => curve.finalValue));
    const logarithmic = this.meta.kind === "points" || peak >= 1000;
    const axis = (value: number) =>
      logarithmic ? Math.log10(Math.max(0, value) + 1) : value;
    const axisMax = logarithmic
      ? Math.max(1, Math.ceil(axis(peak)))
      : niceCeil(peak);
    const unitY = (value: number) =>
      plotBottom - (axis(value) / axisMax) * plotH;
    const maxRolls = Math.max(1, ...curves.map((curve) => curve.rolls));

    const tickAxes = logarithmic
      ? [...new Set([axisMax / 3, (axisMax * 2) / 3, axisMax])]
      : [axisMax / 2, axisMax];
    for (const tickAxis of tickAxes) {
      const value = logarithmic ? 10 ** Math.min(308, tickAxis) - 1 : tickAxis;
      const gy = logarithmic
        ? plotBottom - (tickAxis / axisMax) * plotH
        : unitY(value);
      frame.lineStyle(1, COLORS.parchment, 0.1);
      frame.lineBetween(x, gy, x + width, gy);
      this.add
        .text(x + 3, Math.max(plotTop, gy - 1), formatCompactCount(value), {
          fontFamily: SERIF,
          fontSize: "10px",
          color: CSS.dim,
        })
        .setOrigin(0, gy - plotTop < 11 ? 0 : 1);
    }
    frame.lineStyle(1, COLORS.parchment, 0.28);
    frame.lineBetween(x, plotBottom, x + width, plotBottom);
    frame.lineBetween(x, plotTop, x, plotBottom);

    const cellW = width / legendCols;
    curves.forEach((curve, index) => {
      const color = LINE_COLORS[index % LINE_COLORS.length];
      const progress = curve.rolls > 0 ? curve.rolls / maxRolls : 1;
      const points = curve.values.map((value, point) => ({
        x:
          x +
          width *
            progress *
            (curve.values.length <= 1 ? 0 : point / (curve.values.length - 1)),
        y: unitY(value),
      }));
      if (points.length === 1) points.push({ ...points[0], x: x + 2 });
      const col = index % legendCols;
      const row = Math.floor(index / legendCols);
      const lx = x + col * cellW;
      const ly = plotBottom + 18 + row * 16;
      const swatch = this.add
        .rectangle(lx, ly + 5, 11, 5, color, 0.8)
        .setOrigin(0, 0.5);
      const label = this.add
        .text(
          lx + 16,
          ly,
          `#${index + 1} ${curve.won ? "W" : "L"} · ${formatCompactCount(curve.finalValue)}`,
          { fontFamily: SERIF, fontSize: "10px", color: CSS.parchmentDark },
        )
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: false });
      fitTextWidth(label, Math.max(20, cellW - 20));
      const id = String(curve.startedAt);
      label.on("pointerover", () => this.setHover(id));
      label.on("pointerout", () => this.setHover(undefined));
      label.on("pointerdown", () => this.setHover(id));
      this.lines.push({ id, color, points, swatch, label });
    });

    const hover = this.add
      .rectangle(x, plotTop, width, plotH, COLORS.felt, 0.001)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: false });
    const hoverAt = (
      _pointer: Phaser.Input.Pointer,
      localX: number,
      localY: number,
    ) => {
      const sceneX = x + localX;
      const sceneY = plotTop + localY;
      let nearest: ChartLine | undefined;
      let distance = Infinity;
      for (const line of this.lines) {
        const lineY = polylineYAt(line.points, sceneX);
        if (lineY === undefined) continue;
        const candidate = Math.abs(lineY - sceneY);
        if (candidate < distance) {
          nearest = line;
          distance = candidate;
        }
      }
      this.setHover(nearest?.id);
    };
    hover.on("pointerover", hoverAt);
    hover.on("pointermove", hoverAt);
    hover.on("pointerdown", hoverAt);
    hover.on("pointerout", () => this.setHover(undefined));

    const caption = this.add
      .text(
        x + width,
        y,
        `${formatCompactCount(maxRolls)} rolls · ${logarithmic ? "log" : "linear"} scale`,
        {
          fontFamily: SERIF,
          fontSize: "10px",
          color: CSS.dim,
          fontStyle: "italic",
        },
      )
      .setOrigin(1, 0);
    fitTextWidth(caption, width * 0.48);
  }

  private setHover(id: string | undefined): void {
    if (this.hovered === id) return;
    this.hovered = id;
    for (const line of this.lines) {
      const selected = id === undefined || id === line.id;
      line.swatch.setAlpha(id === undefined ? 0.8 : selected ? 1 : 0.2);
      line.label
        .setAlpha(id === undefined ? 1 : selected ? 1 : 0.3)
        .setColor(id !== undefined && selected ? CSS.ivory : CSS.parchmentDark);
    }
    this.drawChart(this.chartT);
  }

  private armReveal(): void {
    if (!fx.motion || !this.chart || this.lines.length === 0) return;
    this.revealTween?.remove();
    const state = { t: 0 };
    this.revealTween = this.tweens.add({
      targets: state,
      t: 1,
      duration: REVEAL_MS,
      ease: "Cubic.easeOut",
      onUpdate: () => this.drawChart(state.t),
    });
  }

  private drawChart(t: number): void {
    const chart = this.chart;
    if (!chart || !chart.scene) return;
    this.chartT = t;
    chart.clear();
    for (const line of this.lines) {
      const points = curveHead(line.points, t);
      if (points.length < 2) continue;
      const selected = this.hovered === undefined || this.hovered === line.id;
      chart.lineStyle(
        selected && this.hovered ? 3 : 1.8,
        line.color,
        selected ? 0.98 : 0.16,
      );
      chart.beginPath();
      chart.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++)
        chart.lineTo(points[i].x, points[i].y);
      chart.strokePath();
    }
  }

  private close(): void {
    if (this.leaving) return;
    this.leaving = true;
    audio.click();
    if (this.felt) slideOverlayOut(this, this.felt, () => this.scene.stop());
    else this.scene.stop();
  }
}

function niceCeil(value: number): number {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const nice = scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * magnitude;
}

function polylineYAt(
  points: { x: number; y: number }[],
  x: number,
): number | undefined {
  if (points.length === 0 || x < points[0].x || x > points[points.length - 1].x)
    return undefined;
  for (let i = 1; i < points.length; i++) {
    if (x > points[i].x) continue;
    const before = points[i - 1];
    const after = points[i];
    const span = after.x - before.x;
    const t = span <= 0 ? 0 : (x - before.x) / span;
    return Phaser.Math.Linear(before.y, after.y, t);
  }
  return points[points.length - 1].y;
}

function curveHead(
  points: { x: number; y: number }[],
  t: number,
): { x: number; y: number }[] {
  if (points.length < 2 || t >= 1) return points;
  if (t <= 0) return [];
  const end = t * (points.length - 1);
  const whole = Math.floor(end);
  const drawn = points.slice(0, whole + 1);
  if (whole < points.length - 1) {
    const fraction = end - whole;
    drawn.push({
      x: Phaser.Math.Linear(points[whole].x, points[whole + 1].x, fraction),
      y: Phaser.Math.Linear(points[whole].y, points[whole + 1].y, fraction),
    });
  }
  return drawn;
}
