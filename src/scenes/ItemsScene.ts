import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { getSelectionCount, loadProgress } from '../systems/SaveData';
import { ITEMS } from '../systems/Items';
import { addFelt, addPanel, bannerButton } from '../ui/widgets';
import { buildItemCard } from '../ui/itemCard';
import { onResizeCoalesced } from '../ui/layout';

// Native card box plus caption room below — used for grid spacing/scaling.
const CARD_W = 260;
const CARD_H = 420;
const COL_GAP = 24;
const ROW_GAP = 24;

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (pointer: Phaser.Input.Pointer, over: unknown, dx: number, dy: number, dz: number) => void;

/**
 * The Codex: a gallery of every shop item as a card, with a lifetime
 * "selected N times" caption. Still-locked items render greyed with "???".
 * The card row can exceed the panel, so it lives in a `track` container clipped
 * to the grid area by a dedicated camera (native scissor clipping — the same
 * approach ShopScene uses) and scrolls vertically by drag/wheel.
 */
export class ItemsScene extends Phaser.Scene {
  private gridCamera?: Phaser.Cameras.Scene2D.Camera;
  private input$?: { down: PointerHandler; move: PointerHandler; up: PointerHandler; wheel: WheelHandler };

  constructor() {
    super('Items');
  }

  create(): void {
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
    const panelW = Math.min(W - 40, 1100);
    const panelH = Math.min(H - 40, 620);
    const panelTop = H / 2 - panelH / 2;
    const panelBottom = H / 2 + panelH / 2;

    const felt = addFelt(this);
    const panel = addPanel(this, cx, H / 2, panelW, panelH);

    const title = this.add
      .text(cx, panelTop + panelH * 0.09, 'The Codex of Items', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(Math.min(panelW * 0.075, panelH * 0.07), 20, 40))}px`,
        color: CSS.ink,
        fontStyle: 'bold',
        align: 'center'
      })
      .setOrigin(0.5);

    const unlocked = new Set(loadProgress().unlocked);
    const subtitle = this.add
      .text(cx, title.y + title.height / 2 + 18, 'Browse the Order\'s accumulated knowledge of the realm\'s treasures.', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(panelW * 0.022, 13, 18))}px`,
        color: CSS.inkSoft,
        fontStyle: 'italic',
        align: 'center'
      })
      .setOrigin(0.5);

    const buttonH = 70;
    const backY = panelBottom - 24 - buttonH / 2;
    const back = bannerButton(this, cx, backY, 'Return to the Vestibule', () => this.scene.start('Menu'));

    // Grid area sits between the subtitle and the back button, inset in the panel.
    const gridTop = subtitle.y + subtitle.height / 2 + 20;
    const gridBottom = backY - buttonH / 2 - 16;
    const grid = {
      x: cx - panelW * 0.46,
      y: gridTop,
      width: panelW * 0.92,
      height: Math.max(120, gridBottom - gridTop)
    };

    this.buildGallery(grid, unlocked, [felt, panel, title, subtitle, back]);
  }

  private buildGallery(
    grid: { x: number; y: number; width: number; height: number },
    unlocked: Set<string>,
    ignoredByGridCamera: Phaser.GameObjects.GameObject[]
  ): void {
    const n = ITEMS.length;

    // Pick the column count that yields the largest (still readable) cards, then
    // scale each card to its cell. Vertical overflow becomes scroll.
    const cols = Math.max(2, Math.min(5, Math.floor(grid.width / 210)));
    const rows = Math.ceil(n / cols);
    const cellW = grid.width / cols;
    const cardScale = Math.min((cellW - COL_GAP) / CARD_W, 1);
    const cellH = CARD_H * cardScale + ROW_GAP;
    const contentH = rows * cellH;

    const track = this.add.container(grid.x, grid.y);
    ITEMS.forEach((def, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cellW + cellW / 2;
      const y = row * cellH + cellH / 2;
      const card = buildItemCard(this, def, {
        locked: !!def.unlock && !unlocked.has(def.id),
        count: getSelectionCount(def.id)
      });
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

  private ensureGridCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.gridCamera) this.cameras.remove(this.gridCamera, true);
    const cam = this.cameras.add(0, 0, 1, 1);
    cam.setBackgroundColor(COLORS.parchment);
    this.gridCamera = cam;
    return cam;
  }
}
