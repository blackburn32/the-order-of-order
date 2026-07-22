import Phaser from 'phaser';
import { buildTextures } from '../art/textures';
import { audio } from '../systems/Audio';
import { loadSettings } from '../systems/SaveData';
import monasteryUrl from '../../images/monastery.png';
import diceTwirlUrl from '../../images/dice-twirl.png';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    // Intro art, keyed to match IntroScene's PAGES entries.
    this.load.image('intro-monastery', monasteryUrl);
    this.load.image('intro-dice-twirl', diceTwirlUrl);
  }

  create(): void {
    buildTextures(this);
    const settings = loadSettings();
    audio.setVolumes(settings.musicVol, settings.sfxVol);
    this.scene.start('Menu');
  }
}
