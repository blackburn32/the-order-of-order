// A notice the game puts in front of the player — a boss taking the table, the
// mirror duel beginning — in the felt-and-gold panel the roll's score callout
// uses, rather than a strip of parchment across the screen.
//
//        ┌────────────────────────────────┐
//        │  THE ECLIPSE PRESIDES        × │
//        │  Dice showing 6 score nothing  │
//        │  this trial.                   │
//        │  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬         │  ← time left before it closes
//        └────────────────────────────────┘
//
// It closes itself once the bar runs out, and stops counting while the pointer
// rests on it so a slow reader can finish. A finger cannot hover, so a tap on
// the panel holds it open in the same way until the player closes it. The ×
// closes it at once.

import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { fx } from "../systems/Effects";

export interface NoticePanelOptions {
  title: string;
  body?: string;
  /** How long the panel stays up when left alone. */
  durationMs?: number;
  /** Where its middle sits, read again on every relayout. The scene's middle
   *  when left out. */
  centerY?(): number;
  /** Hand every object to the scene's overlay camera. */
  register?(objects: Phaser.GameObjects.GameObject[]): void;
}

export interface NoticePanelHandle {
  /** Re-centre on the scene and refit its width, after a resize. */
  relayout(): void;
  /** Fade it away now. */
  close(): void;
  /** Whether it has closed (or is closing). */
  readonly closed: boolean;
}

const DEFAULT_DURATION_MS = 4000;
const MAX_WIDTH = 540;
const MIN_WIDTH = 300;
const PAD_X = 22;
const PAD_Y = 18;
const BAR_H = 4;
const RADIUS = 16;
const DEPTH = 95;
const FADE_IN_MS = 200;
const FADE_OUT_MS = 250;

export function showNoticePanel(
  scene: Phaser.Scene,
  opts: NoticePanelOptions,
): NoticePanelHandle {
  const duration = opts.durationMs ?? DEFAULT_DURATION_MS;
  const width = Math.max(
    MIN_WIDTH,
    Math.min(MAX_WIDTH, scene.scale.width - 32),
  );
  const textW = width - PAD_X * 2 - 28; // room for the close mark

  const title = scene.add
    .text(-width / 2 + PAD_X, 0, opts.title.toUpperCase(), {
      fontFamily: SERIF,
      fontSize: "22px",
      color: CSS.goldLight,
      fontStyle: "bold",
      wordWrap: { width: textW },
    })
    .setOrigin(0, 0);
  const body = opts.body
    ? scene.add
        .text(-width / 2 + PAD_X, 0, opts.body, {
          fontFamily: SERIF,
          fontSize: "18px",
          color: CSS.parchment,
          lineSpacing: 3,
          wordWrap: { width: width - PAD_X * 2 },
        })
        .setOrigin(0, 0)
    : undefined;

  const height =
    PAD_Y +
    title.height +
    (body ? 8 + body.height : 0) +
    PAD_Y +
    BAR_H +
    PAD_Y * 0.6;
  const top = -height / 2;
  title.setY(top + PAD_Y);
  body?.setY(title.y + title.height + 8);

  const panel = scene.add.graphics();
  panel.fillStyle(COLORS.feltDark, 0.95);
  panel.fillRoundedRect(-width / 2, top, width, height, RADIUS);
  panel.lineStyle(1.5, COLORS.gold, 0.7);
  panel.strokeRoundedRect(-width / 2, top, width, height, RADIUS);

  // The countdown: a track the full width of the copy, and a gold fill that
  // drains from the right as the panel's time runs out.
  const barW = width - PAD_X * 2;
  const barY = top + height - PAD_Y * 0.6 - BAR_H;
  const track = scene.add
    .rectangle(-barW / 2, barY, barW, BAR_H, COLORS.gold, 0.18)
    .setOrigin(0, 0);
  const fill = scene.add
    .rectangle(-barW / 2, barY, barW, BAR_H, COLORS.goldLight, 0.9)
    .setOrigin(0, 0);

  const closeMark = scene.add
    .text(width / 2 - PAD_X + 4, top + PAD_Y - 4, "×", {
      fontFamily: SERIF,
      fontSize: "28px",
      color: CSS.parchment,
    })
    .setOrigin(1, 0)
    .setAlpha(0.75)
    .setInteractive({ useHandCursor: true });

  const container = scene.add
    .container(0, 0, [
      panel,
      title,
      ...(body ? [body] : []),
      track,
      fill,
      closeMark,
    ])
    .setDepth(DEPTH)
    .setSize(width, height)
    .setAlpha(0);
  // The whole panel takes the pointer, so hovering anywhere on it pauses the
  // count and a click on it never falls through to the table underneath.
  container.setInteractive();
  opts.register?.([container]);

  let elapsed = 0;
  // Read off the scene clock rather than summed from each frame's delta,
  // which Phaser smooths and caps, so a slow frame rate stretches the count.
  let lastAt = scene.time.now;
  let hovered = false;
  let held = false;
  let closed = false;

  const relayout = () => {
    const room = scene.scale.width - 24;
    container.setScale(width > room ? room / width : 1);
    container.setPosition(
      scene.scale.width / 2,
      opts.centerY?.() ?? scene.scale.height / 2,
    );
  };
  relayout();

  const tick = () => {
    if (closed || !container.scene) return;
    const now = scene.time.now;
    if (!hovered && !held) elapsed += now - lastAt;
    lastAt = now;
    const left = Math.max(0, 1 - elapsed / duration);
    fill.width = barW * left;
    if (left <= 0) close();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    scene.events.off(Phaser.Scenes.Events.UPDATE, tick);
    if (!container.scene) return;
    container.disableInteractive();
    scene.tweens.add({
      targets: container,
      alpha: 0,
      y: container.y - (fx.motion ? 16 : 0),
      duration: FADE_OUT_MS,
      ease: "Quad.easeIn",
      onComplete: () => container.destroy(),
    });
  };

  container.on("pointerover", (p: Phaser.Input.Pointer) => {
    if (!p.wasTouch) hovered = true;
  });
  container.on("pointerout", () => (hovered = false));
  container.on("pointerdown", (p: Phaser.Input.Pointer) => {
    // A finger can't hover: a tap holds the panel open until it is closed.
    if (p.wasTouch) held = true;
  });
  // The × sits on top of the panel and takes the hover from it; resting on it
  // still counts as reading.
  closeMark.on("pointerover", () => {
    hovered = true;
    closeMark.setAlpha(1);
  });
  closeMark.on("pointerout", () => {
    hovered = false;
    closeMark.setAlpha(0.75);
  });
  closeMark.on(
    "pointerdown",
    (
      _p: Phaser.Input.Pointer,
      _x: number,
      _y: number,
      event: Phaser.Types.Input.EventData,
    ) => {
      event.stopPropagation();
      close();
    },
  );

  scene.events.on(Phaser.Scenes.Events.UPDATE, tick);
  container.once(Phaser.GameObjects.Events.DESTROY, () => {
    closed = true;
    scene.events.off(Phaser.Scenes.Events.UPDATE, tick);
  });

  const restY = container.y;
  if (fx.motion) container.y = restY + 14;
  scene.tweens.add({
    targets: container,
    alpha: 1,
    y: restY,
    duration: FADE_IN_MS,
    ease: "Quad.easeOut",
  });

  return {
    relayout,
    close,
    get closed() {
      return closed;
    },
  };
}
