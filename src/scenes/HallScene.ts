import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { loadHall } from '../systems/SaveData';
import { addFelt, addPanel, bannerButton } from '../ui/widgets';
import { onResizeCoalesced } from '../ui/layout';
import { fetchTopScores, globalScoresEnabled, GlobalScoreRow } from '../systems/GlobalScores';

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (pointer: Phaser.Input.Pointer, over: unknown, dx: number, dy: number, dz: number) => void;

type Tab = 'local' | 'global';
type GlobalStatus = 'idle' | 'loading' | 'error' | 'disabled' | 'ready';

/**
 * The Hall of High Scores. Two tabs: the player's local runs (unchanged, drawn
 * from localStorage) and the worldwide top-100 fetched from LootLocker. The
 * selected tab and the fetched global rows live in instance fields so they
 * survive the wipe-and-rebuild that runs on every resize / tab switch. The
 * global list can overflow the panel, so — like the Codex — its rows live in a
 * `track` container clipped by a dedicated camera and scrolled by drag/wheel.
 */
export class HallScene extends Phaser.Scene {
  private tab: Tab = 'local';
  private globalRows: GlobalScoreRow[] | null = null;
  private globalStatus: GlobalStatus = 'idle';
  private gridCamera?: Phaser.Cameras.Scene2D.Camera;
  private input$?: { down: PointerHandler; move: PointerHandler; up: PointerHandler; wheel: WheelHandler };

  constructor() {
    super('Hall');
  }

  create(): void {
    this.tab = 'local';
    this.globalRows = null;
    this.globalStatus = 'idle';
    this.gridCamera = undefined;
    this.build();

    const off = onResizeCoalesced(this, () => this.rebuild());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardownInput();
      this.input.setDefaultCursor('default');
    });
  }

  private rebuild(): void {
    this.teardownInput();
    this.children.removeAll(true);
    this.build();
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
    const panelLeft = cx - panelW / 2;

    addFelt(this);
    addPanel(this, cx, H / 2, panelW, panelH);

    this.add
      .text(cx, panelTop + panelH * 0.09, 'Hall of High Scores', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(Math.min(panelW * 0.075, panelH * 0.068), 20, 40))}px`,
        color: CSS.ink,
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: panelW * 0.92 }
      })
      .setOrigin(0.5);

    this.buildTabs(cx, panelTop + panelH * 0.19, panelW);

    // Back button is created before the (possibly camera-clipped) content so it
    // is part of the "everything except the scroll track" set the grid camera
    // ignores.
    bannerButton(this, cx, panelTop + panelH * 0.92, 'Return to the Vestibule', () => this.scene.start('Menu'));

    const contentTop = panelTop + panelH * 0.31;
    const contentBottom = panelTop + panelH * 0.86;

    if (this.tab === 'local') {
      this.buildLocal(cx, panelLeft, panelW, panelH, contentTop);
    } else {
      this.buildGlobal(cx, panelLeft, panelW, contentTop, contentBottom);
    }
  }

  private buildTabs(cx: number, y: number, panelW: number): void {
    const local = bannerButton(this, cx, y, 'My Runs', () => this.switchTab('local'));
    const global = bannerButton(this, cx, y, 'Global', () => this.switchTab('global'));
    // Space the two tabs by half their own width plus a fixed gap so they never
    // overlap regardless of the button art's size or the panel width.
    const btnW = (local.getAt(0) as Phaser.GameObjects.Image).width;
    const dx = btnW / 2 + Math.max(24, panelW * 0.03);
    local.setX(cx - dx);
    global.setX(cx + dx);
    const active = this.tab === 'local' ? local : global;
    (active.getAt(0) as Phaser.GameObjects.Image).setTint(0xf0d98a);
  }

  private switchTab(tab: Tab): void {
    // Retry the fetch when (re)entering Global if we've never loaded or errored.
    if (tab === 'global' && (this.globalStatus === 'idle' || this.globalStatus === 'error')) {
      this.loadGlobal();
    }
    this.tab = tab;
    this.rebuild();
  }

  private loadGlobal(): void {
    if (!globalScoresEnabled()) {
      this.globalStatus = 'disabled';
      return;
    }
    this.globalStatus = 'loading';
    fetchTopScores().then((rows) => {
      if (!this.scene.isActive()) return; // scene left while in flight
      if (rows === null) {
        this.globalStatus = 'error';
      } else {
        this.globalRows = rows;
        this.globalStatus = 'ready';
      }
      if (this.tab === 'global') this.rebuild();
    });
  }

  // --- Local tab (existing behaviour) ---------------------------------------

  private buildLocal(cx: number, panelLeft: number, panelW: number, panelH: number, contentTop: number): void {
    const entries = loadHall();

    if (entries.length === 0) {
      this.centerMessage(cx, contentTop + panelH * 0.2, 'No initiates have been recorded.\nBegin a run and earn your place.', panelW);
      return;
    }

    // Column positions are derived from each column's actual measured text
    // width (not a guessed font metric), so DATE/ROUND/SCORE can never collide
    // regardless of font size, locale date format, or digit count — the grid
    // column just absorbs whatever room is left over.
    const headerSize = Math.round(Phaser.Math.Clamp(panelW * 0.032, 11, 16));
    const cellSize = Math.round(Phaser.Math.Clamp(panelW * 0.045, 13, 20));
    const colGap = Math.max(10, panelW * 0.02);

    const headerY = contentTop;
    const rowStart = contentTop + panelH * 0.05;
    const rowStep = Math.min(36, (panelH * 0.55) / Math.max(1, entries.length));

    const dateTexts = [this.header(headerY, 'DATE', headerSize)];
    const roundTexts = [this.header(headerY, 'ROUND', headerSize)];
    const scoreTexts = [this.header(headerY, 'SCORE', headerSize)];
    const gridHeader = this.header(headerY, 'FINAL GRID', headerSize, 0);

    const rows = entries.map((entry, i) => {
      const y = rowStart + i * rowStep;
      const date = new Date(entry.startedAt).toLocaleDateString(undefined, {
        year: '2-digit',
        month: 'numeric',
        day: 'numeric'
      });
      dateTexts.push(this.cell(y, date, cellSize));
      roundTexts.push(this.cell(y, String(entry.round), cellSize));
      scoreTexts.push(this.cell(y, String(entry.score), cellSize));
      return { y, entry };
    });

    const widest = (texts: Phaser.GameObjects.Text[]) => Math.max(...texts.map((t) => t.width));
    const dateW = widest(dateTexts);
    const roundW = widest(roundTexts);
    const scoreW = widest(scoreTexts);

    const col1 = panelLeft + panelW * 0.06 + dateW / 2;
    const col2 = col1 + dateW / 2 + colGap + roundW / 2;
    const col3 = col2 + roundW / 2 + colGap + scoreW / 2;
    const col4 = col3 + scoreW / 2 + colGap * 1.4;
    const gridColW = panelLeft + panelW * 0.95 - col4;
    const iconStep = Math.min(30, Math.max(16, rowStep * 0.85));
    const maxIcons = Math.max(2, Math.floor(gridColW / iconStep));

    dateTexts.forEach((t) => t.setX(col1));
    roundTexts.forEach((t) => t.setX(col2));
    scoreTexts.forEach((t) => t.setX(col3));
    gridHeader.setX(col4);

    rows.forEach(({ y, entry }) => {
      // Victorious runs get a gold crown in the left gutter (old entries predate
      // `won`, so `undefined` reads as a loss — no marker).
      if (entry.won) {
        this.add
          .text(panelLeft + panelW * 0.03, y, '♛', { fontFamily: SERIF, fontSize: `${cellSize}px`, color: CSS.goldLight })
          .setOrigin(0.5);
      }
      const shown = entry.dice.slice(0, maxIcons);
      shown.forEach((die, j) => {
        this.add.image(col4 + j * iconStep, y, `die-${die.sides}`).setScale(0.27);
      });
      if (entry.dice.length > maxIcons) {
        this.add
          .text(col4 + maxIcons * iconStep, y, `+${entry.dice.length - maxIcons}`, {
            fontFamily: SERIF,
            fontSize: '15px',
            color: CSS.inkSoft
          })
          .setOrigin(0, 0.5);
      }
    });
  }

  // --- Global tab -----------------------------------------------------------

  private buildGlobal(cx: number, panelLeft: number, panelW: number, contentTop: number, contentBottom: number): void {
    if (this.globalStatus !== 'ready') {
      const msg =
        this.globalStatus === 'loading'
          ? 'Consulting the global hall…'
          : this.globalStatus === 'disabled'
          ? 'The global hall is beyond reach.'
          : this.globalStatus === 'error'
          ? 'The global hall could not be reached.\nTap Global to try again.'
          : 'Consulting the global hall…';
      this.centerMessage(cx, (contentTop + contentBottom) / 2, msg, panelW);
      return;
    }

    const rows = this.globalRows ?? [];
    if (rows.length === 0) {
      this.centerMessage(cx, (contentTop + contentBottom) / 2, 'No scores have been recorded yet.\nBe the first to earn a place.', panelW);
      return;
    }

    const headerSize = Math.round(Phaser.Math.Clamp(panelW * 0.032, 11, 16));
    const cellSize = Math.round(Phaser.Math.Clamp(panelW * 0.04, 13, 20));

    // Leave a fixed header band at contentTop; the scrolling list starts below.
    const band = Math.max(1, contentBottom - contentTop);
    const grid = {
      x: panelLeft + panelW * 0.09,
      y: contentTop + band * 0.09,
      width: panelW * 0.82,
      height: 0
    };
    // Header row sits just above the scrolling list, fixed.
    const rankX = grid.x + grid.width * 0.08;
    const nameX = grid.x + grid.width * 0.42;
    const scoreX = grid.x + grid.width * 0.98;
    this.header2(contentTop, rankX, 'RANK', headerSize, 0.5);
    this.header2(contentTop, nameX, 'INITIALS', headerSize, 0.5);
    this.header2(contentTop, scoreX, 'SCORE', headerSize, 1);

    grid.height = Math.max(80, contentBottom - grid.y);

    const rowStep = Math.min(34, Math.max(22, grid.height / Math.max(rows.length, 1)));
    const contentH = rows.length * rowStep;

    // Rows live in a track clipped/scrolled by a dedicated camera. Local coords
    // run 0..grid.width horizontally; column X are re-expressed relative to it.
    const track = this.add.container(grid.x, grid.y);
    const lRank = grid.width * 0.08;
    const lName = grid.width * 0.42;
    const lScore = grid.width * 0.98;

    rows.forEach((row, i) => {
      const y = i * rowStep + rowStep / 2;
      if (row.isYou) {
        track.add(this.add.rectangle(grid.width / 2, y, grid.width, rowStep, COLORS.goldLight, 0.18).setOrigin(0.5));
        track.add(this.add.text(0, y, '♛', { fontFamily: SERIF, fontSize: `${cellSize}px`, color: CSS.gold }).setOrigin(0, 0.5));
      }
      const color = row.isYou ? CSS.gold : CSS.ink;
      const style = { fontFamily: SERIF, fontSize: `${cellSize}px`, color, fontStyle: row.isYou ? 'bold' : 'normal' };
      track.add(this.add.text(lRank, y, `${row.rank}`, style).setOrigin(0.5));
      track.add(this.add.text(lName, y, row.name || '—', style).setOrigin(0.5));
      track.add(this.add.text(lScore, y, `${row.score}`, style).setOrigin(1, 0.5));
    });

    // Clip the track to the list area via a dedicated parchment-backed camera.
    const cam = this.ensureGridCamera();
    cam.setViewport(grid.x, grid.y, grid.width, grid.height);
    cam.setScroll(grid.x, grid.y);
    cam.ignore(this.children.list.filter((o) => o !== track));
    this.cameras.main.ignore(track);

    const overflow = Math.max(0, contentH - grid.height);
    if (overflow <= 0) return;

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
      track.y = Phaser.Math.Clamp(startTrackY + (p.y - startPointerY), minY, maxY);
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
      .text(grid.x + grid.width / 2, grid.y + grid.height + 2, 'drag or scroll for more', {
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

  private centerMessage(cx: number, y: number, text: string, panelW: number): void {
    this.add
      .text(cx, y, text, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(panelW * 0.022, 16, 24))}px`,
        color: CSS.inkSoft,
        fontStyle: 'italic',
        align: 'center'
      })
      .setOrigin(0.5);
  }

  private header(y: number, label: string, size: number, originX = 0.5): Phaser.GameObjects.Text {
    return this.add
      .text(0, y, label, {
        fontFamily: SERIF,
        fontSize: `${size}px`,
        color: CSS.inkSoft,
        letterSpacing: 2,
        fontStyle: 'bold'
      })
      .setOrigin(originX, 0.5);
  }

  private header2(y: number, x: number, label: string, size: number, originX: number): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, label, {
        fontFamily: SERIF,
        fontSize: `${size}px`,
        color: CSS.inkSoft,
        letterSpacing: 2,
        fontStyle: 'bold'
      })
      .setOrigin(originX, 0.5);
  }

  private cell(y: number, value: string, size: number): Phaser.GameObjects.Text {
    return this.add.text(0, y, value, { fontFamily: SERIF, fontSize: `${size}px`, color: CSS.ink }).setOrigin(0.5);
  }
}
