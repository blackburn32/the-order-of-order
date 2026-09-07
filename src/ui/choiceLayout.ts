// Arranging a hand of cards the player must choose one of.
//
// Two screens ask that question — the shop, opening a booster pack, and the
// King's writ, which offers only drawbacks — and both want the same answer:
// draw every choice as large as this viewport allows, and close the hand into
// an overlapping fan only when spreading it flat would make the copy
// unreadable. Shared so the two never disagree about what fits.

import Phaser from "phaser";

/** A card's texture size, which every scale here is a fraction of. */
export const CARD_W = 260;
export const CARD_H = 340;

/** The display scale a card's copy is written for. Below it the type floors in
 *  the card builders stop following the art down, so the lines grow into one
 *  another and the longest of them run off the parchment. A hand's choices
 *  close into a fan rather than shrink past this — the same trade the loose
 *  cards make when they drop into the compact carousel. */
export const READABLE_CARD_SCALE = 0.62;
/** Largest a hand's choices are ever drawn, however much room there is. */
export const MAX_CHOICE_SCALE = 0.78;
/** How little of a fanned card its neighbour may leave showing. Half a card is
 *  enough to read its title and see its face; past that the fan stops
 *  tightening and the cards give up size again. */
export const MIN_FAN_STEP = 0.5;
/** Air, in px, kept either side of a fan for the corners its outermost cards
 *  throw out as they tilt. */
export const FAN_BULGE = 36;
/** How much larger a fan must draw the cards before it is worth hiding half of
 *  each one. Every choice legible at once is what the screen is for, so a grid
 *  that is only a little smaller keeps the screen. */
export const MIN_FAN_GAIN = 1.25;
/** How close two arrangements' card sizes have to be before the shape of the
 *  screen, rather than a hair of size, decides between them. */
export const CHOICE_SCALE_TIE = 0.99;
/** How much less of its tightest axis one tied arrangement has to fill before
 *  it is called the roomier of the two. Under this the two are as good as each
 *  other and the plainer shape — the single row, the single column — wins, so
 *  that a hand which already sits comfortably in one line is never broken into
 *  a ragged grid for a percent of air. */
export const CHOICE_FILL_MARGIN = 0.05;
/** Tilt of the outermost card in a fan, and the drop of the lower corners. */
export const FAN_MAX_TILT_DEG = 6;
export const FAN_ARC_MAX = 4;

/** How a hand's choices are arranged. `step` is a fraction of a card's width:
 *  1 means the cards in a row stand clear of one another, less means each
 *  slides under the one beside it. */
export interface ChoiceLayout {
  cols: number;
  rows: number;
  scale: number;
  fanned: boolean;
  step: number;
}

/** Pick the arrangement that draws a pack's choices largest.
 *
 *  Every column count is measured as a plain grid first. Where that would
 *  drive the cards below the size their copy is written for, the same grid is
 *  measured again with each row's cards sliding under one another: an
 *  overlapping row spends none of its width on gaps or on the covered edges,
 *  which at phone widths buys back enough to draw the cards half again as
 *  large. A fan is only ever tightened as far as it takes to climb back to a
 *  readable card, and a fan that would not have to overlap at all is just a
 *  row, so it stays one.
 *
 *  A fan hides half of every card it draws, which on this screen is half of
 *  every choice on offer — so it has to win by a margin, not by a hair.
 *
 *  Cards stop growing at MAX_CHOICE_SCALE, so on a roomy screen several
 *  arrangements draw exactly the same card, and what should decide between
 *  them is the shape of the screen. What that means is how much room the block
 *  of cards leaves around itself: of two arrangements drawing the same card,
 *  the better one is whichever presses less hard against the edge it comes
 *  closest to. That reads as a row across a landscape viewport and a grid down
 *  a portrait one, and unlike counting rows or columns it knows the difference
 *  between a tall viewport and a narrow one — a portrait tablet is easily wide
 *  enough for two or three cards abreast, and the old rule stacked them in a
 *  single column down the middle anyway, running the stack to the full height
 *  of the screen.
 *
 *  Only a clear win in room counts (CHOICE_FILL_MARGIN); otherwise the tie
 *  falls to the simpler shape, so a hand that fits in one line stays in one
 *  line instead of folding into a grid with a hole in its last row. */
export function planChoiceLayout(
  n: number,
  availW: number,
  availH: number,
  gap: number,
): ChoiceLayout {
  let grid: ChoiceLayout | undefined;
  let fan: ChoiceLayout | undefined;
  // Fewest rows where the space is wider than it is tall, fewest columns
  // where it is taller than it is wide. Only ever the last word, once room
  // has failed to separate the two.
  const wide = availW >= availH;
  /** How much of its tightest axis an arrangement's block of cards takes up.
   *  1 is flush with the edge of the space, and lower is roomier. */
  const fill = (a: ChoiceLayout): number => {
    const blockW = a.fanned
      ? CARD_W * a.scale * (1 + (a.cols - 1) * a.step) + FAN_BULGE
      : a.cols * CARD_W * a.scale + (a.cols - 1) * gap;
    const blockH = a.rows * CARD_H * a.scale + (a.rows - 1) * gap;
    return Math.max(blockW / availW, blockH / availH);
  };
  const better = (a: ChoiceLayout, b: ChoiceLayout | undefined): boolean => {
    if (!b) return true;
    const tied =
      a.scale >= b.scale * CHOICE_SCALE_TIE &&
      b.scale >= a.scale * CHOICE_SCALE_TIE;
    if (!tied) return a.scale > b.scale;
    const roomA = fill(a);
    const roomB = fill(b);
    if (roomA + CHOICE_FILL_MARGIN < roomB) return true;
    if (roomB + CHOICE_FILL_MARGIN < roomA) return false;
    return wide ? a.rows < b.rows : a.cols < b.cols;
  };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const heightScale = (availH - (rows - 1) * gap) / (rows * CARD_H);
    const gridScale = Math.min(
      MAX_CHOICE_SCALE,
      heightScale,
      (availW - (cols - 1) * gap) / (cols * CARD_W),
    );
    const flat: ChoiceLayout = {
      cols,
      rows,
      scale: gridScale,
      fanned: false,
      step: 1,
    };
    if (better(flat, grid)) grid = flat;
    // Overlap buys width and nothing else, so it is worth measuring only
    // where the width is what is holding the cards down.
    if (cols === 1 || gridScale >= READABLE_CARD_SCALE) continue;
    const step = Phaser.Math.Clamp(
      ((availW - FAN_BULGE) / (READABLE_CARD_SCALE * CARD_W) - 1) / (cols - 1),
      MIN_FAN_STEP,
      1,
    );
    if (step >= 1) continue;
    const fanScale = Math.min(
      MAX_CHOICE_SCALE,
      heightScale,
      (availW - FAN_BULGE) / (CARD_W * (1 + (cols - 1) * step)),
    );
    const overlapped: ChoiceLayout = {
      cols,
      rows,
      scale: fanScale,
      fanned: true,
      step,
    };
    if (better(overlapped, fan)) fan = overlapped;
  }
  const best = grid as ChoiceLayout;
  return fan && fan.scale > best.scale * MIN_FAN_GAIN ? fan : best;
}
