import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { audio } from "../systems/Audio";
import { loadPlayerStats } from "../systems/PlayerStats";
import { loadProgress } from "../systems/SaveData";
import {
  ITEM_THEMES,
  ITEMS,
  type ItemDef,
  type ItemTheme,
  type Rarity,
} from "../systems/Items";
import {
  addFelt,
  bannerButton,
  cycleChip,
  fitTextWidth,
  type CycleChip,
} from "../ui/widgets";
import {
  buildPlayerStatsPanel,
  type PlayerStatsPanel,
} from "../ui/playerStatsPanel";
import { addCamera, setCameraViewport } from "../ui/camera";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import {
  slideOverlayIn,
  slideOverlayOut,
  slideSceneIn,
  slideSceneOut,
} from "../ui/sceneSlide";
import { buildItemCard } from "../ui/itemCard";
import {
  compactColumns,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";

/** The two halves of the Codex: the collection, and the player's own record
 *  of using it. */
type CodexTab = "cards" | "stats";

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

/** The gallery's three controls, each in the order its chip walks them. The
 *  first entry of each is the default the Codex opens on — and the one the
 *  chip draws unlit (see `cycleChip`), so an active sort or filter shows. */
const SORTS = [
  { id: "rarity", label: "Rarity" },
  { id: "purchases", label: "Purchases" },
] as const;
type SortMode = (typeof SORTS)[number]["id"];

const RARITY_FILTERS = [
  { id: "all", label: "All" },
  { id: "common", label: "Common" },
  { id: "uncommon", label: "Uncommon" },
  { id: "rare", label: "Rare" },
] as const satisfies readonly { id: "all" | Rarity; label: string }[];
type RarityFilter = (typeof RARITY_FILTERS)[number]["id"];

const THEME_FILTERS = [
  { id: "all", label: "All" },
  { id: "swarm", label: "Swarm" },
  { id: "multiplier", label: "Multiplier" },
  { id: "precision", label: "Precision" },
  { id: "economy", label: "Economy" },
  { id: "tempo", label: "Tempo" },
] as const satisfies readonly { id: "all" | ItemTheme; label: string }[];
type ThemeFilter = (typeof THEME_FILTERS)[number]["id"];

/** Air between chips, across a row and between wrapped rows. */
const CHIP_GAP_X = 8;
const CHIP_GAP_Y = 4;
/** Gap between the control strip and the cards it governs. */
const CONTROLS_GAP = 12;

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
  private overlayFelt?: Phaser.GameObjects.Image;
  private leaving = false;
  /** What the control strip is showing. Reset on every visit (see `create`),
   *  so the Codex always opens on the whole collection in the usual order. */
  private sortBy: SortMode = "rarity";
  private rarityFilter: RarityFilter = "all";
  private themeFilter: ThemeFilter = "all";
  private tab: CodexTab = "cards";
  private statsPanel?: PlayerStatsPanel;
  /** Set once an entrance has handed input back. Until then a chart reveal
   *  would play under the slide that is still running. */
  private entered = false;
  private rebuildQueued = false;
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
    this.sortBy = "rarity";
    this.rarityFilter = "all";
    this.themeFilter = "all";
    this.tab = "cards";
    this.statsPanel = undefined;
    this.entered = false;
    this.rebuildQueued = false;
    this.build();
    // The cards the window can't reach wait for whichever entrance is running
    // to finish, keeping the transition's frames clear on both paths. So does
    // the Stats tab's reveal, on the visit that opens straight onto it.
    const arrived = () => {
      this.toppingUp = true;
      this.entered = true;
      this.statsPanel?.reveal();
    };
    if (this.openedAsOverlay && this.overlayFelt) {
      slideOverlayIn(this, this.overlayFelt, arrived);
    } else {
      slideSceneIn(this, this.slideBackdrop, arrived);
    }

    const off = onResizeCoalesced(this, () => this.rebuild());
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

  /** Lay the screen out again from scratch — the resize path, and the one a
   *  chip takes when the sort or a filter changes what the gallery holds. */
  private rebuild(): void {
    this.teardownInput();
    destroyAllChildren(this);
    this.gallery = undefined;
    this.statsPanel = undefined;
    this.build();
  }

  /** A rebuild asked for from inside a chip's own handler, deferred a tick: the
   *  rebuild destroys the chip, and the input plugin is still walking it when
   *  the handler returns. (The resize path is already deferred, so it calls
   *  `rebuild` directly.) */
  private queueRebuild(): void {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    this.time.delayedCall(0, () => {
      this.rebuildQueued = false;
      if (!this.leaving) this.rebuild();
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
    this.overlayFelt = felt;
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(CODEX_AMBIENCE, false);

    // Stacked, the masthead, the content and the back button share the height
    // three ways — on a short landscape viewport that leaves the cards a band
    // barely a quarter of a card tall. Folded, the masthead and the button take
    // a column of their own and the content gets the full height beside them.
    const compact = isCompactLandscape(W, H);
    const columns = compactColumns(this, { leftFraction: 0.36 });

    const header = buildSceneHeader(this, {
      title: "The Codex of Items",
      y: compact ? columns.top + 24 : Math.max(48, Math.min(H * 0.12, 92)),
      width: compact ? columns.left.width : Math.min(W, 760),
      ...(compact ? { x: columns.left.cx } : {}),
    });
    this.slideBackdrop = [felt, ambient, header.glow];

    // The tabs take the line the masthead's subtitle used to hold: what sits
    // under the title is what the screen is showing, and it is now a choice.
    const tabsBottom = this.buildTabs(
      compact ? columns.left.cx : cx,
      header.bottom + (compact ? 16 : 22),
      compact ? columns.left.width : Math.min(W - 32, 420),
    );

    // The back button is created before the (camera-clipped) content so it is
    // part of the "everything except the track" set the clip camera ignores.
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

    // The band both tabs fill: folded, the column beside the masthead; stacked,
    // everything between the tabs and the back button. Both keep a strip clear
    // at the foot for the "drag or scroll for more" line.
    const band = compact
      ? {
          x: columns.right.x,
          y: columns.top,
          width: columns.right.width,
          bottom: columns.bottom - GALLERY_HINT_H,
        }
      : (() => {
          const width = Math.min(W - 32, 1100);
          return {
            x: cx - width / 2,
            y: tabsBottom + 16,
            width,
            bottom: back.y - back.height / 2 - 24,
          };
        })();

    if (this.tab === "stats") {
      this.buildStats({
        x: band.x,
        y: band.y,
        width: band.width,
        height: Math.max(120, band.bottom - band.y),
      });
      return;
    }

    // The control strip takes the top of the band, so the chips sit directly
    // over the cards they govern.
    const controlsH = this.buildControls(band);
    const gridTop = band.y + controlsH + CONTROLS_GAP;
    const progress = loadProgress();
    this.buildGallery(
      {
        x: band.x,
        y: gridTop,
        width: band.width,
        height: Math.max(120, band.bottom - gridTop),
      },
      new Set(progress.unlocked),
      progress.selectionCounts,
    );
  }

  /** Two text tabs sharing a baseline under a gold rule. Switching rebuilds the
   *  screen rather than swapping content in place: the gallery's clip camera,
   *  its scroll handlers and its per-frame top-up are all bound to one layout,
   *  and the scene already rebuilds itself for a change of sort or filter.
   *  Returns the lowest y the strip occupies. */
  private buildTabs(cx: number, y: number, width: number): number {
    const size = Math.round(Phaser.Math.Clamp(width * 0.05, 15, 20));
    const gap = Math.min(Math.max(28, width * 0.09), width * 0.24);

    const make = (label: string, tab: CodexTab) => {
      const active = this.tab === tab;
      const text = this.add
        .text(0, y, label, {
          fontFamily: SERIF,
          fontSize: `${size}px`,
          color: active ? CSS.gold : CSS.dim,
          fontStyle: active ? "bold" : "normal",
          letterSpacing: 2,
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      text.on("pointerover", () =>
        text.setColor(active ? CSS.goldLight : CSS.parchment),
      );
      text.on("pointerout", () => text.setColor(active ? CSS.gold : CSS.dim));
      text.on("pointerdown", () => this.switchTab(tab));
      return text;
    };

    const labels = [make("CARDS", "cards"), make("STATS", "stats")];
    // Folded, the pair heads a narrow column. Share any shrinkage in proportion
    // to the labels' natural widths so neither crowds the other out.
    const room = Math.max(1, width - gap);
    const natural = labels.reduce((sum, label) => sum + label.width, 0);
    if (natural > room) {
      for (const label of labels)
        fitTextWidth(label, (room * label.width) / natural);
    }
    const total = labels.reduce((sum, label) => sum + label.width, 0) + gap;
    let cursor = cx - total / 2;
    for (const label of labels) {
      label.setX(cursor + label.width / 2);
      cursor += label.width + gap;
    }

    const active = labels[this.tab === "cards" ? 0 : 1];
    const ruleY = y + size * 0.9;
    this.add
      .rectangle(active.x, ruleY, active.width + 12, 2, COLORS.gold)
      .setOrigin(0.5)
      .setAlpha(0.75);
    return ruleY + 2;
  }

  private switchTab(tab: CodexTab): void {
    if (tab === this.tab || this.leaving) return;
    audio.click();
    this.tab = tab;
    this.queueRebuild();
  }

  /** The lifetime record, hung off a scrolling track: it is taller than any
   *  phone viewport by design, and taller than most desktop ones once three
   *  charts are stacked under the badges. */
  private buildStats(area: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): void {
    const track = this.add.container(area.x, area.y);
    const panel = buildPlayerStatsPanel(this, {
      x: 0,
      y: 0,
      width: area.width,
      height: area.height,
      stats: loadPlayerStats(),
    });
    track.add(panel.container);
    this.statsPanel = panel;
    this.clipTo(track, area);
    this.attachScroll(track, area, panel.height);
    // A tab switch has no entrance of its own to wait for.
    if (this.entered) panel.reveal();
  }

  private close(): void {
    if (this.leaving) return;
    this.leaving = true;
    if (this.openedAsOverlay && this.overlayFelt) {
      slideOverlayOut(this, this.overlayFelt, () => this.scene.stop());
    } else {
      slideSceneOut(
        this,
        () => this.scene.start(this.returnTo),
        this.slideBackdrop,
      );
    }
  }

  /**
   * The sort/filter strip over the gallery. Chips are built before they are
   * placed: each is as wide as its own widest option (see `cycleChip`), so
   * where the row has to wrap isn't known until they exist. Returns the height
   * the strip took — height the gallery doesn't get.
   */
  private buildControls(area: { x: number; y: number; width: number }): number {
    const chips: CycleChip[] = [
      cycleChip(this, 0, 0, {
        label: "Sort",
        options: SORTS.map((option) => option.label),
        index: SORTS.findIndex((option) => option.id === this.sortBy),
        maxWidth: area.width,
        onChange: (i) => {
          this.sortBy = SORTS[i].id;
          this.queueRebuild();
        },
      }),
      cycleChip(this, 0, 0, {
        label: "Rarity",
        options: RARITY_FILTERS.map((option) => option.label),
        index: RARITY_FILTERS.findIndex(
          (option) => option.id === this.rarityFilter,
        ),
        maxWidth: area.width,
        onChange: (i) => {
          this.rarityFilter = RARITY_FILTERS[i].id;
          this.queueRebuild();
        },
      }),
      cycleChip(this, 0, 0, {
        label: "Theme",
        options: THEME_FILTERS.map((option) => option.label),
        index: THEME_FILTERS.findIndex(
          (option) => option.id === this.themeFilter,
        ),
        maxWidth: area.width,
        onChange: (i) => {
          this.themeFilter = THEME_FILTERS[i].id;
          this.queueRebuild();
        },
      }),
    ];

    // Pack the chips into as many rows as the width needs — three of them fit
    // across a desktop window and wrap to two or three rows in a phone's
    // column — then centre each row over the cards.
    const rows: CycleChip[][] = [[]];
    let rowWidth = 0;
    for (const chip of chips) {
      const row = rows[rows.length - 1];
      const grown = row.length
        ? rowWidth + CHIP_GAP_X + chip.chipWidth
        : chip.chipWidth;
      if (row.length && grown > area.width) {
        rows.push([chip]);
        rowWidth = chip.chipWidth;
      } else {
        row.push(chip);
        rowWidth = grown;
      }
    }

    let y = area.y;
    for (const row of rows) {
      const width =
        row.reduce((sum, chip) => sum + chip.chipWidth, 0) +
        CHIP_GAP_X * (row.length - 1);
      const height = Math.max(...row.map((chip) => chip.height));
      let x = area.x + Math.max(0, (area.width - width) / 2);
      for (const chip of row) {
        chip.setPosition(x + chip.chipWidth / 2, y + height / 2);
        x += chip.chipWidth + CHIP_GAP_X;
      }
      y += height + CHIP_GAP_Y;
    }
    return y - area.y - CHIP_GAP_Y;
  }

  /**
   * The cards on show, in the order the strip asks for.
   *
   * A locked card gives nothing away — not its rarity, not its theme — so it
   * can only be offered while both filters are open: answering a filter on
   * knowledge the player hasn't earned would leak exactly what the card is
   * withholding. Whatever the sort, the locked ones trail the rest.
   */
  private codexItems(
    unlocked: Set<string>,
    counts: Record<string, number | undefined>,
  ): ItemDef[] {
    const isLocked = (def: ItemDef) => !!def.unlock && !unlocked.has(def.id);
    const filtering = this.rarityFilter !== "all" || this.themeFilter !== "all";
    const items = ITEMS.filter((def) => {
      if (isLocked(def)) return !filtering;
      if (this.rarityFilter !== "all" && def.rarity !== this.rarityFilter) {
        return false;
      }
      if (
        this.themeFilter !== "all" &&
        !ITEM_THEMES[def.id].includes(this.themeFilter)
      ) {
        return false;
      }
      return true;
    });
    // `sort` is stable, so a tie on every term falls back to roster order —
    // which is what the rarity sort has always shown within a tier.
    return items.sort(
      (a, b) =>
        Number(isLocked(a)) - Number(isLocked(b)) ||
        (this.sortBy === "purchases"
          ? (counts[b.id] ?? 0) - (counts[a.id] ?? 0)
          : 0) ||
        RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity],
    );
  }

  private buildGallery(
    grid: { x: number; y: number; width: number; height: number },
    unlocked: Set<string>,
    counts: Record<string, number | undefined>,
  ): void {
    const codexItems = this.codexItems(unlocked, counts);
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
    this.clipTo(track, grid);

    if (n === 0) {
      // Said in the gallery's own band rather than under the strip, so the line
      // stands where the missing cards would have been.
      const empty = this.add
        .text(
          grid.x + grid.width / 2,
          grid.y + Math.min(grid.height / 2, 80),
          "No cards of that kind.",
          {
            fontFamily: SERIF,
            fontSize: "17px",
            color: CSS.dim,
            fontStyle: "italic",
            align: "center",
            wordWrap: { width: grid.width },
          },
        )
        .setOrigin(0.5);
      this.gridCamera?.ignore(empty);
      return;
    }

    this.attachScroll(track, grid, contentH, () => this.syncCards());
  }

  /**
   * Clip a (possibly overflowing) track to `area` via a dedicated camera —
   * zoom 1, scroll = the viewport's own screen position (passthrough). The clip
   * is only needed vertically, since no content reaches past the area's own
   * width, so the viewport spans the full screen: that lets the scene slide
   * carry the content clear off the edge rather than having it wink out at the
   * area's left margin partway across.
   *
   * Everything the track holds must already be inside it: the camera filters
   * are taken from the display list as it stands here.
   */
  private clipTo(
    track: Phaser.GameObjects.Container,
    area: { y: number; height: number },
  ): void {
    const cam = this.ensureGridCamera();
    setCameraViewport(cam, 0, area.y, this.scale.width, area.height);
    cam.setScroll(0, area.y);
    cam.ignore(this.children.list.filter((obj) => obj !== track));
    this.cameras.main.ignore(track);
  }

  /**
   * Drag/wheel scrolling for a track taller than its window, with touch
   * momentum, plus the line that says so. Shared by the gallery and the stats
   * panel: both are one overflowing container inside one clipped band, and the
   * only thing that differs is whether anything has to be built as it moves.
   */
  private attachScroll(
    track: Phaser.GameObjects.Container,
    area: { x: number; y: number; width: number; height: number },
    contentH: number,
    onScroll: () => void = () => {},
  ): void {
    const overflow = Math.max(0, contentH - area.height);
    if (overflow <= 0) return;

    // Scroll by moving track.y between the top-aligned rest position and the
    // fully-scrolled-down position.
    const maxY = area.y;
    const minY = area.y - overflow;

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= area.x &&
      p.x <= area.x + area.width &&
      p.y >= area.y &&
      p.y <= area.y + area.height;

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
      onScroll();
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
      onScroll();
    };

    this.scrollTick = (delta) => {
      if (dragging || Math.abs(momentumY) < MOMENTUM_MIN_SPEED) {
        if (!dragging) momentumY = 0;
        return;
      }

      // Integrate the exponential exactly so a 30 fps flick travels the same
      // distance as a 120 fps one. Cap a single step after tab suspension so
      // returning to the game cannot jump across the track.
      const elapsed = Math.min(delta, 50);
      const decay = Math.exp(-MOMENTUM_DECAY_PER_MS * elapsed);
      const distance = (momentumY * (1 - decay)) / MOMENTUM_DECAY_PER_MS;
      const nextY = Phaser.Math.Clamp(track.y + distance, minY, maxY);
      const hitBoundary = nextY !== track.y + distance;
      track.y = nextY;
      momentumY = hitBoundary ? 0 : momentumY * decay;
      onScroll();
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.input$ = { down: onDown, move: onMove, up: onUp, wheel: onWheel };

    const hint = this.add
      .text(
        area.x + area.width / 2,
        area.y + area.height + 12,
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
    if (!def.unlock || g.unlocked.has(def.id)) {
      let pressX = 0;
      let pressY = 0;
      card.setInteractive({ useHandCursor: true });
      card.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        pressX = pointer.x;
        pressY = pointer.y;
      });
      card.on("pointerover", () => card.setScale(1.018));
      card.on("pointerout", () => card.setScale(1));
      card.on("pointerup", (pointer: Phaser.Input.Pointer) => {
        if (
          Phaser.Math.Distance.Between(pressX, pressY, pointer.x, pointer.y) >
          10
        )
          return;
        card.setScale(1);
        this.scene.launch("ItemAnalysis", {
          returnTo: "Items",
          itemId: def.id,
        });
      });
    }
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
    const cam = addCamera(this, 0, 0, 1, 1);
    cam.setBackgroundColor();
    this.gridCamera = cam;
    return cam;
  }
}
