import Phaser from "phaser";
import { buildTextures } from "../art/textures";
import { warmTextPipeline } from "../art/textWarmup";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { loadSettings } from "../systems/SaveData";
import diebertUrl from "../../images/characters/diebert-game.webp";
import melodieUrl from "../../images/characters/melodie-game.webp";
import rolandUrl from "../../images/characters/roland-game.webp";
import { restoreActiveRun } from "../systems/ActiveRunPersistence";

/**
 * Every story panel in `images/story/`, keyed by its file name.
 *
 * Globbed rather than imported one by one because the pages are written before
 * the pictures are painted: `ui/storyPage` already falls back to a 4:3
 * placeholder for a page whose art does not exist, and a missing named import
 * would fail the build instead. Dropping a finished panel into that folder,
 * named for the key its page asks for in `story.ts`, is the whole install step.
 */
const STORY_ART = import.meta.glob<string>("../../images/story/*.{webp,png}", {
  eager: true,
  query: "?url",
  import: "default",
});

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    // The intro's chapters and the acts between trials, keyed to match the
    // `image` on each page in story.ts. A page whose art has not landed yet
    // simply finds no texture and draws the placeholder frame.
    for (const [path, url] of Object.entries(STORY_ART)) {
      const key = path.slice(path.lastIndexOf("/") + 1).replace(/\.\w+$/, "");
      this.load.image(key, url);
    }

    // The roster, keyed to match each character's `art` in systems/Characters.
    this.load.image("character-diebert", diebertUrl);
    this.load.image("character-melodie", melodieUrl);
    this.load.image("character-roland", rolandUrl);
  }

  create(): void {
    buildTextures(this);
    // Walks the type ladder in the background from here on, so the first screen
    // to ask for a given size is not the one paying for it. See the module.
    warmTextPipeline(this.game);
    const settings = loadSettings();
    audio.setVolumes(settings.musicVol, settings.sfxVol);
    // First point the live renderer is known — the config asks for WebGL, but
    // Phaser falls back to Canvas where it isn't available.
    fx.init(this.game.renderer.type, settings.visualEffects);
    // A buttonStyle query is a self-contained design review link. Always land
    // it on the menu being reviewed, without deleting or modifying a saved run.
    if (new URLSearchParams(window.location.search).has("buttonStyle")) {
      this.scene.start("Menu");
      return;
    }
    const restored = restoreActiveRun(this.registry);
    if (!restored) {
      this.scene.start("Menu");
      return;
    }
    const checkpoint = restored.checkpoint;
    this.scene.start(checkpoint.scene, checkpoint);
  }
}
