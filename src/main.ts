import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { MenuScene } from "./scenes/MenuScene";
import { IntroScene } from "./scenes/IntroScene";
import { GameScene } from "./scenes/GameScene";
import { ShopScene } from "./scenes/ShopScene";
import { GameOverScene } from "./scenes/GameOverScene";
import { VictoryScene } from "./scenes/VictoryScene";
import { HallScene } from "./scenes/HallScene";
import { SettingsScene } from "./scenes/SettingsScene";
import { ItemsScene } from "./scenes/ItemsScene";
import { InventoryScene } from "./scenes/InventoryScene";
import { InitialsPromptScene } from "./scenes/InitialsPromptScene";
import { AnalysisScene } from "./scenes/AnalysisScene";
import { TrialOverviewScene } from "./scenes/TrialOverviewScene";
import { TrialResultsScene } from "./scenes/TrialResultsScene";
import { EndingScene } from "./scenes/EndingScene";
import { TributeScene } from "./scenes/TributeScene";
import { installDevPanel } from "./dev/DevPanel";
import { GOLD_BORDER } from "./buildFlags";
import { installHiDpi, installHighResolutionText } from "./renderQuality";
import {
  initializeActiveRunStorage,
  installActiveRunLifecycle,
} from "./systems/ActiveRunPersistence";

// Before the canvas exists, so the frame is part of the first layout rather
// than a reflow after Phaser has sized itself.
if (GOLD_BORDER) document.getElementById("game")?.classList.add("gold-border");

installHighResolutionText();

function createGame(): Phaser.Game {
  const game = new Phaser.Game({
    // Phaser 4's Canvas renderer is deprecated. Keeping the mobile build on the
    // WebGL path also gives curves and transformed textures consistent AA.
    type: Phaser.WEBGL,
    antialias: true,
    antialiasGL: true,
    pixelArt: false,
    // Prevent texture-backed objects (including Text) from landing between
    // output pixels when their positions are otherwise safe to round.
    roundPixels: true,
    parent: "game",
    // This is exposed briefly while scene cameras slide between screens. Match
    // the standard tabletop felt so the transition reads as continuous motion
    // instead of a near-black frame pushing in behind the departing scene.
    backgroundColor: "#161226",
    scale: {
      // The canvas is resized (not letterboxed) to fill the page, in whatever
      // orientation the player is in; every scene lays itself out from
      // `scene.scale.width/height` rather than the fixed design size.
      //
      // These stay CSS pixels. Drawing at the screen's real pixel density is
      // `installHiDpi`'s job, and it deliberately leaves the Scale Manager
      // alone so that layout and input keep one unit throughout.
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    scene: [
      BootScene,
      MenuScene,
      IntroScene,
      TrialOverviewScene,
      GameScene,
      TrialResultsScene,
      EndingScene,
      TributeScene,
      ShopScene,
      GameOverScene,
      VictoryScene,
      HallScene,
      ItemsScene,
      SettingsScene,
      InventoryScene,
      InitialsPromptScene,
      AnalysisScene,
    ],
  });

  window.__game = game;
  installHiDpi(game);
  installDevPanel(game);
  installActiveRunLifecycle();
  return game;
}

// Exposed for smoke tests / debugging in the console.
declare global {
  interface Window {
    __game: Phaser.Game;
  }
}
// Native Preferences must be consulted before Boot decides which scene to
// enter. A storage failure is deliberately non-fatal: browser storage or the
// menu remains available.
void initializeActiveRunStorage().finally(() => createGame());
