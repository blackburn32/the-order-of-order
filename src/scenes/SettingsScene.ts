import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { getRun } from '../state/RunState';
import { audio } from '../systems/Audio';
import { hasBeatenGame, loadSettings, recordRunEnd, resetAllProgress, saveSettings, Settings } from '../systems/SaveData';
import { addFelt, addPanel, bannerButton, checkboxRow, showBanner } from '../ui/widgets';
import { onResizeCoalesced } from '../ui/layout';

interface SettingsData {
  returnTo?: 'Menu' | 'Game';
}

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (pointer: Phaser.Input.Pointer, over: unknown, dx: number, dy: number, dz: number) => void;

export class SettingsScene extends Phaser.Scene {
  private settings!: Settings;
  private returnTo: 'Menu' | 'Game' = 'Menu';
  // The settings rows live in a container the player can scroll when they don't
  // all fit the panel. It's clipped by a dedicated camera (Phaser 4 WebGL masks
  // are unreliable for nested content — same rationale as the shop carousel).
  private scrollCamera?: Phaser.Cameras.Scene2D.Camera;
  private scrollInput?: { down: PointerHandler; move: PointerHandler; up: PointerHandler; wheel: WheelHandler };

  constructor() {
    super('Settings');
  }

  /** Called before create() when the scene is started with data — lets the
   *  "back" button and the mid-run Abandon Run option know where "back" is. */
  init(data: SettingsData): void {
    this.returnTo = data?.returnTo === 'Game' ? 'Game' : 'Menu';
  }

  create(): void {
    this.settings = loadSettings();
    // Not using responsive() — its children.removeAll doesn't clear the extra
    // camera / input listeners a scroll view needs, so drive rebuilds manually.
    this.scrollCamera = undefined;
    this.build();

    const off = onResizeCoalesced(this, () => {
      this.teardown();
      this.children.removeAll(true);
      this.build();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardown();
    });
  }

  private teardown(): void {
    if (this.scrollInput) {
      this.input.off('pointerdown', this.scrollInput.down);
      this.input.off('pointermove', this.scrollInput.move);
      this.input.off('pointerup', this.scrollInput.up);
      this.input.off('pointerupoutside', this.scrollInput.up);
      this.input.off('wheel', this.scrollInput.wheel);
      this.scrollInput = undefined;
    }
    if (this.scrollCamera) {
      this.cameras.remove(this.scrollCamera, true);
      this.scrollCamera = undefined;
    }
    this.scale.off(Phaser.Scale.Events.ENTER_FULLSCREEN);
    this.scale.off(Phaser.Scale.Events.LEAVE_FULLSCREEN);
    this.input.setDefaultCursor('default');
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const panelW = Math.min(W - 40, 1100);
    const panelH = Math.min(H - 40, 620);
    const panelTop = H / 2 - panelH / 2;

    const felt = addFelt(this);
    const panel = addPanel(this, cx, H / 2, panelW, panelH);
    const title = this.add
      .text(cx, panelTop + panelH * 0.1, 'Settings', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(panelH * 0.068, 22, 40))}px`,
        color: CSS.ink,
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    // The scrollable band, inside the panel, below the fixed title.
    const viewportTop = panelTop + panelH * 0.2;
    const viewportH = panelTop + panelH * 0.94 - viewportTop;
    const viewportW = panelW * 0.84;
    const viewportX = cx - viewportW / 2;
    // Keep the whole form on one screen: cap the banner buttons well below the
    // 340px parchment so they render ~80% size, and still shrink further to fit
    // the panel band on narrow screens.
    const btnMaxW = Math.min(viewportW, 272);

    // ---- lay out the rows at absolute world coords in a content container ----
    const content = this.add.container(0, 0);
    const trackW = Math.min(viewportW * 0.72, 420);
    const trackX0 = cx - trackW / 2;
    const trackX1 = cx + trackW / 2;
    // Start low enough that the first slider's label (centered at y-26) clears
    // the clip camera's top edge instead of being sheared off.
    let y = viewportTop + 42;

    this.makeSlider(content, cx, y, trackX0, trackX1, 'Music Volume', this.settings.musicVol, (v) => {
      this.settings.musicVol = v;
      this.apply();
    });
    y += 72;
    this.makeSlider(content, cx, y, trackX0, trackX1, 'Sound Effects', this.settings.sfxVol, (v) => {
      this.settings.sfxVol = v;
      this.apply();
    });
    y += 62;

    content.add(
      checkboxRow(this, cx, y, 'Show Intro', this.settings.showIntro, (value) => {
        this.settings.showIntro = value;
        this.apply();
      })
    );
    y += 48;
    content.add(
      checkboxRow(this, cx, y, 'Show Tutorial', this.settings.showTutorial, (value) => {
        this.settings.showTutorial = value;
        this.apply();
      })
    );
    y += 48;

    // Hard Mode only appears once the player has beaten the game at least once.
    if (hasBeatenGame()) {
      content.add(
        checkboxRow(this, cx, y, 'Hard Mode ☠', this.settings.hardMode, (value) => {
          this.settings.hardMode = value;
          this.apply();
        })
      );
      y += 48;
    }

    content.add(this.buildFullscreenToggle(cx, y));
    y += 58;

    if (this.returnTo === 'Game') {
      content.add(
        bannerButton(
          this,
          cx,
          y,
          'Abandon Run',
          () => {
            audio.click();
            recordRunEnd(getRun(this.registry), false);
            this.scene.start('GameOver');
          },
          btnMaxW
        )
      );
    } else {
      content.add(this.buildResetButton(cx, y, btnMaxW));
    }
    y += 64;

    const backLabel = this.returnTo === 'Game' ? 'Return to Game' : 'Return to the Vestibule';
    content.add(bannerButton(this, cx, y, backLabel, () => this.scene.start(this.returnTo), btnMaxW));

    const contentBottom = y + 34;
    const contentH = contentBottom - viewportTop;

    if (contentH > viewportH) {
      this.enableScroll(content, [felt, panel, title], viewportX, viewportTop, viewportW, viewportH, contentH, cx);
    }
  }

  /** Clip `content` to the viewport with a dedicated camera and wire vertical
   *  drag / wheel / scrollbar — mirrors the shop carousel, swapping x for y. */
  private enableScroll(
    content: Phaser.GameObjects.Container,
    fixed: Phaser.GameObjects.GameObject[],
    viewportX: number,
    viewportTop: number,
    viewportW: number,
    viewportH: number,
    contentH: number,
    cx: number
  ): void {
    const minY = viewportH - contentH; // most-scrolled (negative)
    const maxY = 0; // top

    // A clip camera renders only `content`; the main camera renders everything
    // else. Scroll matches the viewport's screen position (passthrough at zoom 1).
    const cam = this.cameras.add(viewportX, viewportTop, viewportW, viewportH);
    cam.setScroll(viewportX, viewportTop);
    this.scrollCamera = cam;
    this.cameras.main.ignore(content);
    cam.ignore(fixed);

    // Vertical scrollbar (display-only; driven by drag/wheel).
    const barX = viewportX + viewportW + 6;
    const barTrack = this.add.rectangle(barX, viewportTop + viewportH / 2, 5, viewportH, COLORS.inkSoft, 0.4);
    const thumbH = Math.max(30, (viewportH * viewportH) / contentH);
    const thumb = this.add.rectangle(barX, viewportTop + thumbH / 2, 5, thumbH, COLORS.gold, 0.9);
    cam.ignore([barTrack, thumb]);
    const updateThumb = () => {
      const progress = (maxY - content.y) / (maxY - minY);
      thumb.y = viewportTop + thumbH / 2 + progress * (viewportH - thumbH);
    };

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= viewportX && p.x <= viewportX + viewportW && p.y >= viewportTop && p.y <= viewportTop + viewportH;

    let dragging = false;
    let startPointerY = 0;
    let startContentY = 0;

    const onDown: PointerHandler = (p) => {
      if (!inBounds(p)) return;
      // Don't hijack presses that land on a knob/checkbox/button — let those
      // interact; scroll-drag only starts on empty space in the viewport.
      if (this.input.hitTestPointer(p).length > 0) return;
      dragging = true;
      startPointerY = p.y;
      startContentY = content.y;
    };
    const onMove: PointerHandler = (p) => {
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? 'grab' : 'default');
        return;
      }
      content.y = Phaser.Math.Clamp(startContentY + (p.y - startPointerY), minY, maxY);
      updateThumb();
    };
    const onUp: PointerHandler = () => {
      dragging = false;
    };
    const onWheel: WheelHandler = (p, _over, _dx, dy) => {
      if (!inBounds(p)) return;
      content.y = Phaser.Math.Clamp(content.y - dy, minY, maxY);
      updateThumb();
    };

    this.input.on('pointerdown', onDown);
    this.input.on('pointermove', onMove);
    this.input.on('pointerup', onUp);
    this.input.on('pointerupoutside', onUp);
    this.input.on('wheel', onWheel);
    this.scrollInput = { down: onDown, move: onMove, up: onUp, wheel: onWheel };

    const hint = this.add
      .text(cx, viewportTop + viewportH + 3, 'drag or scroll for more', {
        fontFamily: SERIF,
        fontSize: '13px',
        color: CSS.dim,
        fontStyle: 'italic'
      })
      .setOrigin(0.5, 0);
    cam.ignore(hint);
  }

  private buildFullscreenToggle(cx: number, y: number): Phaser.GameObjects.Container {
    const row = checkboxRow(this, cx, y, 'Fullscreen', this.scale.isFullscreen, (value) => {
      if (value) this.scale.startFullscreen();
      else this.scale.stopFullscreen();
    });
    // Keep the checkbox in sync when fullscreen is exited/entered outside the UI
    // (Esc, F11); setChecked doesn't re-fire onChange, so there's no loop.
    this.scale.on(Phaser.Scale.Events.ENTER_FULLSCREEN, () => row.setChecked(true));
    this.scale.on(Phaser.Scale.Events.LEAVE_FULLSCREEN, () => row.setChecked(false));
    return row;
  }

  /** "Reset All Progress" with a lightweight two-tap confirm (there's no modal
   *  helper): the first tap arms it, a second within a few seconds wipes item
   *  unlocks, selection counts, games-completed, and the Hall of High Scores.
   *  Audio settings are kept. */
  private buildResetButton(cx: number, y: number, maxWidth: number): Phaser.GameObjects.Container {
    const DEFAULT = 'Reset All Progress';
    let confirming = false;
    let timer: Phaser.Time.TimerEvent | undefined;

    const button = bannerButton(
      this,
      cx,
      y,
      DEFAULT,
      () => {
        const label = button.getAt(1) as Phaser.GameObjects.Text;
        if (!confirming) {
          confirming = true;
          label.setText('Tap again to confirm');
          timer = this.time.delayedCall(3000, () => {
            confirming = false;
            label.setText(DEFAULT);
          });
          return;
        }
        timer?.remove();
        confirming = false;
        resetAllProgress();
        label.setText('Progress reset');
        showBanner(this, 'All progress has been reset', 1200);
      },
      maxWidth
    );
    return button;
  }

  private apply(): void {
    audio.setVolumes(this.settings.musicVol, this.settings.sfxVol);
    saveSettings(this.settings);
  }

  private makeSlider(
    content: Phaser.GameObjects.Container,
    labelX: number,
    y: number,
    trackX0: number,
    trackX1: number,
    label: string,
    initial: number,
    onChange: (v: number) => void
  ): void {
    const labelText = this.add
      .text(labelX, y - 26, label, { fontFamily: SERIF, fontSize: '22px', color: CSS.ink })
      .setOrigin(0.5);

    const trackY = y + 6;
    const track = this.add.rectangle((trackX0 + trackX1) / 2, trackY, trackX1 - trackX0, 6, COLORS.inkSoft, 0.6);

    const knob = this.add.circle(trackX0 + initial * (trackX1 - trackX0), trackY, 15, COLORS.gold);
    knob.setStrokeStyle(2, COLORS.ink, 0.8);
    knob.setInteractive({ useHandCursor: true });
    this.input.setDraggable(knob);

    // dragX arrives in the content container's local space (Phaser accounts for
    // the parent transform), and the track x-range is expressed in the same
    // space, so clamp directly.
    knob.on('drag', (_pointer: Phaser.Input.Pointer, dragX: number) => {
      knob.x = Phaser.Math.Clamp(dragX, trackX0, trackX1);
      onChange((knob.x - trackX0) / (trackX1 - trackX0));
    });
    knob.on('dragend', () => audio.click());

    content.add([labelText, track, knob]);
  }
}
