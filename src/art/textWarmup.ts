import Phaser from "phaser";
import { CSS, SERIF } from "./palette";

/**
 * Pre-pay the cost of the first `Text` object at each size the interface uses.
 *
 * A Phaser `Text` is a canvas: building one rasterizes the string at
 * `TEXTURE_RESOLUTION` and hands the result to the GPU as a new texture. The
 * browser caches that work per *exact* font string, and Chrome pools canvas
 * backing stores and GL textures per exact size, so the first `Text` at a given
 * size costs some 6ms and every one after it costs well under one.
 *
 * Screens here are built whole, inside `create()`. The shop is the heaviest:
 * 26 Text objects, some 450,000 device pixels of glyphs and 52 new textures,
 * all in the single frame between the previous screen sliding out and this one
 * sliding in. Paid cold that frame runs 50ms on a desktop and a third of a
 * second on a slow phone — the hitch the shop opens on. Paid warm, the same
 * build fits in a frame, which is why a second visit to the shop has never
 * stuttered.
 *
 * So the ladder is walked once per session on whatever screen is up, a few
 * sizes per frame, while the player is reading a menu. Each Text is destroyed in
 * the same callback that made it, after the frame has already been drawn, so
 * none of them is ever seen.
 */

/** The band worth warming. Body copy runs from `MIN_LEGIBLE_PX` (9) up through
 *  the low 20s, and screen titles reach the low 40s; the two or three places
 *  that go bigger are one heading each, and warming the 25 sizes above this
 *  would cost more than the single 6ms they would save. */
const WARM_MIN_PX = 8;
const WARM_MAX_PX = 44;

/** Every weight the interface asks for. Nothing here sets both at once. */
const WARM_STYLES = ["", "bold", "italic"] as const;

/** A string long enough that the canvas behind it is the size a real label's
 *  is, rather than a few glyphs wide. */
const WARM_STRING = "Chalice of Plenty and more";

/** How long a frame may spend warming, and the frame time above which it takes
 *  the frame off entirely. One size can overshoot the budget — it is checked
 *  after the fact, since the whole point is that the cost is not yet known —
 *  so the budget is set well inside a frame. The back-off matters more: it
 *  keeps the warm-up off the very frames it exists to protect, where a scene is
 *  building itself and the loop is already behind. */
const WARM_BUDGET_MS = 3;
const WARM_BACK_OFF_MS = 20;

/**
 * Start warming the text pipeline in the background. Called once, from Boot.
 *
 * Driven from the game's own post-render rather than a scene's update: it
 * outlives every scene, and scenes come and go throughout the walk.
 */
export function warmTextPipeline(game: Phaser.Game): void {
  const ladder: { px: number; fontStyle: string }[] = [];
  for (const fontStyle of WARM_STYLES) {
    for (let px = WARM_MIN_PX; px <= WARM_MAX_PX; px++) {
      ladder.push({ px, fontStyle });
    }
  }

  let next = 0;
  const step = (): void => {
    if (next >= ladder.length) {
      game.events.off(Phaser.Core.Events.POST_RENDER, step);
      return;
    }
    if (game.loop.delta > WARM_BACK_OFF_MS) return;
    // Any live scene will do — this only needs a factory to build through, so
    // that the warm Text is made exactly the way a real one is (see
    // `installHighResolutionText`, which is what puts it at device resolution).
    const scene = game.scene.scenes.find((candidate) =>
      candidate.sys.isActive(),
    );
    if (!scene) return;

    const until = performance.now() + WARM_BUDGET_MS;
    do {
      const { px, fontStyle } = ladder[next++];
      scene.add
        .text(0, 0, WARM_STRING, {
          fontFamily: SERIF,
          fontSize: `${px}px`,
          fontStyle,
          color: CSS.ivory,
        })
        .destroy();
    } while (next < ladder.length && performance.now() < until);
  };

  game.events.on(Phaser.Core.Events.POST_RENDER, step);
}
