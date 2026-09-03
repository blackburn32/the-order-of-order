import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { audio } from "../systems/Audio";
import { isSplitFooter } from "./layout";

export type RunScreen = "Game" | "TrialResults" | "Shop" | "TrialOverview";

/** Inventory and Settings are persistent run chrome: every run screen draws
 * them at the same coordinates and excludes them from scene-slide tweens.
 * Portrait and short viewports put them at opposite ends of one bottom row
 * (Inventory left, Settings right) rather than stacked in the bottom-right
 * corner, where they would sit on top of the wide button those layouts run
 * across the bottom. Screens whose content reaches the bottom edge clear the
 * row with `RUN_FOOTER_ROW_H`. */
export function buildRunFooterLinks(
  scene: Phaser.Scene,
  returnTo: RunScreen,
): Phaser.GameObjects.Text[] {
  const W = scene.scale.width;
  const H = scene.scale.height;
  // Split to opposite ends of one row where the bottom-right corner is spoken
  // for, stacked in that corner where it isn't. See `isSplitFooter`.
  const split = isSplitFooter(scene);
  const settingsY = split ? H - 16 : H - 30;

  const makeLink = (
    x: number,
    y: number,
    originX: number,
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
      .setOrigin(originX, 0.5)
      .setDepth(10_000)
      .setInteractive({ useHandCursor: true });
    link.on("pointerover", () => link.setColor(CSS.gold));
    link.on("pointerout", () => link.setColor(CSS.dim));
    link.on("pointerdown", action);
    return link;
  };

  const inventory = makeLink(
    split ? 24 : W - 24,
    split ? settingsY : settingsY - 22,
    split ? 0 : 1,
    "Inventory",
    () => {
      audio.click();
      scene.scene.launch("Inventory", { returnTo });
      scene.scene.bringToTop("Inventory");
    },
  );
  const settings = makeLink(W - 24, settingsY, 1, "Settings", () => {
    audio.click();
    scene.scene.launch("Settings", { returnTo, overlay: true });
    scene.scene.bringToTop("Settings");
  });

  return [inventory, settings];
}
