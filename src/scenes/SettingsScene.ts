import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { PHONE_BUILD } from "../buildFlags";
import { getRun } from "../state/RunState";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import {
  loadSettings,
  resetAllProgress,
  saveSettings,
  Settings,
} from "../systems/SaveData";
import { finalizeRun } from "../systems/RunEnd";
import {
  addFelt,
  bannerButton,
  BannerAction,
  showBanner,
  stackBannerButtons,
  toggleRow,
} from "../ui/widgets";
import { addCamera } from "../ui/camera";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import {
  compactColumns,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
import {
  slideOverlayIn,
  slideOverlayOut,
  slideSceneIn,
  slideSceneOut,
} from "../ui/sceneSlide";

interface SettingsData {
  returnTo?: string;
  overlay?: boolean;
}

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (
  pointer: Phaser.Input.Pointer,
  over: unknown,
  dx: number,
  dy: number,
  dz: number,
) => void;

/** Fixed sigil brightness for the backdrop — there's no trial to report here,
 *  so the value is chosen purely for how it looks (see MenuScene). */
const SETTINGS_AMBIENCE = 0.6;

/** Row metrics. A slider row carries two lines (label and readout, then the
 *  track); a toggle row is a single band. Both share the form's left and right
 *  edges, so the stack reads as a form rather than as centred lumps. */
const SLIDER_ROW_H = 76;
const TOGGLE_ROW_H = 54;
/** Clear space between the last setting and the buttons that follow. */
const ACTIONS_GAP = 26;
/** Vertical pitch of the stacked buttons at the foot of the form. */
const BUTTON_STEP = 68;
/** Strip kept clear under a scrolling form for its "drag or scroll" line, so
 *  the hint never sits on top of the last row. */
const HINT_H = 22;

export class SettingsScene extends Phaser.Scene {
  private settings!: Settings;
  private returnTo = "Menu";
  private overlay = false;
  // The settings rows live in a container the player can scroll when they don't
  // all fit the screen. It's clipped by a dedicated camera (Phaser 4 WebGL
  // masks are unreliable for nested content — same rationale as the shop
  // carousel).
  private scrollCamera?: Phaser.Cameras.Scene2D.Camera;
  // The felt, the sigil and the masthead's halo — the room the form stands in.
  // Held still while the form itself slides on and off. Only used when Settings
  // is a scene of its own; as a mid-run overlay it has a live scene beneath it
  // and no room of its own to keep.
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  private overlayFelt?: Phaser.GameObjects.Image;
  private leaving = false;
  private scrollInput?: {
    down: PointerHandler;
    move: PointerHandler;
    up: PointerHandler;
    wheel: WheelHandler;
  };

  constructor() {
    super("Settings");
  }

  /** Called before create() when the scene is started with data — lets the
   *  "back" button and the mid-run Abandon Run option know where "back" is. */
  init(data: SettingsData): void {
    this.returnTo = data?.returnTo ?? "Menu";
    this.overlay = data?.overlay === true && this.returnTo !== "Menu";
  }

  create(): void {
    this.settings = loadSettings();
    if (this.overlay) this.scene.get(this.returnTo).input.enabled = false;
    // Not using responsive() — its children.removeAll doesn't clear the extra
    // camera / input listeners a scroll view needs, so drive rebuilds manually.
    this.scrollCamera = undefined;
    this.leaving = false;
    this.build();
    if (this.overlay && this.overlayFelt) {
      slideOverlayIn(this, this.overlayFelt);
    } else {
      slideSceneIn(this, this.slideBackdrop);
    }

    const off = onResizeCoalesced(this, () => {
      this.teardown();
      destroyAllChildren(this);
      this.build();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardown();
      if (this.overlay) this.scene.get(this.returnTo).input.enabled = true;
    });
  }

  private teardown(): void {
    if (this.scrollInput) {
      this.input.off("pointerdown", this.scrollInput.down);
      this.input.off("pointermove", this.scrollInput.move);
      this.input.off("pointerup", this.scrollInput.up);
      this.input.off("pointerupoutside", this.scrollInput.up);
      this.input.off("wheel", this.scrollInput.wheel);
      this.scrollInput = undefined;
    }
    if (this.scrollCamera) {
      this.cameras.remove(this.scrollCamera, true);
      this.scrollCamera = undefined;
    }
    this.scale.off(Phaser.Scale.Events.ENTER_FULLSCREEN);
    this.scale.off(Phaser.Scale.Events.LEAVE_FULLSCREEN);
    this.input.setDefaultCursor("default");
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
    ambient.setProgress(SETTINGS_AMBIENCE, false);

    // A short landscape viewport can show about two of the six rows under a
    // full-width masthead. Folded, the masthead and the run/back actions take
    // one column and the form gets the other — the whole of it, at full
    // height, so it barely needs to scroll at all.
    const compact = isCompactLandscape(W, H);
    const columns = compactColumns(this, { leftFraction: 0.38 });

    const header = buildSceneHeader(this, {
      title: "Settings",
      y: compact ? columns.top + 26 : Math.max(52, Math.min(H * 0.14, 104)),
      width: compact ? columns.left.width : Math.min(W, 720),
      ...(compact ? { x: columns.left.cx } : {}),
    });
    this.slideBackdrop = [felt, ambient, header.glow];

    // The form's own column, and the band it scrolls within. The viewport is
    // wider than the form so the scrollbar has somewhere to sit that isn't on
    // top of a switch.
    const formCx = compact ? columns.right.cx : cx;
    const formW = compact ? columns.right.width - 22 : Math.min(W - 64, 520);
    const viewportTop = compact ? columns.top : header.bottom + 22;
    const viewportW = compact
      ? columns.right.width
      : Math.min(W - 28, formW + 44);
    const viewportX = formCx - viewportW / 2;
    const viewportH = compact
      ? columns.height
      : Math.max(140, H - 20 - viewportTop);
    const btnMaxW = compact ? columns.left.width : Math.min(formW, 300);

    // ---- lay the rows out at absolute world coords in a content container ---
    const content = this.add.container(0, 0);
    const x0 = formCx - formW / 2;
    const x1 = formCx + formW / 2;
    let y = viewportTop + 6;

    // A hairline between rows in place of the parchment panel that used to
    // enclose them: enough structure to group the settings, not enough to read
    // as a second surface laid over the table.
    const divider = () => {
      const line = this.add.graphics();
      line.lineStyle(1, COLORS.parchment, 0.14);
      line.lineBetween(x0, y, x1, y);
      content.add(line);
    };

    this.makeSlider(
      content,
      x0,
      x1,
      y,
      "Music Volume",
      this.settings.musicVol,
      (v) => {
        this.settings.musicVol = v;
        this.apply();
      },
    );
    y += SLIDER_ROW_H;
    divider();

    this.makeSlider(
      content,
      x0,
      x1,
      y,
      "Sound Effects",
      this.settings.sfxVol,
      (v) => {
        this.settings.sfxVol = v;
        this.apply();
      },
    );
    y += SLIDER_ROW_H;
    divider();

    const toggle = (
      label: string,
      initial: boolean,
      onChange: (value: boolean) => void,
    ) => {
      const row = toggleRow(
        this,
        formCx,
        y + TOGGLE_ROW_H / 2,
        formW,
        label,
        initial,
        onChange,
        TOGGLE_ROW_H,
      );
      content.add(row);
      y += TOGGLE_ROW_H;
      divider();
      return row;
    };

    toggle("Show Intro", this.settings.showIntro, (value) => {
      this.settings.showIntro = value;
      this.apply();
    });
    toggle("Show Tutorial", this.settings.showTutorial, (value) => {
      this.settings.showTutorial = value;
      this.apply();
    });
    toggle("Visual Effects", this.settings.visualEffects, (value) => {
      this.settings.visualEffects = value;
      this.apply();
    });

    if (!PHONE_BUILD) {
      const row = toggle("Fullscreen", this.scale.isFullscreen, (value) => {
        if (value) this.scale.startFullscreen();
        else this.scale.stopFullscreen();
      });
      // Keep the switch in sync when fullscreen is left/entered outside the UI
      // (Esc, F11); setChecked doesn't re-fire onChange, so there's no loop.
      this.scale.on(Phaser.Scale.Events.ENTER_FULLSCREEN, () =>
        row.setChecked(true),
      );
      this.scale.on(Phaser.Scale.Events.LEAVE_FULLSCREEN, () =>
        row.setChecked(false),
      );
    }

    const rowsBottom = y;
    const backLabel =
      this.returnTo === "Menu" ? "Return to the Vestibule" : "Return";
    const abandon: BannerAction = {
      label: "Abandon Run",
      onClick: () =>
        this.leave(() => {
          finalizeRun(getRun(this.registry));
          if (this.overlay) this.scene.stop(this.returnTo);
          this.scene.start("GameOver");
        }),
    };

    if (compact) {
      // Both actions live under the masthead, in the other column and outside
      // `content` — a screen this short would otherwise scroll them off, and
      // "Return" is the one control that must never be out of reach.
      const bandTop = header.bottom + 18;
      const band = { top: bandTop, height: columns.bottom - bandTop };
      if (this.returnTo !== "Menu") {
        stackBannerButtons(this, columns.left, band, [
          abandon,
          { label: backLabel, onClick: () => this.close() },
        ]);
      } else {
        // The reset button carries its own confirm state, so it can't go
        // through the plain-label stack; place the pair by hand instead.
        const back = bannerButton(
          this,
          columns.left.cx,
          0,
          backLabel,
          () => this.close(),
          btnMaxW,
        );
        const reset = this.buildResetButton(columns.left.cx, 0, btnMaxW);
        const gap = Phaser.Math.Clamp(
          (band.height - reset.height - back.height) / 1,
          6,
          22,
        );
        const stackTop =
          band.top +
          Math.max(0, (band.height - reset.height - back.height - gap) / 2);
        reset.setY(stackTop + reset.height / 2);
        back.setY(stackTop + reset.height + gap + back.height / 2);
      }
    } else {
      y += ACTIONS_GAP;

      if (this.returnTo !== "Menu") {
        content.add(
          bannerButton(
            this,
            cx,
            y + BUTTON_STEP / 2,
            abandon.label,
            abandon.onClick,
            btnMaxW,
          ),
        );
      } else {
        content.add(this.buildResetButton(cx, y + BUTTON_STEP / 2, btnMaxW));
      }
      y += BUTTON_STEP;

      content.add(
        bannerButton(
          this,
          cx,
          y + BUTTON_STEP / 2,
          backLabel,
          () => this.close(),
          btnMaxW,
        ),
      );
      y += BUTTON_STEP;
    }

    const contentH = (compact ? rowsBottom : y) - viewportTop;
    if (contentH > viewportH - HINT_H) {
      this.enableScroll(
        content,
        this.children.list.filter((obj) => obj !== content),
        viewportX,
        viewportTop,
        viewportW,
        viewportH - HINT_H,
        contentH,
        formCx,
      );
    } else {
      // Nothing to scroll: centre the form in the band it was given rather than
      // leaving it hanging off the masthead with all the slack below it.
      content.y = (viewportH - contentH) / 2;
    }
  }

  /** Overlay Settings crossfades back to the live run beneath it; Settings
   *  opened from the Vestibule hands its still room back to the menu instead. */
  private close(): void {
    this.leave(() => {
      if (this.overlay) this.scene.stop();
      else this.scene.start(this.returnTo);
    });
  }

  private leave(complete: () => void): void {
    if (this.leaving) return;
    this.leaving = true;
    if (this.overlay && this.overlayFelt) {
      slideOverlayOut(this, this.overlayFelt, complete);
    } else {
      slideSceneOut(this, complete, this.slideBackdrop);
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
    cx: number,
  ): void {
    const minY = viewportH - contentH; // most-scrolled (negative)
    const maxY = 0; // top

    // A clip camera renders only `content`; the main camera renders everything
    // else. Scroll matches the viewport's screen position (passthrough at zoom
    // 1). The camera is left transparent, so the felt and the turning sigil the
    // main camera drew stay visible behind the rows.
    // The clip is only needed vertically — the form is narrower than the band
    // it scrolls in — so the camera spans the full width. That lets the scene
    // slide carry the rows clear off the screen rather than having them wink
    // out at the band's edge partway across.
    const cam = addCamera(this, 0, viewportTop, this.scale.width, viewportH);
    cam.setScroll(0, viewportTop);
    this.scrollCamera = cam;
    this.cameras.main.ignore(content);
    cam.ignore(fixed);

    // Vertical scrollbar (display-only; driven by drag/wheel).
    const barX = viewportX + viewportW - 3;
    const barTrack = this.add.rectangle(
      barX,
      viewportTop + viewportH / 2,
      4,
      viewportH,
      COLORS.parchment,
      0.14,
    );
    const thumbH = Math.max(30, (viewportH * viewportH) / contentH);
    const thumb = this.add.rectangle(
      barX,
      viewportTop + thumbH / 2,
      4,
      thumbH,
      COLORS.gold,
      0.8,
    );
    cam.ignore([barTrack, thumb]);
    const updateThumb = () => {
      const progress = (maxY - content.y) / (maxY - minY);
      thumb.y = viewportTop + thumbH / 2 + progress * (viewportH - thumbH);
    };

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= viewportX &&
      p.x <= viewportX + viewportW &&
      p.y >= viewportTop &&
      p.y <= viewportTop + viewportH;

    let dragging = false;
    let startPointerY = 0;
    let startContentY = 0;

    const onDown: PointerHandler = (p) => {
      if (!inBounds(p)) return;
      // Don't hijack presses that land on a slider band, a switch, or a button
      // — let those interact; scroll-drag only starts on empty space.
      if (this.input.hitTestPointer(p).length > 0) return;
      dragging = true;
      startPointerY = p.y;
      startContentY = content.y;
    };
    const onMove: PointerHandler = (p) => {
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? "grab" : "default");
        return;
      }
      content.y = Phaser.Math.Clamp(
        startContentY + (p.y - startPointerY),
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
      content.y = Phaser.Math.Clamp(content.y - dy, minY, maxY);
      updateThumb();
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.scrollInput = { down: onDown, move: onMove, up: onUp, wheel: onWheel };

    const hint = this.add
      .text(cx, viewportTop + viewportH + 4, "drag or scroll for more", {
        fontFamily: SERIF,
        fontSize: "13px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5, 0);
    cam.ignore(hint);
  }

  /** "Reset All Progress" with a lightweight two-tap confirm (there's no modal
   *  helper): the first tap arms it, a second within a few seconds wipes item
   *  unlocks, selection counts, games-completed, and the Hall of High Scores.
   *  Audio settings are kept. */
  private buildResetButton(
    cx: number,
    y: number,
    maxWidth: number,
  ): Phaser.GameObjects.Container {
    const DEFAULT = "Reset All Progress";
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
          label.setText("Tap again to confirm");
          timer = this.time.delayedCall(3000, () => {
            confirming = false;
            label.setText(DEFAULT);
          });
          return;
        }
        timer?.remove();
        confirming = false;
        resetAllProgress();
        label.setText("Progress reset");
        showBanner(this, "All progress has been reset", 1200);
      },
      maxWidth,
    );
    return button;
  }

  private apply(): void {
    audio.setVolumes(this.settings.musicVol, this.settings.sfxVol);
    fx.setEnabled(this.settings.visualEffects);
    saveSettings(this.settings);
  }

  /**
   * One slider row: the label and its percentage readout on the top line,
   * sharing the form's left and right edges with every other row, and the track
   * itself beneath them. The whole track is grabbable rather than just the
   * knob, which is what makes it usable with a thumb.
   */
  private makeSlider(
    content: Phaser.GameObjects.Container,
    x0: number,
    x1: number,
    top: number,
    label: string,
    initial: number,
    onChange: (v: number) => void,
  ): void {
    const trackW = x1 - x0;
    const trackY = top + 52;

    const labelText = this.add
      .text(x0, top + 20, label, {
        fontFamily: SERIF,
        fontSize: "21px",
        color: CSS.parchment,
      })
      .setOrigin(0, 0.5);
    const readout = this.add
      .text(x1, top + 20, `${Math.round(initial * 100)}%`, {
        fontFamily: SERIF,
        fontSize: "18px",
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(1, 0.5);

    const bar = this.add.graphics();
    const drawBar = (t: number) => {
      bar.clear();
      bar.fillStyle(COLORS.parchment, 0.16);
      bar.fillRoundedRect(x0, trackY - 3, trackW, 6, 3);
      bar.fillStyle(COLORS.gold, 0.9);
      // A rounded rect narrower than its own corner diameter renders as a
      // pinched sliver, so the filled part never goes below one knuckle.
      bar.fillRoundedRect(x0, trackY - 3, Math.max(6, trackW * t), 6, 3);
    };
    drawBar(initial);

    const knob = this.add.circle(
      x0 + initial * trackW,
      trackY,
      12,
      COLORS.goldLight,
    );
    knob.setStrokeStyle(2, COLORS.feltDark, 0.9);

    // One interactive band covers the knob and the whole track, so a press
    // anywhere along the row's lower line seizes the value and keeps dragging
    // it. It also keeps the scroll-drag from claiming the gesture (see onDown).
    const zone = this.add
      .rectangle(x0 + trackW / 2, trackY, trackW + 24, 36, COLORS.gold, 0.001)
      .setInteractive({ useHandCursor: true });
    this.input.setDraggable(zone);

    // dragX arrives in the content container's local space (Phaser accounts for
    // the parent transform), and the track's x-range is expressed in that same
    // space, so clamp directly.
    const setFromX = (x: number) => {
      const value = Phaser.Math.Clamp((x - x0) / trackW, 0, 1);
      knob.x = x0 + value * trackW;
      readout.setText(`${Math.round(value * 100)}%`);
      drawBar(value);
      onChange(value);
    };
    zone.on("pointerdown", (p: Phaser.Input.Pointer) => setFromX(p.worldX));
    zone.on("drag", (_p: Phaser.Input.Pointer, dragX: number) =>
      setFromX(dragX),
    );
    zone.on("dragend", () => audio.click());

    content.add([labelText, readout, bar, knob, zone]);
  }
}
