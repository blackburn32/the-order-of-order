import Phaser from "phaser";
import { buildTextures } from "../art/textures";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { loadSettings } from "../systems/SaveData";
import monasteryUrl from "../../images/monastery.png";
import diceTwirlUrl from "../../images/dice-twirl.png";
import volcanoUrl from "../../images/volcano.png";
import diceEarthUrl from "../../images/dice-earth.png";
import { restoreActiveRun } from "../systems/ActiveRunPersistence";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    // Intro art, keyed to match IntroScene's PAGES entries.
    this.load.image("intro-monastery", monasteryUrl);
    this.load.image("intro-dice-twirl", diceTwirlUrl);
    this.load.image("intro-volcano", volcanoUrl);
    this.load.image("intro-dice-earth", diceEarthUrl);
  }

  create(): void {
    buildTextures(this);
    const settings = loadSettings();
    audio.setVolumes(settings.musicVol, settings.sfxVol);
    // First point the live renderer is known — the config asks for WebGL, but
    // Phaser falls back to Canvas where it isn't available.
    fx.init(this.game.renderer.type, settings.visualEffects);
    const restored = restoreActiveRun(this.registry);
    if (!restored) {
      this.scene.start("Menu");
      return;
    }
    const checkpoint = restored.checkpoint;
    this.scene.start(checkpoint.scene, checkpoint);
  }
}
