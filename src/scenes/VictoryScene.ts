import Phaser from 'phaser';
import { CSS, SERIF } from '../art/palette';
import { WIN_ROUND } from '../config';
import { getRun } from '../state/RunState';
import { summarizeDice } from '../systems/Dice';
import { beginRun } from '../systems/Tutorial';
import { addFelt, bannerButton } from '../ui/widgets';
import { responsive } from '../ui/layout';
import { takePendingSubmission } from '../systems/GlobalScores';

export class VictoryScene extends Phaser.Scene {
  constructor() {
    super('Victory');
  }

  create(): void {
    responsive(this, () => this.build());

    // A new personal best queued by the run's end offers itself to the global
    // leaderboard via the arcade initials prompt (launched on top).
    const pending = takePendingSubmission();
    if (pending)
      this.scene.launch('InitialsPrompt', {
        score: pending.score,
        purchases: pending.purchases,
        returnTo: 'Victory'
      });
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
      .text(cx, top, 'The Order Is Complete', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.045, 30, 58))}px`,
        color: CSS.goldLight,
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setShadow(0, 4, '#000000', 10, false, true);

    this.add
      .text(cx, top + step, 'You have brought order to the dice.', {
        fontFamily: SERIF,
        fontSize: '20px',
        color: CSS.dim,
        fontStyle: 'italic'
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 2.3, `You survived all ${WIN_ROUND} rounds`, {
        fontFamily: SERIF,
        fontSize: '32px',
        color: CSS.parchment
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 3.2, `Total score: ${state.totalScore}`, {
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
    // No intro here (main-menu only); beginRun still re-arms the tutorial if the
    // player hasn't completed it yet, or clears it otherwise.
    bannerButton(this, cx, btnY, 'Begin a New Run', () => beginRun(this));
    bannerButton(this, cx, btnY + Math.min(90, H * 0.13), 'Return to the Vestibule', () => this.scene.start('Menu'));
  }
}
