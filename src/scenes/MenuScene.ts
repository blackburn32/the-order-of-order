import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { loadProgress, loadSettings } from "../systems/SaveData";
import { beginRun } from "../systems/Tutorial";
import {
  addFelt,
  bannerButton,
  BannerAction,
  fitTextWidth,
  showBanner,
  stackBannerButtons,
} from "../ui/widgets";
import { AmbientLayer } from "../ui/AmbientLayer";
import { RuleDice } from "../ui/RuleDice";
import { compactColumns, isCompactLandscape, responsive } from "../ui/layout";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";

/**
 * Fixed "trial progress" handed to the menu's AmbientLayer. There's no trial
 * here to report, so the number is chosen purely for how it looks: it drives
 * both the sigil's opacity and its spin, and this value lands on a faint gold
 * ring turning about once every forty seconds.
 */
const MENU_AMBIENCE = 0.7;

/** The light the pointer carries: its display size, its additive strength
 *  (enough to bloom a parchment button as the pointer crosses it without
 *  washing out the label), and the fraction of the gap to the pointer it
 *  closes each frame — low enough that the light visibly trails the cursor
 *  rather than being welded to it. */
const CURSOR_GLOW_SIZE = 260;
const CURSOR_GLOW_ALPHA = 0.22;
const CURSOR_GLOW_EASING = 0.16;

/** Felt left showing between the stacked menu buttons once the viewport is
 *  short enough that the pitch, not the parchment, is what confines them. */
const STACKED_BUTTON_GAP = 8;

export class MenuScene extends Phaser.Scene {
  private cursorGlow?: Phaser.GameObjects.Image;
  private cursorGlowActivated = false;
  // The felt, the sigil, the title halo and the carried light: the room the
  // menu is arranged in. Held still while the menu itself slides on and off,
  // so the Vestibule and the rooms reached from it read as one place.
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  private leaving = false;

  constructor() {
    super("Menu");
  }

  create(): void {
    this.cursorGlowActivated = false;
    this.leaving = false;
    responsive(this, () => this.build());
    slideSceneIn(this, this.slideBackdrop);

    // Phaser initializes the active pointer at a default position before the
    // player has interacted. Keep its light hidden until a real mouse/touch
    // event arrives, then start it at that event instead of easing in from the
    // default corner.
    const activateCursorGlow = (pointer: Phaser.Input.Pointer) => {
      if (this.cursorGlowActivated) return;
      this.cursorGlowActivated = true;
      this.cursorGlow
        ?.setPosition(pointer.worldX, pointer.worldY)
        .setAlpha(CURSOR_GLOW_ALPHA);
    };
    this.input.once("pointermove", activateCursorGlow);
    this.input.once("pointerdown", activateCursorGlow);

    // Browsers require a gesture before audio; first click starts the soundtrack.
    this.input.once("pointerdown", () => {
      audio.startMusic();
    });
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const felt = addFelt(this);

    // The same living backdrop that sits behind the dice grid, centered on the
    // whole viewport so the sigil frames the menu rather than any one element.
    // Created here, straight after the felt, so everything built below layers
    // over it; `responsive` destroys and rebuilds it with the rest of the scene
    // on resize, and AmbientLayer's own destroy tears down its looping tweens.
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(MENU_AMBIENCE, false);

    // A handset in landscape has no height to stack a masthead over four
    // buttons: the masthead takes one column and the buttons the other. See
    // `compactColumns`.
    const compact = isCompactLandscape(W, H);
    const columns = compactColumns(this, { leftFraction: 0.5 });
    const mast = compact ? columns.left : { cx, width: W, x: 0, right: W };
    const titleY = compact ? columns.top + columns.height * 0.42 : H * 0.22;

    // A gradient halo rather than a filled shape. With the sigil turning
    // behind it, any hard edge here reads as a second object laid over the
    // rings instead of as light falling on them — and `spark` is drawn
    // precisely to hold up as a light source when blown far past its own size.
    const glow = this.add
      .image(mast.cx, titleY, "spark")
      .setTint(COLORS.glow)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(
        compact ? mast.width * 1.06 : Math.min(720, W * 0.8),
        compact ? 190 : 300,
      )
      // Alpha set here rather than left to the breathe tween's `from`: a tween
      // added during create doesn't apply its starting value until its first
      // update, so the halo would render at full opacity for the frame the
      // scene is built on — a bright flash where the title is about to slide
      // in, most visible re-entering the menu from Settings.
      .setAlpha(0.12);
    if (fx.motion) {
      // setDisplaySize bakes the stretch into scaleX, so the breathe has to
      // swing around that baked value instead of around 1.
      const haloScaleX = glow.scaleX;
      this.tweens.add({
        targets: glow,
        alpha: { from: 0.12, to: 0.26 },
        scaleX: { from: haloScaleX * 0.95, to: haloScaleX * 1.05 },
        duration: 2400,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    } else {
      glow.setAlpha(0.2);
    }

    // The font sizes have a legibility floor (30px / 16px), so below roughly a
    // 330px-wide viewport the clamp stops shrinking them and the lines would run
    // off the edges — fitTextWidth takes over from there. Same margin as the
    // tagline below, so all three lines share one left/right edge.
    const textMaxW = mast.width - 24;

    const titleSize = Math.round(Phaser.Math.Clamp(W * 0.053, 30, 68));
    const title = this.add
      .text(mast.cx, titleY, "The Order of Order", {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        // The sigil's tick ring and arcs pass behind the letterforms now, and
        // gold-on-gold at low alpha is exactly the collision a drop shadow
        // underneath doesn't solve. A near-black stroke (felt dark, as
        // `floatText` uses) cuts the glyphs out of whatever is turning behind
        // them; scaled off the font size so it stays proportionate from the
        // 30px floor to the 68px ceiling.
        stroke: "#0d0a12",
        strokeThickness: Math.max(3, Math.round(titleSize * 0.09)),
      })
      .setOrigin(0.5)
      // shadowStroke on as well, so the soft shadow follows the stroke's
      // outline rather than only the gold fill sitting inside it.
      .setShadow(0, 4, "#000000", 10, true, true);
    fitTextWidth(title, textMaxW);

    // The stacked layout spaces the two lines off the viewport height; a
    // compact column has to space them off the type instead, or the subtitle
    // lands inside the title's own line box.
    const subtitleGap = compact ? titleSize * 0.62 + 20 : H * 0.09;
    const subtitle = this.add
      .text(mast.cx, titleY + subtitleGap, "An incremental rite of dice", {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.019, 16, 24))}px`,
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5);
    fitTextWidth(subtitle, textMaxW);

    // A broken rule binds the title and subtitle into one masthead instead of
    // leaving two stranded lines of text: a thin gold line interrupted by a
    // centered lozenge, the illuminated-manuscript vocabulary the rest of the
    // game's art already speaks. Placed off the two lines' measured bounds
    // rather than a fraction of H, so it stays centered in the gap at every
    // viewport — the two font sizes hit their legibility floors at different
    // widths, so that gap isn't a fixed proportion of anything.
    const ruleY = (title.getBounds().bottom + subtitle.getBounds().top) / 2;
    const ruleHalf = Math.min(title.width / 2 + 30, mast.width / 2 - 12);

    // Sized off the title rather than the measured gap between the two lines:
    // the gap between their *bounds* is only a dozen pixels (Phaser's line
    // height pads each box well past the ink), while the clear air between the
    // glyphs themselves is several times that. Scaling with the title keeps
    // the row proportionate to the masthead at every viewport.
    const dice = new RuleDice(
      this,
      mast.cx,
      ruleY,
      Phaser.Math.Clamp(titleSize * 0.26, 10, 18),
    );
    const ruleGap = dice.width / 2 + 12;

    const rule = this.add.graphics();
    rule.lineStyle(1.5, COLORS.gold, 0.6);
    rule.lineBetween(mast.cx - ruleHalf, ruleY, mast.cx - ruleGap, ruleY);
    rule.lineBetween(mast.cx + ruleGap, ruleY, mast.cx + ruleHalf, ruleY);

    // The Codex of items stays locked until the player has finished one run.
    const itemsUnlocked = loadProgress().gamesCompleted > 0;
    const actions: BannerAction[] = [
      {
        label: "Start New Run",
        onClick: () =>
          this.leave(() => {
            // Intro plays on every main-menu run until the player skips it; Victory /
            // Game Over "Begin a New Run" skip straight to the game (they call
            // setRun + start('Game') directly, so the intro is main-menu only).
            if (loadSettings().showIntro) this.scene.start("Intro");
            else beginRun(this);
          }),
      },
      {
        label: "Hall of High Scores",
        onClick: () => this.leave(() => this.scene.start("Hall")),
      },
      {
        label: "Codex",
        onClick: () => {
          if (itemsUnlocked)
            this.leave(() => this.scene.start("Items", { returnTo: "Menu" }));
          else showBanner(this, "Complete a run to unlock the Codex", 1200);
        },
      },
      {
        // Pass returnTo explicitly: Phaser keeps a scene's previous start-data
        // when none is supplied, so without this Settings would inherit a stale
        // `{ returnTo: 'Game' }` from a mid-run visit and wrongly offer "Return
        // to Game" / "Abandon Run" from the Vestibule.
        label: "Settings",
        onClick: () =>
          this.leave(() => this.scene.start("Settings", { returnTo: "Menu" })),
      },
    ];

    // Folded, the buttons fill their own column and take their pitch from their
    // own measured heights; stacked, they keep the viewport-proportional pitch
    // the taller composition is built around. That pitch shrinks with the
    // viewport while the parchment's own height doesn't, so on a short screen
    // it drops below one button's height — hence the cap, which keeps a sliver
    // of felt showing between them by shrinking the buttons (label included)
    // rather than letting each one lap the next.
    const btnGap = Math.min(84, H * 0.12);
    const startY = H * 0.48;
    const buttons = compact
      ? stackBannerButtons(this, columns.right, columns, actions)
      : actions.map((action, i) =>
          bannerButton(
            this,
            cx,
            startY + btnGap * i,
            action.label,
            action.onClick,
            undefined,
            btnGap - STACKED_BUTTON_GAP,
          ),
        );

    if (!itemsUnlocked) {
      const itemsBtn = buttons[2];
      itemsBtn.setAlpha(0.55);
      // A padlock pinned to the left of the button, vertically centered, so it
      // doesn't shove the centered label off-center. Both the glyph and its
      // inset ride the button's own scale — the button shrinks to fit a short
      // viewport, and a fixed 24px lock would end up taller than the parchment
      // it sits on and far enough in to collide with the label.
      const img = itemsBtn.getAt(0) as Phaser.GameObjects.Image;
      const lockSize = Math.max(12, Math.round(24 * img.scaleY));
      const lock = this.add
        .text(-img.displayWidth / 2 + lockSize, 0, "\u{1F512}", {
          fontFamily: SERIF,
          fontSize: `${lockSize}px`,
          color: CSS.ink,
        })
        .setOrigin(0, 0.5);
      itemsBtn.add(lock);
    }

    // Folded, the tagline closes off the masthead column rather than running
    // the full width under both of them — and wraps rather than shrinking,
    // since a column has the height for a second line and not the width for
    // one long one.
    const tagline = this.add
      .text(
        mast.cx,
        compact ? columns.bottom - 4 : H - Math.min(28, H * 0.05),
        "Roll ones. Appease the Order. Survive the thresholds.",
        {
          fontFamily: SERIF,
          fontSize: "16px",
          color: CSS.dim,
          fontStyle: "italic",
          align: "center",
          ...(compact ? { wordWrap: { width: textMaxW } } : {}),
        },
      )
      .setOrigin(0.5, compact ? 1 : 0.5);
    fitTextWidth(tagline, textMaxW);

    // A light the pointer carries across the table. Created last so it lies
    // over everything — additive gold on parchment gives each button a soft
    // bloom as the pointer crosses it, which doubles as hover feedback the
    // tint alone doesn't provide. `responsive` destroyed the previous one
    // along with the rest of the display list, so this reassignment is what
    // keeps the handle live across a resize.
    this.cursorGlow = undefined;
    if (fx.on) {
      const pointer = this.input.activePointer;
      this.cursorGlow = this.add
        .image(pointer.worldX, pointer.worldY, "spark")
        .setTint(COLORS.glow)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(CURSOR_GLOW_SIZE, CURSOR_GLOW_SIZE)
        .setAlpha(this.cursorGlowActivated ? CURSOR_GLOW_ALPHA : 0);
    }

    // Assembled last so the carried light — created at the very end of the
    // build — is part of it. Reassigned on every rebuild, since `responsive`
    // destroyed the previous set along with the rest of the display list.
    this.slideBackdrop = [felt, ambient, glow];
    if (this.cursorGlow) this.slideBackdrop.push(this.cursorGlow);
  }

  /** Send the menu off to the right, then hand over to the next scene, which
   *  brings its own interface in from the left over the same still room. */
  private leave(complete: () => void): void {
    if (this.leaving) return;
    this.leaving = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }

  /**
   * Ease the carried light toward the pointer. Read straight off
   * `activePointer` rather than through a `pointermove` handler: the easing
   * needs a per-frame step regardless, and polling here means there's no
   * listener to unsubscribe when `responsive` tears the scene down.
   */
  override update(): void {
    const glow = this.cursorGlow;
    if (!this.cursorGlowActivated || !glow?.active) return;
    const pointer = this.input.activePointer;
    glow.x = Phaser.Math.Linear(glow.x, pointer.worldX, CURSOR_GLOW_EASING);
    glow.y = Phaser.Math.Linear(glow.y, pointer.worldY, CURSOR_GLOW_EASING);
  }
}
