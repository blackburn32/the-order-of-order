import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { getRun } from '../state/RunState';
import { ITEMS, ItemDef } from '../systems/Items';
import { addPanel, bannerButton } from '../ui/widgets';
import { buildItemCard } from '../ui/itemCard';
import { onResizeCoalesced } from '../ui/layout';

export interface InventoryData {
  /** Scene key whose input to re-enable when the overlay closes. */
  returnTo: string;
}

// Native card box (260x340, origin center) plus a little vertical breathing room.
// The inventory hides the card caption, so no extra caption room is needed.
const CARD_W = 260;
const CARD_H = 360;
const COL_GAP = 24;
const ROW_GAP = 24;

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (pointer: Phaser.Input.Pointer, over: unknown, dx: number, dy: number, dz: number) => void;

/**
 * A mid-run inventory: every item bought this run rendered as a card, with a
 * badge showing the copy count on items bought more than once. Launched as an
 * overlay on top of the Game or Shop (via `scene.launch`) so the base scene
 * keeps rendering, dimmed, underneath; the base scene's input is disabled while
 * we're open and restored on close.
 *
 * The card row can exceed the panel, so it lives in a `track` container clipped
 * to the grid area by a dedicated camera (native scissor clipping — the same
 * approach ItemsScene/ShopScene use) and scrolls vertically by drag/wheel.
 */
export class InventoryScene extends Phaser.Scene {
  private returnTo = 'Game';
  private gridCamera?: Phaser.Cameras.Scene2D.Camera;
  private input$?: { down: PointerHandler; move: PointerHandler; up: PointerHandler; wheel: WheelHandler };

  constructor() {
    super('Inventory');
  }

  init(data: InventoryData): void {
    this.returnTo = data?.returnTo ?? 'Game';
  }

  create(): void {
    // Block the scene underneath from reacting to taps/hovers while we're open.
    const base = this.scene.get(this.returnTo);
    if (base) base.input.enabled = false;

    this.gridCamera = undefined;
    this.build();

    const off = onResizeCoalesced(this, () => {
      this.teardownInput();
      this.children.removeAll(true);
      this.build();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardownInput();
      this.input.setDefaultCursor('default');
      const b = this.scene.get(this.returnTo);
      if (b) b.input.enabled = true;
    });
  }

  private teardownInput(): void {
    if (this.input$) {
      this.input.off('pointerdown', this.input$.down);
      this.input.off('pointermove', this.input$.move);
      this.input.off('pointerup', this.input$.up);
      this.input.off('pointerupoutside', this.input$.up);
      this.input.off('wheel', this.input$.wheel);
      this.input$ = undefined;
    }
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const panelW = Math.min(W - 40, 1000);
    const panelH = Math.min(H - 40, 620);
    const panelTop = H / 2 - panelH / 2;
    const panelBottom = H / 2 + panelH / 2;

    // Full-screen dim that swallows taps meant for the base scene.
    const dim = this.add
      .rectangle(cx, H / 2, W, H, COLORS.feltDark, 0.72)
      .setInteractive()
      .on('pointerdown', () => {});
    const panel = addPanel(this, cx, H / 2, panelW, panelH);

    const title = this.add
      .text(cx, panelTop + panelH * 0.09, 'Your Inventory', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(Math.min(panelW * 0.075, panelH * 0.07), 20, 40))}px`,
        color: CSS.ink,
        fontStyle: 'bold',
        align: 'center'
      })
      .setOrigin(0.5);

    const owned = getRun(this.registry).purchases ?? {};
    const entries = ITEMS.filter((def) => (owned[def.id] ?? 0) > 0);

    const subtitle = this.add
      .text(cx, title.y + title.height / 2 + 18, 'Every treasure you\'ve acquired this run.', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(panelW * 0.022, 13, 18))}px`,
        color: CSS.inkSoft,
        fontStyle: 'italic',
        align: 'center'
      })
      .setOrigin(0.5);

    const buttonH = 70;
    const closeY = panelBottom - 24 - buttonH / 2;
    const close = bannerButton(this, cx, closeY, 'Close', () => this.scene.stop());

    const fixed: Phaser.GameObjects.GameObject[] = [dim, panel, title, subtitle, close];

    if (entries.length === 0) {
      const empty = this.add
        .text(cx, H / 2, 'No items purchased yet.', {
          fontFamily: SERIF,
          fontSize: '22px',
          color: CSS.dim,
          fontStyle: 'italic',
          align: 'center'
        })
        .setOrigin(0.5);
      fixed.push(empty);
      return;
    }

    // Grid area sits between the subtitle and the close button, inset in the panel.
    const gridTop = subtitle.y + subtitle.height / 2 + 20;
    const gridBottom = closeY - buttonH / 2 - 16;
    const grid = {
      x: cx - panelW * 0.46,
      y: gridTop,
      width: panelW * 0.92,
      height: Math.max(120, gridBottom - gridTop)
    };

    this.buildGrid(grid, entries, owned, fixed);
  }

  private buildGrid(
    grid: { x: number; y: number; width: number; height: number },
    entries: ItemDef[],
    owned: Partial<Record<string, number>>,
    ignoredByGridCamera: Phaser.GameObjects.GameObject[]
  ): void {
    const n = entries.length;

    // Pick the column count that yields the largest (still readable) cards, then
    // scale each card to its cell. Vertical overflow becomes scroll.
    const cols = Math.max(2, Math.min(5, Math.floor(grid.width / 210)));
    const rows = Math.ceil(n / cols);
    const cellW = grid.width / cols;
    const cardScale = Math.min((cellW - COL_GAP) / CARD_W, 1);
    const cellH = CARD_H * cardScale + ROW_GAP;
    const contentH = rows * cellH;

    const track = this.add.container(grid.x, grid.y);
    entries.forEach((def, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cellW + cellW / 2;
      const y = row * cellH + cellH / 2;
      const card = buildItemCard(this, def, { locked: false, showCaption: false });
      const count = owned[def.id] ?? 0;
      if (count > 1) this.attachBadge(card, count);
      card.setScale(cardScale);
      card.setPosition(x, y);
      track.add(card);
    });

    // Clip the (possibly overflowing) track to the grid area via a dedicated
    // camera — zoom 1, scroll = the grid's own screen position (passthrough).
    const cam = this.ensureGridCamera();
    cam.setViewport(grid.x, grid.y, grid.width, grid.height);
    cam.setScroll(grid.x, grid.y);
    cam.ignore(ignoredByGridCamera);
    this.cameras.main.ignore(track);

    const overflow = Math.max(0, contentH - grid.height);
    if (overflow <= 0) return;

    // Scroll by moving track.y between the top-aligned rest position and the
    // fully-scrolled-down position.
    const maxY = grid.y;
    const minY = grid.y - overflow;

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= grid.x && p.x <= grid.x + grid.width && p.y >= grid.y && p.y <= grid.y + grid.height;

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
        this.input.setDefaultCursor(inBounds(p) ? 'grab' : 'default');
        return;
      }
      const dy = p.y - startPointerY;
      track.y = Phaser.Math.Clamp(startTrackY + dy, minY, maxY);
    };
    const onUp: PointerHandler = () => {
      dragging = false;
    };
    const onWheel: WheelHandler = (p, _over, _dx, dy) => {
      if (!inBounds(p)) return;
      track.y = Phaser.Math.Clamp(track.y - dy, minY, maxY);
    };

    this.input.on('pointerdown', onDown);
    this.input.on('pointermove', onMove);
    this.input.on('pointerup', onUp);
    this.input.on('pointerupoutside', onUp);
    this.input.on('wheel', onWheel);
    this.input$ = { down: onDown, move: onMove, up: onUp, wheel: onWheel };

    const hint = this.add
      .text(grid.x + grid.width / 2, grid.y + grid.height + 3, 'drag or scroll for more', {
        fontFamily: SERIF,
        fontSize: '13px',
        color: CSS.dim,
        fontStyle: 'italic'
      })
      .setOrigin(0.5, 0);
    this.gridCamera?.ignore(hint);
  }

  /** A gold count badge pinned to the card's top-right corner. Added as a child
   *  of the card container so it scales and scrolls with the card. */
  private attachBadge(card: Phaser.GameObjects.Container, count: number): void {
    const bx = 112; // near the card's right edge (half-width 130, origin center)
    const by = -150; // near the card's top edge (half-height 170)
    const circle = this.add.circle(bx, by, 26, COLORS.gold).setStrokeStyle(3, COLORS.ink, 0.9);
    const label = this.add
      .text(bx, by, `${count}`, {
        fontFamily: SERIF,
        fontSize: '28px',
        color: CSS.ink,
        fontStyle: 'bold'
      })
      .setOrigin(0.5);
    card.add([circle, label]);
  }

  private ensureGridCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.gridCamera) this.cameras.remove(this.gridCamera, true);
    const cam = this.cameras.add(0, 0, 1, 1);
    cam.setBackgroundColor(COLORS.parchment);
    this.gridCamera = cam;
    return cam;
  }
}
