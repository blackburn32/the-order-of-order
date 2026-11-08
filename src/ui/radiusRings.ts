import Phaser from "phaser";
import { fx } from "../systems/Effects";
import {
  DIE_HALF_CELL,
  RADIUS_CELLS,
  RADIUS_DICE,
  type RadiusKind,
} from "../systems/RadiusDice";

/**
 * The circles the radius dice reach with (systems/RadiusDice), drawn on the
 * grid in each die's own colour: the Halo's pale blue, Grace's pink and the
 * Censer's violet.
 *
 * The circles sit on the felt BEHIND the dice: a circle tints the cells it
 * covers and every die sits on top of it. The circle is redrawn every frame
 * from where the dice are actually drawn, so it follows a die the player is
 * carrying to a new place and slides with the grid when it reflows.
 *
 * When a radius die goes off, its circle answers: a ring sweeps out from the
 * die to the edge of its reach and the disc flares, so the dice it touched are
 * plainly the dice inside that flash.
 */

/** How strongly the disc is tinted, at rest. */
const FILL_ALPHA = 0.16;
/** The rim, at rest. */
const RIM_ALPHA = 0.55;
/** The rim's width on screen, in pixels, whatever the zoom. */
const RIM_PX = 2.5;

/** The firing animation. */
const SWEEP_MS = 640;
const FLARE_MS = 900;
/** How far apart, in time, the dice that go off one after another flare. */
export const RADIUS_STAGGER_MS = 220;

export interface RadiusCircle {
  index: number;
  kind: RadiusKind;
  x: number;
  y: number;
}

export class RadiusRings {
  private readonly scene: Phaser.Scene;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly effects: Phaser.GameObjects.Container;
  private readonly hide: (objects: Phaser.GameObjects.GameObject[]) => void;

  /** `parent` is the grid's container; `dice` is the dice layer inside it,
   *  which the circles go either side of. */
  constructor(
    scene: Phaser.Scene,
    parent: Phaser.GameObjects.Container,
    dice: Phaser.GameObjects.Container,
    /** Keep objects out of every camera but the grid's. */
    hide: (objects: Phaser.GameObjects.GameObject[]) => void,
  ) {
    this.scene = scene;
    this.hide = hide;
    this.graphics = scene.add.graphics();
    this.effects = scene.add.container(0, 0);
    // Under the dice layer, so every die sits on top of its circle.
    parent.addAt([this.graphics, this.effects], parent.getIndex(dice));
  }

  /** Redraw every circle. `cell` is the grid's cell size and `zoom` the grid
   *  camera's, so the rim keeps one on-screen width. */
  draw(circles: readonly RadiusCircle[], cell: number, zoom: number): void {
    const g = this.graphics;
    // Every frame, since the cameras that must not draw it can be made after
    // it was; marking an object a camera already ignores costs nothing.
    this.hide([g, this.effects]);
    g.clear();
    if (circles.length === 0) return;
    const radius = RADIUS_CELLS * cell;
    for (const c of circles) {
      const color = RADIUS_DICE[c.kind].color;
      g.fillStyle(color, FILL_ALPHA);
      g.fillCircle(c.x, c.y, radius);
      g.lineStyle(RIM_PX / Math.max(1e-6, zoom), color, RIM_ALPHA);
      g.strokeCircle(c.x, c.y, radius);
      // A soft second rim just inside the first marks the edge a die has to
      // cross to be reached.
      g.lineStyle(
        (RIM_PX * 2.5) / Math.max(1e-6, zoom),
        color,
        RIM_ALPHA * 0.25,
      );
      g.strokeCircle(c.x, c.y, radius - cell * (0.5 - DIE_HALF_CELL));
    }
  }

  /** Play a die's circle going off, `delay` ms from now. */
  fire(circle: RadiusCircle, cell: number, zoom: number, delay = 0): void {
    if (!fx.on) return;
    const color = RADIUS_DICE[circle.kind].color;
    const radius = RADIUS_CELLS * cell;
    const rim = RIM_PX / Math.max(1e-6, zoom);

    // The flare: the whole disc brightens and fades back.
    const flare = this.scene.add.circle(circle.x, circle.y, radius, color, 0.4);
    flare.setAlpha(0);
    // The sweep: a ring that runs out from the die to the edge of its reach.
    const sweep = this.scene.add.circle(circle.x, circle.y, radius);
    sweep.setStrokeStyle(rim * 3, color, 1);
    sweep.setScale(DIE_HALF_CELL / RADIUS_CELLS);
    sweep.setAlpha(0);
    this.effects.add([flare, sweep]);
    this.hide([flare, sweep]);

    if (!fx.motion) {
      // Reduced motion: the disc simply lights and fades.
      this.scene.tweens.add({
        targets: flare,
        alpha: { from: 0.9, to: 0 },
        delay,
        duration: FLARE_MS,
        onComplete: () => {
          flare.destroy();
          sweep.destroy();
        },
      });
      return;
    }
    this.scene.tweens.add({
      targets: sweep,
      scale: 1,
      alpha: { from: 1, to: 0.15 },
      delay,
      duration: SWEEP_MS,
      ease: "Cubic.easeOut",
      onComplete: () => sweep.destroy(),
    });
    this.scene.tweens.add({
      targets: flare,
      alpha: { from: 0, to: 1 },
      delay: delay + SWEEP_MS * 0.55,
      duration: FLARE_MS * 0.3,
      yoyo: true,
      hold: FLARE_MS * 0.15,
      ease: "Sine.easeOut",
      onComplete: () => flare.destroy(),
    });
  }

  /** Stop every firing still playing. */
  clearEffects(): void {
    for (const child of [...this.effects.list]) {
      this.scene.tweens.killTweensOf(child);
      child.destroy();
    }
  }

  destroy(): void {
    this.clearEffects();
    this.graphics.destroy();
    this.effects.destroy();
  }
}
