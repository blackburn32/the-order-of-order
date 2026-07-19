import Phaser from 'phaser';
import { CSS, SERIF } from '../art/palette';
import { loadHall } from '../systems/SaveData';
import { addFelt, addPanel, bannerButton } from '../ui/widgets';
import { responsive } from '../ui/layout';

export class HallScene extends Phaser.Scene {
  constructor() {
    super('Hall');
  }

  create(): void {
    responsive(this, () => this.build());
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const panelW = Math.min(W - 40, 1100);
    const panelH = Math.min(H - 40, 620);
    const panelTop = H / 2 - panelH / 2;
    const panelLeft = cx - panelW / 2;

    addFelt(this);
    addPanel(this, cx, H / 2, panelW, panelH);

    this.add
      .text(cx, panelTop + panelH * 0.1, 'Hall of High Scores', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(Math.min(panelW * 0.075, panelH * 0.068), 20, 40))}px`,
        color: CSS.ink,
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: panelW * 0.92 }
      })
      .setOrigin(0.5);

    const entries = loadHall();

    if (entries.length === 0) {
      this.add
        .text(cx, H / 2, 'No initiates have been recorded.\nBegin a run and earn your place.', {
          fontFamily: SERIF,
          fontSize: `${Math.round(Phaser.Math.Clamp(panelW * 0.022, 16, 24))}px`,
          color: CSS.inkSoft,
          fontStyle: 'italic',
          align: 'center'
        })
        .setOrigin(0.5);
    } else {
      // Column positions are derived from each column's actual measured text
      // width (not a guessed font metric), so DATE/ROUND/SCORE can never
      // collide regardless of font size, locale date format, or digit count
      // — the grid column just absorbs whatever room is left over.
      const headerSize = Math.round(Phaser.Math.Clamp(panelW * 0.032, 11, 16));
      const cellSize = Math.round(Phaser.Math.Clamp(panelW * 0.045, 13, 20));
      const colGap = Math.max(10, panelW * 0.02);

      const headerY = panelTop + panelH * 0.24;
      const rowStart = panelTop + panelH * 0.29;
      const rowStep = Math.min(36, (panelH * 0.6) / Math.max(1, entries.length));

      const dateTexts = [this.header(headerY, 'DATE', headerSize)];
      const roundTexts = [this.header(headerY, 'ROUND', headerSize)];
      const scoreTexts = [this.header(headerY, 'SCORE', headerSize)];
      const gridHeader = this.header(headerY, 'FINAL GRID', headerSize, 0);

      const rows = entries.map((entry, i) => {
        const y = rowStart + i * rowStep;
        const date = new Date(entry.startedAt).toLocaleDateString(undefined, {
          year: '2-digit',
          month: 'numeric',
          day: 'numeric'
        });
        dateTexts.push(this.cell(y, date, cellSize));
        roundTexts.push(this.cell(y, String(entry.round), cellSize));
        scoreTexts.push(this.cell(y, String(entry.score), cellSize));
        return { y, entry };
      });

      const widest = (texts: Phaser.GameObjects.Text[]) => Math.max(...texts.map((t) => t.width));
      const dateW = widest(dateTexts);
      const roundW = widest(roundTexts);
      const scoreW = widest(scoreTexts);

      const col1 = panelLeft + panelW * 0.06 + dateW / 2;
      const col2 = col1 + dateW / 2 + colGap + roundW / 2;
      const col3 = col2 + roundW / 2 + colGap + scoreW / 2;
      const col4 = col3 + scoreW / 2 + colGap * 1.4;
      const gridColW = panelLeft + panelW * 0.95 - col4;
      const iconStep = Math.min(30, Math.max(16, rowStep * 0.85));
      const maxIcons = Math.max(2, Math.floor(gridColW / iconStep));

      dateTexts.forEach((t) => t.setX(col1));
      roundTexts.forEach((t) => t.setX(col2));
      scoreTexts.forEach((t) => t.setX(col3));
      gridHeader.setX(col4);

      rows.forEach(({ y, entry }) => {
        const shown = entry.dice.slice(0, maxIcons);
        shown.forEach((die, j) => {
          this.add.image(col4 + j * iconStep, y, `die-${die.sides}`).setScale(0.27);
        });
        if (entry.dice.length > maxIcons) {
          this.add
            .text(col4 + maxIcons * iconStep, y, `+${entry.dice.length - maxIcons}`, {
              fontFamily: SERIF,
              fontSize: '15px',
              color: CSS.inkSoft
            })
            .setOrigin(0, 0.5);
        }
      });
    }

    bannerButton(this, cx, panelTop + panelH * 0.92, 'Return to the Vestibule', () => this.scene.start('Menu'));
  }

  private header(y: number, label: string, size: number, originX = 0.5): Phaser.GameObjects.Text {
    return this.add
      .text(0, y, label, {
        fontFamily: SERIF,
        fontSize: `${size}px`,
        color: CSS.inkSoft,
        letterSpacing: 2,
        fontStyle: 'bold'
      })
      .setOrigin(originX, 0.5);
  }

  private cell(y: number, value: string, size: number): Phaser.GameObjects.Text {
    return this.add
      .text(0, y, value, { fontFamily: SERIF, fontSize: `${size}px`, color: CSS.ink })
      .setOrigin(0.5);
  }
}
