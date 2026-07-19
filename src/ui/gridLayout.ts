export interface GridArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridLayout {
  cols: number;
  rows: number;
  cell: number;
  scale: number;
  positions: { x: number; y: number }[];
}

/**
 * Cols/rows/cell size + a scale + per-index position for `n` items packed
 * into `area`. As `n` grows the whole layout "shrinks out" (scale shrinks)
 * to keep every item visible, with the last, possibly-partial row centered.
 * Shared by the main dice grid and the shop's shrink-die picker grid.
 */
export function computeGridPositions(n: number, area: GridArea, maxCell = 120): GridLayout {
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * area.width) / area.height)));
  const rows = Math.ceil(n / cols);
  const cell = Math.min(maxCell, area.width / cols, area.height / rows);
  const scale = Math.max(0.1, Math.min(1, (cell - 6) / 104));

  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  const startX = cx - ((cols - 1) * cell) / 2;
  const startY = cy - ((rows - 1) * cell) / 2;

  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Center the last, possibly partial, row.
    const inRow = row === rows - 1 ? n - (rows - 1) * cols : cols;
    const rowStartX = cx - ((inRow - 1) * cell) / 2;
    const x = row === rows - 1 ? rowStartX + col * cell : startX + col * cell;
    positions.push({ x, y: startY + row * cell });
  }

  return { cols, rows, cell, scale, positions };
}
