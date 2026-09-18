import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import {
  CHARACTER_ORDER,
  characterUnlocked,
  type CharacterId,
} from "../systems/Characters";
import { charactersBeaten } from "../systems/SaveData";
import { audio } from "../systems/Audio";
import { beginRun } from "../systems/Tutorial";
import {
  buildCharacterCard,
  CHARACTER_CARD_H,
  CHARACTER_CARD_TAIL,
  CHARACTER_CARD_W,
} from "../ui/characterCard";
import {
  MAX_CHOICE_SCALE,
  planChoiceLayout,
  type ChoiceLayout,
} from "../ui/choiceLayout";
import { responsive } from "../ui/layout";
import { attachCardHover } from "../ui/cardHover";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { addFelt } from "../ui/widgets";
import { AmbientLayer } from "../ui/AmbientLayer";

/** Fixed sigil brightness. Set high: this is the one screen where the run has
 *  not started and nothing has gone wrong yet, and the room should read as an
 *  invitation rather than as a decision being demanded. */
const SELECT_AMBIENCE = 0.55;

const CARD_GAP = 26;

const TITLE = "CHOOSE YOUR NOVICE";
const SUBTITLE = "Each keeps a different discipline. The trials do not change.";

/**
 * The character selection, shown once before a run's first trial.
 *
 * It is the same screen as `TributeScene` in every structural respect — a
 * masthead, a hand of cards laid out by `planChoiceLayout`, and a scene that
 * resolves by taking one of them — and for the same reason: both ask the player
 * to pick exactly one card, and neither has any way out. There is no footer and
 * no back button here because there is no run to go back to yet; the run begins
 * when a card is taken, and in no other way.
 *
 * Because it runs BEFORE `beginRun`, there is no RunState while it is open and
 * so no checkpoint to write. A reload here simply returns to the menu, which is
 * the truthful answer: nothing had been started.
 *
 * Locked characters are dealt into the hand rather than left out of it. A hand
 * that grows as the player wins would not tell them that Roland exists, and the
 * card is what says so.
 */
export class CharacterScene extends Phaser.Scene {
  private leaving = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  private beaten: CharacterId[] = [];

  constructor() {
    super("Character");
  }

  create(): void {
    this.leaving = false;
    // Read once per visit rather than per rebuild: a resize must not re-read
    // storage, and nothing can win a run while this screen is open.
    this.beaten = charactersBeaten();
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
    ambient.setProgress(SELECT_AMBIENCE, false);
    this.slideBackdrop = [felt, ambient];

    const titleY = H * 0.08;
    this.add
      .text(cx, titleY, TITLE, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.042, 22, 44))}px`,
        color: CSS.parchment,
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: W - 48 },
      })
      .setOrigin(0.5)
      .setShadow(0, 3, "#000000", 8, false, true);

    const subtitleY = titleY + Math.round(Phaser.Math.Clamp(H * 0.05, 26, 44));
    this.add
      .text(cx, subtitleY, SUBTITLE, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.022, 14, 20))}px`,
        color: CSS.dim,
        fontStyle: "italic",
        align: "center",
        wordWrap: { width: Math.min(W - 48, 620) },
      })
      .setOrigin(0.5);

    // The cards take everything under the masthead, less a margin at the foot
    // so the lowest row never sits flush against the edge of the screen. The
    // planner decides between a row, a grid and a fan from the shape of what is
    // left, which is what carries this screen across portrait and landscape at
    // both phone and desktop sizes without a breakpoint of its own.
    const top = subtitleY + 28;
    // A locked card prints the condition that opens it BELOW the parchment, and
    // the planner only knows about the parchment — so the band the hand is laid
    // out in stops short of the foot by the deepest that line can hang (at the
    // largest a card is ever drawn). The hand centres inside the smaller band
    // and the condition gets the strip left under it, rather than the last row
    // pressing its condition off the bottom of a phone.
    const tail = Math.ceil(CHARACTER_CARD_TAIL * MAX_CHOICE_SCALE);
    const availH = Math.max(CHARACTER_CARD_H * 0.4, H - top - 28 - tail);
    const availW = Math.max(CHARACTER_CARD_W * 0.4, W - 48);
    const layout = planChoiceLayout(
      CHARACTER_ORDER.length,
      availW,
      availH,
      CARD_GAP,
    );
    this.layoutCards(layout, cx, top + availH / 2);
  }

  private layoutCards(layout: ChoiceLayout, cx: number, cy: number): void {
    const n = CHARACTER_ORDER.length;
    const cardW = CHARACTER_CARD_W * layout.scale;
    const cardH = CHARACTER_CARD_H * layout.scale;
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
      this.buildChoice(CHARACTER_ORDER[i], x, y, layout.scale);
    }
  }

  private buildChoice(
    id: CharacterId,
    x: number,
    y: number,
    scale: number,
  ): void {
    const locked = !characterUnlocked(id, this.beaten);
    const card = buildCharacterCard(this, id, { locked, displayScale: scale });
    card.setPosition(x, y);
    card.setSize(CHARACTER_CARD_W * scale, CHARACTER_CARD_H * scale);
    // A locked card is still drawn and still says what opens it; it simply is
    // not a choice, so it takes no hit area and offers no hand cursor.
    if (locked) return;
    card.setInteractive({ useHandCursor: true });
    card.on("pointerdown", () => this.choose(id));
    attachCardHover(this, card);
  }

  /** Take the novice and begin the run. */
  private choose(id: CharacterId): void {
    if (this.leaving) return;
    this.leaving = true;
    audio.buy();
    slideSceneOut(this, () => beginRun(this, id), this.slideBackdrop);
  }
}
