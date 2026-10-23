import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { afflictionCard, type ItemDef } from "../systems/Items";
import { CHARACTERS } from "../systems/Characters";
import { beginRun } from "../systems/Tutorial";
import { audio } from "../systems/Audio";
import {
  dailyBoonCard,
  dailyRite,
  msUntilNextDay,
  type DailyRite,
} from "../systems/Daily";
import { dailyPlayed, loadDailyHall } from "../systems/SaveData";
import { formatScore } from "../ui/formatScore";
import { buildItemCard } from "../ui/itemCard";
import { buildCharacterCard } from "../ui/characterCard";
import {
  CARD_H,
  CARD_W,
  planChoiceLayout,
  type ChoiceLayout,
} from "../ui/choiceLayout";
import { attachCardHover } from "../ui/cardHover";
import { compactColumns, isCompactLandscape, responsive } from "../ui/layout";
import { buildSceneHeader } from "../ui/sceneHeader";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { addFelt, BannerAction, stackBannerButtons } from "../ui/widgets";
import { AmbientLayer } from "../ui/AmbientLayer";

const DAILY_AMBIENCE = 0.6;
const CARD_GAP = 22;

/** The share of the hand's band the novice takes when the day cannot be dealt
 *  as one straight row. */
const NOVICE_BAND = 0.36;
/** The same, on a screen too narrow to stand the novice's card beside the rite:
 *  they are drawn as a strip across the top instead (see `noviceStrip`). */
const NOVICE_STRIP = 0.26;

/** A boon or bane with the line it prints, or null for the day's novice. */
type HandCard = { def: ItemDef; note: string } | null;

/** Room each banner button takes in a stacked foot. */
const BUTTON_ROW_H = 64;

/** The day as the masthead prints it: "Friday, 23 October". Read in UTC, which
 *  is the calendar the rite keeps, so the date shown is the rite's date. */
function formatDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The Daily Rite's antechamber: today's boons and banes laid out as cards, and
 * the door to the day's one attempt.
 *
 * Every rule of the day is shown here, before anything is begun, because the
 * player only gets the one run: the decision to begin it is the decision that
 * counts, and it should be taken with the whole rite in view. The same cards
 * travel with the run onto the Inventory shelf.
 *
 * Reached only from the Vestibule, and only once a run has been won (see
 * MenuScene). Like the character selection, it runs before any RunState
 * exists, so there is nothing to checkpoint while it is open.
 */
export class DailyScene extends Phaser.Scene {
  private rite!: DailyRite;
  private played = false;
  private leaving = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("Daily");
  }

  create(): void {
    this.leaving = false;
    // Read once per visit: a rite that rolled over at midnight while the screen
    // was open is still the rite on the cards until the player comes back.
    this.rite = dailyRite();
    this.played = dailyPlayed(this.rite.day);
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
    ambient.setProgress(DAILY_AMBIENCE, false);

    const compact = isCompactLandscape(W, H);
    const columns = compactColumns(this, { leftFraction: 0.38 });
    const chrome = compact
      ? { cx: columns.left.cx, width: columns.left.width }
      : { cx, width: Math.min(W, 760) };

    const header = buildSceneHeader(this, {
      title: "The Daily Rite",
      subtitle: `${formatDay(this.rite.day)} · as ${CHARACTERS[this.rite.character].name}`,
      y: compact ? columns.top + 40 : Math.max(44, Math.min(H * 0.1, 80)),
      width: chrome.width,
      ...(compact ? { x: columns.left.cx } : {}),
    });
    header.title.setAlign("center");
    this.slideBackdrop = [felt, ambient, header.glow];

    const actions = this.actions();
    const status = this.statusLine();

    if (compact) {
      const statusText = this.status(
        columns.left.cx,
        header.bottom + 14,
        columns.left.width,
        status,
      );
      const bandTop = statusText.getBounds().bottom + 12;
      stackBannerButtons(
        this,
        { cx: columns.left.cx, width: columns.left.width },
        { top: bandTop, height: Math.max(0, columns.bottom - bandTop) },
        actions,
        { primary: !this.played },
      );
      this.layoutHand(
        columns.right.cx,
        columns.top,
        columns.right.width,
        columns.height,
      );
      return;
    }

    const footH = actions.length * BUTTON_ROW_H;
    const footTop = H - 12 - footH;
    stackBannerButtons(
      this,
      { cx, width: Math.min(W - 32, 340) },
      { top: footTop, height: footH },
      actions,
      { primary: !this.played },
    );
    const statusText = this.status(cx, footTop - 8, W - 48, status);
    statusText.setOrigin(0.5, 1);
    const top = header.bottom + 12;
    const bottom = statusText.getBounds().top - 10;
    this.layoutHand(cx, top, W - 32, Math.max(CARD_H * 0.3, bottom - top));
  }

  private actions(): BannerAction[] {
    const actions: BannerAction[] = [];
    if (!this.played)
      actions.push({ label: "Begin the Rite", onClick: () => this.begin() });
    actions.push({
      label: "Today's Board",
      onClick: () =>
        this.leave(() => this.scene.start("Hall", { tab: "daily" })),
    });
    actions.push({
      label: "Return to the Vestibule",
      onClick: () => this.leave(() => this.scene.start("Menu")),
    });
    return actions;
  }

  /** What the foot says above the buttons: the one-attempt rule before the
   *  rite is begun, and how it went (and when the next opens) after. */
  private statusLine(): string {
    const next = `The next rite opens in ${formatWait(msUntilNextDay())}.`;
    const who = CHARACTERS[this.rite.character];
    if (!this.played)
      return `Today every player is ${who.name}, with the same dice, shops and Boss Trials.\nOne attempt: the first run you begin is the one that counts.`;
    const kept = loadDailyHall().find((e) => e.daily === this.rite.day);
    if (!kept) return `Today's rite is already under way.\n${next}`;
    const verdict = kept.won
      ? `won at rank ${kept.rank}`
      : `ended at rank ${kept.rank}-${kept.trial}`;
    return `You kept today's rite: ${verdict}, ${formatScore(kept.score)} points.\n${next}`;
  }

  private status(
    x: number,
    y: number,
    width: number,
    line: string,
  ): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, line, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(width * 0.03, 13, 17))}px`,
        color: CSS.dim,
        fontStyle: "italic",
        align: "center",
        wordWrap: { width },
        lineSpacing: 4,
      })
      .setOrigin(0.5, 0);
  }

  /** Lay the day's cards in the band given: boons first, banes after, each
   *  drawn by the same builder as a card in the shop. */
  /**
   * Lay the day out in the band given: the novice, then the boons, then the
   * banes. Where the five fit in one straight row they are dealt as one hand;
   * where they would have to fan or stack, the novice takes a band of their own
   * — beside the rite on a wide screen, as a strip above it on a narrow one —
   * rather than be fanned under the cards: they are the one card the player
   * has to see whole.
   */
  private layoutHand(cx: number, top: number, width: number, height: number) {
    // Each boon and bane says which side of the day it is on, where the shop
    // prints a price: a granted boon is an ordinary card, and nothing else on
    // its face says it is being given rather than sold.
    const rite: HandCard[] = [
      ...this.rite.boons.map((id) => ({
        def: dailyBoonCard(id),
        note: "Today's boon",
      })),
      ...this.rite.banes.map((id) => ({
        def: afflictionCard(id),
        note: "Today's bane",
      })),
    ];
    const all: HandCard[] = [null, ...rite];
    const whole = this.plan(all.length, width, height);
    if (whole.rows === 1 && !whole.fanned) {
      this.dealHand(all, whole, cx, top + height / 2);
      return;
    }
    if (width > height) {
      const side = width * NOVICE_BAND;
      this.dealHand(
        [null],
        this.plan(1, side, height),
        cx - width / 2 + side / 2,
        top + height / 2,
      );
      const restW = width - side;
      this.dealHand(
        rite,
        this.plan(rite.length, restW, height),
        cx - width / 2 + side + restW / 2,
        top + height / 2,
      );
    } else {
      // Too narrow for even one card beside the rite, so the novice is drawn as
      // a strip instead: the portrait, and their name and rule beside it. A
      // card here would be stood alone on top at a size its copy cannot be
      // read at, and would squeeze the rite into a fan below it.
      const band = Math.min(height * NOVICE_STRIP, 150);
      this.noviceStrip(cx, top + band / 2, width, band);
      const restH = height - band;
      this.dealHand(
        rite,
        this.plan(rite.length, width, restH),
        cx,
        top + band + restH / 2,
      );
    }
  }

  private noviceStrip(cx: number, cy: number, width: number, height: number) {
    const who = CHARACTERS[this.rite.character];
    const artSize = Math.max(48, height - 12);
    const textW = Math.min(width - artSize - 16, 320);
    const left = cx - (artSize + 12 + textW) / 2;
    const art = this.add.image(left + artSize / 2, cy, who.art);
    art.setScale(artSize / Math.max(art.width, art.height));
    const name = this.add
      .text(left + artSize + 12, cy - 4, who.name, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(height * 0.18, 16, 24))}px`,
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(0, 1);
    this.add
      .text(left + artSize + 12, name.y + 6, who.ability, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(height * 0.11, 12, 15))}px`,
        color: CSS.parchment,
        wordWrap: { width: textW },
      })
      .setOrigin(0, 0);
  }

  private plan(n: number, width: number, height: number): ChoiceLayout {
    return planChoiceLayout(
      n,
      Math.max(CARD_W * 0.3, width),
      Math.max(CARD_H * 0.3, height),
      CARD_GAP,
    );
  }

  /** Deal `cards` centred on (cx, cy) as `layout` arranges them. A null entry
   *  is the day's novice, drawn as the character selection draws them. */
  private dealHand(
    cards: HandCard[],
    layout: ChoiceLayout,
    cx: number,
    cy: number,
  ): void {
    const cardW = CARD_W * layout.scale;
    const cardH = CARD_H * layout.scale;
    const stride = cardW * layout.step + (layout.fanned ? 0 : CARD_GAP);
    const rowH = cardH + CARD_GAP;
    const firstY = cy - ((layout.rows - 1) * rowH) / 2;
    cards.forEach((entry, i) => {
      const row = Math.floor(i / layout.cols);
      const col = i % layout.cols;
      const inRow = Math.min(layout.cols, cards.length - row * layout.cols);
      const card = entry
        ? buildItemCard(this, entry.def, {
            locked: false,
            showCaption: false,
            displayScale: layout.scale,
            compactType: true,
            note: entry.note,
          })
        : buildCharacterCard(this, this.rite.character, {
            locked: false,
            displayScale: layout.scale,
          });
      card.setPosition(
        cx + (col - (inRow - 1) / 2) * stride,
        firstY + row * rowH,
      );
      card.setSize(cardW, cardH);
      card.setInteractive();
      attachCardHover(this, card);
    });
  }

  /** The day has already chosen the novice, so the rite goes straight to the
   *  table rather than through the character selection. */
  private begin(): void {
    const rite = this.rite;
    audio.buy();
    this.leave(() => beginRun(this, rite.character, rite));
  }

  private leave(complete: () => void): void {
    if (this.leaving) return;
    this.leaving = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }
}
