import Phaser from "phaser";
import { buildTextures } from "../art/textures";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { loadSettings } from "../systems/SaveData";
import monasteryUrl from "../../images/monastery.png";
import diceTwirlUrl from "../../images/dice-twirl.png";
import volcanoUrl from "../../images/volcano.png";
import diceEarthUrl from "../../images/dice-earth.png";
import tribute1Url from "../../images/story/ending-tribute-1.webp";
import tribute2Url from "../../images/story/ending-tribute-2.webp";
import tribute3Url from "../../images/story/ending-tribute-3.webp";
import betrayal1Url from "../../images/story/ending-betrayal-1.webp";
import betrayal2Url from "../../images/story/ending-betrayal-2.webp";
import betrayal3Url from "../../images/story/ending-betrayal-3.webp";
import summons1Url from "../../images/story/ending-summons-1.webp";
import summons2Url from "../../images/story/ending-summons-2.webp";
import summons3Url from "../../images/story/ending-summons-3.webp";
import disorder1Url from "../../images/story/ending-disorder-1.webp";
import disorder2Url from "../../images/story/ending-disorder-2.webp";
import peace1Url from "../../images/story/ending-peace-1.webp";
import peace2Url from "../../images/story/ending-peace-2.webp";
import peace3Url from "../../images/story/ending-peace-3.webp";
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

    // Story interludes, keyed to match ENDING_PAGES in story.ts.
    this.load.image("ending-tribute-1", tribute1Url);
    this.load.image("ending-tribute-2", tribute2Url);
    this.load.image("ending-tribute-3", tribute3Url);
    this.load.image("ending-betrayal-1", betrayal1Url);
    this.load.image("ending-betrayal-2", betrayal2Url);
    this.load.image("ending-betrayal-3", betrayal3Url);
    this.load.image("ending-summons-1", summons1Url);
    this.load.image("ending-summons-2", summons2Url);
    this.load.image("ending-summons-3", summons3Url);
    this.load.image("ending-disorder-1", disorder1Url);
    this.load.image("ending-disorder-2", disorder2Url);
    this.load.image("ending-peace-1", peace1Url);
    this.load.image("ending-peace-2", peace2Url);
    this.load.image("ending-peace-3", peace3Url);
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
