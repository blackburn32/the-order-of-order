import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { addPanel, bannerButton } from '../ui/widgets';
import { responsive } from '../ui/layout';
import { getInitials, normalizeInitials, Purchases, setInitials, submitScore } from '../systems/GlobalScores';

export interface InitialsPromptData {
  score: number;
  /** This run's purchase tally, ridden along into the leaderboard metadata. */
  purchases?: Purchases;
  /** Scene key to re-enable input on when the prompt closes. */
  returnTo: string;
}

/**
 * Arcade "NEW HIGH SCORE — enter your initials" overlay, launched on top of
 * GameOver/Victory when a run earns a new personal best. It runs as its own
 * scene (rather than objects inside GameOver) so the base scene's `responsive`
 * rebuild-on-resize can't wipe it mid-entry. Three letter slots, editable by
 * hardware keyboard *or* on-screen up/down arrows (the game targets touch), then
 * Confirm submits to the global leaderboard, or Skip dismisses without posting.
 * The base scene's input is disabled while we're open and restored on close.
 */
export class InitialsPromptScene extends Phaser.Scene {
  private score = 0;
  private purchases: Purchases = {};
  private returnTo = 'Menu';
  private slots: string[] = ['A', 'A', 'A'];
  private sel = 0;

  constructor() {
    super('InitialsPrompt');
  }

  init(data: InitialsPromptData): void {
    this.score = data.score;
    this.purchases = data.purchases ?? {};
    this.returnTo = data.returnTo;
    const seed = normalizeInitials(getInitials());
    this.slots = [seed[0] ?? 'A', seed[1] ?? 'A', seed[2] ?? 'A'];
    this.sel = 0;
  }

  create(): void {
    // Block the scene underneath from reacting to taps/hovers while we're open.
    const base = this.scene.get(this.returnTo);
    if (base) base.input.enabled = false;

    responsive(this, () => this.build());

    this.input.keyboard?.on('keydown', this.onKey, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off('keydown', this.onKey, this);
      const b = this.scene.get(this.returnTo);
      if (b) b.input.enabled = true;
    });
  }

  private redraw(): void {
    this.children.removeAll(true);
    this.build();
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const cy = H / 2;

    // Dim, interactive backdrop that swallows taps meant for the base scene.
    this.add
      .rectangle(cx, cy, W, H, COLORS.feltDark, 0.72)
      .setInteractive()
      .on('pointerdown', () => {});

    const panelW = Math.min(W - 40, 560);
    const panelH = Math.min(H - 40, 460);
    const panelTop = cy - panelH / 2;
    addPanel(this, cx, cy, panelW, panelH);

    this.add
      .text(cx, panelTop + panelH * 0.12, 'NEW HIGH SCORE', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(panelW * 0.075, 22, 40))}px`,
        color: CSS.goldLight,
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    this.add
      .text(cx, panelTop + panelH * 0.24, `Score ${this.score} — enter your initials`, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(panelW * 0.035, 14, 20))}px`,
        color: CSS.ink,
        fontStyle: 'italic'
      })
      .setOrigin(0.5);

    // Three letter slots with tap arrows above/below each.
    const slotGap = Math.min(panelW * 0.22, 130);
    const slotY = cy - panelH * 0.02;
    const letterSize = Math.round(Phaser.Math.Clamp(panelW * 0.12, 40, 68));
    const arrowSize = Math.round(letterSize * 0.6);
    const arrowDy = letterSize * 0.9;

    this.slots.forEach((letter, i) => {
      const x = cx + (i - 1) * slotGap;
      const selected = i === this.sel;

      this.makeArrow(x, slotY - arrowDy, '▲', arrowSize, () => this.cycle(i, +1));
      this.makeArrow(x, slotY + arrowDy, '▼', arrowSize, () => this.cycle(i, -1));

      // Selected slot gets an underline + gold letter; tap a slot to select it.
      const t = this.add
        .text(x, slotY, letter, {
          fontFamily: SERIF,
          fontSize: `${letterSize}px`,
          color: selected ? CSS.goldLight : CSS.ink,
          fontStyle: 'bold'
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          this.sel = i;
          this.redraw();
        });

      this.add
        .rectangle(x, slotY + letterSize * 0.62, letterSize * 0.8, 3, selected ? COLORS.goldLight : COLORS.inkSoft)
        .setOrigin(0.5);
      void t;
    });

    // Stack the buttons vertically: the banner texture is ~340px wide, so two
    // side by side always overlap on the panel. A column keeps them clear.
    const btnGap = Math.min(84, panelH * 0.17);
    const btnY = panelTop + panelH * 0.72;
    bannerButton(this, cx, btnY, 'Confirm', () => this.confirm());
    bannerButton(this, cx, btnY + btnGap, 'Skip', () => this.close());
  }

  private makeArrow(x: number, y: number, glyph: string, size: number, onTap: () => void): void {
    this.add
      .text(x, y, glyph, { fontFamily: SERIF, fontSize: `${size}px`, color: CSS.inkSoft })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', function (this: Phaser.GameObjects.Text) {
        this.setColor(CSS.gold);
      })
      .on('pointerout', function (this: Phaser.GameObjects.Text) {
        this.setColor(CSS.inkSoft);
      })
      .on('pointerdown', onTap);
  }

  /** Advance a slot's letter by dir (+1/-1), wrapping A–Z. */
  private cycle(i: number, dir: number): void {
    const code = this.slots[i].charCodeAt(0) - 65;
    const next = (((code + dir) % 26) + 26) % 26;
    this.slots[i] = String.fromCharCode(65 + next);
    this.redraw();
  }

  private onKey(ev: KeyboardEvent): void {
    const key = ev.key;
    if (/^[a-zA-Z]$/.test(key)) {
      this.slots[this.sel] = key.toUpperCase();
      this.sel = Math.min(this.sel + 1, 2);
      this.redraw();
    } else if (key === 'ArrowLeft') {
      this.sel = Math.max(0, this.sel - 1);
      this.redraw();
    } else if (key === 'ArrowRight') {
      this.sel = Math.min(2, this.sel + 1);
      this.redraw();
    } else if (key === 'ArrowUp') {
      this.cycle(this.sel, +1);
    } else if (key === 'ArrowDown') {
      this.cycle(this.sel, -1);
    } else if (key === 'Backspace') {
      this.slots[this.sel] = 'A';
      this.sel = Math.max(0, this.sel - 1);
      this.redraw();
    } else if (key === 'Enter') {
      this.confirm();
    } else if (key === 'Escape') {
      this.close();
    }
  }

  private confirm(): void {
    const initials = this.slots.join('');
    setInitials(initials);
    // Fire-and-forget: don't block closing on the network round-trip.
    void submitScore(this.score, initials, this.purchases);
    this.close();
  }

  private close(): void {
    this.scene.stop();
  }
}
