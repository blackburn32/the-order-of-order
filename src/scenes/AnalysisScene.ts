import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { fx } from "../systems/Effects";
import { addFelt, bannerButton, fitTextWidth } from "../ui/widgets";
import {
  Column,
  compactColumns,
  COMPACT_LANDSCAPE_MAX_H,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import { slideOverlayIn, slideOverlayOut } from "../ui/sceneSlide";
import { combinePointsByItem, PointEntry } from "../systems/ItemPoints";
import { formatScore } from "../ui/formatScore";

/** What to chart. Either the run's raw point maps (Game Over / Victory / local
 *  Hall, which keep the dice-vs-bonus split) or a pre-combined list (a global
 *  Hall row, whose metadata carries only per-item totals). */
export interface AnalysisData {
  /** Scene key whose input to re-enable when this overlay closes. */
  returnTo: string;
  title?: string;
  subtitle?: string;
  dicePoints?: Record<string, number>;
  itemPoints?: Record<string, number>;
  entries?: { id: string; label: string; points: number }[];
}

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (
  pointer: Phaser.Input.Pointer,
  over: unknown,
  dx: number,
  dy: number,
  dz: number,
) => void;

/** Fixed sigil brightness for the backdrop — there is no live round to report
 *  here, so the value is chosen purely for how it looks (see SettingsScene). */
const ANALYSIS_AMBIENCE = 0.55;

/** Row pitch bounds. A short list opens the rows out to the maximum; a long one
 *  closes them to the minimum and scrolls the remainder. */
const MIN_ROW_H = 26;
const MAX_ROW_H = 46;

/** Strip kept clear under the chart for its legend / scroll hint. Wider than
 *  the line it holds: a scrolling list is cut off mid-row at the band edge, and
 *  without a little air that cut lands right on top of the legend. */
const FOOTNOTE_H = 24;

/** Where a list too short to fill its band sits within it: 0 pins it to the
 *  top, 0.5 centres it. */
const SHORT_LIST_BIAS = 0.34;

/** How long the bars take to grow in once the overlay has come to rest. */
const BAR_REVEAL_MS = 560;

/** One bar's geometry, resolved at layout time and redrawn on each frame of the
 *  reveal. Widths are the bar's *full* extent; the reveal scales them. */
interface BarSpec {
  x: number;
  y: number;
  h: number;
  /** Width of the base rolling-points segment (gold). */
  dice: number;
  /** Width of the bonus/multiplier segment (green), stacked after it. */
  bonus: number;
}

/**
 * A per-run "which items earned the points" bar chart, launched as an overlay on
 * top of Game Over / Victory / Hall (like InitialsPromptScene).
 *
 * It wears the same room as the rest of the game rather than a parchment panel:
 * felt, a turning sigil inside its counter-turning ring, the shared masthead
 * with its breathing halo, and the type sitting directly on the table. Bars
 * split base rolling points (from the dice an item provided) from the item's own
 * bonus/multiplier payouts where that split is known, and the list scrolls when
 * a long run has more sources than the viewport has rows.
 */
export class AnalysisScene extends Phaser.Scene {
  private returnTo = "Menu";
  private title = "Run Analysis";
  private subtitle = "";
  private entries: PointEntry[] = [];
  private total = 0;
  private hasSplit = false;

  private felt?: Phaser.GameObjects.Image;
  private leaving = false;
  /** Clips the scrolling chart; absent when the whole list fits. */
  private scrollCamera?: Phaser.Cameras.Scene2D.Camera;
  private scrollInput?: {
    down: PointerHandler;
    move: PointerHandler;
    up: PointerHandler;
    wheel: WheelHandler;
  };
  private bars: BarSpec[] = [];
  private barGfx?: Phaser.GameObjects.Graphics;
  private barTween?: Phaser.Tweens.Tween;
  /** Runs the bar growth. Held back until the entrance has landed, so the two
   *  animations read as one arrival rather than talking over each other. */
  private reveal?: () => void;

  constructor() {
    super("Analysis");
  }

  init(data: AnalysisData): void {
    this.returnTo = data.returnTo;
    this.title = data.title ?? "Run Analysis";
    this.subtitle = data.subtitle ?? "";
    if (data.entries) {
      // Pre-combined (global row): totals only, no dice/bonus split.
      this.entries = [...data.entries]
        .filter((e) => e.points > 0)
        .map((e) => ({
          id: e.id,
          label: e.label,
          dice: 0,
          bonus: 0,
          points: e.points,
        }))
        .sort((a, b) => b.points - a.points);
    } else {
      this.entries = combinePointsByItem(
        data.dicePoints,
        data.itemPoints,
      ).filter((e) => e.points > 0);
    }
    this.total = this.entries.reduce((s, e) => s + e.points, 0);
    this.hasSplit = this.entries.some((e) => e.dice > 0 && e.bonus > 0);
  }

  create(): void {
    // Block the scene underneath from reacting to taps/hovers while we are open.
    const base = this.scene.get(this.returnTo);
    if (base) base.input.enabled = false;

    this.leaving = false;
    this.scrollCamera = undefined;
    // Not using responsive() — its rebuild doesn't clear the extra camera and
    // input listeners a scroll view needs, so drive rebuilds manually.
    this.build();
    if (this.felt) slideOverlayIn(this, this.felt, () => this.reveal?.());
    else this.reveal?.();

    const off = onResizeCoalesced(this, () => {
      this.teardown();
      destroyAllChildren(this);
      this.build();
      // A resize has no entrance to wait on.
      this.reveal?.();
    });

    this.input.keyboard?.on("keydown-ESC", this.close, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardown();
      this.input.keyboard?.off("keydown-ESC", this.close, this);
      const b = this.scene.get(this.returnTo);
      if (b) b.input.enabled = true;
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
    // The reveal tween outlives the graphics it writes to.
    this.barTween?.remove();
    this.barTween = undefined;
    this.barGfx = undefined;
    this.bars = [];
    this.reveal = undefined;
    this.input.setDefaultCursor("default");
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    // A complete room of its own: the overlay is launched over a live scene, so
    // an opaque felt layer keeps the two interfaces from tangling. The base
    // scene's input is off for as long as we are up, so nothing reaches it.
    const felt = addFelt(this);
    this.felt = felt;
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(W / 2, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(ANALYSIS_AMBIENCE, false);

    // The shared threshold rules out columns below 500px because the denser
    // game screens need more width. A chart of labelled bars keeps working in a
    // narrow column, and a short viewport has no other way to show more than a
    // row or two — so this screen folds on any short landscape view.
    const compact =
      isCompactLandscape(W, H) || (W > H && H < COMPACT_LANDSCAPE_MAX_H);
    if (compact) this.buildCompact();
    else this.buildStacked();
  }

  /** The roomy/portrait composition: masthead, total, chart, then the way out. */
  private buildStacked(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const header = buildSceneHeader(this, {
      title: this.title,
      subtitle: this.subtitle || undefined,
      y: Math.max(46, Math.min(H * 0.13, 88)),
      width: Math.min(W, 720),
    });

    const totalBottom = this.buildTotal(
      cx,
      Math.min(W - 32, 620),
      header.bottom + 12,
    );

    const close = bannerButton(
      this,
      cx,
      0,
      "Close",
      () => this.close(),
      Math.min(W - 32, 320),
    );
    close.setY(H - 16 - close.height / 2);

    const chartW = Math.min(W - 40, 620);
    this.buildChart(
      { x: cx - chartW / 2, cx, width: chartW, right: cx + chartW / 2 },
      totalBottom + 16,
      H - 16 - close.height - 16,
    );
  }

  /** A handset in landscape has width but almost no height: the masthead, the
   *  run's total and the way out take one column, the chart the other — at full
   *  height, which is what buys it enough rows to be worth reading. */
  private buildCompact(): void {
    const columns = compactColumns(this, { leftFraction: 0.4 });
    const { left, right } = columns;

    // The shared masthead keeps generous air around its rule and subtitle.
    // Below this height that air costs the chart its rows, so use a
    // single-line title/detail block instead (see InitialsPromptScene).
    const short = columns.height < 215;
    const headerBottom = short
      ? this.buildShortHeader(left.cx, left.width, columns.top)
      : buildSceneHeader(this, {
          title: this.title,
          subtitle: this.subtitle || undefined,
          x: left.cx,
          y: columns.top + 30,
          width: left.width,
        }).bottom;

    const totalBottom = this.buildTotal(
      left.cx,
      left.width,
      headerBottom + (short ? 4 : 8),
    );

    // Whatever is left of the column below the total belongs to the one control
    // this screen has; it shrinks to that budget rather than lapping the text
    // above it or running off the bottom.
    const bandTop = totalBottom + 10;
    const bandH = Math.max(30, columns.bottom - bandTop);
    const close = bannerButton(
      this,
      left.cx,
      0,
      "Close",
      () => this.close(),
      left.width,
      bandH,
    );
    close.setY(bandTop + bandH / 2);

    this.buildChart(right, columns.top, columns.bottom);
  }

  /** A low-profile masthead for landscape viewports with barely any usable
   *  height: one stroked title line, a hairline, and the detail beneath it. */
  private buildShortHeader(cx: number, width: number, top: number): number {
    const titleSize = 22;
    const title = this.add
      .text(cx, top, this.title, {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        stroke: "#0d0a12",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 0)
      .setShadow(0, 3, "#000000", 8, true, true);
    fitTextWidth(title, width);

    const ruleY = title.getBounds().bottom + 3;
    const rule = this.add.graphics();
    rule.lineStyle(1, COLORS.gold, 0.52);
    rule.lineBetween(cx - width / 2, ruleY, cx + width / 2, ruleY);
    if (!this.subtitle) return ruleY + 2;

    const detail = this.add
      .text(cx, ruleY + 3, this.subtitle, {
        fontFamily: SERIF,
        fontSize: "12px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5, 0);
    fitTextWidth(detail, width);
    return detail.getBounds().bottom;
  }

  /** The run's headline number, in gold under the masthead. Returns the y it
   *  ends at, which is where the chart begins. */
  private buildTotal(cx: number, maxWidth: number, top: number): number {
    if (this.total <= 0) return top;
    const size = Math.round(Phaser.Math.Clamp(maxWidth * 0.055, 17, 26));
    const text = this.add
      .text(cx, top, `${formatScore(this.total)} points`, {
        fontFamily: SERIF,
        fontSize: `${size}px`,
        color: CSS.goldLight,
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0)
      .setShadow(0, 3, "#000000", 9, false, true);
    fitTextWidth(text, maxWidth);
    return text.getBounds().bottom;
  }

  /**
   * The ranked bars, filling `column` between `top` and `bottom`. Each row is
   * two lines — source and points over a full-width bar — so the bars stay long
   * enough to compare at any width, instead of a label column eating half of a
   * folded viewport.
   */
  private buildChart(column: Column, top: number, bottom: number): void {
    const band = Math.max(48, bottom - top);

    if (this.entries.length === 0) {
      this.add
        .text(column.cx, top + band / 2, "No points recorded for this run.", {
          fontFamily: SERIF,
          fontSize: "17px",
          color: CSS.dim,
          fontStyle: "italic",
          align: "center",
          wordWrap: { width: column.width },
        })
        .setOrigin(0.5);
      return;
    }

    const count = this.entries.length;
    // The footnote's strip has to be reserved before the rows are measured, but
    // whether it carries a scroll hint is only known once they have been — so
    // measure again if reserving it is what made the list scroll.
    const measure = (noteH: number) => {
      const avail = Math.max(44, band - noteH);
      const rowH = Phaser.Math.Clamp(avail / count, MIN_ROW_H, MAX_ROW_H);
      const contentH = rowH * count;
      const scroll = contentH > avail + 0.5;
      // A band that scrolls is trimmed to a whole number of rows, so the list
      // at rest ends on a finished row rather than one sliced through the
      // middle of its label — which reads as a broken layout rather than as
      // "there is more below".
      const viewH = scroll
        ? Math.max(rowH, Math.floor(avail / rowH) * rowH)
        : avail;
      return { viewH, rowH, contentH, scroll };
    };
    let noteH = this.hasSplit ? FOOTNOTE_H : 0;
    let m = measure(noteH);
    if (!this.hasSplit && m.scroll) {
      noteH = FOOTNOTE_H;
      m = measure(noteH);
    }

    // Built before the content container so the camera split below can treat
    // "everything that is not the content" as the fixed layer.
    const notes: string[] = [];
    if (this.hasSplit) notes.push("gold · dice   green · bonus");
    if (m.scroll) notes.push("drag or scroll for more");
    if (notes.length) {
      const note = this.add
        .text(column.cx, top + m.viewH + 7, notes.join("   ·   "), {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.dim,
          fontStyle: "italic",
        })
        .setOrigin(0.5, 0);
      fitTextWidth(note, column.width);
    }

    // A scrolling chart gives the scrollbar its own gutter, so the bars never
    // run underneath it.
    const chartW = Math.max(60, column.width - (m.scroll ? 14 : 0));
    const x0 = column.x;
    const x1 = x0 + chartW;
    const labelSize = Math.round(Phaser.Math.Clamp(m.rowH * 0.4, 12, 19));
    const valueSize = Math.round(Phaser.Math.Clamp(m.rowH * 0.38, 12, 18));
    const barH = Math.round(Phaser.Math.Clamp(m.rowH * 0.2, 6, 11));
    const max = Math.max(1, ...this.entries.map((e) => e.points));

    // Geometry first: the top bar's glow needs its own row's measurements, and
    // the glow has to go into the container beneath the bars.
    this.bars = this.entries.map((e, i) => {
      const rowTop = top + i * m.rowH;
      // A source with no recorded split charts as one solid gold bar.
      const split = e.dice + e.bonus > 0;
      return {
        x: x0,
        y: rowTop + m.rowH * 0.58,
        h: barH,
        dice: ((split ? e.dice : e.points) / max) * chartW,
        bonus: ((split ? e.bonus : 0) / max) * chartW,
      };
    });

    const content = this.add.container(0, 0);

    // The run's biggest earner gets a little light on it — the same additive
    // halo the mastheads use, so the eye lands on the top of the list first.
    if (fx.rich) {
      const lead = this.bars[0];
      const leadW = Math.max(barH, lead.dice + lead.bonus);
      const glow = this.add
        .image(lead.x + leadW / 2, lead.y + barH / 2, "spark")
        .setTint(COLORS.glow)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(leadW + 60, barH * 7)
        .setAlpha(0.16);
      content.add(glow);
      if (fx.motion) {
        const baseScaleX = glow.scaleX;
        this.tweens.add({
          targets: glow,
          alpha: { from: 0.09, to: 0.2 },
          scaleX: { from: baseScaleX * 0.97, to: baseScaleX * 1.03 },
          duration: 2400,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        });
      }
    }

    const gfx = this.add.graphics();
    content.add(gfx);
    this.barGfx = gfx;

    this.entries.forEach((e, i) => {
      const textY = top + i * m.rowH + m.rowH * 0.29;
      const value = this.add
        .text(x1, textY, formatScore(e.points), {
          fontFamily: SERIF,
          fontSize: `${valueSize}px`,
          color: CSS.goldLight,
          fontStyle: "bold",
        })
        .setOrigin(1, 0.5);
      const label = this.add
        .text(x0, textY, e.label, {
          fontFamily: SERIF,
          fontSize: `${labelSize}px`,
          color: i === 0 ? CSS.ivory : CSS.parchment,
        })
        .setOrigin(0, 0.5);
      fitTextWidth(label, Math.max(24, chartW - value.width - 14));
      content.add([label, value]);
    });

    this.drawBars(fx.motion ? 0 : 1);
    this.reveal = () => {
      if (!fx.motion || !this.barGfx) return;
      this.barTween?.remove();
      const state = { t: 0 };
      this.barTween = this.tweens.add({
        targets: state,
        t: 1,
        duration: BAR_REVEAL_MS,
        ease: "Cubic.easeOut",
        onUpdate: () => this.drawBars(state.t),
      });
    };

    if (m.scroll) {
      this.enableScroll(
        content,
        this.children.list.filter((obj) => obj !== content),
        column,
        top,
        m.viewH,
        m.contentH,
      );
    } else {
      // Nothing to scroll. Sit the list a little above the band's centre: a run
      // with two or three sources leaves most of the band empty, and a lone bar
      // stranded in the middle of it reads as a mistake, where one gathered up
      // under the total reads as a short list.
      content.y = (m.viewH - m.contentH) * SHORT_LIST_BIAS;
    }
  }

  /** Redraw every bar at `t` of its full length. One Graphics for the lot keeps
   *  the reveal to a single draw call per frame. */
  private drawBars(t: number): void {
    const g = this.barGfx;
    if (!g || !g.scene) return;
    g.clear();
    for (const bar of this.bars) {
      const r = bar.h / 2;
      g.fillStyle(COLORS.parchment, 0.13);
      g.fillRoundedRect(
        bar.x,
        bar.y,
        Math.max(bar.h, bar.dice + bar.bonus),
        bar.h,
        r,
      );
      // Stacked as two pills, the bonus drawn full-length first and the dice
      // portion laid over its left end. A rounded rect narrower than its own
      // corner diameter renders as a pinched sliver, so neither goes below one
      // knuckle.
      const dice = bar.dice * t;
      const bonus = bar.bonus * t;
      if (bonus > 0) {
        g.fillStyle(COLORS.glowGreen, 0.9);
        g.fillRoundedRect(
          bar.x,
          bar.y,
          Math.max(bar.h, dice + bonus),
          bar.h,
          r,
        );
      }
      if (dice > 0) {
        g.fillStyle(COLORS.gold, 0.95);
        g.fillRoundedRect(bar.x, bar.y, Math.max(bar.h, dice), bar.h, r);
      }
    }
  }

  /** Clip `content` to the chart's band with a dedicated camera and wire
   *  vertical drag / wheel / scrollbar — mirrors the settings form. */
  private enableScroll(
    content: Phaser.GameObjects.Container,
    fixed: Phaser.GameObjects.GameObject[],
    column: Column,
    viewTop: number,
    viewH: number,
    contentH: number,
  ): void {
    const minY = viewH - contentH; // most-scrolled (negative)
    const maxY = 0; // top

    // A clip camera renders only `content`; the main camera renders everything
    // else. It is left transparent, so the felt and the turning sigil the main
    // camera drew stay visible behind the rows. The clip is only needed
    // vertically, so the camera spans the full width — that lets the scene
    // slide carry the rows clear off the screen rather than having them wink
    // out at the band's edge partway across.
    const cam = this.cameras.add(0, viewTop, this.scale.width, viewH);
    cam.setScroll(0, viewTop);
    this.scrollCamera = cam;
    this.cameras.main.ignore(content);
    cam.ignore(fixed);

    const barX = column.x + column.width - 3;
    const track = this.add.rectangle(
      barX,
      viewTop + viewH / 2,
      4,
      viewH,
      COLORS.parchment,
      0.14,
    );
    const thumbH = Math.max(28, (viewH * viewH) / contentH);
    const thumb = this.add.rectangle(
      barX,
      viewTop + thumbH / 2,
      4,
      thumbH,
      COLORS.gold,
      0.8,
    );
    cam.ignore([track, thumb]);
    const updateThumb = () => {
      const progress = (maxY - content.y) / (maxY - minY);
      thumb.y = viewTop + thumbH / 2 + progress * (viewH - thumbH);
    };

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= column.x &&
      p.x <= column.right &&
      p.y >= viewTop &&
      p.y <= viewTop + viewH;

    let dragging = false;
    let startPointerY = 0;
    let startContentY = 0;

    const onDown: PointerHandler = (p) => {
      if (!inBounds(p)) return;
      // Never hijack a press that landed on a control (the Close button can sit
      // beside the band on a folded viewport).
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
  }

  private close(): void {
    if (this.leaving) return;
    this.leaving = true;
    const done = () => this.scene.stop();
    if (this.felt) slideOverlayOut(this, this.felt, done);
    else done();
  }
}
