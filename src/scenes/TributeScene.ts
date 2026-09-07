import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { getRun } from "../state/RunState";
import { afflict, type AfflictionId } from "../systems/Afflictions";
import { afflictionCard } from "../systems/Items";
import {
  createFreshShopCheckpoint,
  saveActiveRun,
} from "../systems/ActiveRunPersistence";
import { audio } from "../systems/Audio";
import { buildItemCard } from "../ui/itemCard";
import {
  CARD_H,
  CARD_W,
  planChoiceLayout,
  type ChoiceLayout,
} from "../ui/choiceLayout";
import { responsive } from "../ui/layout";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { addFelt } from "../ui/widgets";
import { AmbientLayer } from "../ui/AmbientLayer";

/** Fixed sigil brightness. Low: this is the one screen in the game where
 *  nothing good is on offer, and the room should not be celebrating. */
const TRIBUTE_AMBIENCE = 0.25;

const CARD_GAP = 26;

export interface TributeSceneData {
  gift: "kingsDemands" | "betrayal";
  choices: AfflictionId[];
}

const TITLES: Record<TributeSceneData["gift"], string> = {
  kingsDemands: "THE KING’S DEMANDS",
  betrayal: "THE ORDER OF DISORDER",
};

const SUBTITLES: Record<TributeSceneData["gift"], string> = {
  kingsDemands: "Choose one. The Crown is not asking.",
  betrayal: "A gift you did not ask for, and cannot refuse.",
};

/**
 * The drawback a story act hands over.
 *
 * Two shapes, one screen: the King's writ, where the player must accept one of
 * several demands, and the Order of Disorder's single card, where there is
 * nothing to choose and only something to acknowledge.
 *
 * It has no way out. There is no footer, no back button, and no dismissal — the
 * scene resolves by taking a card and in no other way, because the run cannot
 * continue without one and an exit would be lying about that.
 *
 * The cards are drawn by the ordinary card builder, fed a synthetic definition:
 * `buildItemCard` reads a name, a rarity, a description and a cursed flag, and
 * never an id, so a drawback with no item behind it renders with the same wax
 * mark and red parchment as a cursed card bought in the shop.
 */
export class TributeScene extends Phaser.Scene {
  private dataIn!: TributeSceneData;
  private leaving = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("Tribute");
  }

  init(data?: TributeSceneData): void {
    this.dataIn = {
      gift: data?.gift ?? "kingsDemands",
      choices: data?.choices ?? [],
    };
    this.leaving = false;
  }

  create(): void {
    saveActiveRun(this.registry, {
      scene: "Tribute",
      gift: this.dataIn.gift,
      choices: [...this.dataIn.choices],
    });
    responsive(this, () => this.build());
    slideSceneIn(this, this.slideBackdrop);
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(TRIBUTE_AMBIENCE, false);
    this.slideBackdrop = [felt, ambient];

    const titleY = H * 0.08;
    this.add
      .text(cx, titleY, TITLES[this.dataIn.gift], {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.042, 22, 44))}px`,
        color: CSS.cursed,
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: W - 48 },
      })
      .setOrigin(0.5)
      .setShadow(0, 3, "#000000", 8, false, true);

    const subtitleY = titleY + Math.round(Phaser.Math.Clamp(H * 0.05, 26, 44));
    this.add
      .text(cx, subtitleY, SUBTITLES[this.dataIn.gift], {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.022, 14, 20))}px`,
        color: CSS.dim,
        fontStyle: "italic",
        align: "center",
        wordWrap: { width: Math.min(W - 48, 620) },
      })
      .setOrigin(0.5);

    // The cards take everything under the masthead, less a margin at the foot
    // so the lowest row never sits flush against the edge of the screen.
    const top = subtitleY + 28;
    const availH = Math.max(CARD_H * 0.4, H - top - 28);
    const availW = Math.max(CARD_W * 0.4, W - 48);
    const layout = planChoiceLayout(
      Math.max(1, this.dataIn.choices.length),
      availW,
      availH,
      CARD_GAP,
    );
    this.layoutCards(layout, cx, top + availH / 2);
  }

  private layoutCards(layout: ChoiceLayout, cx: number, cy: number): void {
    const n = this.dataIn.choices.length;
    const cardW = CARD_W * layout.scale;
    const cardH = CARD_H * layout.scale;
    const stride = cardW * layout.step + (layout.fanned ? 0 : CARD_GAP);
    const rowH = cardH + CARD_GAP;
    const top = cy - ((layout.rows - 1) * rowH) / 2;

    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / layout.cols);
      const col = i % layout.cols;
      // The last row may be short, so it is centred on its own count rather
      // than on the full column width.
      const inRow = Math.min(layout.cols, n - row * layout.cols);
      const x = cx + (col - (inRow - 1) / 2) * stride;
      const y = top + row * rowH;
      this.buildChoice(this.dataIn.choices[i], x, y, layout.scale);
    }
  }

  private buildChoice(
    id: AfflictionId,
    x: number,
    y: number,
    scale: number,
  ): void {
    const card = buildItemCard(this, afflictionCard(id), {
      locked: false,
      showCaption: false,
      displayScale: scale,
      compactType: true,
    });
    card.setPosition(x, y);
    card.setSize(CARD_W * scale, CARD_H * scale);
    card.setInteractive({ useHandCursor: true });
    card.on("pointerdown", () => this.choose(id));
    card.on("pointerover", () => card.setScale(1.03));
    card.on("pointerout", () => card.setScale(1));
  }

  /** Take the drawback and move on. The boss clear that led here still owes the
   *  player its boon shop, so that is where both gifts hand off to. */
  private choose(id: AfflictionId): void {
    if (this.leaving) return;
    this.leaving = true;
    const state = getRun(this.registry);
    afflict(state, id);
    // Held by id as well as on the affliction list, so endless knows which of
    // the run's drawbacks was the Crown's and can lift exactly that one.
    if (this.dataIn.gift === "kingsDemands") state.kingsDemand = id;
    audio.buy();
    const checkpoint = createFreshShopCheckpoint(state);
    saveActiveRun(this.registry, checkpoint);
    slideSceneOut(
      this,
      () => this.scene.start("Shop", checkpoint),
      this.slideBackdrop,
    );
  }
}
