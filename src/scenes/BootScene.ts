import Phaser from 'phaser';
import { buildTextures } from '../art/textures';
import { audio } from '../systems/Audio';
import { loadSettings } from '../systems/SaveData';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    buildTextures(this);
    const settings = loadSettings();
    audio.setVolumes(settings.musicVol, settings.sfxVol);
    this.scene.start('Menu');
  }
}
