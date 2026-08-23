import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { fx } from "../systems/Effects";
import { RuleDice } from "./RuleDice";
import { fitTextWidth } from "./widgets";

/**
 * The masthead the menu and the trial screens share: a breathing gold halo, a
 * stroked gold title, a broken rule set with die-shaped marks, and an optional
 * italic subtitle beneath it.
 *
 * Pulled out of those scenes' own layout code so the screens that used to open
 * on a parchment panel (Settings, the Codex, the Hall) can wear the same
 * masthead instead of inventing a third look. The halo and the stroke are what
 * let gold type sit directly on the felt with the sigil turning behind it —
 * without them the glyphs and the sigil's arcs collide.
 */
export interface SceneHeaderOptions {
  title: string;
  subtitle?: string;
  /** Vertical centre of the title line. */
  y: number;
  /** Room the header has to lay itself out in; defaults to the viewport. */
  width?: number;
  /**
   * Horizontal centre. Defaults to the viewport's, which is also the signal
   * that the header has the whole screen: passing an `x` puts it in *column*
   * mode, where the halo, the type and the rule are all confined to `width` so
   * none of them spills into the column alongside. Compact-landscape screens
   * pass their text column's centre.
   */
  x?: number;
}

export interface SceneHeader {
  title: Phaser.GameObjects.Text;
  subtitle?: Phaser.GameObjects.Text;
  /** The breathing halo behind the title. It is light falling on the table
   *  rather than part of the interface, so scene transitions hold it still
   *  along with the felt and the sigil (see `sceneSlide`). */
  glow: Phaser.GameObjects.Image;
  /** Every object the header created, for callers that route their content
   *  through a second camera and need the fixed chrome excluded from it. */
  objects: Phaser.GameObjects.GameObject[];
  /** Lowest y the header occupies — content begins below this. */
  bottom: number;
}

export function buildSceneHeader(
  scene: Phaser.Scene,
  opts: SceneHeaderOptions,
): SceneHeader {
  const W = scene.scale.width;
  const width = opts.width ?? W;
  const columnar = opts.x !== undefined;
  const cx = opts.x ?? W / 2;
  const y = opts.y;
  const textMaxW = columnar ? width : W - 32;
  // The halo is light falling on the table, so it may bleed a little past the
  // type — but in a column it must not reach the neighbouring one.
  const glowW = columnar ? width * 1.06 : Math.min(700, W * 0.78);

  const glow = scene.add
    .image(cx, y, "spark")
    .setTint(COLORS.glow)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDisplaySize(glowW, columnar ? 170 : 240)
    .setAlpha(0.18);
  if (fx.motion) {
    // setDisplaySize bakes the stretch into scaleX, so the breathe swings
    // around that baked value rather than around 1.
    const haloScaleX = glow.scaleX;
    scene.tweens.add({
      targets: glow,
      alpha: { from: 0.1, to: 0.22 },
      scaleX: { from: haloScaleX * 0.96, to: haloScaleX * 1.04 },
      duration: 2400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  const titleSize = Math.round(Phaser.Math.Clamp(width * 0.06, 28, 46));
  const title = scene.add
    .text(cx, y, opts.title, {
      fontFamily: SERIF,
      fontSize: `${titleSize}px`,
      color: CSS.gold,
      fontStyle: "bold",
      letterSpacing: 2,
      stroke: "#0d0a12",
      strokeThickness: Math.max(3, Math.round(titleSize * 0.09)),
    })
    .setOrigin(0.5)
    .setShadow(0, 4, "#000000", 10, true, true);
  fitTextWidth(title, textMaxW);

  const objects: Phaser.GameObjects.GameObject[] = [glow, title];

  let subtitle: Phaser.GameObjects.Text | undefined;
  if (opts.subtitle) {
    subtitle = scene.add
      .text(cx, y + titleSize * 0.55 + 34, opts.subtitle, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(width * 0.021, 13, 19))}px`,
        color: CSS.dim,
        fontStyle: "italic",
        align: "center",
        wordWrap: { width: Math.min(textMaxW, 640) },
      })
      .setOrigin(0.5);
    objects.push(subtitle);
  }

  // With a subtitle the rule divides the two lines; without one it closes the
  // masthead off. Measured off the text bounds rather than a fraction of the
  // viewport: the two font sizes hit their floors at different widths, so the
  // gap between them isn't a fixed proportion of anything.
  const ruleY = subtitle
    ? (title.getBounds().bottom + subtitle.getBounds().top) / 2
    : title.getBounds().bottom + 12;
  const dice = new RuleDice(
    scene,
    cx,
    ruleY,
    Phaser.Math.Clamp(titleSize * 0.26, 10, 16),
  );
  const ruleGap = dice.width / 2 + 12;
  const ruleHalf = Math.min(
    title.width / 2 + 40,
    columnar ? width / 2 : W / 2 - 24,
  );
  const rule = scene.add.graphics();
  rule.lineStyle(1.5, COLORS.gold, 0.58);
  rule.lineBetween(cx - ruleHalf, ruleY, cx - ruleGap, ruleY);
  rule.lineBetween(cx + ruleGap, ruleY, cx + ruleHalf, ruleY);
  objects.push(dice, rule);

  return {
    title,
    subtitle,
    glow,
    objects,
    bottom: subtitle ? subtitle.getBounds().bottom : ruleY + 6,
  };
}
