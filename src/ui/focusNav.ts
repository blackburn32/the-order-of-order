// Keyboard and controller navigation for every screen, without each screen
// having to know about it.
//
// The game is built for pointers: every control is an interactive game object
// that reacts to pointerover / pointerdown / pointerup. So rather than give
// twenty scenes a focus model each, this treats whatever is interactive on the
// topmost live scene as the focus ring: the arrow keys or the d-pad / left
// stick move to the nearest control in that direction, Enter / Space / A
// presses the focused one (as a tap would), and Escape / B goes back. Focusing
// a control also hovers it, so tooltips show for a controller as they do for a
// mouse. The ring itself is a DOM outline over the canvas, so it needs no
// camera of its own and sits above every scene.
//
// The ring stays hidden until a key or a button is used, and hides again on the
// next pointer or touch, so a mouse or touch player never sees it.
//
// What it does not do: drag. Rearranging dice, panning the grid and dragging
// the volume sliders still want a pointer or touch.

import Phaser from "phaser";
import { DPR } from "../renderQuality";

type Dir = "up" | "down" | "left" | "right";

interface Candidate {
  obj: Phaser.GameObjects.GameObject;
  camera: Phaser.Cameras.Scene2D.Camera;
  /** Centre and size on screen, in layout pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const STICK_THRESHOLD = 0.55;
const REPEAT_FIRST_MS = 380;
const REPEAT_MS = 140;

/** Standard-mapping gamepad buttons. */
const PAD = {
  a: 0,
  b: 1,
  start: 9,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

export function installFocusNav(game: Phaser.Game): void {
  let focused: Phaser.GameObjects.GameObject | null = null;
  let focusedScene: Phaser.Scene | null = null;
  let active = false;

  const ring = document.createElement("div");
  Object.assign(ring.style, {
    position: "fixed",
    pointerEvents: "none",
    border: "2px solid #f1d27a",
    borderRadius: "8px",
    boxShadow: "0 0 0 2px rgba(13,10,18,0.85), 0 0 14px rgba(241,210,122,0.55)",
    zIndex: "10",
    display: "none",
    transition:
      "left 90ms ease-out, top 90ms ease-out, width 90ms, height 90ms",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(ring);

  /** The scene that would take a tap: the topmost one running with input on. */
  function topScene(): Phaser.Scene | null {
    const scenes = game.scene.getScenes(true);
    for (let i = scenes.length - 1; i >= 0; i--) {
      const scene = scenes[i];
      if (scene.input?.enabled && scene.sys.isVisible()) return scene;
    }
    return null;
  }

  function renders(
    obj: Phaser.GameObjects.GameObject,
    camera: Phaser.Cameras.Scene2D.Camera,
  ): boolean {
    if (!obj.willRender(camera)) return false;
    let parent = obj.parentContainer;
    while (parent) {
      if (!parent.willRender(camera)) return false;
      parent = parent.parentContainer;
    }
    return true;
  }

  function candidates(scene: Phaser.Scene): Candidate[] {
    const list = (
      scene.input as unknown as { _list: Phaser.GameObjects.GameObject[] }
    )._list;
    const W = game.scale.width;
    const H = game.scale.height;
    const out: Candidate[] = [];
    // Topmost camera first: a scrolling pane's camera is added after main.
    const cameras = [...scene.cameras.cameras].reverse();
    for (const obj of list) {
      if (!obj.input?.enabled || !obj.active) continue;
      // Only controls something listens to; a bare blocker (a felt swallowing
      // taps) is interactive but is not a control.
      if (
        obj.listenerCount("pointerdown") + obj.listenerCount("pointerup") ===
        0
      )
        continue;
      const camera = cameras.find((cam) => cam.visible && renders(obj, cam));
      if (!camera) continue;
      const bounds = (
        obj as unknown as { getBounds?: () => Phaser.Geom.Rectangle }
      ).getBounds?.();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
      // Full-screen catch-alls are not controls you can move between.
      if (bounds.width >= W * 0.95 && bounds.height >= H * 0.95) continue;
      const zoom = camera.zoomX / DPR;
      const left = camera.x / DPR + (bounds.x - camera.scrollX) * zoom;
      const top = camera.y / DPR + (bounds.y - camera.scrollY) * zoom;
      const w = bounds.width * zoom;
      const h = bounds.height * zoom;
      const x = left + w / 2;
      const y = top + h / 2;
      // Off screen, or outside the pane that clips it.
      const vx = camera.x / DPR;
      const vy = camera.y / DPR;
      const vw = camera.width / DPR;
      const vh = camera.height / DPR;
      if (x < vx || x > vx + vw || y < vy || y > vy + vh) continue;
      if (x < 0 || x > W || y < 0 || y > H) continue;
      out.push({ obj, camera, x, y, w, h });
    }
    return out;
  }

  function pointerAt(c: Candidate): Phaser.Input.Pointer {
    const zoom = c.camera.zoomX / DPR;
    const worldX = (c.x - c.camera.x / DPR) / zoom + c.camera.scrollX;
    const worldY = (c.y - c.camera.y / DPR) / zoom + c.camera.scrollY;
    const now = game.loop.time;
    // A stand-in with what the game's handlers read off a pointer.
    return {
      id: 99,
      x: c.x,
      y: c.y,
      worldX,
      worldY,
      downX: c.x,
      downY: c.y,
      upX: c.x,
      upY: c.y,
      downTime: now,
      upTime: now,
      isDown: false,
      wasTouch: false,
      button: 0,
      camera: c.camera,
      event: null,
      position: new Phaser.Math.Vector2(c.x, c.y),
      leftButtonDown: () => true,
      rightButtonDown: () => false,
      getDuration: () => 0,
      getDistance: () => 0,
      noButtonDown: () => false,
    } as unknown as Phaser.Input.Pointer;
  }

  function emit(c: Candidate, event: string, pointer = pointerAt(c)): void {
    try {
      c.obj.emit(event, pointer, 0, 0, { stopPropagation() {} });
    } catch (err) {
      console.warn(`focus: ${event} handler threw`, err);
    }
  }

  function current(scene: Phaser.Scene): Candidate | undefined {
    if (!focused || focusedScene !== scene) return undefined;
    return candidates(scene).find((c) => c.obj === focused);
  }

  function setFocus(scene: Phaser.Scene, next: Candidate | undefined): void {
    const prev = current(scene);
    if (prev && prev.obj !== next?.obj) emit(prev, "pointerout");
    focused = next?.obj ?? null;
    focusedScene = next ? scene : null;
    if (next && next.obj !== prev?.obj) emit(next, "pointerover");
    drawRing(next);
  }

  function drawRing(c: Candidate | undefined): void {
    if (!c || !active) {
      ring.style.display = "none";
      return;
    }
    const rect = game.canvas.getBoundingClientRect();
    const sx = rect.width / game.scale.width;
    const sy = rect.height / game.scale.height;
    const pad = 4;
    ring.style.display = "block";
    ring.style.left = `${rect.left + (c.x - c.w / 2) * sx - pad}px`;
    ring.style.top = `${rect.top + (c.y - c.h / 2) * sy - pad}px`;
    ring.style.width = `${c.w * sx + pad * 2}px`;
    ring.style.height = `${c.h * sy + pad * 2}px`;
  }

  /** The control a direction leads to: the nearest one whose centre lies that
   *  way, favouring the ones most squarely in line. */
  function nearest(
    from: Candidate,
    all: Candidate[],
    dir: Dir,
  ): Candidate | undefined {
    let best: Candidate | undefined;
    let bestScore = Infinity;
    for (const c of all) {
      if (c.obj === from.obj) continue;
      const dx = c.x - from.x;
      const dy = c.y - from.y;
      const along =
        dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
      const across = dir === "left" || dir === "right" ? dy : dx;
      if (along <= 4) continue;
      const score = along + Math.abs(across) * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /** Where focus starts on a screen: top-left-most, reading order. */
  function first(all: Candidate[]): Candidate | undefined {
    return [...all].sort((a, b) => a.y - b.y || a.x - b.x)[0];
  }

  function move(dir: Dir): void {
    const scene = topScene();
    if (!scene) return;
    const all = candidates(scene);
    const from = current(scene);
    if (!active || !from) {
      active = true;
      setFocus(scene, from ?? first(all));
      return;
    }
    const next = nearest(from, all, dir);
    if (next) setFocus(scene, next);
    else drawRing(from);
  }

  function press(): void {
    const scene = topScene();
    if (!scene) return;
    const c = current(scene);
    if (!active || !c) {
      move("down");
      return;
    }
    const pointer = pointerAt(c);
    emit(c, "pointerdown", pointer);
    emit(c, "pointerup", pointer);
    // The press may have rebuilt the screen or changed scenes; re-find the
    // control by position next frame.
    const x = c.x;
    const y = c.y;
    game.events.once(Phaser.Core.Events.POST_STEP, () => {
      const top = topScene();
      if (!top) return;
      const all = candidates(top);
      if (top === scene && all.some((o) => o.obj === focused)) {
        drawRing(all.find((o) => o.obj === focused));
        return;
      }
      const near = [...all].sort(
        (a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y),
      )[0];
      setFocus(top, top === scene ? near : first(all));
    });
  }

  /** The label a control shows, when it is a button with one. */
  function labelOf(obj: Phaser.GameObjects.GameObject): string {
    const children =
      obj instanceof Phaser.GameObjects.Container ? obj.list : [obj];
    for (const child of children)
      if (child instanceof Phaser.GameObjects.Text) return child.text;
    return "";
  }

  const BACK_LABEL = /^(return|back|close|skip|not now|leave)\b/i;

  function back(): void {
    const scene = topScene();
    // Screens that close on Escape listen for it already; B sends the same
    // key, so they need nothing more.
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape" }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Escape", code: "Escape" }),
    );
    // Everywhere else, B presses the screen's own way back, if it has one.
    game.events.once(Phaser.Core.Events.POST_STEP, () => {
      if (!scene || topScene() !== scene || !scene.sys.isActive()) return;
      const way = candidates(scene).find((c) =>
        BACK_LABEL.test(labelOf(c.obj)),
      );
      if (!way) return;
      const pointer = pointerAt(way);
      emit(way, "pointerdown", pointer);
      emit(way, "pointerup", pointer);
    });
  }

  // --- Keyboard ------------------------------------------------------------

  window.addEventListener("keydown", (event) => {
    // A focused text field (none in the game today) keeps its keys.
    if ((event.target as HTMLElement | null)?.tagName === "INPUT") return;
    const dir = (
      {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
      } as Record<string, Dir>
    )[event.key];
    // The initials prompt uses the arrows itself, for its letters.
    if (dir && topScene()?.scene.key === "InitialsPrompt") return;
    if (dir) {
      event.preventDefault();
      move(dir);
    } else if ((event.key === "Enter" || event.key === " ") && active) {
      if (topScene()?.scene.key === "InitialsPrompt") return;
      event.preventDefault();
      press();
    }
  });

  const hide = () => {
    if (!active) return;
    active = false;
    ring.style.display = "none";
  };
  window.addEventListener("pointerdown", hide, true);
  window.addEventListener("wheel", hide, { passive: true });

  // --- Gamepad -------------------------------------------------------------

  const held = new Map<string, number>(); // control -> next repeat time
  function edge(name: string, down: boolean, now: number, repeat: boolean) {
    if (!down) {
      held.delete(name);
      return false;
    }
    const next = held.get(name);
    if (next === undefined) {
      held.set(name, now + REPEAT_FIRST_MS);
      return true;
    }
    if (repeat && now >= next) {
      held.set(name, now + REPEAT_MS);
      return true;
    }
    return false;
  }

  game.events.on(Phaser.Core.Events.STEP, (now: number) => {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const btn = (i: number) => pad.buttons[i]?.pressed ?? false;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const dirs: [Dir, boolean][] = [
        ["up", btn(PAD.up) || ay < -STICK_THRESHOLD],
        ["down", btn(PAD.down) || ay > STICK_THRESHOLD],
        ["left", btn(PAD.left) || ax < -STICK_THRESHOLD],
        ["right", btn(PAD.right) || ax > STICK_THRESHOLD],
      ];
      for (const [dir, down] of dirs)
        if (edge(`${pad.index}:${dir}`, down, now, true)) move(dir);
      if (edge(`${pad.index}:a`, btn(PAD.a), now, false)) press();
      if (edge(`${pad.index}:b`, btn(PAD.b) || btn(PAD.start), now, false))
        back();
    }
    // Keep the ring on its control while the screen animates under it.
    if (active && focused && focusedScene) {
      const scene = topScene();
      if (scene !== focusedScene) {
        setFocus(focusedScene, undefined);
        if (scene) setFocus(scene, first(candidates(scene)));
      } else drawRing(current(scene));
    }
  });
}
