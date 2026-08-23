import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { loadProgress } from "../systems/SaveData";
import { ITEMS } from "../systems/Items";
import { addFelt, bannerButton } from "../ui/widgets";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { buildItemCard } from "../ui/itemCard";
import {
  compactColumns,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";

export interface ItemsData {
  /** Active scene to reveal when an in-game Codex overlay closes. */
  returnTo?: string;
}

// Native card box plus caption room below — used for grid spacing/scaling.
const CARD_W = 260;
const CARD_H = 420;
// A compact gutter lets common 360px-wide phone layouts keep two cards per row
// while each card remains just above the 50% readability threshold.
const COL_GAP = 12;
const ROW_GAP = 24;
const MIN_READABLE_CARD_SCALE = 0.5;
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2 } as const;

/** Fixed sigil brightness for the backdrop — no trial to report here, so the
 *  value is chosen purely for how it looks (see MenuScene). */
const CODEX_AMBIENCE = 0.55;

/** Rows of cards built beyond each edge of the scroll window, so a flick
 *  doesn't outrun the build and expose an empty cell. The gallery's first pass
 *  skips the buffer: nothing can scroll until the entrance slide gives input
 *  back, and the top-up is running by then. */
const CARD_BUFFER_ROWS = 1;
/** Strip kept clear under the gallery for its "drag or scroll for more" line,
 *  where no back button already leaves room for it. */
const GALLERY_HINT_H = 20;
/** Cards the background top-up builds per frame. Each is five game objects,
 *  four of them Text — a millisecond or so together, which disappears into a
 *  frame's budget while still finishing the whole Codex within a second of the
 *  entrance. */
const TOPUP_PER_FRAME = 1;

/** Touch-scroll momentum is measured in track pixels per millisecond. An
 * exponential decay keeps a flick feeling the same at every frame rate, while
 * the cutoff prevents an imperceptibly slow tail from running indefinitely. */
const MOMENTUM_DECAY_PER_MS = 0.0035;
const MOMENTUM_MIN_SPEED = 0.015;
const MOMENTUM_MAX_SPEED = 2.5;
const MOMENTUM_SAMPLE_BLEND = 0.35;
const MOMENTUM_MAX_SAMPLE_AGE_MS = 80;

/** Everything the gallery needs to place and build a card on demand. It is held
 *  on the scene because the cards outlive the call that laid the grid out: the
 *  scroll handlers and the per-frame top-up both materialise more of them. */
interface Gallery {
  track: Phaser.GameObjects.Container;
  items: (typeof ITEMS)[number][];
  unlocked: Set<string>;
  /** Lifetime selection tallies, read once with the rest of the save rather
   *  than per card — `getSelectionCount` parses the whole progress blob out of
   *  localStorage on every call. */
  counts: Record<string, number | undefined>;
  built: Set<number>;
  cols: number;
  cellW: number;
  cellH: number;
  cardScale: number;
  /** Screen y of the scroll window's top edge, and its height. */
  top: number;
  height: number;
}

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (
  pointer: Phaser.Input.Pointer,
  over: unknown,
  dx: number,
  dy: number,
  dz: number,
) => void;

/**
 * The Codex: a gallery of every shop item as a card, with a lifetime
 * "selected N times" caption. Still-locked items render greyed with "???".
 * The card row can exceed the panel, so it lives in a `track` container clipped
 * to the grid area by a dedicated camera (native scissor clipping — the same
 * approach ShopScene uses) and scrolls vertically by drag/wheel.
 */
export class ItemsScene extends Phaser.Scene {
  private returnTo = "Menu";
  private openedAsOverlay = false;
  private returnInputWasEnabled = true;
  private gridCamera?: Phaser.Cameras.Scene2D.Camera;
  private gallery?: Gallery;
  private toppingUp = false;
  private scrollTick?: (delta: number) => void;
  // The felt, the sigil and the masthead's halo — the room the gallery is hung
  // in. Held still while the gallery itself slides on and off. Only used when
  // the Codex is a scene of its own; as an overlay it has a live scene beneath
  // it and no room of its own to keep.
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  private leaving = false;
  private input$?: {
    down: PointerHandler;
    move: PointerHandler;
    up: PointerHandler;
    wheel: WheelHandler;
  };

  constructor() {
    super("Items");
  }

  init(data: ItemsData): void {
    this.returnTo = data?.returnTo ?? "Menu";
  }

  create(): void {
    this.openedAsOverlay = this.scene.isActive(this.returnTo);
    if (this.openedAsOverlay) {
      const base = this.scene.get(this.returnTo);
      this.returnInputWasEnabled = base.input.enabled;
      base.input.enabled = false;
      // Inventory is registered after Items in the scene list, so a plain
      // launch would otherwise leave this overlay rendering behind it.
      this.scene.bringToTop();
    }

    this.gridCamera = undefined;
    this.gallery = undefined;
    // Scene instances are reused across visits, so the top-up has to be re-armed
    // rather than left on from the last one — otherwise it would run during the
    // entrance it exists to keep clear.
    this.toppingUp = false;
    this.leaving = false;
    this.build();
    // The cards the window can't reach wait for the entrance to finish; an
    // overlay has no entrance to wait for.
    if (this.openedAsOverlay) this.toppingUp = true;
    else slideSceneIn(this, this.slideBackdrop, () => (this.toppingUp = true));

    const off = onResizeCoalesced(this, () => {
      this.teardownInput();
      destroyAllChildren(this);
      this.build();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardownInput();
      this.input.setDefaultCursor("default");
      if (this.openedAsOverlay) {
        const base = this.scene.get(this.returnTo);
        base.input.enabled = this.returnInputWasEnabled;
      }
    });
  }

  private teardownInput(): void {
    this.scrollTick = undefined;
    if (this.input$) {
      this.input.off("pointerdown", this.input$.down);
      this.input.off("pointermove", this.input$.move);
      this.input.off("pointerup", this.input$.up);
      this.input.off("pointerupoutside", this.input$.up);
      this.input.off("wheel", this.input$.wheel);
      this.input$ = undefined;
    }
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(CODEX_AMBIENCE, false);

    // Stacked, the masthead, the gallery and the back button share the height
    // three ways — on a short landscape viewport that leaves the cards a band
    // barely a quarter of a card tall. Folded, the masthead and the button take
    // a column of their own and the gallery gets the full height beside them.
    const compact = isCompactLandscape(W, H);
    const columns = compactColumns(this, { leftFraction: 0.36 });

    const header = buildSceneHeader(this, {
      title: "The Codex of Items",
      subtitle:
        "Browse the Order's accumulated knowledge of the realm's treasures.",
      y: compact ? columns.top + 24 : Math.max(48, Math.min(H * 0.12, 92)),
      width: compact ? columns.left.width : Math.min(W, 760),
      ...(compact ? { x: columns.left.cx } : {}),
    });
    this.slideBackdrop = [felt, ambient, header.glow];

    const progress = loadProgress();
    const unlocked = new Set(progress.unlocked);

    // The back button is created before the (camera-clipped) gallery so it is
    // part of the "everything except the card track" set the grid camera
    // ignores.
    const backLabel = this.openedAsOverlay
      ? "Close Codex"
      : "Return to the Vestibule";
    const back = compact
      ? bannerButton(
          this,
          columns.left.cx,
          0,
          backLabel,
          () => this.close(),
          columns.left.width,
        )
      : bannerButton(
          this,
          cx,
          H - 24 - 70 / 2,
          backLabel,
          () => this.close(),
          Math.min(W - 40, 340),
        );
    if (compact) back.setY(columns.bottom - back.height / 2);

    // The gallery fills the band between the masthead and the back button —
    // or, folded, the whole of the column beside them, less a strip for the
    // "drag or scroll" line the stacked layout fits above the button.
    const grid = compact
      ? {
          x: columns.right.x,
          y: columns.top,
          width: columns.right.width,
          height: Math.max(120, columns.height - GALLERY_HINT_H),
        }
      : (() => {
          const gridTop = header.bottom + 20;
          const gridBottom = back.y - back.height / 2 - 24;
          const gridW = Math.min(W - 32, 1100);
          return {
            x: cx - gridW / 2,
            y: gridTop,
            width: gridW,
            height: Math.max(120, gridBottom - gridTop),
          };
        })();

    this.buildGallery(grid, unlocked, progress.selectionCounts);
  }

  private close(): void {
    // An overlay just lifts off the scene still running underneath it. A Codex
    // opened from the Vestibule instead slides its gallery off to the right and
    // hands the still room over to the menu, which brings its own interface in.
    if (this.openedAsOverlay) {
      this.scene.stop();
      return;
    }
    if (this.leaving) return;
    this.leaving = true;
    slideSceneOut(
      this,
      () => this.scene.start(this.returnTo),
      this.slideBackdrop,
    );
  }

  private buildGallery(
    grid: { x: number; y: number; width: number; height: number },
    unlocked: Set<string>,
    counts: Record<string, number | undefined>,
  ): void {
    const isLocked = (def: (typeof ITEMS)[number]) =>
      !!def.unlock && !unlocked.has(def.id);
    const codexItems = [...ITEMS].sort((a, b) => {
      const aOrder = isLocked(a) ? 3 : RARITY_ORDER[a.rarity];
      const bOrder = isLocked(b) ? 3 : RARITY_ORDER[b.rarity];
      return aOrder - bOrder;
    });
    const n = codexItems.length;

    // Drop columns before cards become too small to read. Extra rows scroll,
    // which is preferable to squeezing a full-size Text texture down to a
    // fraction of a phone pixel grid.
    const minCellW = CARD_W * MIN_READABLE_CARD_SCALE + COL_GAP;
    const cols = Math.max(1, Math.min(5, Math.floor(grid.width / minCellW)));
    const rows = Math.ceil(n / cols);
    const cellW = grid.width / cols;
    const cardScale = Math.min((cellW - COL_GAP) / CARD_W, 1);
    const cellH = CARD_H * cardScale + ROW_GAP;
    const contentH = rows * cellH;

    // Only the cards the window can reach are built now. All fifty-odd of them
    // is north of two hundred Text objects, and rasterising that many in the
    // frame the Codex opens costs a quarter of a second — landing squarely on
    // the entrance slide. `update` fills the rest in once the slide is done.
    const track = this.add.container(grid.x, grid.y);
    this.gallery = {
      track,
      items: codexItems,
      unlocked,
      counts,
      built: new Set(),
      cols,
      cellW,
      cellH,
      cardScale,
      top: grid.y,
      height: grid.height,
    };
    this.syncCards(0);

    // Clip the (possibly overflowing) track to the gallery's band via a
    // dedicated camera — zoom 1, scroll = the viewport's own screen position
    // (passthrough). The clip is only needed vertically, since no card reaches
    // past the grid's own width, so the viewport spans the full screen: that
    // lets the scene slide carry the cards clear off the edge rather than
    // having them wink out at the grid's left margin partway across.
    const cam = this.ensureGridCamera();
    cam.setViewport(0, grid.y, this.scale.width, grid.height);
    cam.setScroll(0, grid.y);
    cam.ignore(this.children.list.filter((obj) => obj !== track));
    this.cameras.main.ignore(track);

    const overflow = Math.max(0, contentH - grid.height);
    if (overflow <= 0) return;

    // Scroll by moving track.y between the top-aligned rest position and the
    // fully-scrolled-down position.
    const maxY = grid.y;
    const minY = grid.y - overflow;

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= grid.x &&
      p.x <= grid.x + grid.width &&
      p.y >= grid.y &&
      p.y <= grid.y + grid.height;

    let dragging = false;
    let touchDrag = false;
    let startPointerY = 0;
    let startTrackY = 0;
    let lastTrackY = track.y;
    let lastMoveAt = 0;
    let momentumY = 0;

    const onDown: PointerHandler = (p) => {
      if (!inBounds(p)) return;
      dragging = true;
      touchDrag = p.wasTouch;
      startPointerY = p.y;
      startTrackY = track.y;
      lastTrackY = track.y;
      lastMoveAt = performance.now();
      momentumY = 0;
    };
    const onMove: PointerHandler = (p) => {
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? "grab" : "default");
        return;
      }
      const dy = p.y - startPointerY;
      track.y = Phaser.Math.Clamp(startTrackY + dy, minY, maxY);
      const now = performance.now();
      const elapsed = now - lastMoveAt;
      if (touchDrag && elapsed > 0) {
        const sample = Phaser.Math.Clamp(
          (track.y - lastTrackY) / elapsed,
          -MOMENTUM_MAX_SPEED,
          MOMENTUM_MAX_SPEED,
        );
        momentumY = Phaser.Math.Linear(
          momentumY,
          sample,
          MOMENTUM_SAMPLE_BLEND,
        );
      }
      lastTrackY = track.y;
      lastMoveAt = now;
      this.syncCards();
    };
    const onUp: PointerHandler = () => {
      if (
        !touchDrag ||
        performance.now() - lastMoveAt > MOMENTUM_MAX_SAMPLE_AGE_MS
      ) {
        momentumY = 0;
      }
      dragging = false;
      touchDrag = false;
    };
    const onWheel: WheelHandler = (p, _over, _dx, dy) => {
      if (!inBounds(p)) return;
      momentumY = 0;
      track.y = Phaser.Math.Clamp(track.y - dy, minY, maxY);
      this.syncCards();
    };

    this.scrollTick = (delta) => {
      if (dragging || Math.abs(momentumY) < MOMENTUM_MIN_SPEED) {
        if (!dragging) momentumY = 0;
        return;
      }

      // Integrate the exponential exactly so a 30 fps flick travels the same
      // distance as a 120 fps one. Cap a single step after tab suspension so
      // returning to the game cannot jump across the gallery.
      const elapsed = Math.min(delta, 50);
      const decay = Math.exp(-MOMENTUM_DECAY_PER_MS * elapsed);
      const distance = (momentumY * (1 - decay)) / MOMENTUM_DECAY_PER_MS;
      const nextY = Phaser.Math.Clamp(track.y + distance, minY, maxY);
      const hitBoundary = nextY !== track.y + distance;
      track.y = nextY;
      momentumY = hitBoundary ? 0 : momentumY * decay;
      this.syncCards();
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.input$ = { down: onDown, move: onMove, up: onUp, wheel: onWheel };

    const hint = this.add
      .text(
        grid.x + grid.width / 2,
        grid.y + grid.height + 12,
        "drag or scroll for more",
        {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.dim,
          fontStyle: "italic",
        },
      )
      .setOrigin(0.5, 0.5);
    this.gridCamera?.ignore(hint);
  }

  /** Build every card the scroll window can currently reach. Cards are never
   *  torn down again: fifty-odd of them is an affordable display list once the
   *  cost has been spread out, and rebuilding on each change of scroll
   *  direction would put that cost straight back into the moving frame. */
  private syncCards(buffer = CARD_BUFFER_ROWS): void {
    const g = this.gallery;
    if (!g) return;
    // How far the track has been scrolled up out of the window.
    const scrolled = g.top - g.track.y;
    const firstRow = Math.floor(scrolled / g.cellH) - buffer;
    const lastRow = Math.floor((scrolled + g.height) / g.cellH) + buffer;
    const from = Math.max(0, firstRow * g.cols);
    const to = Math.min(g.items.length - 1, (lastRow + 1) * g.cols - 1);
    for (let i = from; i <= to; i++) this.buildCard(i);
  }

  /** Build card `index` if it isn't there yet; true when one was made. */
  private buildCard(index: number): boolean {
    const g = this.gallery;
    if (!g || g.built.has(index)) return false;
    const def = g.items[index];
    const card = buildItemCard(this, def, {
      locked: !!def.unlock && !g.unlocked.has(def.id),
      count: g.counts[def.id] ?? 0,
      displayScale: g.cardScale,
    });
    card.setPosition(
      (index % g.cols) * g.cellW + g.cellW / 2,
      Math.floor(index / g.cols) * g.cellH + g.cellH / 2,
    );
    g.track.add(card);
    // `Camera.ignore` walks a container's children as they stand at the time of
    // the call, so the main camera's filter over the track doesn't cover a card
    // that arrives later. Without this one it would be drawn a second time,
    // unclipped, straight over the rest of the scene.
    this.cameras.main.ignore(card);
    g.built.add(index);
    return true;
  }

  /** Fill in the cards the window hasn't asked for, a few per frame, so a
   *  scroll that outruns `syncCards` still finds them already built. */
  override update(_time: number, delta: number): void {
    this.scrollTick?.(delta);
    const g = this.gallery;
    if (!g || !this.toppingUp || g.built.size >= g.items.length) return;
    let budget = TOPUP_PER_FRAME;
    for (let i = 0; i < g.items.length && budget > 0; i++) {
      if (this.buildCard(i)) budget -= 1;
    }
  }

  private ensureGridCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.gridCamera) this.cameras.remove(this.gridCamera, true);
    const cam = this.cameras.add(0, 0, 1, 1);
    cam.setBackgroundColor();
    this.gridCamera = cam;
    return cam;
  }
}
