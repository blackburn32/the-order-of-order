import Phaser from 'phaser';
import { CSS, SERIF } from '../art/palette';
import { getRun, newRun, setRun } from '../state/RunState';
import { summarizeDice } from '../systems/Dice';
import { addFelt, bannerButton } from '../ui/widgets';
import { responsive } from '../ui/layout';

export class GameOverScene extends Phaser.Scene {
  constructor() {
    super('GameOver');
  }

  create(): void {
    responsive(this, () => this.build());
  }

  private build(): void {
    const state = getRun(this.registry);
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    addFelt(this);

    const top = H * 0.2;
    const step = Math.min(H * 0.09, 60);

    this.add
      .text(cx, top, 'The Run Has Ended', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.045, 30, 58))}px`,
        color: CSS.red,
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setShadow(0, 4, '#000000', 10, false, true);

    this.add
      .text(cx, top + step, 'The Order does not tolerate disorder.', {
        fontFamily: SERIF,
        fontSize: '20px',
        color: CSS.dim,
        fontStyle: 'italic'
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 2.3, `You fell in Round ${state.round}`, {
        fontFamily: SERIF,
        fontSize: '32px',
        color: CSS.parchment
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 3.2, `Final score: ${state.score}`, {
        fontFamily: SERIF,
        fontSize: '24px',
        color: CSS.goldLight
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 4.1, `Your grid: ${summarizeDice(state.dice)}`, {
        fontFamily: SERIF,
        fontSize: '18px',
        color: CSS.dim,
        align: 'center',
        wordWrap: { width: Math.min(900, W - 60) }
      })
      .setOrigin(0.5);

    const btnY = Math.min(H - 90, top + step * 5.4);
    bannerButton(this, cx, btnY, 'Begin a New Run', () => {
      setRun(this.registry, newRun());
      this.scene.start('Game');
    });
    bannerButton(this, cx, btnY + Math.min(90, H * 0.13), 'Return to the Vestibule', () => this.scene.start('Menu'));
  }
}
