import { GridArea } from "./gridLayout";

// Dense auxiliary pickers still use a threshold. The main game grid now uses
// the viewport at every count so switching render paths can never leak dice.
export const WINDOW_THRESHOLD = 1500;

const WINDOWED_CELL = 60;
// How far in the player may zoom. Deliberately well above FIT_MAX_ZOOM: a
// handful of dice already fits the area at the fit cap, so without extra
// headroom a small grid would open fully zoomed in with nowhere to go.
const MAX_ZOOM = 4;
// Cap on the *automatic* fit-to-grid zoom, so a one-die grid opens at a sane
// die size rather than filling the whole area with a single face.
const FIT_MAX_ZOOM = 1.5;
// Summary cards keep render cost bounded below this zoom. This is a numerical
// guard rather than a rendering limit: realistic grids can still fit in full.
const MIN_ZOOM = 0.0001;
const CARD_TARGET_SCREEN_SIZE = 112;
const LOD_HYSTERESIS = 0.9;

export const GRID_LOD_THRESHOLDS = {
  callouts: 150,
  effects: 300,
  cards: 10_000,
} as const;

export type GridDetailLevel = "full" | "noCallouts" | "noEffects" | "cards";

const DETAIL_LEVELS: GridDetailLevel[] = [
  "full",
  "noCallouts",
  "noEffects",
  "cards",
];
const DETAIL_THRESHOLDS = [
  0,
  GRID_LOD_THRESHOLDS.callouts,
  GRID_LOD_THRESHOLDS.effects,
  GRID_LOD_THRESHOLDS.cards,
];
// Empty margin kept around the dice on every edge of the pannable area, so
// zooming out past the point where the whole grid fits still shows a bit of
// breathing room beyond the dice rather than pinning them flush against the
// pan limits with nowhere left to go.
const EDGE_MARGIN = WINDOWED_CELL / 2;
// Slack added to the pannable area beyond whatever is already reachable,
// expressed as a fraction of the visible span. Because the visible span scales
// with 1/zoom, this is a constant *screen* fraction: the grid can always be
// dragged this much of the viewport in any direction, even when it fits
// entirely in view and there would otherwise be nothing to pan.
const PAN_SLACK_FRACTION = 0.4;

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface VisibleDie {
  index: number;
  x: number;
  y: number;
}

/** A screen-space point the dice block centres itself on, instead of the
 *  middle of the grid viewport. */
export interface GridFocus {
  x: number;
  y: number;
}

export interface WindowedView {
  scale: number;
  zoom: number;
  virtualW: number;
  virtualH: number;
  scrollX: number; // clamped to the virtual grid's bounds
  scrollY: number; // clamped to the virtual grid's bounds
  homeScrollX: number; // scroll that centres the dice on the focus point
  homeScrollY: number;
  cols: number;
  rows: number;
  cell: number;
  originX: number;
  originY: number;
  viewW: number;
  viewH: number;
  equivalentDice: number;
  visible: VisibleDie[];
}

export interface VisibleDiceCard {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  region: {
    cols: number;
    rowStart: number;
    rowEnd: number;
    colStart: number;
    colEnd: number;
  };
}

export function clampZoom(zoom: number, area: GridArea): number {
  void area;
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Select the representation for the amount of raw grid covered by the camera.
 *  Moving toward less detail happens exactly at each cutoff. Moving back toward
 *  more detail has a 10% dead band so wheel jitter cannot rapidly rebuild both
 *  representations at a boundary. */
export function gridDetailLevel(
  equivalentDice: number,
  previous?: GridDetailLevel,
): GridDetailLevel {
  let target = 0;
  for (let i = 1; i < DETAIL_THRESHOLDS.length; i++) {
    if (equivalentDice >= DETAIL_THRESHOLDS[i]) target = i;
  }
  if (!previous) return DETAIL_LEVELS[target];

  let current = DETAIL_LEVELS.indexOf(previous);
  if (target >= current) return DETAIL_LEVELS[target];
  while (
    current > target &&
    equivalentDice < DETAIL_THRESHOLDS[current] * LOD_HYSTERESIS
  ) {
    current -= 1;
  }
  return DETAIL_LEVELS[current];
}

/** Columns the dice pack into. Deliberately independent of the viewport's
 *  aspect: the block grows outward from the sigil at the centre of the room,
 *  so it stays square rather than stretching into whatever letterbox shape the
 *  grid viewport happens to be. */
function gridColumns(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
}

/**
 * The largest box centred on `focus` that still fits inside `area`, plus where
 * `focus` falls across the area as a fraction of each axis.
 *
 * Because the dice block centres on the focus point rather than on the
 * viewport, this box — not the whole area — is the room a fit-to-grid zoom
 * actually has: each half of it is only as wide as the *nearer* edge allows.
 */
function focusedExtent(
  area: GridArea,
  focus?: GridFocus,
): { width: number; height: number; fracX: number; fracY: number } {
  const width = Math.max(1, area.width);
  const height = Math.max(1, area.height);
  if (!focus) return { width, height, fracX: 0.5, fracY: 0.5 };
  const x = clamp(focus.x, area.x, area.x + width);
  const y = clamp(focus.y, area.y, area.y + height);
  return {
    width: Math.max(1, 2 * Math.min(x - area.x, area.x + width - x)),
    height: Math.max(1, 2 * Math.min(y - area.y, area.y + height - y)),
    fracX: (x - area.x) / width,
    fracY: (y - area.y) / height,
  };
}

/** Zoom that keeps the complete, tightly-packed grid in view when possible. */
export function fitGridZoom(
  n: number,
  area: GridArea,
  focus?: GridFocus,
): number {
  const cols = gridColumns(n);
  const rows = Math.max(1, Math.ceil(n / cols));
  const width = cols * WINDOWED_CELL + EDGE_MARGIN * 2;
  const height = rows * WINDOWED_CELL + EDGE_MARGIN * 2;
  const extent = focusedExtent(area, focus);
  return clampZoom(
    Math.min(extent.width / width, extent.height / height, FIT_MAX_ZOOM),
    area,
  );
}

interface AxisWindow {
  /** Virtual coordinate of the content block's leading edge. */
  origin: number;
  /** Total pannable span; scroll is clamped to [0, virtual - viewSpan]. */
  virtual: number;
  /** Scroll that puts the content block's centre on the focus point. */
  home: number;
  /** The requested scroll, clamped into the pannable span. */
  scroll: number;
}

/**
 * Lay one axis of the virtual grid out. The content block sits so that its
 * centre lands on the focus point when the camera is at `home`; the pannable
 * span then stretches to cover the content (plus its edge margin), that home
 * position, and the drag slack beyond whichever of the two is outermost.
 *
 * Everything is worked out with the content block starting at 0 and then
 * shifted so the lowest reachable scroll becomes 0 — the contract callers
 * clamp against. With the focus at the middle of the view this reduces exactly
 * to centring the content in the pannable area.
 */
function axisWindow(
  content: number,
  viewSpan: number,
  focusFraction: number,
  requested: number,
): AxisWindow {
  const home = content / 2 - focusFraction * viewSpan;
  const slack = (viewSpan * PAN_SLACK_FRACTION) / 2;
  const min = Math.min(home, -EDGE_MARGIN) - slack;
  const max = Math.max(home, content + EDGE_MARGIN - viewSpan) + slack;
  const virtual = max - min + viewSpan;
  return {
    origin: -min,
    virtual,
    home: home - min,
    scroll: clamp(requested, 0, Math.max(0, virtual - viewSpan)),
  };
}

/**
 * Like `computeGridPositions`, but for a virtual grid that can be far larger
 * than the visible area. Positions are returned in *virtual/world*
 * coordinates (not screen coordinates) — the caller is expected to render
 * them through a camera whose viewport is the screen-space `area` and whose
 * scroll/zoom are `scrollX`/`scrollY`/`zoom`, so clipping is done by the
 * camera (a native, always-supported operation) rather than a GameObject
 * mask (which Phaser 4's WebGL renderer does not reliably support for
 * complex/nested content).
 *
 * Only the dice inside the viewport (plus a small buffer, so nothing pops in
 * right at the edge) are returned — the caller only ever needs to keep that
 * many sprites alive, regardless of how large `n` gets.
 */
export function computeWindowedView(
  n: number,
  area: GridArea,
  view: Viewport,
  focus?: GridFocus,
): WindowedView {
  const cols = gridColumns(n);
  const rows = Math.ceil(n / cols);
  const cell = WINDOWED_CELL; // fixed; the camera's zoom provides the visual zoom
  const zoom = clampZoom(view.zoom, area);
  const contentW = cols * cell;
  const contentH = rows * cell;
  // How much virtual space is visible through the camera at this zoom.
  const viewW = area.width / zoom;
  const viewH = area.height / zoom;
  // The pannable bounds are the dice content plus a margin on every edge —
  // scrollX/Y of 0 is the *outer edge of the margin*, not the first die —
  // stretched to reach the focus point and the drag slack beyond both.
  const extent = focusedExtent(area, focus);
  const axisX = axisWindow(contentW, viewW, extent.fracX, view.scrollX);
  const axisY = axisWindow(contentH, viewH, extent.fracY, view.scrollY);
  const { virtual: virtualW, origin: originX, scroll: scrollX } = axisX;
  const { virtual: virtualH, origin: originY, scroll: scrollY } = axisY;

  // This is the number of raw cells the viewport represents, independent of
  // whether those cells are about to become DieSprites or summary cards. The
  // one-cell allowance covers partially visible cells at both edges.
  const equivalentDice = Math.min(
    n,
    Math.ceil(viewW / cell + 1) * Math.ceil(viewH / cell + 1),
  );

  const cullBuffer = 1; // extra ring of cells around the viewport, so nothing pops in at the edge
  const colStart = Math.max(
    0,
    Math.floor((scrollX - originX) / cell) - cullBuffer,
  );
  const colEnd = Math.min(
    cols - 1,
    Math.ceil((scrollX - originX + viewW) / cell) + cullBuffer,
  );
  const rowStart = Math.max(
    0,
    Math.floor((scrollY - originY) / cell) - cullBuffer,
  );
  const rowEnd = Math.min(
    rows - 1,
    Math.ceil((scrollY - originY + viewH) / cell) + cullBuffer,
  );

  const visible: VisibleDie[] = [];
  // Never enumerate a raw view which the caller will immediately replace with
  // cards. This is the key bound that makes arbitrarily deep zoom-out cheap.
  if (equivalentDice < GRID_LOD_THRESHOLDS.cards) {
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const index = row * cols + col;
        if (index >= n) continue;
        visible.push({
          index,
          x: originX + col * cell + cell / 2,
          y: originY + row * cell + cell / 2,
        });
      }
    }
  }

  const scale = Math.max(0.1, Math.min(1, (cell - 6) / 104));

  return {
    scale,
    zoom,
    virtualW,
    virtualH,
    scrollX,
    scrollY,
    homeScrollX: axisX.home,
    homeScrollY: axisY.home,
    cols,
    rows,
    cell,
    originX,
    originY,
    viewW,
    viewH,
    equivalentDice,
    visible,
  };
}

/** Spatial card regions for the current camera. Region width grows in powers of
 *  two as the camera zooms out, keeping cards near a readable screen size and
 *  preventing representation churn on every wheel tick. */
export function computeVisibleDiceCards(
  n: number,
  view: WindowedView,
): VisibleDiceCard[] {
  const rawCellScreenSize = view.cell * view.zoom;
  const idealCells = CARD_TARGET_SCREEN_SIZE / rawCellScreenSize;
  const regionCells = Math.max(
    1,
    2 ** Math.round(Math.log2(Math.max(1, idealCells))),
  );
  const columnRegionCount = axisRegionCount(view.cols, regionCells);
  const rowRegionCount = axisRegionCount(view.rows, regionCells);

  const colStart = Math.max(
    0,
    Math.floor((view.scrollX - view.originX) / view.cell),
  );
  const colEnd = Math.min(
    view.cols - 1,
    Math.ceil((view.scrollX - view.originX + view.viewW) / view.cell),
  );
  const rowStart = Math.max(
    0,
    Math.floor((view.scrollY - view.originY) / view.cell),
  );
  const rowEnd = Math.min(
    view.rows - 1,
    Math.ceil((view.scrollY - view.originY + view.viewH) / view.cell),
  );

  const [tileColStart, tileColEnd] = visibleRegionSpan(
    columnRegionCount,
    regionCells,
    colStart,
    colEnd,
  );
  const [tileRowStart, tileRowEnd] = visibleRegionSpan(
    rowRegionCount,
    regionCells,
    rowStart,
    rowEnd,
  );

  const cards: VisibleDiceCard[] = [];
  // Iterate offsets rather than incrementing enormous tile indices directly.
  // Above Number.MAX_SAFE_INTEGER, `tileRow++` can round back to the same value
  // and turn a bounded visible-card loop into an infinite one.
  const visibleRowRegions = Math.max(0, tileRowEnd - tileRowStart + 1);
  const visibleColumnRegions = Math.max(0, tileColEnd - tileColStart + 1);
  for (let rowOffset = 0; rowOffset < visibleRowRegions; rowOffset++) {
    const tileRow = tileRowStart + rowOffset;
    const { start: firstRow, end: lastRow } = axisRegionAt(
      view.rows,
      regionCells,
      tileRow,
      rowRegionCount,
    );
    for (
      let columnOffset = 0;
      columnOffset < visibleColumnRegions;
      columnOffset++
    ) {
      const tileCol = tileColStart + columnOffset;
      const { start: firstCol, end: lastCol } = axisRegionAt(
        view.cols,
        regionCells,
        tileCol,
        columnRegionCount,
      );
      if (firstRow * view.cols + firstCol >= n) continue;

      const width = (lastCol - firstCol) * view.cell;
      const height = (lastRow - firstRow) * view.cell;
      cards.push({
        key: `${regionCells}:${tileRow}:${tileCol}`,
        x: view.originX + firstCol * view.cell + width / 2,
        y: view.originY + firstRow * view.cell + height / 2,
        width,
        height,
        region: {
          cols: view.cols,
          rowStart: firstRow,
          rowEnd: lastRow,
          colStart: firstCol,
          colEnd: lastCol,
        },
      });
    }
  }
  return cards;
}

/** Number of near-equal card regions on one virtual-grid axis. This is the
 *  arithmetic equivalent of materialising every partition, but remains O(1)
 *  when an axis contains trillions of cells. A small tail is folded into the
 *  preceding region rather than becoming an unreadable sliver. */
function axisRegionCount(total: number, target: number): number {
  const full = Math.floor(total / target);
  const remainder = total - full * target;
  if (remainder <= 0) return full;
  return full > 0 && remainder <= target * 0.6 ? full : full + 1;
}

function axisRegionAt(
  total: number,
  target: number,
  index: number,
  count: number,
): { start: number; end: number } {
  const start = index * target;
  return {
    start,
    end: index >= count - 1 ? total : Math.min(total, start + target),
  };
}

/** Inclusive region-index span intersecting a visible cell span, with one
 *  buffered region on either side to prevent pop-in while panning. */
function visibleRegionSpan(
  regionCount: number,
  target: number,
  visibleStart: number,
  visibleEnd: number,
): [number, number] {
  if (regionCount <= 0) return [0, -1];
  const start = clamp(Math.floor(visibleStart / target), 0, regionCount - 1);
  const end = clamp(Math.floor(visibleEnd / target), 0, regionCount - 1);
  return [Math.max(0, start - 1), Math.min(regionCount - 1, end + 1)];
}
