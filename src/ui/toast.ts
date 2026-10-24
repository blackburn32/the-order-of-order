// Toasts: a short line of confirmation ("All progress has been reset") that
// rises from the bottom of the screen, rests, and fades on its own. They say
// that something happened, not what to do next, so they never take input
// beyond a tap to clear them early.
//
// Each scene keeps its own column of them. A second toast while one is still
// up stacks above it rather than covering it, and the column closes up as
// they leave.

import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { fx } from "../systems/Effects";

export type ToastTone = "info" | "success" | "warning";

export interface ToastOptions {
  /** How long it rests before fading. */
  durationMs?: number;
  /** Colours the edge and the mark before the message. */
  tone?: ToastTone;
  /** Hand the toast to the scene's overlay camera, where it has one. */
  register?(objects: Phaser.GameObjects.GameObject[]): void;
}

const DEFAULT_DURATION_MS = 2200;
const PAD_X = 18;
const HEIGHT = 44;
const GAP = 10;
/** Kept clear of the bottom edge (and a phone's home bar). */
const BOTTOM_MARGIN = 36;
const DEPTH = 9_000;
const ENTER_MS = 220;
const LEAVE_MS = 260;

const TONE: Record<
  ToastTone,
  { edge: number; mark: string; markColor: string }
> = {
  info: { edge: COLORS.gold, mark: "◆", markColor: CSS.goldLight },
  success: { edge: COLORS.goldLight, mark: "✓", markColor: CSS.goldLight },
  warning: { edge: COLORS.waxRed, mark: "!", markColor: CSS.red },
};

interface Live {
  container: Phaser.GameObjects.Container;
  leaving: boolean;
}

const columns = new WeakMap<Phaser.Scene, Live[]>();

/** Where the toast `index` places from the bottom rests. */
function slotY(scene: Phaser.Scene, index: number): number {
  return (
    scene.scale.height - BOTTOM_MARGIN - HEIGHT / 2 - index * (HEIGHT + GAP)
  );
}

function restack(scene: Phaser.Scene, live: Live[]): void {
  live
    .filter((toast) => !toast.leaving)
    .forEach((toast, index) => {
      scene.tweens.add({
        targets: toast.container,
        y: slotY(scene, index),
        duration: fx.motion ? 180 : 0,
        ease: "Cubic.out",
      });
    });
}

/** Show `message` as a toast at the bottom of `scene`. */
export function showToast(
  scene: Phaser.Scene,
  message: string,
  opts: ToastOptions = {},
): void {
  const tone = TONE[opts.tone ?? "info"];
  let live = columns.get(scene);
  if (!live) {
    live = [];
    columns.set(scene, live);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      columns.delete(scene),
    );
  }

  const mark = scene.add
    .text(0, 0, tone.mark, {
      fontFamily: SERIF,
      fontSize: "18px",
      color: tone.markColor,
      fontStyle: "bold",
    })
    .setOrigin(0, 0.5);
  const text = scene.add
    .text(0, 0, message, {
      fontFamily: SERIF,
      fontSize: "18px",
      color: CSS.parchment,
    })
    .setOrigin(0, 0.5);
  const maxW = scene.scale.width - 32;
  const markGap = 10;
  const textRoom = maxW - PAD_X * 2 - mark.width - markGap;
  if (text.width > textRoom) text.setScale(textRoom / text.width);
  const width = PAD_X * 2 + mark.width + markGap + text.displayWidth;
  mark.setX(-width / 2 + PAD_X);
  text.setX(mark.x + mark.width + markGap);

  const bg = scene.add.graphics();
  bg.fillStyle(COLORS.feltDark, 0.95);
  bg.fillRoundedRect(-width / 2, -HEIGHT / 2, width, HEIGHT, HEIGHT / 2);
  bg.lineStyle(1.5, tone.edge, 0.85);
  bg.strokeRoundedRect(-width / 2, -HEIGHT / 2, width, HEIGHT, HEIGHT / 2);

  const restY = slotY(scene, live.filter((toast) => !toast.leaving).length);
  const container = scene.add
    .container(scene.scale.width / 2, restY + (fx.motion ? 24 : 0), [
      bg,
      mark,
      text,
    ])
    .setDepth(DEPTH)
    .setSize(width, HEIGHT)
    .setAlpha(0)
    .setInteractive({ useHandCursor: true });
  opts.register?.([container]);

  const entry: Live = { container, leaving: false };
  live.push(entry);

  const column = live;
  const leave = () => {
    if (entry.leaving || !container.scene) return;
    entry.leaving = true;
    timer.remove();
    container.disableInteractive();
    restack(scene, column);
    scene.tweens.add({
      targets: container,
      alpha: 0,
      y: container.y + (fx.motion ? 16 : 0),
      duration: LEAVE_MS,
      ease: "Quad.easeIn",
      onComplete: () => {
        const at = column.indexOf(entry);
        if (at >= 0) column.splice(at, 1);
        container.destroy();
      },
    });
  };

  scene.tweens.add({
    targets: container,
    alpha: 1,
    y: restY,
    duration: ENTER_MS,
    ease: "Quad.easeOut",
  });
  const timer = scene.time.delayedCall(
    ENTER_MS + (opts.durationMs ?? DEFAULT_DURATION_MS),
    leave,
  );
  container.on("pointerdown", leave);
}
