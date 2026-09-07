import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { fx } from "../systems/Effects";
import { formatCompactCount } from "./formatScore";
import { fitTextWidth } from "./widgets";

/**
 * The "ten best runs" line chart, shared by every screen that draws one: a
 * left-to-right reveal, a compact key under the plot, and direct hover/touch
 * emphasis that dims every line but the one being read.
 *
 * Everything is built into one container in local coordinates, so a caller can
 * hang the chart off a scrolling track as readily as off the scene root. The
 * caller owns the container: destroying it destroys the chart.
 */

/** Line colours in the order curves claim them, ranked best first. */
export const CURVE_COLORS = [
  0xe6c65a, 0x86e07a, 0x72b7e8, 0xd98fe8, 0xff8b72, 0x69d6c5, 0xf2a65a,
  0xcfd6df, 0xe66fa8, 0xa8d672,
];

const REVEAL_MS = 560;
/** Room above the plot for the title line, and below it for the key. */
const HEAD_H = 24;
const KEY_TOP = 18;
const KEY_ROW_H = 16;
const KEY_FOOT = 17;
const KEY_MIN_CELL_W = 132;
const MIN_PLOT_H = 52;
/** Room a chart with nothing to plot takes: its title, and the line saying so.
 *  A full-height empty plot is a large hole in a stacked column. */
const EMPTY_H = 52;
/** Past this the axis is compressed: a run's score climbs by orders of
 *  magnitude, and a linear axis draws nine of the ten curves flat on the floor. */
const LOG_THRESHOLD = 1000;

export interface RunCurveSeries {
  /** Stable identity for hover; need only be unique within the chart. */
  id: string;
  /** Key text, e.g. `#1 W · 12.4K`. */
  label: string;
  /** The series' values, evenly spaced across its own span of the axis. */
  values: number[];
  /** How far across the shared x axis this series reaches, 0..1. A run that
   *  took half as many rolls as the longest one draws half as wide. */
  span: number;
}

export interface RunCurveChartOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  /** Italic note opposite the title — the scale, the roll count, and so on. The
   *  chart appends nothing; what is passed is what is printed. */
  caption?: string;
  series: RunCurveSeries[];
  /** Force the compressed axis. Left unset it is chosen from the peak. */
  logarithmic?: boolean;
  /** Shown centred in the plot's place when there are no series. */
  emptyText?: string;
  /** Axis tick labels. Defaults to a compact count. */
  format?: (value: number) => string;
}

export interface RunCurveChart {
  container: Phaser.GameObjects.Container;
  /** Play the left-to-right reveal, if motion is enabled. */
  reveal(): void;
}

interface ChartLine {
  id: string;
  color: number;
  points: { x: number; y: number }[];
  swatch: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
}

export function buildRunCurveChart(
  scene: Phaser.Scene,
  opts: RunCurveChartOptions,
): RunCurveChart {
  const { width, height, series } = opts;
  const format = opts.format ?? formatCompactCount;
  const container = scene.add.container(opts.x, opts.y);

  const title = scene.add
    .text(0, 0, opts.title, {
      fontFamily: SERIF,
      fontSize: "14px",
      color: CSS.parchment,
      fontStyle: "bold",
    })
    .setOrigin(0, 0);
  fitTextWidth(title, width);
  container.add(title);

  if (series.length === 0) {
    const empty = scene.add
      .text(width / 2, height / 2, opts.emptyText ?? "No analyzed runs yet", {
        fontFamily: SERIF,
        fontSize: "18px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5);
    fitTextWidth(empty, width - 24);
    container.add(empty);
    return { container, reveal: () => {} };
  }

  if (opts.caption) {
    const caption = scene.add
      .text(width, 0, opts.caption, {
        fontFamily: SERIF,
        fontSize: "10px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(1, 0);
    fitTextWidth(caption, width * 0.48);
    container.add(caption);
  }

  const keyCols = Math.max(1, Math.min(5, Math.floor(width / KEY_MIN_CELL_W)));
  const keyRows = Math.ceil(series.length / keyCols);
  const keyH = keyRows * KEY_ROW_H + 5;
  const plotTop = HEAD_H;
  const plotH = Math.max(MIN_PLOT_H, height - HEAD_H - keyH - KEY_FOOT);
  const plotBottom = plotTop + plotH;

  // The axis is sized off every sample, not just the final ones: a pool that
  // was culled back, or a curve that peaked mid-run, would otherwise draw off
  // the top of the plot.
  const peak = Math.max(1, ...series.map((line) => Math.max(...line.values)));
  const logarithmic = opts.logarithmic ?? peak >= LOG_THRESHOLD;
  const axis = (value: number) =>
    logarithmic ? Math.log10(Math.max(0, value) + 1) : value;
  const axisMax = logarithmic
    ? Math.max(1, Math.ceil(axis(peak)))
    : niceCeil(peak);
  const unitY = (value: number) => plotBottom - (axis(value) / axisMax) * plotH;

  const frame = scene.add.graphics();
  container.add(frame);
  const tickAxes = logarithmic
    ? [...new Set([axisMax / 3, (axisMax * 2) / 3, axisMax])]
    : [axisMax / 2, axisMax];
  for (const tickAxis of tickAxes) {
    const value = logarithmic ? 10 ** Math.min(308, tickAxis) - 1 : tickAxis;
    const gy = logarithmic
      ? plotBottom - (tickAxis / axisMax) * plotH
      : unitY(value);
    frame.lineStyle(1, COLORS.parchment, 0.1);
    frame.lineBetween(0, gy, width, gy);
    container.add(
      scene.add
        .text(3, Math.max(plotTop, gy - 1), format(value), {
          fontFamily: SERIF,
          fontSize: "10px",
          color: CSS.dim,
        })
        .setOrigin(0, gy - plotTop < 11 ? 0 : 1),
    );
  }
  frame.lineStyle(1, COLORS.parchment, 0.28);
  frame.lineBetween(0, plotBottom, width, plotBottom);
  frame.lineBetween(0, plotTop, 0, plotBottom);

  // The lines are drawn into one Graphics above the frame and below the key, so
  // the reveal only ever clears and redraws this single object.
  const plot = scene.add.graphics();
  container.add(plot);

  const lines: ChartLine[] = [];
  let hovered: string | undefined;
  let t = fx.motion ? 0 : 1;

  const draw = () => {
    if (!plot.scene) return;
    plot.clear();
    for (const line of lines) {
      const points = curveHead(line.points, t);
      if (points.length < 2) continue;
      const selected = hovered === undefined || hovered === line.id;
      plot.lineStyle(
        selected && hovered ? 3 : 1.8,
        line.color,
        selected ? 0.98 : 0.16,
      );
      plot.beginPath();
      plot.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++)
        plot.lineTo(points[i].x, points[i].y);
      plot.strokePath();
    }
  };

  const setHover = (id: string | undefined) => {
    if (hovered === id) return;
    hovered = id;
    for (const line of lines) {
      const selected = id === undefined || id === line.id;
      line.swatch.setAlpha(id === undefined ? 0.8 : selected ? 1 : 0.2);
      line.label
        .setAlpha(id === undefined ? 1 : selected ? 1 : 0.3)
        .setColor(id !== undefined && selected ? CSS.ivory : CSS.parchmentDark);
    }
    draw();
  };

  const cellW = width / keyCols;
  series.forEach((line, index) => {
    const color = CURVE_COLORS[index % CURVE_COLORS.length];
    const span = Phaser.Math.Clamp(line.span, 0, 1);
    const points = line.values.map((value, point) => ({
      x:
        width *
        span *
        (line.values.length <= 1 ? 0 : point / (line.values.length - 1)),
      y: unitY(value),
    }));
    // A single-sample run is a dot; give it enough width to be a stroke.
    if (points.length === 1) points.push({ ...points[0], x: 2 });
    const col = index % keyCols;
    const row = Math.floor(index / keyCols);
    const lx = col * cellW;
    const ly = plotBottom + KEY_TOP + row * KEY_ROW_H;
    const swatch = scene.add
      .rectangle(lx, ly + 5, 11, 5, color, 0.8)
      .setOrigin(0, 0.5);
    const label = scene.add
      .text(lx + 16, ly, line.label, {
        fontFamily: SERIF,
        fontSize: "10px",
        color: CSS.parchmentDark,
      })
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: false });
    fitTextWidth(label, Math.max(20, cellW - 20));
    label.on("pointerover", () => setHover(line.id));
    label.on("pointerout", () => setHover(undefined));
    label.on("pointerdown", () => setHover(line.id));
    container.add([swatch, label]);
    lines.push({ id: line.id, color, points, swatch, label });
  });

  // An invisible plate over the plot: reading a chart by pointing at a line is
  // the gesture, and the lines themselves are a Graphics with no hit area.
  const hover = scene.add
    .rectangle(0, plotTop, width, plotH, COLORS.felt, 0.001)
    .setOrigin(0, 0)
    .setInteractive({ useHandCursor: false });
  const hoverAt = (
    _pointer: Phaser.Input.Pointer,
    localX: number,
    localY: number,
  ) => {
    const px = localX;
    const py = plotTop + localY;
    let nearest: ChartLine | undefined;
    let distance = Infinity;
    for (const line of lines) {
      const lineY = polylineYAt(line.points, px);
      if (lineY === undefined) continue;
      const candidate = Math.abs(lineY - py);
      if (candidate < distance) {
        nearest = line;
        distance = candidate;
      }
    }
    setHover(nearest?.id);
  };
  hover.on("pointerover", hoverAt);
  hover.on("pointermove", hoverAt);
  hover.on("pointerdown", hoverAt);
  hover.on("pointerout", () => setHover(undefined));
  container.add(hover);

  draw();

  return {
    container,
    reveal: () => {
      if (!fx.motion || lines.length === 0) return;
      const state = { t: 0 };
      scene.tweens.add({
        targets: state,
        t: 1,
        duration: REVEAL_MS,
        ease: "Cubic.easeOut",
        onUpdate: () => {
          t = state.t;
          draw();
        },
      });
    },
  };
}

/**
 * The axis a set of series will be drawn on, so a caller can name the scale in
 * its caption without guessing. `force` is for a series whose units always climb
 * by orders of magnitude — points — regardless of how far this particular set of
 * runs happened to get.
 */
export function curveAxisIsLog(
  series: readonly RunCurveSeries[],
  force = false,
): boolean {
  if (force) return true;
  const peak = Math.max(1, ...series.map((line) => Math.max(...line.values)));
  return peak >= LOG_THRESHOLD;
}

/** The height a chart of `height` actually needs to seat its key — callers that
 *  stack charts in a scrolling column size their cells with this. */
export function runCurveChartHeight(
  plotHeight: number,
  series: number,
  width: number,
): number {
  if (series === 0) return HEAD_H + EMPTY_H;
  const keyCols = Math.max(1, Math.min(5, Math.floor(width / KEY_MIN_CELL_W)));
  const keyRows = Math.ceil(series / keyCols);
  return HEAD_H + plotHeight + keyRows * KEY_ROW_H + 5 + KEY_FOOT;
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
