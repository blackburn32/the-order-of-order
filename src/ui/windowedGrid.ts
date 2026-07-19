import Phaser from 'phaser';
import { GridArea } from './gridLayout';

// Above this many dice, the grid stops trying to shrink-to-fit everything on
// screen at once (which is how rendering "falls over" at huge counts) and
// switches to a fixed-size scrollable/zoomable window instead.
export const WINDOW_THRESHOLD = 1500;

const WINDOWED_CELL = 60;
const MAX_ZOOM = 1.5;
// Caps how many dice can be on screen at once at maximum zoom-out. The min
// zoom is derived from this (given the current viewport area) rather than
// being a fixed ratio, so it scales sensibly on any screen size instead of
// showing a wildly different dice count on a phone vs. an ultrawide
// monitor. 10x the old fixed-ratio limit (MIN_ZOOM was 0.3, which worked
// out to ~1,350 dice visible on a typical 1280x720 layout).
export const MAX_ZOOMED_OUT_DICE = 13500;
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
  visible: VisibleDie[];
}

export function clampZoom(zoom: number, area: GridArea): number {
  const minZoom = Math.sqrt((area.width * area.height) / MAX_ZOOMED_OUT_DICE) / WINDOWED_CELL;
  return Phaser.Math.Clamp(zoom, minZoom, MAX_ZOOM);
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
export function computeWindowedView(n: number, area: GridArea, view: Viewport): WindowedView {
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * area.width) / area.height)));
  const rows = Math.ceil(n / cols);
  const cell = WINDOWED_CELL; // fixed; the camera's zoom provides the visual zoom
  const zoom = clampZoom(view.zoom, area);
  const contentW = cols * cell;
  const contentH = rows * cell;
  // The pannable bounds are the dice content plus a margin on every edge —
  // scrollX/Y of 0 is the *outer edge of the margin*, not the first die.
  const virtualW = contentW + EDGE_MARGIN * 2;
  const virtualH = contentH + EDGE_MARGIN * 2;

  // How much virtual space is visible through the camera at this zoom.
  const viewW = area.width / zoom;
  const viewH = area.height / zoom;

  const scrollX = Phaser.Math.Clamp(view.scrollX, 0, Math.max(0, virtualW - viewW));
  const scrollY = Phaser.Math.Clamp(view.scrollY, 0, Math.max(0, virtualH - viewH));

  const cullBuffer = 1; // extra ring of cells around the viewport, so nothing pops in at the edge
  const colStart = Math.max(0, Math.floor((scrollX - EDGE_MARGIN) / cell) - cullBuffer);
  const colEnd = Math.min(cols - 1, Math.ceil((scrollX - EDGE_MARGIN + viewW) / cell) + cullBuffer);
  const rowStart = Math.max(0, Math.floor((scrollY - EDGE_MARGIN) / cell) - cullBuffer);
  const rowEnd = Math.min(rows - 1, Math.ceil((scrollY - EDGE_MARGIN + viewH) / cell) + cullBuffer);

  const visible: VisibleDie[] = [];
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      const index = row * cols + col;
      if (index >= n) continue;
      visible.push({ index, x: EDGE_MARGIN + col * cell + cell / 2, y: EDGE_MARGIN + row * cell + cell / 2 });
    }
  }

  const scale = Math.max(0.1, Math.min(1, (cell - 6) / 104));

  return { scale, zoom, virtualW, virtualH, scrollX, scrollY, visible };
}
