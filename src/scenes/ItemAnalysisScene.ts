import Phaser from "phaser";
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
import {
  buildRunCurveChart,
  curveAxisIsLog,
  type RunCurveChart,
  type RunCurveSeries,
} from "../ui/runCurveChart";
import { buildStatBadges } from "../ui/statBadges";
import { addFelt, bannerButton } from "../ui/widgets";

interface ItemAnalysisData {
  returnTo: string;
  itemId: ShopItemId;
}

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
  private chart?: RunCurveChart;
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
    if (this.felt) slideOverlayIn(this, this.felt, () => this.chart?.reveal());
    else this.chart?.reveal();

    const off = onResizeCoalesced(this, () => {
      destroyAllChildren(this);
      this.chart = undefined;
      this.build();
    });
    this.input.keyboard?.on("keydown-ESC", this.close, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
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

    if (isCompactLandscape(W, H)) this.buildCompact();
    else this.buildStacked();
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
    const grid = buildStatBadges(this, {
      x,
      y,
      width,
      cols,
      height,
      badges: [
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
      ],
    });
    return y + grid.height;
  }

  private buildChart(
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const curves = this.stats.topRuns;
    const maxRolls = Math.max(1, ...curves.map((curve) => curve.rolls));
    const series: RunCurveSeries[] = curves.map((curve, index) => ({
      id: String(curve.startedAt),
      label: `#${index + 1} ${curve.won ? "W" : "L"} · ${formatCompactCount(curve.finalValue)}`,
      values: curve.values,
      span: curve.rolls > 0 ? curve.rolls / maxRolls : 1,
    }));
    // Points climb by orders of magnitude within a run, so their axis is always
    // compressed; a payoff counted in dice or gold only needs it once it gets
    // large. Settled here rather than left to the chart so the caption cannot
    // name a scale the plot isn't drawn on.
    const logarithmic = curveAxisIsLog(series, this.meta.kind === "points");
    this.chart = buildRunCurveChart(this, {
      x,
      y,
      width,
      height,
      title: this.meta.chartTitle,
      caption:
        curves.length === 0
          ? undefined
          : `${formatCompactCount(maxRolls)} rolls · ${
              logarithmic ? "log" : "linear"
            } scale`,
      logarithmic,
      series,
    });
  }

  private close(): void {
    if (this.leaving) return;
    this.leaving = true;
    audio.click();
    if (this.felt) slideOverlayOut(this, this.felt, () => this.scene.stop());
    else this.scene.stop();
  }
}
