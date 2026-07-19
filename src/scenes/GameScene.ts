import Phaser from 'phaser';
import { ROLLS_PER_ROUND, SHOP_ROLLS, roundTarget } from '../config';
import { COLORS, CSS, SERIF } from '../art/palette';
import { getRun, RunState } from '../state/RunState';
import { rollAll } from '../systems/Dice';
import { scoreRoll } from '../systems/Scoring';
import { audio } from '../systems/Audio';
import { saveHallEntry } from '../systems/SaveData';
import { DieSprite } from '../ui/DieSprite';
import { addFelt, floatText, showBanner } from '../ui/widgets';
import { isPortrait, onResizeCoalesced } from '../ui/layout';
import { computeGridPositions, GridArea } from '../ui/gridLayout';
import { clampZoom, computeWindowedView, Viewport, WINDOW_THRESHOLD } from '../ui/windowedGrid';

const HUD_LABELS = ['ROUND', 'ROLL', 'SCORE', 'TARGET'] as const;
const SEAL_RADIUS = 85; // half of the 170x170 seal texture

interface HudCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  hud: HudCell[];
  footer: { numbersY: number; settingsY: number; centered: boolean };
  grid: GridArea;
  button: { x: number; y: number };
}

export class GameScene extends Phaser.Scene {
  private state!: RunState;
  // Keyed by index into state.dice — below WINDOW_THRESHOLD every index has a
  // sprite; above it, only the dice currently inside the scroll/zoom
  // viewport do, so rendering cost stays bounded no matter how large the
  // grid grows. See src/ui/windowedGrid.ts.
  private sprites!: Map<number, DieSprite>;
  private gridContainer!: Phaser.GameObjects.Container;
  // Only created once the grid goes windowed: a second camera whose viewport
  // is clipped to the grid area (native scissor clipping) and whose own
  // scroll/zoom drives pan/zoom, instead of a GameObject mask — Phaser 4's
  // WebGL renderer doesn't reliably support masking a container this deep.
  private gridCamera?: Phaser.Cameras.Scene2D.Camera;
  private windowed = false;
  private viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
  private layout!: Layout;
  // Everything that ISN'T a die sprite (felt, HUD, roll button): cheap to
  // destroy and rebuild wholesale on resize, unlike the (potentially huge)
  // dice grid, which is repositioned in place instead — see handleResize().
  private chrome!: Phaser.GameObjects.Container;
  private rolling = false;
  private tumbling = false;
  private tumbleEvent?: Phaser.Time.TimerEvent;
  private settleTimer?: Phaser.Time.TimerEvent;
  private pendingAdvance?: Phaser.Time.TimerEvent;
  private hudRound!: Phaser.GameObjects.Text;
  private hudRoll!: Phaser.GameObjects.Text;
  private hudScore!: Phaser.GameObjects.Text;
  private hudTarget!: Phaser.GameObjects.Text;
  private hudNumbers!: Phaser.GameObjects.Text;
  private sealImage!: Phaser.GameObjects.Image;

  constructor() {
    super('Game');
  }

  create(): void {
    this.state = getRun(this.registry);
    this.rolling = false;
    this.tumbling = false;
    this.tumbleEvent = undefined;
    this.settleTimer = undefined;
    this.pendingAdvance = undefined;
    this.sprites = new Map();
    this.viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
    // The scene instance is reused across restarts, but Phaser destroys all
    // non-main cameras on shutdown — this field would otherwise dangle.
    this.gridCamera = undefined;
    this.gridContainer = this.add.container(0, 0);

    this.build();

    if (this.windowed) {
      // Start centered on the grid rather than its top-left corner.
      const view = computeWindowedView(this.state.dice.length, this.layout.grid, this.viewport);
      this.viewport.scrollX = (view.virtualW - this.layout.grid.width) / 2;
      this.viewport.scrollY = (view.virtualH - this.layout.grid.height) / 2;
      this.syncGrid(this.layout);
    }

    const offResize = onResizeCoalesced(this, () => this.handleResize());
    const offInput = this.windowed ? this.wireGridInput() : undefined;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      offResize();
      offInput?.();
    });
  }

  /** A resize mid-tumble would leave the flicker loop pointing at stale
   *  sprites, and would silently drop that roll's score — so resolve it
   *  first. The dice grid itself is never destroyed here — only the felt/HUD
   *  "chrome" is rebuilt; sprites are just repositioned (or, above
   *  WINDOW_THRESHOLD, re-windowed) to the new layout, since `state.dice`
   *  never changes shape mid-session. */
  private handleResize(): void {
    if (this.tumbling) {
      this.tumbleEvent?.remove();
      this.settleTimer?.remove();
      this.settleRoll(0, false);
    }

    const layout = this.computeLayout();
    this.buildChrome(layout);
    this.syncGrid(layout);
  }

  private build(): void {
    const layout = this.computeLayout();
    this.buildChrome(layout);
    this.syncGrid(layout);
  }

  // ---- layout ----------------------------------------------------------------

  private computeLayout(): Layout {
    const W = this.scale.width;
    const H = this.scale.height;
    const margin = 16;
    const portrait = isPortrait(this);
    const footerH = portrait ? 64 : 40;
    const button = { x: W / 2, y: H - footerH - SEAL_RADIUS - 14 };

    // HUD: a row across wide screens, 2 rows medium, a column of 4 narrow —
    // pills always stretch to fill their column's width.
    const hudCols = W >= 820 ? 4 : W >= 480 ? 2 : 1;
    const hudRows = HUD_LABELS.length / hudCols;
    const cellH = hudCols === 4 ? 58 : hudCols === 2 ? 52 : 44;
    const gapX = 10;
    const gapY = 8;
    const cellW = (W - margin * 2 - gapX * (hudCols - 1)) / hudCols;

    const hud: HudCell[] = HUD_LABELS.map((_, i) => {
      const col = i % hudCols;
      const row = Math.floor(i / hudCols);
      return {
        x: margin + cellW / 2 + col * (cellW + gapX),
        y: margin + cellH / 2 + row * (cellH + gapY),
        w: cellW,
        h: cellH
      };
    });
    const hudBottom = margin + hudRows * cellH + (hudRows - 1) * gapY;

    const gridTop = hudBottom + 16;
    const gridBottom = button.y - SEAL_RADIUS - 16;

    return {
      hud,
      footer: {
        numbersY: portrait ? H - footerH + 16 : H - footerH + 10,
        settingsY: portrait ? H - 16 : H - footerH + 10,
        centered: portrait
      },
      grid: {
        x: portrait ? margin : W * 0.06,
        y: gridTop,
        width: portrait ? W - margin * 2 : W * 0.88,
        height: Math.max(60, gridBottom - gridTop)
      },
      button
    };
  }

  // ---- chrome: felt + HUD + roll button -------------------------------------

  private buildChrome(layout: Layout): void {
    this.chrome?.destroy();

    const items: Phaser.GameObjects.GameObject[] = [];
    items.push(addFelt(this));
    items.push(...this.buildHud(layout));
    items.push(...this.buildRollButton(layout));
    if (this.state.dice.length > WINDOW_THRESHOLD) items.push(...this.buildWindowHint(layout));

    this.chrome = this.add.container(0, 0, items);
    // A fresh container always lands on top of the display list — but the
    // felt background inside it needs to stay behind the (untouched) dice.
    this.children.sendToBack(this.chrome);
    // The grid camera (if any) only ever shows gridContainer — the previous
    // chrome reference it was ignoring is gone, so point it at the new one.
    this.gridCamera?.ignore(this.chrome);
  }

  /** Border + caption around the grid area once it's scrollable, so it's
   *  obvious the grid isn't showing every die at once. */
  private buildWindowHint(layout: Layout): Phaser.GameObjects.GameObject[] {
    const area = layout.grid;
    const border = this.add
      .rectangle(area.x + area.width / 2, area.y + area.height / 2, area.width, area.height)
      .setStrokeStyle(2, COLORS.gold, 0.35);
    const hint = this.add
      .text(area.x + area.width / 2, area.y + 14, `${this.state.dice.length} dice — drag to pan, scroll to zoom`, {
        fontFamily: SERIF,
        fontSize: '13px',
        color: CSS.dim,
        fontStyle: 'italic'
      })
      .setOrigin(0.5, 0);
    return [border, hint];
  }

  private buildHud(layout: Layout): Phaser.GameObjects.GameObject[] {
    const W = this.scale.width;
    const items: Phaser.GameObjects.GameObject[] = [];

    const refs = HUD_LABELS.map((label, i) => {
      const plaque = this.makePlaque(layout.hud[i], label);
      items.push(plaque.image, plaque.label, plaque.value);
      return plaque.value;
    });
    [this.hudRound, this.hudRoll, this.hudScore, this.hudTarget] = refs;

    const { numbersY, settingsY, centered } = layout.footer;
    if (centered) {
      this.hudNumbers = this.add
        .text(W / 2, numbersY, '', {
          fontFamily: SERIF,
          fontSize: '14px',
          color: CSS.dim,
          fontStyle: 'italic',
          align: 'center',
          wordWrap: { width: W - 32 }
        })
        .setOrigin(0.5);
      items.push(this.hudNumbers, this.buildSettingsLink(W / 2, settingsY, 0.5));
    } else {
      this.hudNumbers = this.add
        .text(24, numbersY, '', {
          fontFamily: SERIF,
          fontSize: '17px',
          color: CSS.dim,
          fontStyle: 'italic',
          wordWrap: { width: W * 0.5 }
        })
        .setOrigin(0, 0.5);
      items.push(this.hudNumbers, this.buildSettingsLink(W - 24, settingsY, 1));
    }

    this.updateHud();
    return items;
  }

  /** Opens Settings mid-run; Settings shows "Abandon Run" and returns here
   *  instead of to the Menu when it knows it was opened from the game. */
  private buildSettingsLink(x: number, y: number, originX: number): Phaser.GameObjects.Text {
    const link = this.add
      .text(x, y, 'Settings', { fontFamily: SERIF, fontSize: '17px', color: CSS.dim, fontStyle: 'italic' })
      .setOrigin(originX, 0.5)
      .setInteractive({ useHandCursor: true });
    link.on('pointerover', () => link.setColor(CSS.gold));
    link.on('pointerout', () => link.setColor(CSS.dim));
    link.on('pointerdown', () => {
      audio.click();
      this.scene.start('Settings', { returnTo: 'Game' });
    });
    return link;
  }

  private makePlaque(
    cell: HudCell,
    label: string
  ): { image: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text; value: Phaser.GameObjects.Text } {
    const { x, y, w, h } = cell;
    const fontScale = h / 58; // relative to the plaque texture's natural height
    const image = this.add.image(x, y, 'plaque').setDisplaySize(w, h);
    const labelText = this.add
      .text(x, y - 18 * fontScale, label, {
        fontFamily: SERIF,
        fontSize: `${14 * fontScale}px`,
        color: CSS.dim,
        letterSpacing: 2
      })
      .setOrigin(0.5);
    const value = this.add
      .text(x, y + 8 * fontScale, '', {
        fontFamily: SERIF,
        fontSize: `${26 * fontScale}px`,
        color: CSS.goldLight,
        fontStyle: 'bold'
      })
      .setOrigin(0.5);
    return { image, label: labelText, value };
  }

  private updateHud(): void {
    const s = this.state;
    this.hudRound.setText(String(s.round));
    this.hudRoll.setText(`${s.roll}/${ROLLS_PER_ROUND}`);
    this.hudScore.setText(String(s.score));
    this.hudTarget.setText(String(roundTarget(s.round)));

    const extras = s.extraPoints > 0 ? `  ·  +${s.extraPoints} bonus per scoring die` : '';
    this.hudNumbers.setText(`Sacred numbers: ${s.scoringNumbers.join(', ')}${extras}`);
  }

  // ---- dice grid -----------------------------------------------------------

  /** Reconciles the live sprite pool against whichever dice should currently
   *  be visible (all of them below WINDOW_THRESHOLD, or just the current
   *  scroll/zoom window above it) — creating sprites for newly-visible
   *  indices, destroying ones that scrolled out, and repositioning the rest.
   *  Used for the initial build, resize, and every pan/zoom step. */
  private syncGrid(layout: Layout): void {
    this.layout = layout;
    const n = this.state.dice.length;
    this.windowed = n > WINDOW_THRESHOLD;

    let visible: { index: number; x: number; y: number }[];
    let scale: number;

    if (this.windowed) {
      const view = computeWindowedView(n, layout.grid, this.viewport);
      this.viewport.scrollX = view.scrollX;
      this.viewport.scrollY = view.scrollY;
      visible = view.visible;
      scale = view.scale;

      const cam = this.ensureGridCamera();
      cam.setViewport(layout.grid.x, layout.grid.y, layout.grid.width, layout.grid.height);
      cam.setZoom(view.zoom);
      // Phaser's Camera.scrollX/Y is the world position at the viewport's
      // CENTER, offset by half the *unzoomed* viewport size — not the world
      // position at its top-left edge (which is what `view.scrollX/Y`
      // means, and what the edge-clamping in computeWindowedView is written
      // against). The two only coincide at zoom=1; convert here.
      const halfW = layout.grid.width / 2;
      const halfH = layout.grid.height / 2;
      cam.setScroll(
        view.scrollX + halfW * (1 / view.zoom - 1),
        view.scrollY + halfH * (1 / view.zoom - 1)
      );
    } else {
      const g = computeGridPositions(n, layout.grid);
      visible = g.positions.map((p, index) => ({ index, x: p.x, y: p.y }));
      scale = g.scale;
    }

    const visibleIndices = new Set(visible.map((v) => v.index));
    for (const [index, sprite] of this.sprites) {
      if (!visibleIndices.has(index)) {
        sprite.destroy();
        this.sprites.delete(index);
      }
    }

    for (const { index, x, y } of visible) {
      let sprite = this.sprites.get(index);
      if (!sprite) {
        sprite = new DieSprite(this, x, y, this.state.dice[index]);
        this.gridContainer.add(sprite);
        this.sprites.set(index, sprite);
        // Camera.ignore() only snapshots a Container's *current* children,
        // so each windowed sprite needs to opt out of the main camera
        // individually as it's created (it renders via gridCamera instead).
        if (this.windowed) this.cameras.main.ignore(sprite);
      } else {
        sprite.clearPulse();
      }
      sprite.setPosition(x, y);
      sprite.setScale(scale);
    }
  }

  /** Lazily creates the dedicated grid camera the first (and only) time the
   *  grid goes windowed — its viewport gives native, always-correct clipping
   *  to the grid area, and its own scroll/zoom drive pan/zoom. */
  private ensureGridCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.gridCamera) return this.gridCamera;
    this.gridCamera = this.cameras.add(0, 0, 1, 1);
    // A fully transparent background camera doesn't composite its draws
    // correctly over content another camera already rendered — give it an
    // opaque backdrop matching the felt so dice actually show up.
    this.gridCamera.setBackgroundColor(COLORS.felt);
    this.gridCamera.ignore(this.chrome);
    return this.gridCamera;
  }

  /** Popups (score float-ups, round banners) are loose scene children, not
   *  part of chrome or the grid — without this, the grid camera's opaque
   *  background paints over whatever the main camera already drew for them,
   *  and its own scroll/zoom (meant for virtual dice coordinates) would
   *  misplace them if it tried to redraw them itself. Ignoring keeps them on
   *  the main camera only, always on top of the grid, at their real position. */
  private overlay<T extends Phaser.GameObjects.GameObject>(objOrList: T | T[]): T | T[] {
    this.gridCamera?.ignore(objOrList);
    return objOrList;
  }

  /** Drag-to-pan + wheel-to-zoom over the grid area, only wired when the
   *  grid is windowed (below the threshold there's nothing to scroll to). */
  private wireGridInput(): () => void {
    let dragging = false;
    let start = { x: 0, y: 0, scrollX: 0, scrollY: 0 };

    const inBounds = (p: Phaser.Input.Pointer) => {
      const a = this.layout.grid;
      return p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height;
    };

    const onDown = (p: Phaser.Input.Pointer) => {
      if (!inBounds(p)) return;
      dragging = true;
      start = { x: p.x, y: p.y, scrollX: this.viewport.scrollX, scrollY: this.viewport.scrollY };
    };
    const onMove = (p: Phaser.Input.Pointer) => {
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? 'grab' : 'default');
        return;
      }
      // A screen-pixel drag covers more virtual ground the further zoomed out we are.
      this.viewport.scrollX = start.scrollX - (p.x - start.x) / this.viewport.zoom;
      this.viewport.scrollY = start.scrollY - (p.y - start.y) / this.viewport.zoom;
      this.syncGrid(this.layout);
    };
    const onUp = () => {
      dragging = false;
    };
    const onWheel = (p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
      if (!inBounds(p)) return;
      const area = this.layout.grid;

      // Keep the same point of the grid centered through the zoom change.
      const oldViewW = area.width / this.viewport.zoom;
      const oldViewH = area.height / this.viewport.zoom;
      const centerX = this.viewport.scrollX + oldViewW / 2;
      const centerY = this.viewport.scrollY + oldViewH / 2;

      this.viewport.zoom = clampZoom(this.viewport.zoom - dy * 0.001, area);

      const newViewW = area.width / this.viewport.zoom;
      const newViewH = area.height / this.viewport.zoom;
      this.viewport.scrollX = centerX - newViewW / 2;
      this.viewport.scrollY = centerY - newViewH / 2;
      this.syncGrid(this.layout);
    };

    this.input.on('pointerdown', onDown);
    this.input.on('pointermove', onMove);
    this.input.on('pointerup', onUp);
    this.input.on('pointerupoutside', onUp);
    this.input.on('wheel', onWheel);

    return () => {
      this.input.off('pointerdown', onDown);
      this.input.off('pointermove', onMove);
      this.input.off('pointerup', onUp);
      this.input.off('pointerupoutside', onUp);
      this.input.off('wheel', onWheel);
      this.input.setDefaultCursor('default');
    };
  }

  // ---- roll button ---------------------------------------------------------

  private buildRollButton(layout: Layout): Phaser.GameObjects.GameObject[] {
    const { x, y } = layout.button;
    this.sealImage = this.add.image(x, y, 'seal');
    const label = this.add
      .text(x, y - 3, 'ROLL', {
        fontFamily: SERIF,
        fontSize: '34px',
        color: CSS.parchment,
        fontStyle: 'bold',
        letterSpacing: 3
      })
      .setOrigin(0.5)
      .setShadow(0, 2, '#000000', 4, false, true);

    this.sealImage.setInteractive({ useHandCursor: true });
    this.sealImage.on('pointerover', () => !this.rolling && this.sealImage.setScale(1.06));
    this.sealImage.on('pointerout', () => this.sealImage.setScale(1));
    this.sealImage.on('pointerdown', () => this.onRoll());
    label.setDepth(1);
    return [this.sealImage, label];
  }

  // ---- roll flow -----------------------------------------------------------

  private onRoll(): void {
    this.sealImage.setScale(0.96);
    this.time.delayedCall(120, () => this.sealImage.setScale(1));

    if (this.tumbling) {
      // Mid-tumble: skip the flicker and resolve the roll now.
      this.interruptRoll();
      return;
    }

    if (this.pendingAdvance) {
      // Mid-hold (post-settle, waiting to decide what's next): skip the wait
      // and advance right now — a click should never just do nothing.
      this.pendingAdvance.remove();
      this.pendingAdvance = undefined;
      this.afterRoll(true);
      return;
    }

    if (!this.rolling) this.startRoll();
  }

  private startRoll(): void {
    this.rolling = true;
    this.tumbling = true;

    audio.roll(this.state.dice.length);
    rollAll(this.state.dice);

    // Tumble animation: flicker random faces, then settle on the real values.
    // Only the currently-rendered (visible) sprites animate — offscreen dice
    // still roll correctly, they just don't need to visibly flicker.
    this.tumbleEvent = this.time.addEvent({
      delay: 70,
      repeat: 6,
      callback: () => {
        for (const sprite of this.sprites.values()) {
          sprite.showFace(1 + Math.floor(Math.random() * sprite.die.sides));
        }
      }
    });
    this.settleTimer = this.time.delayedCall(70 * 7 + 40, () => this.settleRoll(700, false));
  }

  /** Skip the rest of the tumble, resolve the roll now, then queue a fast re-roll. */
  private interruptRoll(): void {
    this.tumbleEvent?.remove();
    this.settleTimer?.remove();
    this.settleRoll(200, true);
  }

  private settleRoll(holdMs: number, autoReroll: boolean): void {
    this.tumbling = false;
    const s = this.state;
    for (const sprite of this.sprites.values()) sprite.showFace(sprite.die.value);

    const result = scoreRoll(s);
    s.roll += 1;
    s.score += result.points;

    for (const i of result.scoringIndices) this.sprites.get(i)?.pulse(false);
    for (const i of result.jackpotIndices) {
      const sprite = this.sprites.get(i);
      if (!sprite) continue;
      sprite.pulse(true);
      this.overlay(floatText(this, sprite.x, sprite.y - 40, 'JACKPOT +20', CSS.goldLight, 24));
    }

    if (result.points > 0) {
      audio.score(result.points);
      this.overlay(floatText(this, this.scale.width / 2, 150, `+${result.points}`, CSS.goldLight, 42));
    } else {
      audio.dud();
    }

    this.updateHud();
    this.pendingAdvance = this.time.delayedCall(holdMs, () => {
      this.pendingAdvance = undefined;
      this.afterRoll(autoReroll);
    });
  }

  private afterRoll(autoReroll: boolean): void {
    const s = this.state;

    if (s.roll >= ROLLS_PER_ROUND) {
      const target = roundTarget(s.round);
      if (s.score >= target) {
        audio.roundUp();
        this.overlay(showBanner(this, `Round ${s.round} survived — the Order is pleased`, 1300));
        s.round += 1;
        s.roll = 0;
        s.score = 0;
        this.time.delayedCall(1700, () => {
          this.updateHud();
          this.rolling = false;
        });
      } else {
        audio.gameOver();
        saveHallEntry({
          startedAt: s.startedAt,
          round: s.round,
          score: s.score,
          dice: s.dice.map((d) => ({ sides: d.sides, rollplayer: d.rollplayer }))
        });
        this.overlay(showBanner(this, 'The Order is displeased. Your run ends.', 1300));
        this.time.delayedCall(1700, () => this.scene.start('GameOver'));
      }
      return;
    }

    if (SHOP_ROLLS.includes(s.roll)) {
      this.overlay(showBanner(this, 'The shop beckons…', 900));
      this.time.delayedCall(1300, () => this.scene.start('Shop'));
      return;
    }

    if (autoReroll) {
      this.startRoll();
    } else {
      this.rolling = false;
    }
  }
}
