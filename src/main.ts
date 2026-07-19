import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';
import { ShopScene } from './scenes/ShopScene';
import { GameOverScene } from './scenes/GameOverScene';
import { HallScene } from './scenes/HallScene';
import { SettingsScene } from './scenes/SettingsScene';
import { installDevPanel } from './dev/DevPanel';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0d0a12',
  scale: {
    // The canvas is resized (not letterboxed) to fill the page, in whatever
    // orientation the player is in; every scene lays itself out from
    // `scene.scale.width/height` rather than the fixed design size.
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight
  },
  scene: [BootScene, MenuScene, GameScene, ShopScene, GameOverScene, HallScene, SettingsScene]
});

// Exposed for smoke tests / debugging in the console.
declare global {
  interface Window {
    __game: Phaser.Game;
  }
}
window.__game = game;

installDevPanel(game);
