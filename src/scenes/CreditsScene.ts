import Phaser from "phaser";
import { CSS } from "../art/palette";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { addFelt, bannerButton } from "../ui/widgets";
import { onResizeCoalesced, destroyAllChildren } from "../ui/layout";
import { versionLabel } from "../buildInfo";
import { CREDITS } from "../credits";
import licenses from "../generated/licenses.json";

interface Licence {
  name: string;
  version: string;
  license: string;
  text: string;
}

/**
 * Credits & Licences: who made the game, then the licence of every package it
 * ships (src/generated/licenses.json, written by `npm run licenses`), which the
 * MIT and 0BSD licences ask to travel with the software.
 *
 * The body is a DOM panel over the canvas rather than Phaser text: it is a lot
 * of plain text, and the browser's own scrolling, selection and text sizing
 * are the right tools for it. It sits inside the game's parent element, so the
 * interface size setting scales it with everything else.
 */
export class CreditsScene extends Phaser.Scene {
  private panel?: HTMLDivElement;
  private leaving = false;
  private backdrop: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("Credits");
  }

  create(): void {
    this.leaving = false;
    this.build();
    slideSceneIn(this, this.backdrop);
    const off = onResizeCoalesced(this, () => {
      destroyAllChildren(this);
      this.build();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.close();
    };
    window.addEventListener("keydown", onKey);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      window.removeEventListener("keydown", onKey);
      this.panel?.remove();
      this.panel = undefined;
    });
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(W / 2, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(0.5, false);
    const header = buildSceneHeader(this, {
      title: "Credits & Licences",
      y: Math.max(46, Math.min(H * 0.12, 96)),
      width: Math.min(W, 720),
    });
    this.backdrop = [felt, ambient, header.glow];

    const buttonY = H - 44;
    bannerButton(
      this,
      W / 2,
      buttonY,
      "Return",
      () => this.close(),
      Math.min(W - 32, 300),
      64,
    );

    const top = header.bottom + 12;
    const bottom = buttonY - 40;
    const width = Math.min(W - 32, 620);
    this.mountPanel((W - width) / 2, top, width, Math.max(80, bottom - top));
  }

  private mountPanel(x: number, y: number, w: number, h: number): void {
    const parent = this.game.canvas.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === "static")
      parent.style.position = "relative";
    // The canvas is centred in its parent; place the panel against it.
    const offsetX = this.game.canvas.offsetLeft;
    const offsetY = this.game.canvas.offsetTop;

    this.panel?.remove();
    const panel = document.createElement("div");
    this.panel = panel;
    Object.assign(panel.style, {
      position: "absolute",
      left: `${offsetX + x}px`,
      top: `${offsetY + y}px`,
      width: `${w}px`,
      height: `${h}px`,
      overflowY: "auto",
      touchAction: "pan-y",
      overscrollBehavior: "contain",
      color: CSS.parchment,
      font: '15px/1.5 Georgia, "Palatino Linotype", "Times New Roman", serif',
      padding: "4px 10px 16px",
      boxSizing: "border-box",
      userSelect: "text",
      webkitUserSelect: "text",
    } satisfies Partial<CSSStyleDeclaration>);

    const heading = (text: string) => {
      const el = document.createElement("h3");
      el.textContent = text;
      Object.assign(el.style, {
        color: CSS.gold,
        font: 'bold 18px Georgia, "Palatino Linotype", serif',
        margin: "18px 0 6px",
      });
      panel.appendChild(el);
    };
    const para = (text: string, dim = false) => {
      const el = document.createElement("p");
      el.textContent = text;
      el.style.margin = "0 0 6px";
      if (dim) el.style.color = CSS.dim;
      panel.appendChild(el);
    };

    for (const section of CREDITS) {
      heading(section.title);
      for (const line of section.lines) para(line);
    }

    heading("Open-source software");
    para(
      "The Order of Order is built on these packages, each used under the licence shown.",
      true,
    );
    for (const pkg of licenses as Licence[]) {
      const details = document.createElement("details");
      details.style.margin = "4px 0";
      const summary = document.createElement("summary");
      summary.textContent = `${pkg.name} ${pkg.version} — ${pkg.license}`;
      summary.style.cursor = "pointer";
      const pre = document.createElement("pre");
      pre.textContent = pkg.text || `Licensed under ${pkg.license}.`;
      Object.assign(pre.style, {
        whiteSpace: "pre-wrap",
        font: "12px/1.4 ui-monospace, Menlo, Consolas, monospace",
        color: CSS.dim,
        margin: "6px 0 10px",
      });
      details.append(summary, pre);
      panel.appendChild(details);
    }

    para(versionLabel(), true);
    parent.appendChild(panel);
  }

  private close(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.panel?.remove();
    slideSceneOut(
      this,
      () => this.scene.start("Settings", { returnTo: "Menu" }),
      this.backdrop,
    );
  }
}
