import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { getRun, RunState } from "../state/RunState";
import { DIE_LADDER, DieSides } from "../systems/Dice";
import { ITEMS, ItemDef } from "../systems/Items";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { addCamera } from "../ui/camera";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildItemCard } from "../ui/itemCard";
import { buildSceneHeader } from "../ui/sceneHeader";
import { formatScore } from "../ui/formatScore";
import {
  compactColumns,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
import { addFelt, bannerButton, fitTextWidth } from "../ui/widgets";

export interface InventoryData {
  /** Scene key whose input to re-enable when the overlay closes. */
  returnTo: string;
}

type InventoryTab = "items" | "dice";
type InventoryNavTab = InventoryTab | "codex";

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (
  pointer: Phaser.Input.Pointer,
  over: unknown,
  dx: number,
  dy: number,
  dz: number,
) => void;

// Containers carry AlphaSingle while images and text carry Alpha, so the
// shared shape is spelt out rather than picking one of the two components.
type SlideObject = Phaser.GameObjects.GameObject &
  Phaser.GameObjects.Components.Transform & { alpha: number };

interface ContentArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fixed sigil brightness for the backdrop — the inventory is read between
 *  rolls rather than during one, so the value is chosen purely for how it
 *  looks (see MenuScene). */
const INVENTORY_AMBIENCE = 0.5;

// Native card box with the caption dropped (the inventory prints its copy
// tally on the card's face), used for grid spacing and for scaling a card to
// its cell.
const CARD_W = 260;
const CARD_H = 340;
const COL_GAP = 12;
const ROW_GAP = 22;
/** Drop a column rather than shrink cards past the point they can be read. */
const MIN_READABLE_CARD_SCALE = 0.5;

/** Zebra banding for the dice rows, matching the Hall's table: faint enough to
 *  read as ruling on the felt rather than as plates laid on it. */
const BAND_ALPHA = 0.26;
/** Room above the first dice row for its column heads and their hairline. */
const HEAD_H = 34;

/** Matches sceneSlide's entrance, so the overlay arrives at the same pace as a
 *  scene change; the backdrop fades up underneath it. */
const SLIDE_MS = 360;
const BACKDROP_FADE_MS = 240;
/** Each row/card trails the one before it as the list settles in. */
const ENTRY_STAGGER_MS = 42;
const ENTRY_STAGGER_CAP_MS = 420;
const ENTRY_MS = 260;
/** How far a row/card starts to the right of its resting place. */
const ENTRY_OFFSET = 20;
/** The outgoing half of a tab change. */
const TAB_SWAP_MS = 140;

/** Strip kept clear under a scrolling list for its "drag or scroll" line. */
const HINT_H = 22;

/** Rarity order for the item shelf — the rarest treasures first, so a
 *  collection leads with what it is proudest of. The Codex, which is a
 *  reference rather than a hoard, deliberately sorts the other way. */
const RARITY_ORDER = { rare: 0, uncommon: 1, common: 2 } as const;

/** One badge on a dice row: a die size's persistent auras and windfall
 *  multipliers, in the colour that tells them apart at a glance. */
interface ChipSpec {
  label: string;
  color: number;
  css: string;
}

interface DiceRow {
  sides: DieSides;
  count: number;
  chips: ChipSpec[];
}

/**
 * A mid-run inventory: the items bought this run as a shelf of cards, and the
 * grid's dice as a ranked list — one line per die size, with its picture, its
 * count, and the auras riding on it.
 *
 * Launched as an overlay on top of the Game or Shop (via `scene.launch`) so the
 * base scene keeps running underneath; its input is disabled while we are open
 * and restored on close. The overlay lays its own felt and sigil rather than
 * dimming what is beneath, so it reads as the same room the trial screens use
 * — masthead, felt, turning sigil — with the contents set straight on the table
 * instead of on a parchment panel.
 *
 * Either tab can exceed its band, so its content lives in a `track` container
 * clipped to that band by a dedicated camera (native scissor clipping — the
 * same approach the Codex and the Hall use) and scrolls by drag/wheel.
 */
export class InventoryScene extends Phaser.Scene {
  private returnTo = "Game";
  private tab: InventoryTab = "items";
  private gridCamera?: Phaser.Cameras.Scene2D.Camera;
  /** The felt and the sigil — the room the inventory is laid out in. Held
   *  still (and faded, not slid) while the interface moves across it. */
  private backdrop: SlideObject[] = [];
  /** Everything the current tab built, torn down and replaced on a tab change
   *  while the chrome around it stays put. */
  private contentObjects: Phaser.GameObjects.GameObject[] = [];
  private contentArea: ContentArea = { x: 0, y: 0, width: 0, height: 0 };
  /** How much of the band the current tab's content actually covers. The item
   *  shelf fills it; the dice list is a centred block, and its scrollbar wants
   *  to sit beside the rows rather than out at the band's far margin. */
  private contentSpan = 0;
  private tabItems: {
    tab: InventoryNavTab;
    text: Phaser.GameObjects.Text;
  }[] = [];
  private tabUnderline?: Phaser.GameObjects.Rectangle;
  private swapping = false;
  private leaving = false;
  private input$?: {
    down: PointerHandler;
    move: PointerHandler;
    up: PointerHandler;
    wheel: WheelHandler;
  };

  constructor() {
    super("Inventory");
  }

  init(data: InventoryData): void {
    this.returnTo = data?.returnTo ?? "Game";
    this.tab = "items";
  }

  create(): void {
    // Block the scene underneath from reacting to taps/hovers while we're open.
    const base = this.scene.get(this.returnTo);
    if (base) base.input.enabled = false;

    this.gridCamera = undefined;
    this.swapping = false;
    this.leaving = false;
    this.build();
    this.enter();

    const off = onResizeCoalesced(this, () => this.rebuild());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardownScroll();
      this.input.setDefaultCursor("default");
      const b = this.scene.get(this.returnTo);
      if (b) b.input.enabled = true;
    });
  }

  private rebuild(): void {
    // A tab swap in flight owns objects this is about to destroy, and its
    // completion would build a second copy of the content into the rebuilt
    // scene. Killing the tweens drops that callback with them.
    this.tweens.killAll();
    this.teardownScroll();
    destroyAllChildren(this);
    this.contentObjects = [];
    this.tabItems = [];
    this.tabUnderline = undefined;
    this.swapping = false;
    this.build();
  }

  private teardownScroll(): void {
    this.teardownScrollInput();
    this.removeGridCamera();
  }

  private teardownScrollInput(): void {
    if (!this.input$) return;
    this.input.off("pointerdown", this.input$.down);
    this.input.off("pointermove", this.input$.move);
    this.input.off("pointerup", this.input$.up);
    this.input.off("pointerupoutside", this.input$.up);
    this.input.off("wheel", this.input$.wheel);
    this.input$ = undefined;
  }

  private removeGridCamera(): void {
    if (!this.gridCamera) return;
    this.cameras.remove(this.gridCamera, true);
    this.gridCamera = undefined;
  }

  // --- Chrome ---------------------------------------------------------------

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(INVENTORY_AMBIENCE, false);
    this.backdrop = [felt, ambient];

    // Stacked, the masthead, the tabs, the contents and the two footer buttons
    // share the height four ways — on a short landscape viewport that leaves
    // the contents a band shorter than half a card. Folded, the chrome takes a
    // column of its own and the contents get the full height beside it: the
    // same fold the Codex makes of the same gallery, on the one
    // `isCompactLandscape` gate, so a device that turns folds both at once.
    const compact = isCompactLandscape(W, H);
    const columns = compactColumns(this, { leftFraction: 0.36 });

    const header = buildSceneHeader(this, {
      title: "Your Inventory",
      subtitle: "Everything you carry into the trials.",
      y: compact ? columns.top + 24 : Math.max(46, Math.min(H * 0.12, 88)),
      width: compact ? columns.left.width : Math.min(W, 760),
      ...(compact ? { x: columns.left.cx } : {}),
    });

    // The tabs head the contents when stacked, and the chrome column when
    // folded — either way they are as wide as whatever they head.
    const tableW = compact ? columns.left.width : Math.min(W - 32, 1000);
    const tabsY = header.bottom + (compact ? 20 : 26);
    this.buildTabs(compact ? columns.left.cx : cx, tabsY, tableW);

    // The footer is created before the (camera-clipped) content so it is part
    // of the "everything except the track" set the grid camera ignores.
    let contentTop: number;
    let contentBottom: number;
    if (compact) {
      // Folded there is no full-width strip along the bottom, so Close stays
      // under the tabs in the chrome column — beside the contents rather than
      // below them however far they scroll.
      const bandTop = tabsY + 34;
      const bandH = columns.bottom - bandTop;
      bannerButton(
        this,
        columns.left.cx,
        bandTop + bandH / 2,
        "Close",
        () => this.close(),
        columns.left.width,
        bandH,
      );
      contentTop = columns.top;
      contentBottom = columns.bottom;
    } else {
      const buttonH = 70;
      const buttonY = H - 20 - buttonH / 2;
      bannerButton(
        this,
        cx,
        buttonY,
        "Close",
        () => this.close(),
        Math.min(tableW, 340),
      );
      contentTop = tabsY + 32;
      contentBottom = buttonY - buttonH / 2 - 18;
    }

    this.contentArea = {
      x: compact ? columns.right.x : cx - tableW / 2,
      y: contentTop,
      width: compact ? columns.right.width : tableW,
      height: Math.max(120, contentBottom - contentTop),
    };
    this.buildContent();
  }

  /** Three text tabs sharing a baseline under a sliding gold rule. Codex opens
   *  the existing gallery overlay, while Items and Dice swap this scene's
   *  content in place. */
  private buildTabs(cx: number, y: number, tableW: number): void {
    const size = Math.round(Phaser.Math.Clamp(tableW * 0.026, 16, 21));
    // The gap closes up as the column narrows: at the folded width the 30px
    // floor was a third of the room the labels themselves needed.
    const gap = Math.min(Math.max(30, tableW * 0.05), tableW * 0.12);

    const make = (label: string, tab: InventoryNavTab) => {
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
        text.setColor(this.tab === tab ? CSS.goldLight : CSS.parchment),
      );
      text.on("pointerout", () =>
        text.setColor(this.tab === tab ? CSS.gold : CSS.dim),
      );
      text.on("pointerdown", () => this.switchTab(tab));
      return text;
    };

    const items = make("ITEMS", "items");
    const dice = make("DICE", "dice");
    const codex = make("CODEX", "codex");

    // Folded, the trio heads a narrow column. Share any required shrinkage in
    // proportion to the labels' natural widths so none crowds out a neighbour.
    const labels = [items, dice, codex];
    const room = Math.max(1, tableW - gap * (labels.length - 1));
    const naturalW = labels.reduce((sum, label) => sum + label.width, 0);
    if (naturalW > room) {
      for (const label of labels) {
        fitTextWidth(label, (room * label.width) / naturalW);
      }
    }

    const totalW =
      labels.reduce((sum, label) => sum + label.width, 0) +
      gap * (labels.length - 1);
    let cursor = cx - totalW / 2;
    for (const label of labels) {
      label.setX(cursor + label.width / 2);
      cursor += label.width + gap;
    }
    this.tabItems = [
      { tab: "items", text: items },
      { tab: "dice", text: dice },
      { tab: "codex", text: codex },
    ];

    // One rule that travels between the tabs rather than a fresh line drawn on
    // each switch, so the underline tracks the change instead of teleporting
    // with the content.
    const active = this.tab === "items" ? items : dice;
    this.tabUnderline = this.add
      .rectangle(active.x, y + size * 0.9, active.width + 12, 2, COLORS.gold)
      .setOrigin(0.5)
      .setAlpha(0.75);
  }

  private switchTab(tab: InventoryNavTab): void {
    if (tab === this.tab || this.swapping || this.leaving) return;
    audio.click();
    if (tab === "codex") {
      this.scene.launch("Items", { returnTo: "Inventory" });
      return;
    }
    this.tab = tab;

    for (const entry of this.tabItems) {
      const active = entry.tab === tab;
      entry.text
        .setColor(active ? CSS.gold : CSS.dim)
        .setFontStyle(active ? "bold" : "normal");
    }
    const activeText = this.tabItems.find((e) => e.tab === tab)?.text;
    const underline = this.tabUnderline;
    if (activeText && underline) {
      // The rule keeps its native width and rides scaleX across, so the two
      // tabs' differing widths don't need a redraw.
      const scaleX = (activeText.width + 12) / underline.width;
      if (fx.motion) {
        this.tweens.add({
          targets: underline,
          x: activeText.x,
          scaleX,
          duration: 200,
          ease: "Cubic.easeOut",
        });
      } else {
        underline.setX(activeText.x).setScale(scaleX, 1);
      }
    }

    this.swapContent();
  }

  /** Send the outgoing tab's content off to the left, then build the incoming
   *  one — which brings itself in from the right, a row at a time. */
  private swapContent(): void {
    const outgoing = this.contentObjects;
    this.contentObjects = [];
    // Only the handlers go now. The clip camera is the one thing drawing an
    // overflowing track, so pulling it here would make the outgoing content
    // vanish instead of leaving.
    this.teardownScrollInput();

    const finish = () => {
      this.removeGridCamera();
      outgoing.forEach((obj) => obj.destroy());
      this.buildContent();
      this.swapping = false;
    };

    const targets = outgoing.filter(
      (obj): obj is SlideObject => "x" in obj && "alpha" in obj,
    );
    if (!fx.motion || targets.length === 0) {
      finish();
      return;
    }
    this.swapping = true;
    this.tweens.add({
      targets,
      alpha: 0,
      x: `-=${ENTRY_OFFSET * 2}`,
      duration: TAB_SWAP_MS,
      ease: "Quad.easeIn",
      onComplete: finish,
    });
  }

  /** The interface leaves to the right and the room fades out behind it,
   *  handing the screen back to the scene that was running underneath. */
  private close(): void {
    if (this.leaving) return;
    this.leaving = true;
    if (!fx.motion) {
      this.scene.stop();
      return;
    }
    this.input.enabled = false;
    const distance = this.scale.width;
    const targets = this.interfaceTargets();
    if (targets.length > 0) {
      this.tweens.add({
        targets,
        x: `+=${distance}`,
        duration: SLIDE_MS,
        ease: "Cubic.easeIn",
      });
    }
    this.tweens.add({
      targets: this.backdrop,
      alpha: 0,
      duration: BACKDROP_FADE_MS,
      delay: SLIDE_MS - BACKDROP_FADE_MS,
      ease: "Quad.easeIn",
      onComplete: () => this.scene.stop(),
    });
  }

  /** The interface comes in from the left the way a scene change does, while
   *  the felt and the sigil fade up beneath it — the room arriving around the
   *  contents rather than sliding in with them. */
  private enter(): void {
    if (!fx.motion) return;

    for (const object of this.backdrop) object.alpha = 0;
    this.tweens.add({
      targets: this.backdrop,
      alpha: 1,
      duration: BACKDROP_FADE_MS,
      ease: "Quad.easeOut",
    });

    const targets = this.interfaceTargets();
    if (targets.length === 0) return;
    const distance = this.scale.width;
    for (const target of targets) target.x -= distance;
    this.input.enabled = false;
    this.tweens.add({
      targets,
      x: `+=${distance}`,
      duration: SLIDE_MS,
      ease: "Cubic.easeOut",
      onComplete: () => {
        if (!this.leaving) this.input.enabled = true;
      },
    });
  }

  /** Every top-level object that isn't part of the room: the interface the
   *  entrance and the exit carry across the screen. */
  private interfaceTargets(): SlideObject[] {
    const backdrop = new Set<Phaser.GameObjects.GameObject>(this.backdrop);
    return this.children.list.filter(
      (obj): obj is SlideObject => !backdrop.has(obj) && "x" in obj,
    );
  }

  // --- Content --------------------------------------------------------------

  private buildContent(): void {
    const area = this.contentArea;
    const run = getRun(this.registry);
    const track = this.add.container(area.x, area.y);
    this.contentObjects.push(track);
    this.contentSpan = area.width;

    const contentH =
      this.tab === "dice"
        ? this.buildDiceList(track, area, run)
        : this.buildItemShelf(track, area, run);

    if (contentH <= area.height) {
      // Nothing to scroll: centre a short list in the band it was given rather
      // than leaving it hanging off the tabs with all the slack below it.
      track.y = area.y + (area.height - contentH) / 2;
      return;
    }
    this.enableScroll(track, area, contentH);
  }

  /** Fade a freshly built row or card in from the right, trailing the ones
   *  before it. Returns the object so builders can go on placing it. */
  private stagger<T extends SlideObject>(object: T, index: number): T {
    if (!fx.motion) return object;
    const restX = object.x;
    object.alpha = 0;
    object.x = restX + ENTRY_OFFSET;
    this.tweens.add({
      targets: object,
      x: restX,
      alpha: 1,
      duration: ENTRY_MS,
      delay: Math.min(index * ENTRY_STAGGER_MS, ENTRY_STAGGER_CAP_MS),
      ease: "Cubic.easeOut",
    });
    return object;
  }

  private emptyMessage(
    track: Phaser.GameObjects.Container,
    area: ContentArea,
    message: string,
  ): number {
    const text = this.add
      .text(area.width / 2, Math.min(area.height * 0.38, 130), message, {
        fontFamily: SERIF,
        fontSize: "20px",
        color: CSS.dim,
        fontStyle: "italic",
        align: "center",
        wordWrap: { width: area.width - 40 },
      })
      .setOrigin(0.5);
    track.add(this.stagger(text, 0));
    return area.height;
  }

  // --- Items ----------------------------------------------------------------

  private ownedItems(run: RunState): ItemDef[] {
    const owned = run.purchases ?? {};
    return ITEMS.filter((def) => (owned[def.id] ?? 0) > 0).sort(
      (a, b) =>
        RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity] ||
        a.name.localeCompare(b.name),
    );
  }

  private buildItemShelf(
    track: Phaser.GameObjects.Container,
    area: ContentArea,
    run: RunState,
  ): number {
    const entries = this.ownedItems(run);
    if (entries.length === 0) {
      return this.emptyMessage(
        track,
        area,
        "Nothing acquired yet.\nThe shop between trials is where a collection starts.",
      );
    }

    const owned = run.purchases ?? {};
    const minCellW = CARD_W * MIN_READABLE_CARD_SCALE + COL_GAP;
    const cols = Math.max(
      1,
      Math.min(5, entries.length, Math.floor(area.width / minCellW)),
    );
    const rows = Math.ceil(entries.length / cols);
    const cellW = area.width / cols;
    const cardScale = Math.min((cellW - COL_GAP) / CARD_W, 1);
    const cellH = CARD_H * cardScale + ROW_GAP;

    entries.forEach((def, i) => {
      // Rendering at the final size, rather than scaling a full-size card down,
      // keeps the type crisp — see the Codex's gallery.
      const card = buildItemCard(this, def, {
        locked: false,
        showCaption: false,
        displayScale: cardScale,
        copies: owned[def.id] ?? 0,
      });
      const row = Math.floor(i / cols);
      // A short last row stays left-aligned with the columns above it rather
      // than centring itself and breaking the shelf's left edge.
      card.setPosition((i % cols) * cellW + cellW / 2, row * cellH + cellH / 2);
      track.add(this.stagger(card, i));
    });

    return rows * cellH;
  }

  // --- Dice -----------------------------------------------------------------

  /** One line per die size, largest first, with the auras riding on that size
   *  collected into badges. Sizes are read through `groups()`, which is O(dice
   *  buckets) — a grid of millions still resolves to a handful of lines. */
  private diceRows(run: RunState): DiceRow[] {
    interface Tally {
      count: number;
      loaded: number;
      wild: number;
      /** Windfall multiplier -> how many dice of this size carry it. */
      maxFace: Map<number, number>;
    }
    const bySides = new Map<number, Tally>();
    for (const group of run.dice.groups()) {
      let tally = bySides.get(group.die.sides);
      if (!tally) {
        tally = { count: 0, loaded: 0, wild: 0, maxFace: new Map() };
        bySides.set(group.die.sides, tally);
      }
      tally.count += group.count;
      if (group.die.loaded) tally.loaded += group.count;
      if (group.die.wildFace) tally.wild += group.count;
      if (group.die.maxFaceBonus > 0) {
        const factor = group.die.maxFaceBonus;
        tally.maxFace.set(
          factor,
          (tally.maxFace.get(factor) ?? 0) + group.count,
        );
      }
    }

    return [...DIE_LADDER]
      .sort((a, b) => b - a)
      .filter((sides) => bySides.has(sides))
      .map((sides) => {
        const tally = bySides.get(sides)!;
        // An aura bought as a size aura covers every die of that size, while a
        // windfall die arrives one at a time. Naming the share only when it is
        // a share keeps the common "all of them" case uncluttered.
        const share = (n: number) =>
          n < tally.count ? ` (${formatScore(n)})` : "";
        const chips: ChipSpec[] = [];
        for (const factor of [...tally.maxFace.keys()].sort((a, b) => b - a)) {
          chips.push({
            label: `×${factor} ON MAX${share(tally.maxFace.get(factor)!)}`,
            color: COLORS.goldLight,
            css: CSS.goldLight,
          });
        }
        if (tally.wild > 0) {
          chips.push({
            label: `WILD FACE${share(tally.wild)}`,
            color: COLORS.rarityRare,
            css: CSS.rarityRare,
          });
        }
        if (run.royalSealSizes.includes(sides)) {
          chips.push({
            label: "ROYAL SEAL",
            color: COLORS.rarityUncommon,
            css: CSS.rarityUncommon,
          });
        }
        if (tally.loaded > 0) {
          chips.push({
            label: `LOADED${share(tally.loaded)}`,
            color: COLORS.glowSteel,
            css: CSS.steel,
          });
        }
        return { sides, count: tally.count, chips };
      });
  }

  private buildDiceList(
    track: Phaser.GameObjects.Container,
    area: ContentArea,
    run: RunState,
  ): number {
    const rows = this.diceRows(run);
    if (rows.length === 0) {
      return this.emptyMessage(track, area, "No dice in the grid.");
    }

    const rowH = Phaser.Math.Clamp(
      (area.height - HEAD_H) / rows.length,
      40,
      64,
    );
    const iconSize = Math.min(rowH * 0.78, 46);
    const nameSize = Math.round(Phaser.Math.Clamp(rowH * 0.34, 15, 23));
    const chipSize = Math.round(Phaser.Math.Clamp(rowH * 0.21, 10, 13));
    const headSize = Math.round(Phaser.Math.Clamp(area.width * 0.024, 10, 14));
    const pad = Math.max(8, area.width * 0.015);
    const gap = Math.max(14, area.width * 0.028);

    // Both text columns are built at x = 0 and placed only once all of them
    // have been measured, so the size, the count, and the badges cannot collide
    // whatever the font size or the digit count.
    const names = rows.map((row) =>
      this.add
        .text(0, 0, `d${row.sides}`, {
          fontFamily: SERIF,
          fontSize: `${nameSize}px`,
          color: CSS.gold,
          fontStyle: "bold",
        })
        .setOrigin(0, 0.5),
    );
    const counts = rows.map((row) =>
      this.add
        .text(0, 0, `×${formatScore(row.count)}`, {
          fontFamily: SERIF,
          fontSize: `${nameSize}px`,
          color: CSS.parchment,
        })
        .setOrigin(1, 0.5),
    );
    // The heads are built alongside the rows and measured with them, because a
    // column has to be at least as wide as its own heading: "DIE" is wider than
    // `d6` and "COUNT" than `×1`, so a grid holding one small die laid its
    // columns out narrower than the words above them and ran the two together.
    const head = (label: string, originX: number) =>
      this.add
        .text(0, HEAD_H / 2 - 6, label, {
          fontFamily: SERIF,
          fontSize: `${headSize}px`,
          color: CSS.dim,
          letterSpacing: 2,
        })
        .setOrigin(originX, 0.5);
    const heads = [head("DIE", 0), head("COUNT", 1), head("MODIFIERS", 0)];

    const nameW = Math.max(heads[0].width, ...names.map((t) => t.width));
    const countW = Math.max(heads[1].width, ...counts.map((t) => t.width));

    const badges = rows.map((row) => this.buildChips(row.chips, chipSize));

    // The list is laid out at the width it actually occupies and then centred,
    // rather than stretched across the whole band: a handful of short lines
    // ruled edge to edge reads as a table with its right half missing.
    const leftW = iconSize + 14 + nameW + gap + countW;
    const badgeW = Math.max(heads[2].width, ...badges.map((b) => b.width));
    const roomForBadges = Math.max(48, area.width - pad * 2 - leftW - gap);
    const chipsColW = Math.min(badgeW, roomForBadges);
    const blockW = Math.min(area.width, pad * 2 + leftW + gap + chipsColW);
    const blockLeft = (area.width - blockW) / 2;

    const iconX = blockLeft + pad + iconSize / 2;
    const nameX = blockLeft + pad + iconSize + 14;
    const countRight = nameX + nameW + gap + countW;
    const chipsX = countRight + gap;
    // Banding and the head's rule run a little past the ink on either side, the
    // way ruling on a page does.
    const bandW = Math.min(area.width, blockW + 28);
    this.contentSpan = bandW;

    heads[0].setX(nameX);
    heads[1].setX(countRight);
    heads[2].setX(chipsX);
    // Only the modifiers head can still outrun its column — the band may be too
    // narrow to give the badges the room the word wants.
    fitTextWidth(heads[2], chipsColW);
    // A hairline under the column heads — the one piece of ruling the list
    // needs to separate its head from its body.
    const rule = this.add.graphics();
    rule.lineStyle(1, COLORS.gold, 0.35);
    rule.lineBetween(
      area.width / 2 - bandW / 2,
      HEAD_H - 10,
      area.width / 2 + bandW / 2,
      HEAD_H - 10,
    );
    track.add([...heads, rule]);

    rows.forEach((row, i) => {
      const container = this.add.container(0, HEAD_H + i * rowH + rowH / 2);
      if (i % 2 === 1) {
        container.add(
          this.add.rectangle(
            area.width / 2,
            0,
            bandW,
            rowH,
            COLORS.feltLight,
            BAND_ALPHA,
          ),
        );
      }

      // The die body alone, with neither a face nor its baked type label: a row
      // is a size held in the grid rather than a die mid-roll, and at this size
      // the baked label is illegible beside the one the row already carries.
      // Sized rather than scaled: the die body is baked above layout
      // resolution, and a display size is the one form that normalises itself.
      container.add(
        this.add
          .image(iconX, 0, `die-${row.sides}`)
          .setDisplaySize(iconSize, iconSize),
      );

      container.add(names[i].setPosition(nameX, 0));
      container.add(counts[i].setPosition(countRight, 0));
      const badge = badges[i];
      badge.container.setX(chipsX);
      if (badge.width > chipsColW) {
        badge.container.setScale(chipsColW / badge.width);
      }
      container.add(badge.container);

      track.add(this.stagger(container, i));
    });

    return HEAD_H + rows.length * rowH;
  }

  /** The badges at the right of a dice row, laid left to right from x = 0 and
   *  reported with the width they came to — the caller places the column and
   *  shrinks the row as a unit when its own width ran out. */
  private buildChips(
    chips: ChipSpec[],
    fontSize: number,
  ): { container: Phaser.GameObjects.Container; width: number } {
    const row = this.add.container(0, 0);
    if (chips.length === 0) {
      const dash = this.add
        .text(0, 0, "—", {
          fontFamily: SERIF,
          fontSize: `${fontSize + 2}px`,
          color: CSS.dim,
        })
        .setOrigin(0, 0.5);
      row.add(dash);
      return { container: row, width: dash.width };
    }

    const padX = Math.max(6, fontSize * 0.7);
    const height = fontSize + 12;
    const gap = 7;
    let cursor = 0;
    for (const chip of chips) {
      const label = this.add
        .text(0, 0, chip.label, {
          fontFamily: SERIF,
          fontSize: `${fontSize}px`,
          color: chip.css,
          fontStyle: "bold",
          letterSpacing: 1,
        })
        .setOrigin(0.5);
      const width = label.width + padX * 2;
      const plate = this.add.graphics();
      plate.fillStyle(chip.color, 0.12);
      plate.fillRoundedRect(cursor, -height / 2, width, height, height / 2);
      plate.lineStyle(1, chip.color, 0.55);
      plate.strokeRoundedRect(cursor, -height / 2, width, height, height / 2);
      label.setPosition(cursor + width / 2, 0);
      row.add([plate, label]);
      cursor += width + gap;
    }

    return { container: row, width: Math.max(1, cursor - gap) };
  }

  // --- Scrolling ------------------------------------------------------------

  /** Clip `track` to the content band with a dedicated camera and wire vertical
   *  drag / wheel, plus a display-only scrollbar. */
  private enableScroll(
    track: Phaser.GameObjects.Container,
    area: ContentArea,
    contentH: number,
  ): void {
    const height = area.height - HINT_H;
    const overflow = Math.max(1, contentH - height);

    // The clip is only needed vertically — nothing reaches past the band's own
    // width — so the camera spans the full screen. That lets the entrance and
    // the tab swap carry the content clear off the edge rather than having it
    // wink out at the band's margin partway across.
    const cam = addCamera(this, 0, area.y, this.scale.width, height);
    cam.setScroll(0, area.y);
    this.gridCamera = cam;
    cam.ignore(this.children.list.filter((obj) => obj !== track));
    this.cameras.main.ignore(track);

    // Scroll by moving track.y between the top-aligned rest position and the
    // fully-scrolled-down position.
    const maxY = area.y;
    const minY = area.y - overflow;

    const barX = Math.min(
      area.x + (area.width + this.contentSpan) / 2 + 14,
      this.scale.width - 8,
    );
    const barTrack = this.add.rectangle(
      barX,
      area.y + height / 2,
      4,
      height,
      COLORS.parchment,
      0.14,
    );
    const thumbH = Math.max(30, (height * height) / contentH);
    const thumb = this.add.rectangle(
      barX,
      area.y + thumbH / 2,
      4,
      thumbH,
      COLORS.gold,
      0.8,
    );
    const updateThumb = () => {
      const progress = (maxY - track.y) / (maxY - minY);
      thumb.y = area.y + thumbH / 2 + progress * (height - thumbH);
    };

    const hint = this.add
      .text(
        area.x + area.width / 2,
        area.y + height + 4,
        "drag or scroll for more",
        {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.dim,
          fontStyle: "italic",
        },
      )
      .setOrigin(0.5, 0);
    // The bar and the hint frame the band rather than living inside it, so the
    // clip camera leaves them to the main one.
    cam.ignore([barTrack, thumb, hint]);
    this.contentObjects.push(barTrack, thumb, hint);

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= area.x &&
      p.x <= area.x + area.width &&
      p.y >= area.y &&
      p.y <= area.y + height;

    let dragging = false;
    let startPointerY = 0;
    let startTrackY = 0;

    const onDown: PointerHandler = (p) => {
      if (!inBounds(p)) return;
      dragging = true;
      startPointerY = p.y;
      startTrackY = track.y;
    };
    const onMove: PointerHandler = (p) => {
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? "grab" : "default");
        return;
      }
      track.y = Phaser.Math.Clamp(
        startTrackY + (p.y - startPointerY),
        minY,
        maxY,
      );
      updateThumb();
    };
    const onUp: PointerHandler = () => {
      dragging = false;
    };
    const onWheel: WheelHandler = (p, _over, _dx, dy) => {
      if (!inBounds(p)) return;
      track.y = Phaser.Math.Clamp(track.y - dy, minY, maxY);
      updateThumb();
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.input$ = { down: onDown, move: onMove, up: onUp, wheel: onWheel };
  }
}
