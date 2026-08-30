import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { artImage } from "../art/textures";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";

/** Felt tabletop background, stretched to cover the current viewport.
 *  `overscan` bleeds it past every edge — pass a few pixels in scenes that
 *  shake the camera, so the shake never drags a bare edge into view. */
export function addFelt(
  scene: Phaser.Scene,
  overscan = 0,
): Phaser.GameObjects.Image {
  const { width, height } = scene.scale;
  return scene.add
    .image(width / 2, height / 2, "felt")
    .setDisplaySize(width + overscan * 2, height + overscan * 2);
}

/** Parchment panel sized to an explicit display box (non-uniform scale is fine — procedural art). */
export function addPanel(
  scene: Phaser.Scene,
  cx: number,
  cy: number,
  w: number,
  h: number,
): Phaser.GameObjects.Image {
  return scene.add.image(cx, cy, "panel").setDisplaySize(w, h);
}

/** Horizontal breathing room kept between a button's label and the parchment
 *  edge when the label is what drives the button's width. */
const BUTTON_LABEL_PAD = 28;
/** Margin kept between a button and the viewport edges when no explicit
 *  `maxWidth` confines it. */
const BUTTON_SCREEN_MARGIN = 32;

/** Reduce a text object's actual font size until it fits `maxWidth`; a no-op
 *  when it already does. Baking at the final size avoids the fractional object
 *  scale that can make glyph edges look soft. */
export function fitTextWidth(
  text: Phaser.GameObjects.Text,
  maxWidth: number,
): Phaser.GameObjects.Text {
  if (text.width <= maxWidth) return text;

  const fontSize = Number.parseFloat(String(text.style.fontSize));
  if (Number.isFinite(fontSize) && fontSize > 0) {
    text.setFontSize(
      Math.max(1, Math.floor(fontSize * (maxWidth / text.width))),
    );
  } else {
    // Defensive fallback for an unusual non-pixel font style.
    text.setScale(maxWidth / text.width);
  }
  return text;
}

/** Parchment banner button with hover/press feedback. Pass `maxWidth` to resize
 *  it when it would be wider than the space available (e.g. a narrow settings
 *  panel); without one it still stays inside the viewport. Pass `maxHeight`
 *  where the vertical room is what runs out first — a column of buttons on a
 *  short viewport, or a stack whose pitch is a fraction of the viewport height
 *  — and the button shrinks to that budget, label and all, rather than
 *  overflowing the screen or lapping the button below it. The background is
 *  resized, while the label is re-rendered at its final font size instead of
 *  fractionally scaling the whole container and blurring the text. */
export function bannerButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  onClick: () => void,
  maxWidth?: number,
  maxHeight?: number,
): Phaser.GameObjects.Container {
  // `artImage`, not `scene.add.image`: the parchment is baked above layout
  // resolution, and every measurement below — the button's own width, the
  // height budget, the label's font size — is taken off the image, so it has to
  // be the size the art was designed at rather than the pixels it is stored in.
  const img = artImage(scene, 0, 0, "btn");
  const text = scene.add
    .text(0, 0, label, { fontFamily: SERIF, fontSize: "26px", color: CSS.ink })
    .setOrigin(0.5);
  const container = scene.add.container(x, y, [img, text]);
  const contentW = Math.max(img.displayWidth, text.width + BUTTON_LABEL_PAD);
  const limit = maxWidth ?? scene.scale.width - BUTTON_SCREEN_MARGIN;
  // Whichever axis runs out first sets the scale, so the label shrinks with
  // the parchment instead of being sized off a width that was never the
  // binding constraint.
  const heightScale = maxHeight
    ? Math.max(0, maxHeight) / img.displayHeight
    : 1;
  const displayScale = Math.min(1, limit / contentW, heightScale);
  const displayW = img.displayWidth * displayScale;
  const displayH = img.displayHeight * displayScale;
  const labelPad = Math.max(12, BUTTON_LABEL_PAD * displayScale);

  img.setDisplaySize(displayW, displayH);
  text.setFontSize(Math.max(13, Math.round(26 * displayScale)));
  fitTextWidth(text, Math.max(1, displayW - labelPad));
  container.setSize(displayW, displayH);
  container.setInteractive({ useHandCursor: true });
  container.on("pointerover", () => img.setTint(0xfff2c8));
  container.on("pointerout", () => img.clearTint());
  container.on("pointerdown", () => {
    audio.click();
    onClick();
  });
  return container;
}

/** One entry in a column of banner buttons. */
export interface BannerAction {
  label: string;
  onClick: () => void;
}

/** Vertical breathing room between stacked banner buttons: the pitch opens up
 *  to the maximum where there's room to spare, and never closes past the
 *  minimum — which is also the air the stack reserves when it has to shrink
 *  the buttons to fit the band at all. */
const STACK_GAP_MIN = 6;
const STACK_GAP_MAX = 22;

/**
 * Stack banner buttons down a column, each sized to the column's width and the
 * set spaced to sit centred in `band` without ever overlapping. The
 * compact-landscape screens all put their actions in one column, and a fixed
 * vertical pitch is exactly what breaks on a short viewport — so the pitch is
 * derived from the buttons' own measured heights and whatever room is left.
 *
 * Once the gap is down to its minimum there's nothing left to give, so below
 * that the buttons themselves shrink: each is capped at its even share of the
 * band less the gaps, which is what keeps the last one on screen on a viewport
 * as short as a handset in landscape.
 */
export function stackBannerButtons(
  scene: Phaser.Scene,
  column: { cx: number; width: number },
  band: { top: number; height: number },
  actions: BannerAction[],
): Phaser.GameObjects.Container[] {
  const gaps = Math.max(1, actions.length - 1);
  const share = Math.max(
    1,
    (band.height - STACK_GAP_MIN * gaps) / Math.max(1, actions.length),
  );
  const buttons = actions.map((action) =>
    bannerButton(
      scene,
      column.cx,
      0,
      action.label,
      action.onClick,
      column.width,
      share,
    ),
  );
  const stackH = buttons.reduce((sum, button) => sum + button.height, 0);
  const gap = Phaser.Math.Clamp(
    (band.height - stackH) / gaps,
    STACK_GAP_MIN,
    STACK_GAP_MAX,
  );
  let y = band.top + Math.max(0, (band.height - stackH - gap * gaps) / 2);
  for (const button of buttons) {
    button.setY(y + button.height / 2);
    y += button.height + gap;
  }
  return buttons;
}

/**
 * A labelled checkbox row centered on (x, y): a gold check in an ink-bordered
 * box to the left, the label to its right. Tapping anywhere on the row toggles
 * it, plays a click, and reports the new value. Returns the container so callers
 * can drop it into a scroll content container or reposition it. The returned
 * container carries `setChecked` so callers can reflect state changed elsewhere
 * (e.g. fullscreen toggled with Esc/F11) without firing `onChange`.
 */
export interface CheckboxRow extends Phaser.GameObjects.Container {
  setChecked(value: boolean): void;
}

/** Optional color overrides so a row reads on either background: the defaults
 *  suit a parchment panel (ink text, ink border); pass light values to place
 *  the row on the dark felt (e.g. the intro). */
export interface CheckboxRowStyle {
  textColor?: string;
  boxStroke?: number;
}

export function checkboxRow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  initial: boolean,
  onChange: (value: boolean) => void,
  boxSize = 26,
  style: CheckboxRowStyle = {},
): CheckboxRow {
  let value = initial;
  const textColor = style.textColor ?? CSS.ink;
  const boxStroke = style.boxStroke ?? COLORS.ink;

  const box = scene.add
    .rectangle(0, 0, boxSize, boxSize, COLORS.feltLight, 0.35)
    .setOrigin(0, 0.5);
  box.setStrokeStyle(2, boxStroke, 0.9);
  const check = scene.add
    .rectangle(boxSize / 2, 0, boxSize * 0.5, boxSize * 0.5, COLORS.gold)
    .setOrigin(0.5)
    .setVisible(value);
  const text = scene.add
    .text(boxSize + 14, 0, label, {
      fontFamily: SERIF,
      fontSize: "22px",
      color: textColor,
    })
    .setOrigin(0, 0.5);

  // Origin the container on the box's left edge, then shift so the whole row
  // reads as centered on x.
  const rowW = boxSize + 14 + text.width;
  // Pad the hit area vertically so clicks land anywhere across the box or the
  // label, not just on the thin band the glyphs occupy.
  const hitH = Math.max(boxSize, text.height) + 20;
  const container = scene.add.container(x - rowW / 2, y, [box, check, text]);
  container.setSize(rowW, hitH);
  // Measured from the container's top-left: Phaser adds the display origin to
  // the point before testing it (see toggleRow).
  container.setInteractive(
    new Phaser.Geom.Rectangle(0, 0, rowW, hitH),
    Phaser.Geom.Rectangle.Contains,
  );
  container.input!.cursor = "pointer";
  container.on("pointerdown", () => {
    value = !value;
    check.setVisible(value);
    audio.click();
    onChange(value);
  });

  const row = container as CheckboxRow;
  row.setChecked = (v: boolean) => {
    value = v;
    check.setVisible(value);
  };
  return row;
}

/** The switch drawn at the right end of a `toggleRow`: pill track, round knob.
 *  Sized so the knob clears the track's stroke by a pixel on every side. */
const SWITCH_W = 52;
const SWITCH_H = 28;
const SWITCH_KNOB_R = 11;
/** How far the knob sits from the switch's centre in each state. */
const SWITCH_THROW = SWITCH_W / 2 - SWITCH_H / 2;

export interface ToggleRow extends Phaser.GameObjects.Container {
  setChecked(value: boolean): void;
}

/**
 * A full-width settings row: label on the left, a pill switch on the right,
 * with the whole band clickable. Where `checkboxRow` centres a box-and-label
 * pair as one lump — which leaves a ragged column when several are stacked —
 * this pins the labels to one left edge and the switches to one right edge, so
 * a stack of rows reads as a form.
 *
 * Colours assume the dark felt rather than a parchment panel. The returned
 * container carries `setChecked` so callers can reflect state changed
 * elsewhere (fullscreen toggled with Esc/F11) without firing `onChange`.
 */
export function toggleRow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  label: string,
  initial: boolean,
  onChange: (value: boolean) => void,
  height = 52,
): ToggleRow {
  let value = initial;
  let hovered = false;

  const labelText = scene.add
    .text(-width / 2, 0, label, {
      fontFamily: SERIF,
      fontSize: "21px",
      color: CSS.parchment,
    })
    .setOrigin(0, 0.5);

  const switchX = width / 2 - SWITCH_W / 2;
  const track = scene.add.graphics({ x: switchX, y: 0 });
  const knob = scene.add.circle(
    switchX + (value ? SWITCH_THROW : -SWITCH_THROW),
    0,
    SWITCH_KNOB_R,
    COLORS.ivory,
  );

  const redraw = () => {
    track.clear();
    track.fillStyle(value ? COLORS.gold : COLORS.feltLight, value ? 0.9 : 0.85);
    track.fillRoundedRect(
      -SWITCH_W / 2,
      -SWITCH_H / 2,
      SWITCH_W,
      SWITCH_H,
      SWITCH_H / 2,
    );
    track.lineStyle(
      1.5,
      value ? COLORS.goldLight : COLORS.parchmentDark,
      hovered ? 0.95 : 0.6,
    );
    track.strokeRoundedRect(
      -SWITCH_W / 2,
      -SWITCH_H / 2,
      SWITCH_W,
      SWITCH_H,
      SWITCH_H / 2,
    );
    labelText.setColor(hovered ? CSS.ivory : CSS.parchment);
    knob.setFillStyle(value ? COLORS.ivory : COLORS.parchmentDark);
  };
  redraw();

  const container = scene.add.container(x, y, [labelText, track, knob]);
  container.setSize(width, height);
  // Phaser normalizes a hit test by adding the object's display origin before
  // running the callback, and setSize puts a container's origin at its centre —
  // so a hit area for a centred container is measured from its top-left corner,
  // not from its middle.
  container.setInteractive(
    new Phaser.Geom.Rectangle(0, 0, width, height),
    Phaser.Geom.Rectangle.Contains,
  );
  container.input!.cursor = "pointer";

  const settle = () => {
    const knobX = switchX + (value ? SWITCH_THROW : -SWITCH_THROW);
    scene.tweens.killTweensOf(knob);
    if (fx.motion) {
      scene.tweens.add({
        targets: knob,
        x: knobX,
        duration: 150,
        ease: "Cubic.easeOut",
      });
    } else {
      knob.x = knobX;
    }
    redraw();
  };

  container.on("pointerover", () => {
    hovered = true;
    redraw();
  });
  container.on("pointerout", () => {
    hovered = false;
    redraw();
  });
  container.on("pointerdown", () => {
    value = !value;
    settle();
    audio.click();
    onChange(value);
  });

  const row = container as ToggleRow;
  row.setChecked = (v: boolean) => {
    if (v === value) return;
    value = v;
    settle();
  };
  return row;
}

/** Floating score text that drifts up and fades. Returns the Text so callers
 *  that render through a secondary camera (e.g. a windowed dice grid) can
 *  exclude it from that camera and keep it above everything. */
export function floatText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  message: string,
  color: string = CSS.goldLight,
  size = 30,
): Phaser.GameObjects.Text {
  const text = scene.add
    .text(x, y, message, {
      fontFamily: SERIF,
      fontSize: `${size}px`,
      color,
      fontStyle: "bold",
      stroke: "#0d0a12",
      strokeThickness: 4,
    })
    .setOrigin(0.5)
    .setDepth(50);
  scene.tweens.add({
    targets: text,
    y: y - 70,
    alpha: 0,
    duration: 1100,
    ease: "Quad.easeOut",
    onComplete: () => text.destroy(),
  });
  return text;
}

/** A denied score float: the value appears in the usual scoring colour, but a
 * red stroke cancels it before the pair drifts away together. */
export function struckFloatText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  message: string,
  color: string = CSS.goldLight,
  size = 24,
): Phaser.GameObjects.Container {
  const text = scene.add
    .text(0, 0, message, {
      fontFamily: SERIF,
      fontSize: `${size}px`,
      color,
      fontStyle: "bold",
      stroke: "#0d0a12",
      strokeThickness: 4,
    })
    .setOrigin(0.5);
  const strike = scene.add.graphics();
  strike.lineStyle(Math.max(2, size * 0.11), COLORS.waxRed, 1);
  strike.lineBetween(-text.width / 2 - 4, 0, text.width / 2 + 4, 0);
  const container = scene.add.container(x, y, [text, strike]).setDepth(50);
  scene.tweens.add({
    targets: container,
    y: y - 70,
    alpha: 0,
    duration: 1100,
    ease: "Quad.easeOut",
    onComplete: () => container.destroy(),
  });
  return container;
}

/** Centered announcement banner that slides in, holds, and fades. Returns
 *  its GameObjects — see `floatText` for why. */
export function showBanner(
  scene: Phaser.Scene,
  message: string,
  holdMs = 1100,
): Phaser.GameObjects.GameObject[] {
  const cx = scene.scale.width / 2;
  const cy = scene.scale.height / 2;
  const img = artImage(scene, cx, cy, "banner").setDepth(90).setAlpha(0);
  const text = scene.add
    .text(cx, cy, message, {
      fontFamily: SERIF,
      fontSize: "34px",
      color: CSS.goldLight,
    })
    .setOrigin(0.5)
    .setDepth(91)
    .setAlpha(0);
  scene.tweens.add({
    targets: [img, text],
    alpha: 1,
    duration: 200,
    onComplete: () => {
      scene.tweens.add({
        targets: [img, text],
        alpha: 0,
        delay: holdMs,
        duration: 300,
        onComplete: () => {
          img.destroy();
          text.destroy();
        },
      });
    },
  });
  return [img, text];
}

/** Vertical spacing between stacked banners (px), on top of the banner height. */
const BANNER_GAP = 14;

/**
 * A vertically-stacked queue of announcement banners. Where a bare `showBanner`
 * always lands at scene center — so two firing at once overlap — a stack lays
 * its live banners out in a column centered on the scene and smoothly reflows
 * them as banners come and go, so nothing ever overlaps. Each banner fades in,
 * holds, and fades out independently; when one leaves, the survivors slide to
 * close the gap.
 *
 * The owning scene passes a `register` callback so freshly-created banner
 * objects can be routed through its overlay camera (see GameScene.overlay);
 * scenes that don't window their content can omit it.
 */
export class BannerStack {
  private entries: {
    container: Phaser.GameObjects.Container;
    slotH: number;
  }[] = [];

  constructor(
    private scene: Phaser.Scene,
    private register: (
      objs: Phaser.GameObjects.GameObject[],
    ) => void = () => {},
  ) {}

  /** Push a banner onto the stack. `detail`, when given, is rendered as a
   *  smaller second line beneath the headline. */
  push(message: string, opts: { holdMs?: number; detail?: string } = {}): void {
    const scene = this.scene;
    const holdMs = opts.holdMs ?? 1100;
    const hasDetail = !!opts.detail;

    const img = artImage(scene, 0, 0, "banner");
    const title = scene.add
      .text(0, hasDetail ? -13 : 0, message, {
        fontFamily: SERIF,
        fontSize: "30px",
        color: CSS.goldLight,
      })
      .setOrigin(0.5);
    const container = scene.add.container(
      scene.scale.width / 2,
      scene.scale.height / 2,
      [img, title],
    );
    let detailW = 0;
    if (opts.detail) {
      const detail = scene.add
        .text(0, 17, opts.detail, {
          fontFamily: SERIF,
          fontSize: "19px",
          color: CSS.parchment,
        })
        .setOrigin(0.5);
      container.add(detail);
      detailW = detail.width;
    }
    // Shrink uniformly to fit narrow (portrait/mobile) viewports rather than
    // overflow the sides — driven by whichever is widest, the parchment strip
    // or a long text line, since the text isn't confined to the strip.
    const contentW = Math.max(img.displayWidth, title.width, detailW);
    const maxW = scene.scale.width - 40;
    const scale = contentW > maxW ? maxW / contentW : 1;
    container.setScale(scale).setDepth(90).setAlpha(0);

    const entry = { container, slotH: img.displayHeight * scale + BANNER_GAP };
    this.entries.push(entry);
    this.register([container]);
    this.layout();

    scene.tweens.add({ targets: container, alpha: 1, duration: 200 });
    scene.time.delayedCall(200 + holdMs, () => {
      scene.tweens.add({
        targets: container,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          container.destroy();
          this.entries = this.entries.filter((e) => e !== entry);
          this.layout();
        },
      });
    });
  }

  /** Reflow live banners into a centered column, tweening each to its slot. */
  private layout(): void {
    const anchorY = this.scene.scale.height / 2;
    const totalH = this.entries.reduce((sum, e) => sum + e.slotH, 0);
    let top = anchorY - totalH / 2;
    for (const e of this.entries) {
      const targetY = top + e.slotH / 2;
      this.scene.tweens.add({
        targets: e.container,
        y: targetY,
        duration: 200,
        ease: "Cubic.out",
      });
      top += e.slotH;
    }
  }
}
