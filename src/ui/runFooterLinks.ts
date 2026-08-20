import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { audio } from "../systems/Audio";
import { isPortrait } from "./layout";

export type RunScreen = "Game" | "TrialResults" | "Shop" | "TrialOverview";

/** Inventory and Settings are persistent run chrome: every run screen draws
 * them at the same coordinates and excludes them from scene-slide tweens. */
export function buildRunFooterLinks(
  scene: Phaser.Scene,
  returnTo: RunScreen,
): Phaser.GameObjects.Text[] {
  const x = scene.scale.width - 24;
  const settingsY = isPortrait(scene)
    ? scene.scale.height - 16
    : scene.scale.height - 30;

  const makeLink = (
    y: number,
    label: string,
    action: () => void,
  ): Phaser.GameObjects.Text => {
    const link = scene.add
      .text(x, y, label, {
        fontFamily: SERIF,
        fontSize: "17px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(1, 0.5)
      .setDepth(10_000)
      .setInteractive({ useHandCursor: true });
    link.on("pointerover", () => link.setColor(CSS.gold));
    link.on("pointerout", () => link.setColor(CSS.dim));
    link.on("pointerdown", action);
    return link;
  };

  const inventory = makeLink(settingsY - 22, "Inventory", () => {
    audio.click();
    scene.scene.launch("Inventory", { returnTo });
    scene.scene.bringToTop("Inventory");
  });
  const settings = makeLink(settingsY, "Settings", () => {
    audio.click();
    scene.scene.launch("Settings", { returnTo, overlay: true });
    scene.scene.bringToTop("Settings");
  });

  return [inventory, settings];
}
