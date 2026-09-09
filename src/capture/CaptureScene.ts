import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { addFelt } from "../ui/widgets";
import { buildItemCard } from "../ui/itemCard";
import { DieSprite } from "../ui/DieSprite";
import { makeDie, type Die } from "../systems/Dice";
import {
  captureDice,
  capturePreset,
  CORE_CARD_IDS,
  CURSED_CARD_IDS,
  itemById,
  type CaptureBackdrop,
  type CapturePresetId,
} from "./presets";

interface CaptureSceneData {
  presetId: CapturePresetId;
  backdrop: CaptureBackdrop;
}

const TITLE_DEPTH = 20;

export class CaptureScene extends Phaser.Scene {
  private presetId: CapturePresetId = "cards-core";
  private backdrop: CaptureBackdrop = "felt";

  constructor() {
    super("CaptureStudio");
  }

  init(data: CaptureSceneData): void {
    this.presetId = data.presetId;
    this.backdrop = data.backdrop;
  }

  create(): void {
    this.renderPreset();
  }

  private renderPreset(): void {
    this.addBackdrop();

    switch (this.presetId) {
      case "card-two-newcomers":
        this.renderSingleCard("extra_die");
        break;
      case "card-like-minds":
        this.renderSingleCard("twin");
        break;
      case "card-resonance":
        this.renderSingleCard("amplifier");
        break;
      case "cards-core":
        this.renderCards(
          CORE_CARD_IDS,
          "Foundational doctrine",
          "Every card rewrites the roll.",
        );
        break;
      case "cards-cursed":
        this.renderCards(
          CURSED_CARD_IDS,
          "Questionable doctrine",
          "Power with the customary administrative drawback.",
        );
        break;
      case "dice-order":
        this.renderDiceOrder();
        break;
      case "settling":
        this.renderSettling();
        break;
      default:
        // Gameplay presets are handed to the real GameScene by main.ts.
        this.renderCards(
          CORE_CARD_IDS,
          "Capture Studio",
          capturePreset(this.presetId).label,
        );
    }

    this.signalReady();
  }

  private addBackdrop(): void {
    const { width: W, height: H } = this.scale;
    this.cameras.main.setBackgroundColor("rgba(0,0,0,0)");
    if (this.backdrop === "transparent") return;

    if (this.backdrop === "felt") {
      addFelt(this);
      const ring = this.add
        .image(W / 2, H * 0.56, "sigil-ring")
        .setTint(COLORS.gold)
        .setAlpha(0.105);
      const size = Math.min(W, H) * 1.18;
      ring.setDisplaySize(size, size);
      this.add
        .image(W / 2, H * 0.56, "sigil")
        .setDisplaySize(size * 0.68, size * 0.68)
        .setTint(COLORS.gold)
        .setAlpha(0.12);
      return;
    }

    this.cameras.main.setBackgroundColor(COLORS.parchment);
    const g = this.add.graphics().setAlpha(0.18);
    g.lineStyle(1, COLORS.inkSoft, 1);
    const gap = Math.max(32, Math.round(Math.min(W, H) / 14));
    for (let x = -H; x < W + H; x += gap) {
      g.lineBetween(x, 0, x + H, H);
      g.lineBetween(x + H, 0, x, H);
    }
  }

  private heading(kicker: string, title: string, detail?: string): number {
    const { width: W, height: H } = this.scale;
    const dark = this.backdrop === "parchment";
    const top = Math.max(28, H * 0.07);
    const kickerSize = Math.round(Phaser.Math.Clamp(W * 0.013, 12, 18));
    const titleSize = Math.round(Phaser.Math.Clamp(W * 0.046, 34, 70));

    this.add
      .text(W / 2, top, kicker.toUpperCase(), {
        fontFamily: SERIF,
        fontSize: `${kickerSize}px`,
        color: dark ? CSS.waxRed : CSS.goldLight,
        fontStyle: "bold",
        letterSpacing: 4,
      })
      .setOrigin(0.5, 0)
      .setDepth(TITLE_DEPTH);

    const heading = this.add
      .text(W / 2, top + kickerSize * 1.7, title, {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: dark ? CSS.ink : CSS.ivory,
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: W * 0.88 },
      })
      .setOrigin(0.5, 0)
      .setDepth(TITLE_DEPTH);

    if (detail) {
      this.add
        .text(W / 2, heading.y + heading.height + 10, detail, {
          fontFamily: SERIF,
          fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.016, 14, 23))}px`,
          color: dark ? CSS.inkSoft : CSS.parchmentDark,
          fontStyle: "italic",
          align: "center",
          wordWrap: { width: W * 0.78 },
        })
        .setOrigin(0.5, 0)
        .setDepth(TITLE_DEPTH);
    }

    return heading.y + heading.height;
  }

  private renderCards(
    ids: typeof CORE_CARD_IDS | typeof CURSED_CARD_IDS,
    kicker: string,
    title: string,
  ): void {
    const { width: W, height: H } = this.scale;
    const headingBottom = this.heading(kicker, title);
    const portrait = H > W * 1.05;
    const availableH = H - headingBottom - H * 0.09;
    const horizontalScale =
      (W * 0.82) / (ids.length * 260 + (ids.length - 1) * 34);
    const verticalScale = availableH / 390;
    const scale = Phaser.Math.Clamp(
      Math.min(horizontalScale, verticalScale),
      portrait ? 0.58 : 0.72,
      1.42,
    );
    const cardY = headingBottom + availableH * 0.56;
    const spread = portrait ? 188 * scale : 305 * scale;

    ids.forEach((id, index) => {
      const card = buildItemCard(this, itemById(id), {
        locked: false,
        showCaption: false,
        displayScale: scale,
      });
      const offset = index - (ids.length - 1) / 2;
      card
        .setPosition(
          W / 2 + offset * spread,
          cardY + Math.abs(offset) * 12 * scale,
        )
        .setDepth(10 + index);
    });
  }

  private renderSingleCard(id: (typeof CORE_CARD_IDS)[number]): void {
    const { width: W, height: H } = this.scale;
    const scale = Math.min((W * 0.8) / 260, (H * 0.84) / 340);
    buildItemCard(this, itemById(id), {
      locked: false,
      showCaption: false,
      displayScale: scale,
    }).setPosition(W / 2, H / 2);
  }

  private renderDiceOrder(): void {
    const { width: W, height: H } = this.scale;
    const headingBottom = this.heading(
      "Members in good standing",
      "An increasingly improbable congregation.",
      "Every shape has agreed to remain still for the portrait.",
    );
    const dice = captureDice();
    const columns = H > W ? 2 : 4;
    const rows = Math.ceil(dice.length / columns);
    const areaTop = headingBottom + Math.max(50, H * 0.08);
    const areaH = H - areaTop - H * 0.07;
    const cellW = (W * 0.84) / columns;
    const cellH = areaH / rows;
    const scale = Math.min(cellW / 125, cellH / 125, 1.75);
    const left = W / 2 - ((columns - 1) * cellW) / 2;

    dice.forEach((die, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const sprite = new DieSprite(
        this,
        left + col * cellW,
        areaTop + cellH * (row + 0.42),
        die,
      );
      sprite.setScale(scale);
    });
  }

  private renderSettling(): void {
    const { width: W, height: H } = this.scale;
    this.heading(
      "The founding miracle",
      "For one remarkable moment, it stopped.",
      "Its face held. Its thoughts followed. An institution became inevitable.",
    );

    const main = makeDie(6);
    main.value = 1;
    const centre = new DieSprite(this, W / 2, H * 0.62, main);
    centre.setScale(Math.min(W, H) / 260).setDepth(8);

    const unsettled: Array<{ die: Die; sprite: DieSprite }> = [];
    for (let i = 0; i < 4; i++) {
      const die = makeDie(6);
      die.value = ((i + 2) % 6) + 1;
      const side = i < 2 ? -1 : 1;
      const distance = (i % 2 === 0 ? 0.24 : 0.38) * W;
      const sprite = new DieSprite(
        this,
        W / 2 + side * distance,
        H * (0.56 + (i % 2) * 0.19),
        die,
      );
      sprite.setScale(Math.min(W, H) / 400).setAlpha(0.7);
      unsettled.push({ die, sprite });
    }

    const rollFaces = () => {
      for (const entry of unsettled) {
        entry.die.value = (entry.die.value % 6) + 1;
        entry.sprite.showFace(entry.die.value);
      }
    };
    this.time.addEvent({ delay: 140, loop: true, callback: rollFaces });

    const halo = this.add
      .circle(centre.x, centre.y, Math.min(W, H) * 0.15, COLORS.glow, 0.04)
      .setStrokeStyle(2, COLORS.gold, 0.38)
      .setDepth(2);
    this.tweens.add({
      targets: halo,
      scale: 1.12,
      alpha: 0.16,
      duration: 1350,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    this.add
      .text(W / 2, H * 0.87, "OBSERVED DURATION · 2.8 SECONDS", {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.013, 12, 18))}px`,
        color: this.backdrop === "parchment" ? CSS.waxRed : CSS.goldLight,
        fontStyle: "bold",
        letterSpacing: 3,
      })
      .setOrigin(0.5);
  }

  private signalReady(): void {
    this.game.events.once(Phaser.Core.Events.POST_RENDER, () => {
      this.game.events.emit("capture-content-ready", this.presetId);
    });
  }
}
