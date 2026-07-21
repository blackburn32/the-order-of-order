import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { loadSettings, saveSettings } from '../systems/SaveData';
import { beginRun } from '../systems/Tutorial';
import { addFelt, bannerButton, checkboxRow } from '../ui/widgets';
import { responsive } from '../ui/layout';

interface Page {
  title: string;
  blurb: string;
}

// The premise of the Order, one screen at a time. Images are placeholder 4:3
// rectangles for now — real art drops in later.
const PAGES: Page[] = [
  {
    title: 'A Gathering Chaos',
    blurb:
      'Across the realm, order frays. Numbers fall as they please, and the wild churn of chance brings great peril to every living thing.'
  },
  {
    title: 'The Brave Monks',
    blurb:
      'In the high monasteries, a devoted few refuse to yield. Searching the old vaults, they uncover a relic of impossible make.'
  },
  {
    title: 'The Sacred Dice',
    blurb:
      'The artifact is a set of dice — and rolled with discipline, they can bind the chaos and restore the world’s order. The rite is yours to perform.'
  }
];

export class IntroScene extends Phaser.Scene {
  private page = 0;
  private skip = false;

  constructor() {
    super('Intro');
  }

  create(): void {
    this.page = 0;
    this.skip = false;
    responsive(this, () => this.build());
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const last = this.page === PAGES.length - 1;
    const p = PAGES[this.page];

    addFelt(this);

    this.add
      .text(cx, H * 0.09, p.title, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.05, 26, 52))}px`,
        color: CSS.gold,
        fontStyle: 'bold'
      })
      .setOrigin(0.5)
      .setShadow(0, 3, '#000000', 8, false, true);

    // Placeholder 4:3 image, sized to fit both width and the vertical band left
    // between the title and the text/controls below.
    const maxImgW = Math.min(W - 48, 560);
    const maxImgH = H * 0.42;
    const imgW = Math.min(maxImgW, maxImgH * (4 / 3));
    const imgH = imgW * (3 / 4);
    const imgCy = H * 0.36;
    const image = this.add.rectangle(cx, imgCy, imgW, imgH, COLORS.feltLight, 0.6);
    image.setStrokeStyle(2, COLORS.gold, 0.4);
    this.add
      .text(cx, imgCy, '4 : 3', { fontFamily: SERIF, fontSize: '18px', color: CSS.dim, fontStyle: 'italic' })
      .setOrigin(0.5);

    const blurbStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: SERIF,
      fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.022, 16, 22))}px`,
      color: CSS.parchment,
      align: 'center',
      wordWrap: { width: Math.min(W - 48, 620) }
    };
    const blurbTop = imgCy + imgH / 2 + 26;
    this.add.text(cx, blurbTop, p.blurb, blurbStyle).setOrigin(0.5, 0);

    // Reserve a text band as tall as the *longest* blurb so the controls below
    // sit at the same y on every page — the button shouldn't jump as the copy
    // changes. (Measure off-screen, then discard.)
    const maxBlurbH = Math.max(
      ...PAGES.map((page) => {
        const probe = this.add.text(0, 0, page.blurb, blurbStyle).setVisible(false);
        const h = probe.height;
        probe.destroy();
        return h;
      })
    );

    // The button sits just under the reserved text band with a little padding,
    // clamped so the whole control block stays on short screens.
    const blockTop = Math.min(blurbTop + maxBlurbH + 28, H - 150);

    const label = last ? 'Begin' : 'Continue';
    const button = bannerButton(this, cx, 0, label, () => {
      if (last) {
        beginRun(this);
      } else {
        // Advance in place (not scene.restart, which would reset `page`); the
        // responsive() resize handler still points at build() and reads `page`.
        this.page += 1;
        this.children.removeAll(true);
        this.build();
      }
    });
    button.y = blockTop + button.height / 2;
    let cursorY = button.y + button.height / 2 + 24;

    // Final page: the skip checkbox sits below the button.
    if (last) {
      this.skip = !loadSettings().showIntro;
      const row = checkboxRow(this, cx, cursorY, 'Skip the intro on future runs', this.skip, (value) => {
        this.skip = value;
        const settings = loadSettings();
        settings.showIntro = !value;
        saveSettings(settings);
      });
      row.setDepth(1);
      cursorY += 34;
    }

    // Page dots, closing out the control block.
    const dotGap = 22;
    PAGES.forEach((_, i) => {
      const dot = this.add.circle(cx + (i - (PAGES.length - 1) / 2) * dotGap, cursorY, 5, COLORS.gold);
      dot.setAlpha(i === this.page ? 1 : 0.35);
    });
  }
}
