import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { addFelt, bannerButton, fitTextWidth } from "../ui/widgets";
import {
  Column,
  compactColumns,
  COMPACT_LANDSCAPE_MAX_H,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
import { addCamera } from "../ui/camera";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import { slideOverlayIn, slideOverlayOut } from "../ui/sceneSlide";
import {
  combinePointsByItem,
  PointEntry,
  sourceLabel,
} from "../systems/ItemPoints";
import type { RollSample } from "../systems/RunHistory";
import { formatCompactCount, formatScore } from "../ui/formatScore";
import { trialInRank } from "../config";

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
  /** The run's per-roll timeline (see systems/RunHistory), charted under the
   *  bars. Local runs only: a global row carries per-item totals and nothing
   *  else, so those open with the bars alone. */
  history?: RollSample[];
  /** Rolls the run actually took. Equal to `history.length - 1` for every run
   *  short enough to be sampled one-for-one. */
  rolls?: number;
}

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (
  pointer: Phaser.Input.Pointer,
  over: unknown,
  dx: number,
  dy: number,
  dz: number,
) => void;

/** Fixed sigil brightness for the backdrop — there is no live round to report
 *  here, so the value is chosen purely for how it looks (see SettingsScene). */
const ANALYSIS_AMBIENCE = 0.55;

/** Row pitch bounds. A short list opens the rows out to the maximum; a long one
 *  closes them to the minimum and scrolls the remainder. */
const MIN_ROW_H = 26;
const MAX_ROW_H = 46;

/** Strip kept clear under the chart for its legend / scroll hint. Wider than
 *  the line it holds: a scrolling list is cut off mid-row at the band edge, and
 *  without a little air that cut lands right on top of the legend. */
const FOOTNOTE_H = 24;

/** Where a list too short to fill its band sits within it: 0 pins it to the
 *  top, 0.5 centres it. */
const SHORT_LIST_BIAS = 0.34;

/** How long the bars take to grow in once the overlay has come to rest. */
const BAR_REVEAL_MS = 560;

/** A charted curve's furniture, above and below its plot: the heading that
 *  names it and carries its final value, and the axis caption under it. */
const GRAPH_HEAD_H = 17;
const GRAPH_FOOT_H = 16;

/** Compact item keys use equal-width columns under a plot. This keeps every
 *  visible series named without letting a large build turn the key into a
 *  single unreadably long line. */
const GRAPH_KEY_CELL_W = 112;
const GRAPH_KEY_ROW_H = 15;
const GRAPH_KEY_TOP = 3;

/** Air over each plot, separating it from the bars — or the plot — above it. */
const GRAPH_GAP = 14;

/** Plot height bounds. The floor is what a curve still reads at on a handset in
 *  landscape. The ceiling only binds where a plot competes with the bars for the
 *  same column, so the two-column composition raises it. */
const MIN_PLOT_H = 76;
const MAX_PLOT_H = 168;
const MAX_SPLIT_PLOT_H = 300;

/** The two-column composition: the gutter between the bars and the curves, and
 *  the narrowest either column may be before the chart folds back into one. */
const SPLIT_GUTTER = 28;
const MIN_SPLIT_COLUMN = 320;

/** How wide the two columns together may grow. Past this the bars are longer
 *  than they are worth comparing and the labels drift away from their values. */
const MAX_SPLIT_W = 1120;

/** Most points a curve is drawn with. A run's timeline is far shorter than this
 *  in practice; the cap is what keeps a thousand-roll endless run from costing a
 *  thousand line segments on every frame of the reveal. */
const MAX_CURVE_POINTS = 512;

/** Above this many dice the pool has spanned enough orders of magnitude that a
 *  linear axis would flatten everything before the last trial or two. */
const DICE_LOG_THRESHOLD = 1000;

/** A stable high-contrast cycle shared by both graphs, so one item keeps the
 *  same identity when the player toggles points and dice independently. */
const ITEM_LINE_COLORS = [
  0xe6c65a, 0x86e07a, 0x72b7e8, 0xd98fe8, 0xff8b72, 0x69d6c5, 0xf2a65a,
  0xcfd6df, 0xe66fa8, 0xa8d672, 0x8f9ff0, 0xe8df87,
];

/** One bar's geometry, resolved at layout time and redrawn on each frame of the
 *  reveal. Widths are the bar's *full* extent; the reveal scales them. */
interface BarSpec {
  x: number;
  y: number;
  h: number;
  /** Width of the base rolling-points segment (gold). */
  dice: number;
  /** Width of the bonus/multiplier segment (green), stacked after it. */
  bonus: number;
}

/**
 * One curve, resolved at layout time into scene coordinates so the reveal only
 * has to walk the points. Everything here is redrawn every frame, because the
 * bars and the curves share one Graphics and it is cleared each time.
 */
interface GraphSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: {
    id: string;
    color: number;
    /** The polyline, thinned to at most one point per pixel of width. */
    points: { x: number; y: number }[];
    /** The preceding cumulative item boundary. Present in stacked-item view;
     *  absent for the aggregate, whose area closes against the plot floor. */
    lowerPoints?: { x: number; y: number }[];
    legend?: {
      swatch: Phaser.GameObjects.Rectangle;
      label: Phaser.GameObjects.Text;
    };
  }[];
  hoveredId?: string;
  /** Horizontal gridlines, as scene y. */
  grid: number[];
  /** Trial boundaries, as scene x; `strong` marks the first trial of a rank. */
  marks: { x: number; strong: boolean }[];
}

/** A series ready to be laid out: values already in axis units, the top of the
 *  axis (its bottom is always zero), and the labels that go with it. */
type CurveId = "points" | "dice";

interface CurveLine {
  id: string;
  label: string;
  color: number;
  values: number[];
  /** Axis-space cumulative boundary below this item. */
  lowerValues?: number[];
}

interface Curve {
  id: CurveId;
  title: string;
  /** The series' last value, printed opposite the title. */
  value: string;
  caption: string;
  aggregate: CurveLine;
  items: CurveLine[];
  axisMax: number;
  ticks: { value: number; label: string }[];
}

/**
 * A per-run "which items earned the points" bar chart, launched as an overlay on
 * top of Game Over / Victory / Hall (like InitialsPromptScene).
 *
 * It wears the same room as the rest of the game rather than a parchment panel:
 * felt, a turning sigil inside its counter-turning ring, the shared masthead
 * with its breathing halo, and the type sitting directly on the table. Bars
 * split base rolling points (from the dice an item provided) from the item's own
 * bonus/multiplier payouts where that split is known, and the list scrolls when
 * a long run has more sources than the viewport has rows.
 *
 * A run that recorded a timeline also charts how it got there: points and pool
 * size against every roll it took. A viewport with the room stands those curves
 * in a second column beside the bars, so the whole analysis is read at once;
 * anything smaller runs them under the bars in the one scrolling column.
 */
export class AnalysisScene extends Phaser.Scene {
  private returnTo = "Menu";
  private title = "Run Analysis";
  private subtitle = "";
  private entries: PointEntry[] = [];
  private total = 0;
  private hasSplit = false;
  private history: RollSample[] = [];
  private rolls = 0;
  /** Each graph owns its view state: the player can expand one into item lines
   *  without changing the other. Reset for every newly-opened analysis. */
  private itemLines: Record<CurveId, boolean> = {
    points: false,
    dice: false,
  };

  private felt?: Phaser.GameObjects.Image;
  private leaving = false;
  /** Clips the scrolling chart; absent when the whole list fits. */
  private scrollCamera?: Phaser.Cameras.Scene2D.Camera;
  /** User scroll retained across an item-line reflow, so expanding a graph does
   *  not throw the player back to the top of a long analysis. */
  private scrollY = 0;
  private scrollInput?: {
    down: PointerHandler;
    move: PointerHandler;
    up: PointerHandler;
    wheel: WheelHandler;
  };
  private bars: BarSpec[] = [];
  private graphs: GraphSpec[] = [];
  private chartGfx?: Phaser.GameObjects.Graphics;
  /** Current reveal position, reused by hover redraws so moving over a graph
   *  while it enters cannot snap the chart to its finished state. */
  private chartT = 1;
  private barTween?: Phaser.Tweens.Tween;
  /** Runs the bar growth. Held back until the entrance has landed, so the two
   *  animations read as one arrival rather than talking over each other. */
  private reveal?: () => void;

  constructor() {
    super("Analysis");
  }

  init(data: AnalysisData): void {
    this.returnTo = data.returnTo;
    this.title = data.title ?? "Run Analysis";
    this.subtitle = data.subtitle ?? "";
    if (data.entries) {
      // Pre-combined (global row): totals only, no dice/bonus split.
      this.entries = [...data.entries]
        .filter((e) => e.points > 0)
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
    this.total = this.entries.reduce((s, e) => s + e.points, 0);
    this.hasSplit = this.entries.some((e) => e.dice > 0 && e.bonus > 0);
    // One sample is a point, not a curve; a run that recorded none charts
    // nothing and simply keeps the bars it always had.
    this.history = (data.history ?? []).length >= 2 ? [...data.history!] : [];
    this.rolls = data.rolls ?? Math.max(0, this.history.length - 1);
    this.itemLines = { points: false, dice: false };
    this.scrollY = 0;
  }

  create(): void {
    // Block the scene underneath from reacting to taps/hovers while we are open.
    const base = this.scene.get(this.returnTo);
    if (base) base.input.enabled = false;

    this.leaving = false;
    this.scrollCamera = undefined;
    // Not using responsive() — its rebuild doesn't clear the extra camera and
    // input listeners a scroll view needs, so drive rebuilds manually.
    this.build();
    if (this.felt) slideOverlayIn(this, this.felt, () => this.reveal?.());
    else this.reveal?.();

    const off = onResizeCoalesced(this, () => {
      this.teardown();
      destroyAllChildren(this);
      this.build();
      // A resize has no entrance to wait on.
      this.reveal?.();
    });

    this.input.keyboard?.on("keydown-ESC", this.close, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardown();
      this.input.keyboard?.off("keydown-ESC", this.close, this);
      const b = this.scene.get(this.returnTo);
      if (b) b.input.enabled = true;
    });
  }

  private teardown(): void {
    if (this.scrollInput) {
      this.input.off("pointerdown", this.scrollInput.down);
      this.input.off("pointermove", this.scrollInput.move);
      this.input.off("pointerup", this.scrollInput.up);
      this.input.off("pointerupoutside", this.scrollInput.up);
      this.input.off("wheel", this.scrollInput.wheel);
      this.scrollInput = undefined;
    }
    if (this.scrollCamera) {
      this.cameras.remove(this.scrollCamera, true);
      this.scrollCamera = undefined;
    }
    // The reveal tween outlives the graphics it writes to.
    this.barTween?.remove();
    this.barTween = undefined;
    this.chartGfx = undefined;
    this.bars = [];
    this.graphs = [];
    this.reveal = undefined;
    this.input.setDefaultCursor("default");
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    // A complete room of its own: the overlay is launched over a live scene, so
    // an opaque felt layer keeps the two interfaces from tangling. The base
    // scene's input is off for as long as we are up, so nothing reaches it.
    const felt = addFelt(this);
    this.felt = felt;
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(W / 2, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(ANALYSIS_AMBIENCE, false);

    // The shared threshold rules out columns below 500px because the denser
    // game screens need more width. A chart of labelled bars keeps working in a
    // narrow column, and a short viewport has no other way to show more than a
    // row or two — so this screen folds on any short landscape view.
    const compact =
      isCompactLandscape(W, H) || (W > H && H < COMPACT_LANDSCAPE_MAX_H);
    if (compact) this.buildCompact();
    else this.buildStacked();
  }

  /** The roomy/portrait composition: masthead, total, chart, then the way out. */
  private buildStacked(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const header = buildSceneHeader(this, {
      title: this.title,
      subtitle: this.subtitle || undefined,
      y: Math.max(46, Math.min(H * 0.13, 88)),
      width: Math.min(W, 720),
    });

    const totalBottom = this.buildTotal(
      cx,
      Math.min(W - 32, 620),
      header.bottom + 12,
    );

    const close = bannerButton(
      this,
      cx,
      0,
      "Close",
      () => this.close(),
      Math.min(W - 32, 320),
    );
    close.setY(H - 16 - close.height / 2);

    const bandTop = totalBottom + 16;
    const bandBottom = H - 16 - close.height - 16;
    const curves = this.buildCurves();

    // Given the room, the curves stand beside the bars rather than under them.
    // The pair keeps a wider margin than the single column does: run out to the
    // same 20px and two columns read as one edge-to-edge slab.
    const wide = Math.min(W - 80, MAX_SPLIT_W);
    const split = this.splitColumns(
      cx - wide / 2,
      wide,
      bandBottom - bandTop,
      curves,
    );
    if (split) {
      this.buildSplitChart(split, curves, bandTop);
      return;
    }

    const chartW = Math.min(W - 40, 620);
    this.buildChart(
      { x: cx - chartW / 2, cx, width: chartW, right: cx + chartW / 2 },
      bandTop,
      bandBottom,
      curves,
    );
  }

  /** A handset in landscape has width but almost no height: the masthead, the
   *  run's total and the way out take one column, the chart the other — at full
   *  height, which is what buys it enough rows to be worth reading. */
  private buildCompact(): void {
    const columns = compactColumns(this, { leftFraction: 0.4 });
    const { left, right } = columns;

    // The shared masthead keeps generous air around its rule and subtitle.
    // Below this height that air costs the chart its rows, so use a
    // single-line title/detail block instead (see InitialsPromptScene).
    const short = columns.height < 215;
    const headerBottom = short
      ? this.buildShortHeader(left.cx, left.width, columns.top)
      : buildSceneHeader(this, {
          title: this.title,
          subtitle: this.subtitle || undefined,
          x: left.cx,
          y: columns.top + 30,
          width: left.width,
        }).bottom;

    const totalBottom = this.buildTotal(
      left.cx,
      left.width,
      headerBottom + (short ? 4 : 8),
    );

    // Whatever is left of the column below the total belongs to the one control
    // this screen has; it shrinks to that budget rather than lapping the text
    // above it or running off the bottom.
    const bandTop = totalBottom + 10;
    const bandH = Math.max(30, columns.bottom - bandTop);
    const close = bannerButton(
      this,
      left.cx,
      0,
      "Close",
      () => this.close(),
      left.width,
      bandH,
    );
    close.setY(bandTop + bandH / 2);

    // A wide-but-short window folds to these columns too, and its chart column
    // is often broad enough to take the same split the roomy layout does.
    const curves = this.buildCurves();
    const split = this.splitColumns(
      right.x,
      right.width,
      columns.height,
      curves,
    );
    if (split) this.buildSplitChart(split, curves, columns.top);
    else this.buildChart(right, columns.top, columns.bottom, curves);
  }

  /** A low-profile masthead for landscape viewports with barely any usable
   *  height: one stroked title line, a hairline, and the detail beneath it. */
  private buildShortHeader(cx: number, width: number, top: number): number {
    const titleSize = 22;
    const title = this.add
      .text(cx, top, this.title, {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        stroke: "#0d0a12",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 0)
      .setShadow(0, 3, "#000000", 8, true, true);
    fitTextWidth(title, width);

    const ruleY = title.getBounds().bottom + 3;
    const rule = this.add.graphics();
    rule.lineStyle(1, COLORS.gold, 0.52);
    rule.lineBetween(cx - width / 2, ruleY, cx + width / 2, ruleY);
    if (!this.subtitle) return ruleY + 2;

    const detail = this.add
      .text(cx, ruleY + 3, this.subtitle, {
        fontFamily: SERIF,
        fontSize: "12px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5, 0);
    fitTextWidth(detail, width);
    return detail.getBounds().bottom;
  }

  /** The run's headline number, in gold under the masthead. Returns the y it
   *  ends at, which is where the chart begins. */
  private buildTotal(cx: number, maxWidth: number, top: number): number {
    if (this.total <= 0) return top;
    const size = Math.round(Phaser.Math.Clamp(maxWidth * 0.055, 17, 26));
    const text = this.add
      .text(cx, top, `${formatScore(this.total)} points`, {
        fontFamily: SERIF,
        fontSize: `${size}px`,
        color: CSS.goldLight,
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0)
      .setShadow(0, 3, "#000000", 9, false, true);
    fitTextWidth(text, maxWidth);
    return text.getBounds().bottom;
  }

  /**
   * The two columns the chart stands in when the viewport can hold the whole of
   * it at once — bars on the left, curves on the right — or null where it
   * cannot, which is what puts them back into one scrolling column. Both halves
   * have to fit outright: a split that still scrolled would be a worse version
   * of the single column rather than a better one.
   */
  private splitColumns(
    x: number,
    width: number,
    height: number,
    curves: Curve[],
  ): { bars: Column; curves: Column; band: number } | null {
    if (this.entries.length === 0 || curves.length === 0) return null;
    const each = Math.floor((width - SPLIT_GUTTER) / 2);
    if (each < MIN_SPLIT_COLUMN) return null;
    // The legend belongs under the bars but is measured out of the band both
    // columns share, so the two sides still end on the same line.
    const band = height - (this.hasSplit ? FOOTNOTE_H : 0);
    if (this.entries.length * MIN_ROW_H > band) return null;
    const curvesH = curves.reduce(
      (sum, curve) =>
        sum +
        GRAPH_GAP +
        GRAPH_HEAD_H +
        MIN_PLOT_H +
        this.graphFootHeight(curve, each),
      0,
    );
    if (curvesH > band) return null;
    const column = (left: number): Column => ({
      x: left,
      cx: left + each / 2,
      width: each,
      right: left + each,
    });
    return { bars: column(x), curves: column(x + each + SPLIT_GUTTER), band };
  }

  /**
   * The side-by-side composition: the ranked bars in one column and the run's
   * curves in the other, both sized to the band they share. Nothing scrolls —
   * `splitColumns` hands this layout back only when the whole chart fits — so
   * each side is simply gathered a little above the band's centre, the way a
   * short list is in the single column.
   */
  private buildSplitChart(
    columns: { bars: Column; curves: Column; band: number },
    curves: Curve[],
    top: number,
  ): void {
    this.scrollY = 0;
    const { bars, curves: plots, band } = columns;
    const count = this.entries.length;

    const rowH = Phaser.Math.Clamp(band / count, MIN_ROW_H, MAX_ROW_H);

    // With no bars to compete with for the column, the plots open out to fill
    // the band rather than stopping at the height they settle for beneath a list.
    const furniture = curves.reduce(
      (sum, curve) =>
        sum +
        GRAPH_GAP +
        GRAPH_HEAD_H +
        this.graphFootHeight(curve, plots.width),
      0,
    );
    const plotH = Math.round(
      Phaser.Math.Clamp(
        (band - furniture) / curves.length,
        MIN_PLOT_H,
        MAX_SPLIT_PLOT_H,
      ),
    );

    // One offset for both columns, taken from whichever side is taller, so the
    // two start on the same line instead of drifting apart by the difference
    // between them. The bias is the single column's: a pair that does not fill
    // the band gathers up under the total rather than floating in the middle.
    const tallest = Math.max(rowH * count, furniture + curves.length * plotH);
    const sectionTop = top + (band - tallest) * SHORT_LIST_BIAS;
    const barsTop = sectionTop;
    let curveTop = sectionTop;

    if (this.hasSplit) {
      // Directly under the last bar rather than down on the band's floor: with
      // nothing scrolling here, a legend stranded below a short list reads as
      // having come loose from the thing it explains.
      const note = this.add
        .text(
          bars.cx,
          barsTop + rowH * count + 6,
          "gold · dice   green · bonus",
          {
            fontFamily: SERIF,
            fontSize: "13px",
            color: CSS.dim,
            fontStyle: "italic",
          },
        )
        .setOrigin(0.5, 0);
      fitTextWidth(note, bars.width);
    }

    this.barGeometry(bars.x, bars.width, barsTop, rowH);
    const content = this.add.container(0, 0);
    this.barGlow(content);
    const gfx = this.add.graphics();
    content.add(gfx);
    this.chartGfx = gfx;
    this.barRows(content, bars.x, bars.width, barsTop, rowH);

    this.graphs = [];
    for (const curve of curves) {
      curveTop = this.buildGraph(
        content,
        curve,
        plots.x,
        plots.width,
        curveTop,
        plotH,
      );
    }
    this.armReveal();
  }

  /**
   * The ranked bars, filling `column` between `top` and `bottom`, with the run's
   * curves under them. Each row is two lines — source and points over a
   * full-width bar — so the bars stay long enough to compare at any width,
   * instead of a label column eating half of a folded viewport. The column
   * scrolls when what it holds outgrows the band.
   */
  private buildChart(
    column: Column,
    top: number,
    bottom: number,
    curves: Curve[],
  ): void {
    const band = Math.max(48, bottom - top);
    const count = this.entries.length;

    if (count === 0 && curves.length === 0) {
      this.add
        .text(column.cx, top + band / 2, "No points recorded for this run.", {
          fontFamily: SERIF,
          fontSize: "17px",
          color: CSS.dim,
          fontStyle: "italic",
          align: "center",
          wordWrap: { width: column.width },
        })
        .setOrigin(0.5);
      return;
    }

    // The footnote's strip has to be reserved before the rows are measured, but
    // whether it carries a scroll hint is only known once they have been — so
    // measure again if reserving it is what made the list scroll.
    const measure = (noteH: number) => {
      const avail = Math.max(44, band - noteH);
      // Each plot takes about a third of the band: enough to read a curve by,
      // and little enough that the bars above still get their rows.
      const plotH =
        curves.length === 0
          ? 0
          : Math.round(Phaser.Math.Clamp(avail * 0.34, MIN_PLOT_H, MAX_PLOT_H));
      const curvesH = curves.reduce(
        (sum, curve) =>
          sum +
          GRAPH_GAP +
          GRAPH_HEAD_H +
          plotH +
          this.graphFootHeight(curve, column.width),
        0,
      );
      const rowsAvail = Math.max(MIN_ROW_H, avail - curvesH);
      const rowH =
        count === 0
          ? 0
          : Phaser.Math.Clamp(rowsAvail / count, MIN_ROW_H, MAX_ROW_H);
      const contentH = rowH * count + curvesH;
      const scroll = contentH > avail + 0.5;
      // A band that scrolls is trimmed to a whole number of rows, so the list
      // at rest ends on a finished row rather than one sliced through the
      // middle of its label — which reads as a broken layout rather than as
      // "there is more below". Only a bare list can be trimmed that way; with
      // curves under it the band's edge has to fall wherever it falls.
      const viewH =
        scroll && curves.length === 0
          ? Math.max(rowH, Math.floor(avail / rowH) * rowH)
          : avail;
      return { viewH, rowH, contentH, scroll, plotH };
    };
    let noteH = this.hasSplit ? FOOTNOTE_H : 0;
    let m = measure(noteH);
    if (!this.hasSplit && m.scroll) {
      noteH = FOOTNOTE_H;
      m = measure(noteH);
    }

    // Built before the content container so the camera split below can treat
    // "everything that is not the content" as the fixed layer.
    const notes: string[] = [];
    if (this.hasSplit) notes.push("gold · dice   green · bonus");
    if (m.scroll) notes.push("drag or scroll for more");
    if (notes.length) {
      const note = this.add
        .text(column.cx, top + m.viewH + 7, notes.join("   ·   "), {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.dim,
          fontStyle: "italic",
        })
        .setOrigin(0.5, 0);
      fitTextWidth(note, column.width);
    }

    // A scrolling chart gives the scrollbar its own gutter, so the bars never
    // run underneath it.
    const chartW = Math.max(60, column.width - (m.scroll ? 14 : 0));

    this.barGeometry(column.x, chartW, top, m.rowH);
    const content = this.add.container(0, 0);
    this.barGlow(content);
    const gfx = this.add.graphics();
    content.add(gfx);
    this.chartGfx = gfx;
    this.barRows(content, column.x, chartW, top, m.rowH);

    // The curves take the column below the last bar, one under the other.
    this.graphs = [];
    let curveTop = top + m.rowH * count;
    for (const curve of curves) {
      curveTop = this.buildGraph(
        content,
        curve,
        column.x,
        chartW,
        curveTop,
        m.plotH,
      );
    }

    this.armReveal();

    if (m.scroll) {
      this.enableScroll(
        content,
        this.children.list.filter((obj) => obj !== content),
        column,
        top,
        m.viewH,
        m.contentH,
      );
    } else {
      // Nothing to scroll. Sit the list a little above the band's centre: a run
      // with two or three sources leaves most of the band empty, and a lone bar
      // stranded in the middle of it reads as a mistake, where one gathered up
      // under the total reads as a short list.
      content.y = (m.viewH - m.contentH) * SHORT_LIST_BIAS;
      this.scrollY = 0;
    }
  }

  /** Resolve every bar's extent for a list of `rowH` rows starting at `top`.
   *  Settled before anything reaches the display list: the leader's glow needs
   *  its own row's measurements, and has to go in beneath the bars. */
  private barGeometry(
    x: number,
    width: number,
    top: number,
    rowH: number,
  ): void {
    const barH = Math.round(Phaser.Math.Clamp(rowH * 0.2, 6, 11));
    const max = Math.max(1, ...this.entries.map((e) => e.points));
    this.bars = this.entries.map((e, i) => {
      // A source with no recorded split charts as one solid gold bar.
      const split = e.dice + e.bonus > 0;
      return {
        x,
        y: top + i * rowH + rowH * 0.58,
        h: barH,
        dice: ((split ? e.dice : e.points) / max) * width,
        bonus: ((split ? e.bonus : 0) / max) * width,
      };
    });
  }

  /** The run's biggest earner gets a little light on it — the same additive
   *  halo the mastheads use, so the eye lands on the top of the list first. */
  private barGlow(content: Phaser.GameObjects.Container): void {
    if (!fx.rich || this.bars.length === 0) return;
    const lead = this.bars[0];
    const leadW = Math.max(lead.h, lead.dice + lead.bonus);
    const glow = this.add
      .image(lead.x + leadW / 2, lead.y + lead.h / 2, "spark")
      .setTint(COLORS.glow)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(leadW + 60, lead.h * 7)
      .setAlpha(0.16);
    content.add(glow);
    if (!fx.motion) return;
    const baseScaleX = glow.scaleX;
    this.tweens.add({
      targets: glow,
      alpha: { from: 0.09, to: 0.2 },
      scaleX: { from: baseScaleX * 0.97, to: baseScaleX * 1.03 },
      duration: 2400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  /** Each row's two labels — its source on the left, its points on the right —
   *  sitting over the bar `barGeometry` measured for it. */
  private barRows(
    content: Phaser.GameObjects.Container,
    x: number,
    width: number,
    top: number,
    rowH: number,
  ): void {
    const labelSize = Math.round(Phaser.Math.Clamp(rowH * 0.4, 12, 19));
    const valueSize = Math.round(Phaser.Math.Clamp(rowH * 0.38, 12, 18));
    this.entries.forEach((e, i) => {
      const textY = top + i * rowH + rowH * 0.29;
      const value = this.add
        .text(x + width, textY, formatScore(e.points), {
          fontFamily: SERIF,
          fontSize: `${valueSize}px`,
          color: CSS.goldLight,
          fontStyle: "bold",
        })
        .setOrigin(1, 0.5);
      const label = this.add
        .text(x, textY, e.label, {
          fontFamily: SERIF,
          fontSize: `${labelSize}px`,
          color: i === 0 ? CSS.ivory : CSS.parchment,
        })
        .setOrigin(0, 0.5);
      fitTextWidth(label, Math.max(24, width - value.width - 14));
      content.add([label, value]);
    });
  }

  /** Draw the chart at rest, and arm the growth the entrance hands off to. */
  private armReveal(): void {
    this.drawChart(fx.motion ? 0 : 1);
    this.reveal = () => {
      if (!fx.motion || !this.chartGfx) return;
      this.barTween?.remove();
      const state = { t: 0 };
      this.barTween = this.tweens.add({
        targets: state,
        t: 1,
        duration: BAR_REVEAL_MS,
        ease: "Cubic.easeOut",
        onUpdate: () => this.drawChart(state.t),
      });
    };
  }

  /** Space beneath a plot's caption. Item view adds a compact, complete key;
   *  aggregate view keeps the original single-line footer. */
  private graphFootHeight(curve: Curve, width: number): number {
    if (!this.itemLines[curve.id] || curve.items.length === 0)
      return GRAPH_FOOT_H;
    const columns = Math.max(1, Math.floor(width / GRAPH_KEY_CELL_W));
    const rows = Math.ceil(curve.items.length / columns);
    return GRAPH_FOOT_H + GRAPH_KEY_TOP + rows * GRAPH_KEY_ROW_H;
  }

  /**
   * Turn the run's timeline into the two series the screen charts: the points it
   * had banked after every roll, and how many dice it was rolling them with.
   * Points are always log-scaled — a run's last trial outscores its first by
   * more orders of magnitude than a linear axis can show at once — and the pool
   * follows suit only once it has spanned enough of them to need it.
   */
  private buildCurves(): Curve[] {
    if (this.history.length < 2) return [];
    const last = this.history[this.history.length - 1];
    const trials = `trials 1–${last.trial}`;
    const rolls = `${formatCompactCount(this.rolls)} rolls`;

    // Item timelines are all-or-nothing. A run resumed from an aggregate-only
    // save may have attribution on its newer samples, but drawing that as if it
    // began at zero would invent a false history.
    const attributed = this.history.every(
      (sample) => sample.pointsByItem && sample.diceByItem,
    );
    const itemIds = new Set(this.entries.map((entry) => entry.id));
    if (attributed) {
      const extras = new Set<string>();
      for (const sample of this.history) {
        for (const id of Object.keys(sample.pointsByItem!)) extras.add(id);
        for (const id of Object.keys(sample.diceByItem!)) extras.add(id);
      }
      for (const id of [...extras].sort((a, b) =>
        sourceLabel(a).localeCompare(sourceLabel(b)),
      ))
        itemIds.add(id);
    }
    // One order drives both stacks. "Contribution" means the cumulative point
    // attribution at run end; a dice source that never scored is still shown,
    // after every scoring contributor, with alphabetical ties.
    const orderedItemIds = [...itemIds].sort((a, b) => {
      const aPoints = last.pointsByItem?.[a] ?? 0n;
      const bPoints = last.pointsByItem?.[b] ?? 0n;
      return aPoints === bPoints
        ? sourceLabel(a).localeCompare(sourceLabel(b))
        : aPoints > bPoints
          ? -1
          : 1;
    });
    const colorById = new Map(
      orderedItemIds.map((id, index) => [
        id,
        ITEM_LINE_COLORS[index % ITEM_LINE_COLORS.length],
      ]),
    );

    const scoreValues = this.history.map((sample) => bigLog10(sample.score));
    const scoreMax = Math.max(1, Math.ceil(Math.max(...scoreValues)));

    const diceCounts = this.history.map((sample) => sample.dice);
    const peakDice = Math.max(1, ...diceCounts);
    const diceLog = peakDice >= DICE_LOG_THRESHOLD;
    const diceMax = diceLog
      ? Math.max(1, Math.ceil(Math.log10(peakDice)))
      : niceCeil(peakDice);

    const pointRaw = attributed
      ? orderedItemIds
          .map((id) => ({
            id,
            label: sourceLabel(id),
            color: colorById.get(id)!,
            raw: this.history.map((sample) => sample.pointsByItem![id] ?? 0n),
          }))
          .filter((line) => line.raw.some((value) => value > 0n))
      : [];
    const pointsByItem: CurveLine[] = [];
    let pointFloor = this.history.map(() => 0n);
    for (const { raw, ...line } of pointRaw) {
      const pointCeiling = raw.map((value, index) => value + pointFloor[index]);
      pointsByItem.push({
        ...line,
        values: pointCeiling.map(bigLog10),
        lowerValues: pointFloor.map(bigLog10),
      });
      pointFloor = pointCeiling;
    }

    const diceRaw = attributed
      ? orderedItemIds
          .map((id) => ({
            id,
            label: sourceLabel(id),
            color: colorById.get(id)!,
            raw: this.history.map((sample) => sample.diceByItem![id] ?? 0),
          }))
          .filter((line) => line.raw.some((value) => value > 0))
      : [];
    const diceAxis = (value: number) =>
      diceLog && value > 0 ? Math.log10(value) : value;
    const diceByItem: CurveLine[] = [];
    let diceFloor = this.history.map(() => 0);
    for (const { raw, ...line } of diceRaw) {
      const diceCeiling = raw.map((value, index) => value + diceFloor[index]);
      diceByItem.push({
        ...line,
        values: diceCeiling.map(diceAxis),
        lowerValues: diceFloor.map(diceAxis),
      });
      diceFloor = diceCeiling;
    }

    return [
      {
        id: "points",
        title: "Points banked",
        value: formatScore(last.score),
        caption: `${rolls} · ${trials} · log scale`,
        aggregate: {
          id: "total",
          label: "All items",
          color: COLORS.gold,
          values: scoreValues,
        },
        items: pointsByItem,
        axisMax: scoreMax,
        ticks: decadeTicks(scoreMax),
      },
      {
        id: "dice",
        title: "Dice in the pool",
        value: `${formatCompactCount(last.dice)} dice`,
        caption: diceLog
          ? `peak ${formatCompactCount(peakDice)} · ${trials} · log scale`
          : `peak ${formatCompactCount(peakDice)} · ${trials}`,
        aggregate: {
          id: "total",
          label: "All items",
          color: COLORS.glowSteel,
          values: diceLog
            ? diceCounts.map((n) => (n > 0 ? Math.log10(n) : 0))
            : diceCounts,
        },
        items: diceByItem,
        axisMax: diceMax,
        ticks: diceLog
          ? decadeTicks(diceMax)
          : [
              { value: diceMax / 2, label: formatCompactCount(diceMax / 2) },
              { value: diceMax, label: formatCompactCount(diceMax) },
            ],
      },
    ];
  }

  /**
   * Lay one curve out: its heading, its plot, and the caption under it. Returns
   * the y the next section starts at. Only the text is created here — the plot
   * itself is geometry on `this.graphs`, drawn (and re-drawn, through the
   * reveal) by `drawChart`.
   */
  private buildGraph(
    content: Phaser.GameObjects.Container,
    curve: Curve,
    x: number,
    width: number,
    top: number,
    plotH: number,
  ): number {
    const headY = top + GRAPH_GAP;
    const value = this.add
      .text(x + width, headY, curve.value, {
        fontFamily: SERIF,
        fontSize: "13px",
        color: CSS.goldLight,
        fontStyle: "bold",
      })
      .setOrigin(1, 0);
    const title = this.add
      .text(x, headY, curve.title, {
        fontFamily: SERIF,
        fontSize: "14px",
        color: CSS.parchment,
      })
      .setOrigin(0, 0);
    let titleRight = x + width - value.width - 12;
    const itemMode = this.itemLines[curve.id];
    if (curve.items.length > 0) {
      const toggle = this.add
        .text(titleRight, headY, `ITEM STACK ${itemMode ? "ON" : "OFF"}`, {
          fontFamily: SERIF,
          fontSize: "10px",
          color: itemMode ? CSS.ivory : CSS.parchmentDark,
          backgroundColor: itemMode ? "#5a4a2e" : "#221a38",
        })
        .setPadding(5, 2)
        .setOrigin(1, 0)
        .setInteractive({ useHandCursor: true });
      toggle.on("pointerover", () => toggle.setColor(CSS.ivory));
      toggle.on("pointerout", () =>
        toggle.setColor(itemMode ? CSS.ivory : CSS.parchmentDark),
      );
      toggle.on("pointerdown", () => {
        audio.click();
        this.itemLines[curve.id] = !this.itemLines[curve.id];
        this.rebuildChartView();
      });
      titleRight = toggle.x - toggle.width - 9;
      content.add(toggle);
    }
    fitTextWidth(title, Math.max(24, titleRight - x));
    content.add([title, value]);

    const plotTop = headY + GRAPH_HEAD_H;
    const plotBottom = plotTop + plotH;
    const unitY = (v: number) =>
      plotBottom - Phaser.Math.Clamp(v / curve.axisMax, 0, 1) * (plotH - 1);

    // Gridlines are labelled inside the plot rather than in a left-hand gutter:
    // a folded viewport's column has no width to spare for an axis, and a curve
    // is never dense enough at its own left edge to be hidden by them.
    const grid: number[] = [];
    for (const tick of curve.ticks) {
      if (tick.value <= 0 || tick.value > curve.axisMax) continue;
      const y = unitY(tick.value);
      grid.push(y);
      // Labels sit above their line, except the topmost — a tick at the very top
      // of the axis has no room up there, and its label would land in the
      // heading above the plot.
      const under = y - plotTop < 12;
      content.add(
        this.add
          .text(x + 3, under ? y + 1 : y - 1, tick.label, {
            fontFamily: SERIF,
            fontSize: "10px",
            color: CSS.dim,
          })
          .setOrigin(0, under ? 0 : 1),
      );
    }

    const selectedLines = itemMode ? curve.items : [curve.aggregate];
    const n = curve.aggregate.values.length;
    // At most one point per pixel of width: past that the extra segments are
    // invisible and only cost the reveal frames.
    const budget = Math.max(2, Math.min(MAX_CURVE_POINTS, Math.round(width)));
    const stride = Math.max(1, Math.ceil((n - 1) / (budget - 1)));
    const pointsFor = (values: number[]) => {
      const pointAt = (i: number) => ({
        x: x + (width * i) / (n - 1),
        y: unitY(values[i]),
      });
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < n - 1; i += stride) points.push(pointAt(i));
      points.push(pointAt(n - 1));
      return points;
    };
    const lines = selectedLines.map((line) => {
      return {
        id: line.id,
        color: line.color,
        points: pointsFor(line.values),
        lowerPoints: line.lowerValues ? pointsFor(line.lowerValues) : undefined,
      };
    });

    // Where each trial began, so the curve can be read against the run's shape.
    // A run long enough for its trial ticks to close into hatching keeps only
    // the rank boundaries.
    let marks = this.history
      .map((sample, i) => ({ sample, i }))
      .filter(
        ({ sample, i }) => i > 0 && sample.trial !== this.history[i - 1].trial,
      )
      .map(({ sample, i }) => ({
        x: x + (width * i) / (n - 1),
        strong: trialInRank(sample.trial) === 1,
      }));
    if (marks.length > 24) marks = marks.filter((mark) => mark.strong);

    const graph: GraphSpec = {
      x,
      y: plotTop,
      width,
      height: plotH,
      lines,
      grid,
      marks,
    };
    this.graphs.push(graph);

    const caption = this.add
      .text(x + width / 2, plotBottom + 3, curve.caption, {
        fontFamily: SERIF,
        fontSize: "11px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5, 0);
    fitTextWidth(caption, width);
    content.add(caption);

    if (itemMode && curve.items.length > 0) {
      const columns = Math.max(1, Math.floor(width / GRAPH_KEY_CELL_W));
      const cellW = width / columns;
      const keyTop = plotBottom + GRAPH_FOOT_H + GRAPH_KEY_TOP;
      curve.items.forEach((line, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const cellX = x + column * cellW;
        const cellY = keyTop + row * GRAPH_KEY_ROW_H;
        const swatch = this.add
          .rectangle(cellX, cellY + 5, 11, 5, line.color, 0.78)
          .setOrigin(0, 0.5);
        const label = this.add
          .text(cellX + 16, cellY, line.label, {
            fontFamily: SERIF,
            fontSize: "10px",
            color: CSS.parchmentDark,
          })
          .setOrigin(0, 0)
          .setData("analysisHoverZone", true);
        fitTextWidth(label, Math.max(12, cellW - 20));
        label.setInteractive({ useHandCursor: false });
        content.add([swatch, label]);
        const graphLine = graph.lines.find(
          (candidate) => candidate.id === line.id,
        );
        if (graphLine) {
          graphLine.legend = { swatch, label };
          label.on("pointerover", () => this.setGraphHover(graph, line.id));
          label.on("pointerout", () => this.setGraphHover(graph, undefined));
        }
      });

      // One transparent interaction plane covers the plot. At the pointer's x,
      // interpolate every cumulative boundary and identify the band containing
      // y; this stays accurate through thinning, scrolling and responsive
      // layouts because it uses the exact geometry being drawn.
      const hoverZone = this.add
        .rectangle(x, plotTop, width, plotH, COLORS.felt, 0.001)
        .setOrigin(0, 0)
        .setData("analysisHoverZone", true)
        .setInteractive({ useHandCursor: false });
      const hoverAt = (
        _pointer: Phaser.Input.Pointer,
        localX: number,
        localY: number,
      ) => {
        const sceneX = x + localX;
        const sceneY = plotTop + localY;
        let hovered: string | undefined;
        for (let i = graph.lines.length - 1; i >= 0; i--) {
          const candidate = graph.lines[i];
          if (!candidate.lowerPoints) continue;
          const upper = polylineYAt(candidate.points, sceneX);
          const lower = polylineYAt(candidate.lowerPoints, sceneX);
          if (
            sceneY >= Math.min(upper, lower) &&
            sceneY <= Math.max(upper, lower)
          ) {
            hovered = candidate.id;
            break;
          }
        }
        this.setGraphHover(graph, hovered);
      };
      hoverZone.on("pointerover", hoverAt);
      hoverZone.on("pointermove", hoverAt);
      hoverZone.on("pointerout", () => this.setGraphHover(graph, undefined));
      content.add(hoverZone);
    }

    return plotBottom + this.graphFootHeight(curve, width);
  }

  /** Reflow the chart after one graph changes view: its item key changes the
   *  section's height and can move the screen between split and scrolling
   *  layouts, so a complete lightweight rebuild is safer than nudging pieces. */
  private rebuildChartView(): void {
    this.teardown();
    destroyAllChildren(this);
    this.build();
    // A mode switch is direct manipulation, not a fresh scene entrance.
    this.drawChart(1);
    this.reveal = undefined;
  }

  /** Synchronize the stack emphasis and its key, then redraw at the reveal's
   *  current position. */
  private setGraphHover(graph: GraphSpec, id: string | undefined): void {
    if (graph.hoveredId === id) return;
    graph.hoveredId = id;
    for (const line of graph.lines) {
      if (!line.legend) continue;
      const selected = id === undefined || line.id === id;
      line.legend.swatch.setAlpha(id === undefined ? 0.78 : selected ? 1 : 0.2);
      line.legend.label
        .setAlpha(id === undefined ? 1 : selected ? 1 : 0.32)
        .setColor(id !== undefined && selected ? CSS.ivory : CSS.parchmentDark);
    }
    this.drawChart(this.chartT);
  }

  /** Redraw every bar and curve at `t` of its full extent. One Graphics for the
   *  lot keeps the reveal to a single draw call per frame. */
  private drawChart(t: number): void {
    const g = this.chartGfx;
    if (!g || !g.scene) return;
    this.chartT = t;
    g.clear();
    for (const bar of this.bars) {
      const r = bar.h / 2;
      g.fillStyle(COLORS.parchment, 0.13);
      g.fillRoundedRect(
        bar.x,
        bar.y,
        Math.max(bar.h, bar.dice + bar.bonus),
        bar.h,
        r,
      );
      // Stacked as two pills, the bonus drawn full-length first and the dice
      // portion laid over its left end. A rounded rect narrower than its own
      // corner diameter renders as a pinched sliver, so neither goes below one
      // knuckle.
      const dice = bar.dice * t;
      const bonus = bar.bonus * t;
      if (bonus > 0) {
        g.fillStyle(COLORS.glowGreen, 0.9);
        g.fillRoundedRect(
          bar.x,
          bar.y,
          Math.max(bar.h, dice + bonus),
          bar.h,
          r,
        );
      }
      if (dice > 0) {
        g.fillStyle(COLORS.gold, 0.95);
        g.fillRoundedRect(bar.x, bar.y, Math.max(bar.h, dice), bar.h, r);
      }
    }
    for (const graph of this.graphs) this.drawGraph(g, graph, t);
  }

  /** One curve: its grid and trial marks, the wash under the line, then the line
   *  itself, swept in from the left over the reveal. */
  private drawGraph(
    g: Phaser.GameObjects.Graphics,
    graph: GraphSpec,
    t: number,
  ): void {
    const bottom = graph.y + graph.height;
    const right = graph.x + graph.width;

    for (const mark of graph.marks) {
      g.lineStyle(1, COLORS.gold, mark.strong ? 0.2 : 0.08);
      g.lineBetween(mark.x, graph.y, mark.x, bottom);
    }
    g.lineStyle(1, COLORS.parchment, 0.1);
    for (const y of graph.grid) g.lineBetween(graph.x, y, right, y);
    // The floor and the left edge, so a curve hugging either still has a frame.
    g.lineStyle(1, COLORS.parchment, 0.28);
    g.lineBetween(graph.x, bottom, right, bottom);
    g.lineBetween(graph.x, graph.y, graph.x, bottom);

    for (const line of graph.lines) {
      const drawn = curveHead(line.points, t);
      if (drawn.length < 2) continue;
      const selected =
        graph.hoveredId === undefined || graph.hoveredId === line.id;

      // Item view closes each colored band against the cumulative boundary
      // below it. Aggregate view has no lower series, so it keeps the original
      // light wash down to the plot floor.
      const lower = line.lowerPoints
        ? curveHead(line.lowerPoints, t)
        : undefined;
      const fillAlpha = lower
        ? graph.hoveredId === undefined
          ? 0.28
          : selected
            ? 0.52
            : 0.07
        : 0.12;
      g.fillStyle(line.color, fillAlpha);
      g.beginPath();
      if (lower && lower.length === drawn.length) {
        g.moveTo(drawn[0].x, drawn[0].y);
        for (let i = 1; i < drawn.length; i++) g.lineTo(drawn[i].x, drawn[i].y);
        for (let i = lower.length - 1; i >= 0; i--)
          g.lineTo(lower[i].x, lower[i].y);
      } else {
        g.moveTo(drawn[0].x, bottom);
        for (const point of drawn) g.lineTo(point.x, point.y);
        g.lineTo(drawn[drawn.length - 1].x, bottom);
      }
      g.closePath();
      g.fillPath();

      g.lineStyle(
        lower && selected && graph.hoveredId !== undefined
          ? 2.75
          : lower
            ? 1.5
            : 2,
        line.color,
        lower && !selected ? 0.22 : 0.98,
      );
      g.beginPath();
      g.moveTo(drawn[0].x, drawn[0].y);
      for (let i = 1; i < drawn.length; i++) g.lineTo(drawn[i].x, drawn[i].y);
      g.strokePath();
    }
  }

  /** Clip `content` to the chart's band with a dedicated camera and wire
   *  vertical drag / wheel / scrollbar — mirrors the settings form. */
  private enableScroll(
    content: Phaser.GameObjects.Container,
    fixed: Phaser.GameObjects.GameObject[],
    column: Column,
    viewTop: number,
    viewH: number,
    contentH: number,
  ): void {
    const minY = viewH - contentH; // most-scrolled (negative)
    const maxY = 0; // top

    // A clip camera renders only `content`; the main camera renders everything
    // else. It is left transparent, so the felt and the turning sigil the main
    // camera drew stay visible behind the rows. The clip is only needed
    // vertically, so the camera spans the full width — that lets the scene
    // slide carry the rows clear off the screen rather than having them wink
    // out at the band's edge partway across.
    const cam = addCamera(this, 0, viewTop, this.scale.width, viewH);
    cam.setScroll(0, viewTop);
    this.scrollCamera = cam;
    this.cameras.main.ignore(content);
    cam.ignore(fixed);

    const barX = column.x + column.width - 3;
    const track = this.add.rectangle(
      barX,
      viewTop + viewH / 2,
      4,
      viewH,
      COLORS.parchment,
      0.14,
    );
    const thumbH = Math.max(28, (viewH * viewH) / contentH);
    const thumb = this.add.rectangle(
      barX,
      viewTop + thumbH / 2,
      4,
      thumbH,
      COLORS.gold,
      0.8,
    );
    cam.ignore([track, thumb]);
    const updateThumb = () => {
      const progress = (maxY - content.y) / (maxY - minY);
      thumb.y = viewTop + thumbH / 2 + progress * (viewH - thumbH);
    };
    content.y = Phaser.Math.Clamp(this.scrollY, minY, maxY);
    this.scrollY = content.y;
    updateThumb();

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= column.x &&
      p.x <= column.right &&
      p.y >= viewTop &&
      p.y <= viewTop + viewH;

    let dragging = false;
    let startPointerY = 0;
    let startContentY = 0;

    const onDown: PointerHandler = (p) => {
      if (!inBounds(p)) return;
      // Never hijack a press that landed on a control (the Close button can sit
      // beside the band on a folded viewport). The graph's transparent hover
      // plane is informational, not a control, so touch drags may start on it.
      if (
        this.input
          .hitTestPointer(p)
          .some((object) => !object.getData("analysisHoverZone"))
      )
        return;
      dragging = true;
      startPointerY = p.y;
      startContentY = content.y;
    };
    const onMove: PointerHandler = (p) => {
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? "grab" : "default");
        return;
      }
      content.y = Phaser.Math.Clamp(
        startContentY + (p.y - startPointerY),
        minY,
        maxY,
      );
      this.scrollY = content.y;
      updateThumb();
    };
    const onUp: PointerHandler = () => {
      dragging = false;
    };
    const onWheel: WheelHandler = (p, _over, _dx, dy) => {
      if (!inBounds(p)) return;
      content.y = Phaser.Math.Clamp(content.y - dy, minY, maxY);
      this.scrollY = content.y;
      updateThumb();
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.scrollInput = { down: onDown, move: onMove, up: onUp, wheel: onWheel };
  }

  private close(): void {
    if (this.leaving) return;
    this.leaving = true;
    const done = () => this.scene.stop();
    if (this.felt) slideOverlayOut(this, this.felt, done);
    else done();
  }
}

/**
 * log10 of a score far too large for a double to hold. The leading digits give
 * the mantissa and the digit count the exponent, so a run whose points ran past
 * 1e300 plots as faithfully as a four-figure one. Zero — the run's opening
 * sample — sits on the axis floor.
 */
function bigLog10(value: bigint): number {
  if (value <= 1n) return 0;
  const digits = value.toString();
  const head = digits.slice(0, 15);
  return Math.log10(Number(head)) + (digits.length - head.length);
}

/** Gridlines for a log axis running from 1 to 10^`max`, thinned to at most four
 *  so a short plot is not sliced into ribbons. */
function decadeTicks(max: number): { value: number; label: string }[] {
  const step = Math.max(1, Math.ceil(max / 4));
  const ticks: { value: number; label: string }[] = [];
  for (let power = step; power <= max; power += step) {
    ticks.push({
      value: power,
      label: power <= 6 ? (10 ** power).toLocaleString() : `1e${power}`,
    });
  }
  return ticks;
}

/** The next round number at or above `value`, for the top of a linear axis. */
function niceCeil(value: number): number {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/** Interpolate a monotonic-x polyline at `x`. Graph hit-testing uses the same
 *  thinned geometry as rendering, so the highlighted band is exactly the one
 *  under the pointer rather than an approximation from the raw samples. */
function polylineYAt(points: { x: number; y: number }[], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;

  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const from = points[lo];
  const to = points[hi];
  const span = to.x - from.x;
  const t = span > 0 ? (x - from.x) / span : 0;
  return from.y + (to.y - from.y) * t;
}

/** The first `t` of a polyline, ending on a point interpolated along whichever
 *  segment the sweep is partway through — so the reveal advances smoothly
 *  rather than a whole segment at a time. */
function curveHead(
  points: { x: number; y: number }[],
  t: number,
): { x: number; y: number }[] {
  if (points.length < 2 || t >= 1) return points;
  if (t <= 0) return [];
  const span = (points.length - 1) * t;
  const whole = Math.floor(span);
  const head = points.slice(0, whole + 1);
  const next = points[whole + 1];
  if (next) {
    const from = points[whole];
    const fraction = span - whole;
    head.push({
      x: from.x + (next.x - from.x) * fraction,
      y: from.y + (next.y - from.y) * fraction,
    });
  }
  return head;
}
