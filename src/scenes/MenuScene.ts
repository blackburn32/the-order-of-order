import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { audio } from '../systems/Audio';
import { loadProgress, loadSettings } from '../systems/SaveData';
import { beginRun } from '../systems/Tutorial';
import { addFelt, bannerButton, showBanner } from '../ui/widgets';
import { responsive } from '../ui/layout';

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create(): void {
    responsive(this, () => this.build());

    // Browsers require a gesture before audio; first click wakes the drone.
    this.input.once('pointerdown', () => {
      audio.ensure();
      audio.startDrone();
    });
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    addFelt(this);

    const titleY = H * 0.22;
    const glow = this.add.ellipse(cx, titleY, Math.min(720, W * 0.8), 260, COLORS.glow, 0.07);
    this.tweens.add({
      targets: glow,
      alpha: { from: 0.5, to: 1 },
      scaleX: { from: 0.95, to: 1.05 },
      duration: 2400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    this.add
      .text(cx, titleY, 'The Order of Order', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.053, 30, 68))}px`,
        color: CSS.gold,
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setShadow(0, 4, '#000000', 10, false, true);

    this.add
      .text(cx, titleY + H * 0.09, 'An incremental rite of dice', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.019, 16, 24))}px`,
        color: CSS.dim,
        fontStyle: 'italic'
      })
      .setOrigin(0.5);

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
      if (itemsUnlocked) this.scene.start('Items');
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

    bannerButton(this, cx, startY + btnGap * 3, 'Settings', () => this.scene.start('Settings'));

    this.add
      .text(cx, H - Math.min(28, H * 0.05), 'Roll ones. Appease the Order. Survive the thresholds.', {
        fontFamily: SERIF,
        fontSize: '16px',
        color: CSS.dim,
        fontStyle: 'italic'
      })
      .setOrigin(0.5);
  }
}
