import Phaser from 'phaser';
import { COLORS, CSS, SERIF } from '../art/palette';
import { audio } from '../systems/Audio';
import { loadSettings, saveSettings, Settings } from '../systems/SaveData';
import { addFelt, addPanel, bannerButton } from '../ui/widgets';
import { responsive } from '../ui/layout';

interface SettingsData {
  returnTo?: 'Menu' | 'Game';
}

export class SettingsScene extends Phaser.Scene {
  private settings!: Settings;
  private returnTo: 'Menu' | 'Game' = 'Menu';

  constructor() {
    super('Settings');
  }

  /** Called before create() when the scene is started with data — lets the
   *  "back" button and the mid-run Abandon Run option know where "back" is. */
  init(data: SettingsData): void {
    this.returnTo = data?.returnTo === 'Game' ? 'Game' : 'Menu';
  }

  create(): void {
    this.settings = loadSettings();
    responsive(this, () => this.build());
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const panelW = Math.min(W - 40, 1100);
    const panelH = Math.min(H - 40, 620);
    const panelTop = H / 2 - panelH / 2;

    addFelt(this);
    addPanel(this, cx, H / 2, panelW, panelH);

    this.add
      .text(cx, panelTop + panelH * 0.1, 'Settings', {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(panelH * 0.068, 22, 40))}px`,
        color: CSS.ink,
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    // Label stacked above the track, centered — same layout in every orientation.
    const trackW = panelW * 0.6;
    const trackX0 = cx - trackW / 2;
    const trackX1 = trackX0 + trackW;
    const sliderStep = panelH * 0.16;
    const sliderTop = panelTop + panelH * 0.32;

    this.makeSlider(cx, sliderTop, trackX0, trackX1, 'Music Volume', this.settings.musicVol, (v) => {
      this.settings.musicVol = v;
      this.apply();
    });

    this.makeSlider(cx, sliderTop + sliderStep, trackX0, trackX1, 'Sound Effects', this.settings.sfxVol, (v) => {
      this.settings.sfxVol = v;
      this.apply();
    });

    const fsY = sliderTop + sliderStep * 2 + panelH * 0.06;
    const fsButton = bannerButton(this, cx, fsY, this.fsLabel(), () => {
      if (this.scale.isFullscreen) {
        this.scale.stopFullscreen();
      } else {
        this.scale.startFullscreen();
      }
    });
    const fsText = fsButton.getAt(1) as Phaser.GameObjects.Text;
    this.scale.on(Phaser.Scale.Events.ENTER_FULLSCREEN, () => fsText.setText('Fullscreen: On'));
    this.scale.on(Phaser.Scale.Events.LEAVE_FULLSCREEN, () => fsText.setText('Fullscreen: Off'));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.ENTER_FULLSCREEN);
      this.scale.off(Phaser.Scale.Events.LEAVE_FULLSCREEN);
    });

    // Stacked buttons below, spaced consistently regardless of how many there are.
    const buttonGap = Math.min(90, panelH * 0.145);
    let nextY = fsY + buttonGap;

    if (this.returnTo === 'Game') {
      bannerButton(this, cx, nextY, 'Abandon Run', () => {
        audio.click();
        this.scene.start('Menu');
      });
      nextY += buttonGap;
    }

    const backLabel = this.returnTo === 'Game' ? 'Return to Game' : 'Return to the Vestibule';
    const backY = Math.min(nextY, panelTop + panelH - 45);
    bannerButton(this, cx, backY, backLabel, () => this.scene.start(this.returnTo));
  }

  private fsLabel(): string {
    return `Fullscreen: ${this.scale.isFullscreen ? 'On' : 'Off'}`;
  }

  private apply(): void {
    audio.setVolumes(this.settings.musicVol, this.settings.sfxVol);
    saveSettings(this.settings);
  }

  private makeSlider(
    labelX: number,
    y: number,
    trackX0: number,
    trackX1: number,
    label: string,
    initial: number,
    onChange: (v: number) => void
  ): void {
    const labelY = y - 26;
    this.add
      .text(labelX, labelY, label, { fontFamily: SERIF, fontSize: '22px', color: CSS.ink })
      .setOrigin(0.5);

    const trackY = y + 6;
    this.add.rectangle((trackX0 + trackX1) / 2, trackY, trackX1 - trackX0, 6, COLORS.inkSoft, 0.6);

    const knob = this.add.circle(trackX0 + initial * (trackX1 - trackX0), trackY, 15, COLORS.gold);
    knob.setStrokeStyle(2, COLORS.ink, 0.8);
    knob.setInteractive({ useHandCursor: true });
    this.input.setDraggable(knob);

    knob.on('drag', (_pointer: Phaser.Input.Pointer, dragX: number) => {
      knob.x = Phaser.Math.Clamp(dragX, trackX0, trackX1);
      onChange((knob.x - trackX0) / (trackX1 - trackX0));
    });
    knob.on('dragend', () => audio.click());
  }
}
