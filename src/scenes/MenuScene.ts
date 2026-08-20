import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { audio } from '../systems/Audio';
import { fx } from '../systems/Effects';
import { loadProgress, loadSettings } from '../systems/SaveData';
import { beginRun } from '../systems/Tutorial';
import { addFelt, bannerButton, fitTextWidth, showBanner } from '../ui/widgets';
import { AmbientLayer } from '../ui/AmbientLayer';
import { RuleDice } from '../ui/RuleDice';
import { responsive } from '../ui/layout';

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

export class MenuScene extends Phaser.Scene {
  private cursorGlow?: Phaser.GameObjects.Image;
  private cursorGlowActivated = false;

  constructor() {
    super('Menu');
  }

  create(): void {
    this.cursorGlowActivated = false;
    responsive(this, () => this.build());

    // Phaser initializes the active pointer at a default position before the
    // player has interacted. Keep its light hidden until a real mouse/touch
    // event arrives, then start it at that event instead of easing in from the
    // default corner.
    const activateCursorGlow = (pointer: Phaser.Input.Pointer) => {
      if (this.cursorGlowActivated) return;
      this.cursorGlowActivated = true;
      this.cursorGlow?.setPosition(pointer.worldX, pointer.worldY).setAlpha(CURSOR_GLOW_ALPHA);
    };
    this.input.once('pointermove', activateCursorGlow);
    this.input.once('pointerdown', activateCursorGlow);

    // Browsers require a gesture before audio; first click starts the soundtrack.
    this.input.once('pointerdown', () => {
      audio.startMusic();
    });
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    addFelt(this);

    // The same living backdrop that sits behind the dice grid, centered on the
    // whole viewport so the sigil frames the menu rather than any one element.
    // Created here, straight after the felt, so everything built below layers
    // over it; `responsive` destroys and rebuilds it with the rest of the scene
    // on resize, and AmbientLayer's own destroy tears down its looping tweens.
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(MENU_AMBIENCE, false);

    const titleY = H * 0.22;

    // A gradient halo rather than a filled shape. With the sigil turning
    // behind it, any hard edge here reads as a second object laid over the
    // rings instead of as light falling on them — and `spark` is drawn
    // precisely to hold up as a light source when blown far past its own size.
    const glow = this.add
      .image(cx, titleY, 'spark')
      .setTint(COLORS.glow)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(Math.min(720, W * 0.8), 300);
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
        ease: 'Sine.easeInOut'
      });
    } else {
      glow.setAlpha(0.2);
    }

    // The font sizes have a legibility floor (30px / 16px), so below roughly a
    // 330px-wide viewport the clamp stops shrinking them and the lines would run
    // off the edges — fitTextWidth takes over from there. Same margin as the
    // tagline below, so all three lines share one left/right edge.
    const textMaxW = W - 24;

    const titleSize = Math.round(Phaser.Math.Clamp(W * 0.053, 30, 68));
    const title = this.add
      .text(cx, titleY, 'The Order of Order', {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: 'bold',
        // The sigil's tick ring and arcs pass behind the letterforms now, and
        // gold-on-gold at low alpha is exactly the collision a drop shadow
        // underneath doesn't solve. A near-black stroke (felt dark, as
        // `floatText` uses) cuts the glyphs out of whatever is turning behind
        // them; scaled off the font size so it stays proportionate from the
        // 30px floor to the 68px ceiling.
        stroke: '#0d0a12',
        strokeThickness: Math.max(3, Math.round(titleSize * 0.09))
      })
      .setOrigin(0.5)
      // shadowStroke on as well, so the soft shadow follows the stroke's
      // outline rather than only the gold fill sitting inside it.
      .setShadow(0, 4, '#000000', 10, true, true);
    fitTextWidth(title, textMaxW);

    const subtitle = this.add
      .text(cx, titleY + H * 0.09, 'An incremental rite of dice', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.019, 16, 24))}px`,
        color: CSS.dim,
        fontStyle: 'italic'
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
    const ruleHalf = Math.min(title.width / 2 + 30, W / 2 - 24);

    // Sized off the title rather than the measured gap between the two lines:
    // the gap between their *bounds* is only a dozen pixels (Phaser's line
    // height pads each box well past the ink), while the clear air between the
    // glyphs themselves is several times that. Scaling with the title keeps
    // the row proportionate to the masthead at every viewport.
    const dice = new RuleDice(this, cx, ruleY, Phaser.Math.Clamp(titleSize * 0.26, 10, 18));
    const ruleGap = dice.width / 2 + 12;

    const rule = this.add.graphics();
    rule.lineStyle(1.5, COLORS.gold, 0.6);
    rule.lineBetween(cx - ruleHalf, ruleY, cx - ruleGap, ruleY);
    rule.lineBetween(cx + ruleGap, ruleY, cx + ruleHalf, ruleY);

    const btnGap = Math.min(84, H * 0.12);
    const startY = H * 0.48;
    bannerButton(this, cx, startY, 'Start New Run', () => {
      // Intro plays on every main-menu run until the player skips it; Victory /
      // Game Over "Begin a New Run" skip straight to the game (they call
      // setRun + start('Game') directly, so the intro is main-menu only).
      if (loadSettings().showIntro) this.scene.start('Intro');
      else beginRun(this);
    });
    bannerButton(this, cx, startY + btnGap, 'Hall of High Scores', () => this.scene.start('Hall'));

    // The Codex of items stays locked until the player has finished one run.
    const itemsUnlocked = loadProgress().gamesCompleted > 0;
    const itemsBtn = bannerButton(this, cx, startY + btnGap * 2, 'Codex', () => {
      if (itemsUnlocked) this.scene.start('Items', { returnTo: 'Menu' });
      else showBanner(this, 'Complete a run to unlock the Codex', 1200);
    });
    if (!itemsUnlocked) {
      itemsBtn.setAlpha(0.55);
      // A padlock pinned to the left of the button, vertically centered, so it
      // doesn't shove the centered label off-center.
      const img = itemsBtn.getAt(0) as Phaser.GameObjects.Image;
      const lock = this.add
        .text(-img.width / 2 + 24, 0, '🔒', { fontFamily: SERIF, fontSize: '24px', color: CSS.ink })
        .setOrigin(0, 0.5);
      itemsBtn.add(lock);
    }

    // Pass returnTo explicitly: Phaser keeps a scene's previous start-data when
    // none is supplied, so without this Settings would inherit a stale
    // `{ returnTo: 'Game' }` from a mid-run visit and wrongly offer "Return to
    // Game" / "Abandon Run" from the Vestibule.
    bannerButton(this, cx, startY + btnGap * 3, 'Settings', () => this.scene.start('Settings', { returnTo: 'Menu' }));

    const tagline = this.add
      .text(cx, H - Math.min(28, H * 0.05), 'Roll ones. Appease the Order. Survive the thresholds.', {
        fontFamily: SERIF,
        fontSize: '16px',
        color: CSS.dim,
        fontStyle: 'italic'
      })
      .setOrigin(0.5);
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
        .image(pointer.worldX, pointer.worldY, 'spark')
        .setTint(COLORS.glow)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(CURSOR_GLOW_SIZE, CURSOR_GLOW_SIZE)
        .setAlpha(this.cursorGlowActivated ? CURSOR_GLOW_ALPHA : 0);
    }
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
