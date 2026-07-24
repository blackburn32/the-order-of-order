import Phaser from "phaser";
import { GridArea } from "./gridLayout";

// Dense auxiliary pickers still use a threshold. The main game grid now uses
// the viewport at every count so switching render paths can never leak dice.
export const WINDOW_THRESHOLD = 1500;

const WINDOWED_CELL = 60;
const MAX_ZOOM = 1.5;
// Summary cards keep render cost bounded below this zoom. This is a numerical
// guard rather than a rendering limit: realistic grids can still fit in full.
const MIN_ZOOM = 0.0001;
const CARD_TARGET_SCREEN_SIZE = 112;
const LOD_HYSTERESIS = 0.9;

export const GRID_LOD_THRESHOLDS = {
  callouts: 1_000,
  effects: 5_000,
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

export interface WindowedView {
  scale: number;
  zoom: number;
  virtualW: number;
  virtualH: number;
  scrollX: number; // clamped to the virtual grid's bounds
  scrollY: number; // clamped to the virtual grid's bounds
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

interface AxisRegion {
  start: number;
  end: number;
}

export function clampZoom(zoom: number, area: GridArea): number {
  void area;
  return Phaser.Math.Clamp(zoom, MIN_ZOOM, MAX_ZOOM);
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

/** Zoom that keeps the complete, tightly-packed grid in view when possible. */
export function fitGridZoom(n: number, area: GridArea): number {
  const cols = Math.max(
    1,
    Math.ceil(Math.sqrt((n * area.width) / area.height)),
  );
  const rows = Math.max(1, Math.ceil(n / cols));
  const width = cols * WINDOWED_CELL + EDGE_MARGIN * 2;
  const height = rows * WINDOWED_CELL + EDGE_MARGIN * 2;
  return clampZoom(
    Math.min(area.width / width, area.height / height, MAX_ZOOM),
    area,
  );
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
): WindowedView {
  const cols = Math.max(
    1,
    Math.ceil(Math.sqrt((n * area.width) / area.height)),
  );
  const rows = Math.ceil(n / cols);
  const cell = WINDOWED_CELL; // fixed; the camera's zoom provides the visual zoom
  const zoom = clampZoom(view.zoom, area);
  const contentW = cols * cell;
  const contentH = rows * cell;
  // The pannable bounds are the dice content plus a margin on every edge —
  // scrollX/Y of 0 is the *outer edge of the margin*, not the first die.
  // How much virtual space is visible through the camera at this zoom.
  const viewW = area.width / zoom;
  const viewH = area.height / zoom;
  const virtualW = Math.max(contentW + EDGE_MARGIN * 2, viewW);
  const virtualH = Math.max(contentH + EDGE_MARGIN * 2, viewH);
  const originX = (virtualW - contentW) / 2;
  const originY = (virtualH - contentH) / 2;

  const scrollX = Phaser.Math.Clamp(
    view.scrollX,
    0,
    Math.max(0, virtualW - viewW),
  );
  const scrollY = Phaser.Math.Clamp(
    view.scrollY,
    0,
    Math.max(0, virtualH - viewH),
  );

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
  const columnRegions = partitionAxis(view.cols, regionCells);
  const rowRegions = partitionAxis(view.rows, regionCells);

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
    columnRegions,
    colStart,
    colEnd,
  );
  const [tileRowStart, tileRowEnd] = visibleRegionSpan(
    rowRegions,
    rowStart,
    rowEnd,
  );

  const cards: VisibleDiceCard[] = [];
  for (let tileRow = tileRowStart; tileRow <= tileRowEnd; tileRow++) {
    const { start: firstRow, end: lastRow } = rowRegions[tileRow];
    for (let tileCol = tileColStart; tileCol <= tileColEnd; tileCol++) {
      const { start: firstCol, end: lastCol } = columnRegions[tileCol];
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

/** Split an axis into near-equal card-sized regions. A very small remainder is
 *  folded into the preceding region instead of becoming an unreadable sliver. */
function partitionAxis(total: number, target: number): AxisRegion[] {
  const regions: AxisRegion[] = [];
  let start = 0;
  while (start + target <= total) {
    regions.push({ start, end: start + target });
    start += target;
  }
  if (start < total) {
    const remainder = total - start;
    if (regions.length > 0 && remainder <= target * 0.6) {
      regions[regions.length - 1].end = total;
    } else {
      regions.push({ start, end: total });
    }
  }
  return regions;
}

/** Inclusive region-index span intersecting a visible cell span, with one
 *  buffered region on either side to prevent pop-in while panning. */
function visibleRegionSpan(
  regions: readonly AxisRegion[],
  visibleStart: number,
  visibleEnd: number,
): [number, number] {
  let start = regions.findIndex((region) => region.end > visibleStart);
  if (start < 0) start = regions.length - 1;
  let end = regions.findIndex((region) => region.start > visibleEnd) - 1;
  if (end < 0) end = regions.length - 1;
  return [Math.max(0, start - 1), Math.min(regions.length - 1, end + 1)];
}
