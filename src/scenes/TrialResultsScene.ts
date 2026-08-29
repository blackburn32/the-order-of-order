import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { rankOf, trialName } from "../config";
import type { TrialEndOutcome } from "../sim/engine";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { describeUnlockAction, ITEMS, type ShopItemId } from "../systems/Items";
import {
  COMPACT_MARGIN,
  compactColumns,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
import { AmbientLayer } from "../ui/AmbientLayer";
import { RuleDice } from "../ui/RuleDice";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { addFelt, bannerButton, fitTextWidth } from "../ui/widgets";
import { buildItemCard } from "../ui/itemCard";
import { buildRunFooterLinks } from "../ui/runFooterLinks";
import { CalloutHandle, showCallout } from "../ui/Callout";
import {
  advanceTutorial,
  getTutorial,
  TutorialStage,
  TUTORIAL_TEXT,
} from "../systems/Tutorial";
import { getRun } from "../state/RunState";
import { endingAfterTrial, type EndingDef } from "../systems/Endings";
import {
  createFreshShopCheckpoint,
  saveActiveRun,
  type ResumableCheckpoint,
} from "../systems/ActiveRunPersistence";

/** Native size of the 'card' texture buildItemCard draws on. */
const CARD_W = 260;
const CARD_H = 340;

/** The display scale a card's copy is written for. Below it the type stops
 *  following the art down and starts spilling over the parchment, so this is
 *  the point at which a row of cards closes into a fan rather than shrink any
 *  further — the same trade the shop's compact carousel makes. */
const READABLE_CARD_SCALE = 0.62;
/** How little of a fanned card its neighbour may leave showing. Half a card is
 *  enough to read its title and see its face; past that the fan stops tightening
 *  and the cards give up size again. */
const MIN_FAN_STEP = 0.5;
/** Air, in card units, kept either side of a fan for the corners its outermost
 *  cards throw out as they tilt. */
const FAN_BULGE = 36;
/** Tilt of the outermost cards in a fan, and the drop of their lower corners. */
const FAN_MAX_TILT_DEG = 6;
const FAN_ARC_MAX = 4;
/** The smallest a card is ever drawn. A band this tight has already sent the
 *  cards terse, so what has to survive at the floor is a rarity and a title —
 *  not a description — and the floor is low enough to keep the announcement and
 *  its footnote off the way on below them. */
const MIN_CARD_SCALE = 0.26;
/** The pose a fanned card takes when it is brought to the front to be read. */
const FAN_FOCUS_LIFT = 10;
const FAN_FOCUS_SCALE = 1.06;
/** How long a terse card takes to grow into the column, and the rest of the
 *  column takes to stand aside for it. */
const EXPAND_MS = 260;
/** Air left above an opened card that has had to grow past its band. */
const EXPAND_HEADROOM = 10;

export interface TrialResultsData {
  outcome: TrialEndOutcome;
  unlocked: ShopItemId[];
}

/** Offsets inside the gold receipt's box: where the total sits, where the
 *  itemised rows begin, and the padding under the last one. Shared by the
 *  builder and by `receiptHeight`, which the compact layout needs *before*
 *  the box exists in order to centre it in its column. */
const RECEIPT_TITLE_INSET = 14;
const RECEIPT_LINES_INSET = 49;
const RECEIPT_FOOT_PAD = 18;

function receiptHeight(lines: number, lineGap: number): number {
  return (
    RECEIPT_LINES_INSET + Math.max(0, lines - 1) * lineGap + RECEIPT_FOOT_PAD
  );
}

/** The label of the interest row, which the tutorial's Interest step points at. */
const INTEREST_LABEL = "Interest";

/** The itemised gold lines worth printing: every source that paid, plus the
 *  trial reward itself even when it paid nothing (a receipt with no first
 *  line reads as an error rather than as a small reward). While the tutorial is
 *  running the interest row is kept too, at +0 or not: it is the thing the
 *  Interest step explains, and a lesson needs a row to point at. A first purse
 *  is four gold, so that row would otherwise never appear during the tutorial —
 *  which is exactly why players did not know interest existed. */
function receiptLines(
  o: TrialEndOutcome,
  teaching = false,
): Array<[string, number]> {
  const all: Array<[string, number]> = [
    ["Trial reward", o.goldBreakdown.base],
    ["Rolls left in hand", o.goldBreakdown.rolls],
    [INTEREST_LABEL, o.goldBreakdown.interest],
    ["Relics and boss rewards", o.goldBreakdown.items],
    ["Tithe Bowl during rolls", o.rollGold.titheBowl],
    ["Lucky Coin during rolls", o.rollGold.luckyCoin],
    // The one line that can take gold away: a ceiling affliction skimming the
    // purse as the trial ends (Pauper's Vow). Printed last, and signed, so the
    // receipt still adds up to what the player is carrying into the shop.
    ["Forfeited to your vow", -o.goldForfeited],
  ];
  return all.filter(
    ([label, amount], i) =>
      amount !== 0 || i === 0 || (teaching && label === INTEREST_LABEL),
  );
}

/** A laid-out results screen, handed to the reveal sequence: the groups it
 *  fades in, in order, and the button it finishes on. Both the stacked and the
 *  folded arrangement produce one of these, so the presentation itself doesn't
 *  care which it got. */
interface ResultsLayout {
  /** The title halo — part of the room, held still by the scene slide. */
  glow: Phaser.GameObjects.Image;
  headline: Phaser.GameObjects.GameObject[];
  /** The receipt's box, total and rows, revealed as one group. */
  receipt: Phaser.GameObjects.GameObject[];
  unlock: {
    objects: Phaser.GameObjects.GameObject[];
    burstX: number;
    burstY: number;
  };
  button: Phaser.GameObjects.Container;
  buttonY: number;
}

/** One deliberate pause between play and shopping: success, accounting, then
 * meta-progression. The whole presentation can be skipped with one tap without
 * changing the state it represents. */
export class TrialResultsScene extends Phaser.Scene {
  private dataIn!: TrialResultsData;
  private revealObjects: Phaser.GameObjects.GameObject[] = [];
  private timers: Phaser.Time.TimerEvent[] = [];
  private complete = false;
  private leaving = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  // Screen rect of the gold receipt, which the first-run tutorial points at
  // once the reveal has finished.
  private receiptRect?: Phaser.Geom.Rectangle;
  // The interest row inside it, which the tutorial's Interest step points at.
  private interestRect?: Phaser.Geom.Rectangle;
  private tutorialCallout?: CalloutHandle;
  // Which fanned card is currently pulled to the front, so the same card is
  // not re-focused on every pointer move across it.
  private fanFocus?: number;
  // The terse card currently opened over its column, if any, and the cards a
  // press may land on without closing it.
  private expansion?: {
    index: number;
    card: Phaser.GameObjects.Container;
    close: () => void;
  };
  private expandables: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("TrialResults");
  }

  init(data: TrialResultsData): void {
    this.dataIn = data;
  }

  create(): void {
    this.complete = false;
    this.leaving = false;
    this.build(true);
    slideSceneIn(this, this.slideBackdrop);
    // A press anywhere finishes the reveal; a press anywhere that is not a card
    // also puts an opened card away. Which cards those are is read off the
    // pointer's own hit list, so this does not depend on whether the scene hears
    // about the press before or after the card does.
    const skip = (
      _pointer: Phaser.Input.Pointer,
      over: Phaser.GameObjects.GameObject[],
    ) => {
      this.revealAll();
      const expansion = this.expansion;
      if (!expansion) return;
      const onCard = over?.some(
        (object) =>
          object === expansion.card || this.expandables.includes(object),
      );
      if (!onCard) expansion.close();
    };
    this.input.on("pointerdown", skip);
    const off = onResizeCoalesced(this, () => {
      this.clearTimers();
      // removeAll destroys the callout's objects along with everything else;
      // drop the stale handle so the rebuild anchors a fresh one.
      this.tutorialCallout = undefined;
      destroyAllChildren(this);
      // The rebuild starts from nothing revealed — including the continue
      // button, which build() creates hidden — so let revealAll do its work
      // again rather than short-circuit on the old scene's completion.
      this.complete = false;
      this.build(false);
      this.revealAll();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.input.off("pointerdown", skip);
      this.clearTimers();
    });
  }

  private build(animate: boolean): void {
    this.revealObjects = [];
    this.fanFocus = undefined;
    this.expansion = undefined;
    this.expandables = [];
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(0.82, false);
    const footerLinks = buildRunFooterLinks(this, "TrialResults");

    // Verdict, receipt, unlocked cards and the way on stack four deep — more
    // than a short landscape viewport has the height for, so there it folds
    // into a header line over two columns instead.
    const layout = isCompactLandscape(W, H)
      ? this.layoutCompact()
      : this.layoutStacked();
    this.slideBackdrop = [felt, ambient, layout.glow, ...footerLinks];
    this.revealObjects.push(
      ...layout.headline,
      ...layout.receipt,
      ...layout.unlock.objects,
      layout.button,
    );

    const { button, buttonY } = layout;
    if (!animate || !fx.motion) {
      this.revealAll();
      return;
    }
    for (const obj of this.revealObjects) {
      if (obj !== button) {
        const target = obj as unknown as Phaser.GameObjects.Components.Alpha;
        target.setAlpha(0);
      }
    }
    this.schedule(120, () => this.revealGroup(layout.headline, 0));
    this.schedule(720, () => {
      audio.buy();
      this.revealGroup(layout.receipt, 35);
    });
    if (layout.unlock.objects.length > 0) {
      this.schedule(1450, () => {
        this.revealGroup(layout.unlock.objects, 65);
        fx.burst(this, layout.unlock.burstX, layout.unlock.burstY, {
          count: 30,
          tint: COLORS.goldLight,
          speed: 250,
        });
      });
    }
    // Nothing unlocked means nothing to wait for: the button arrives early.
    this.schedule(layout.unlock.objects.length > 0 ? 2150 : 1400, () => {
      button
        .setVisible(true)
        .setAlpha(0)
        .setY(buttonY + 18);
      this.tweens.add({
        targets: button,
        alpha: 1,
        y: buttonY,
        duration: 280,
        ease: "Cubic.easeOut",
      });
      this.complete = true;
      this.renderTutorial();
    });
  }

  /** The tall arrangement: verdict, receipt, unlocked cards and the way on,
   *  one under the other down the middle of the screen. */
  private layoutStacked(): ResultsLayout {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const panelW = Math.min(W - 28, 980);
    const panelH = Math.min(H - 28, 700);
    const top = H / 2 - panelH / 2 + 48;

    const glow = this.buildTitleGlow(cx, top, Math.min(700, W * 0.78), 250);
    const titleSize = Phaser.Math.Clamp(panelW * 0.058, 28, 52);
    const title = this.add
      .text(cx, top, this.verdict(), {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        letterSpacing: 3,
        stroke: "#0d0a12",
        strokeThickness: Math.max(3, Math.round(titleSize * 0.09)),
      })
      .setOrigin(0.5)
      .setShadow(0, 4, "#000000", 10, true, true);
    const subtitle = this.add
      .text(cx, top + 50, this.trialLine(), {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(panelW * 0.023, 14, 21)}px`,
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5);

    const ruleY = top + 86;
    const ruleDice = new RuleDice(this, cx, ruleY, 12);
    const rule = this.add.graphics();
    const ruleHalf = panelW * 0.4;
    const ruleGap = ruleDice.width / 2 + 12;
    rule.lineStyle(1.5, COLORS.gold, 0.58);
    rule.lineBetween(cx - ruleHalf, ruleY, cx - ruleGap, ruleY);
    rule.lineBetween(cx + ruleGap, ruleY, cx + ruleHalf, ruleY);

    const receipt = this.buildReceipt(
      cx,
      ruleY + 13,
      Math.min(panelW * 0.72, 660),
      panelW,
      Math.min(27, panelH * 0.042),
    );

    const buttonY = H / 2 + panelH / 2 - 48;
    const unlock = this.buildUnlockSection(
      cx,
      receipt.bottom + 14,
      buttonY - 42,
      panelW,
    );
    const button = this.buildContinueButton(
      cx,
      buttonY,
      Math.min(panelW * 0.65, 420),
    );

    return {
      glow,
      headline: [title, subtitle],
      receipt: receipt.objects,
      unlock,
      button,
      buttonY,
    };
  }

  /** The folded arrangement for a short landscape viewport: the verdict and
   *  its trial share one header line across the top, and the receipt and the
   *  way on take a column beneath it — beside the trial's unlocked cards, when
   *  there are any, which is what the other column is for. A trial that
   *  unlocked nothing has nothing to put there, so the receipt keeps the middle
   *  of the screen rather than sitting next to a column of air. */
  private layoutCompact(): ResultsLayout {
    const W = this.scale.width;
    const H = this.scale.height;
    const left = COMPACT_MARGIN;
    const right = W - COMPACT_MARGIN;
    const headerTop = 12;

    const titleSize = Math.round(Phaser.Math.Clamp(W * 0.05, 22, 34));
    const title = this.add
      .text(left, headerTop, this.verdict(), {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        letterSpacing: 3,
        stroke: "#0d0a12",
        strokeThickness: Math.max(3, Math.round(titleSize * 0.09)),
      })
      .setOrigin(0, 0)
      .setShadow(0, 3, "#000000", 8, true, true);
    const glow = this.buildTitleGlow(
      left + title.width / 2,
      headerTop + title.height / 2,
      Math.min(560, W * 0.6),
      150,
    );
    // Sized off the title, so it can only be built after it — then sent back
    // behind, where light falling on the table belongs.
    this.children.moveBelow(glow, title);
    const subtitle = this.add
      .text(right, headerTop + title.height / 2, this.trialLine(), {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(titleSize * 0.52, 12, 17))}px`,
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(1, 0.5);
    fitTextWidth(subtitle, Math.max(60, right - left - title.width - 18));

    const ruleY = Math.round(headerTop + title.height + 6);
    const rule = this.add.graphics();
    rule.lineStyle(1, COLORS.gold, 0.32);
    rule.lineBetween(left, ruleY, right, ruleY);

    const unlocks = this.unlockedDefs().length > 0;
    const columns = compactColumns(this, {
      top: ruleY + 12,
      leftFraction: 0.46,
    });
    // With no cards to show, the receipt column is the whole band.
    const column = unlocks
      ? columns.left
      : { cx: W / 2, width: Math.min(W * 0.62, 560) };

    // The receipt's height follows from how many sources paid, and the button
    // measures itself, so the pair can be centred in the column as one block.
    const lineGap = Phaser.Math.Clamp(columns.height * 0.07, 16, 27);
    const boxH = receiptHeight(
      receiptLines(this.dataIn.outcome, this.teachingReceipt()).length,
      lineGap,
    );
    const button = this.buildContinueButton(
      column.cx,
      0,
      Math.min(column.width, 420),
    );
    const blockGap = Phaser.Math.Clamp(columns.height * 0.06, 14, 26);
    const blockTop =
      columns.top +
      Math.max(0, (columns.height - boxH - blockGap - button.height) / 2);
    const receipt = this.buildReceipt(
      column.cx,
      blockTop,
      column.width,
      column.width / 0.72,
      lineGap,
    );
    const buttonY = receipt.bottom + blockGap + button.height / 2;
    button.setY(buttonY);

    // Inventory/Settings are pinned to the bottom-right corner on every run
    // screen, and that is where this column ends — so the cards stop short of
    // them, the way the shop's compact sidebar does.
    const unlock = this.buildUnlockSection(
      columns.right.cx,
      columns.top,
      Math.min(columns.bottom, H - 62),
      columns.right.width / 0.92,
    );

    return {
      glow,
      headline: [title, subtitle, rule],
      receipt: receipt.objects,
      unlock,
      button,
      buttonY,
    };
  }

  /** The item definitions behind this trial's unlocks. The compact layout
   *  needs to know whether there are any *before* it decides how to divide the
   *  screen, so the lookup is shared rather than done inside the section. */
  private unlockedDefs(): (typeof ITEMS)[number][] {
    return this.dataIn.unlocked
      .map((id) => ITEMS.find((item) => item.id === id))
      .filter((item): item is (typeof ITEMS)[number] => !!item);
  }

  private verdict(): string {
    return this.dataIn.outcome.insuranceUsed
      ? "TRIAL SURVIVED"
      : "TRIAL CLEARED";
  }

  private trialLine(): string {
    const o = this.dataIn.outcome;
    return `${trialName(o.completedTrial).replace(" Trial", " trial")}, Rank ${rankOf(o.completedTrial)}`;
  }

  private buildTitleGlow(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Phaser.GameObjects.Image {
    const glow = this.add
      .image(x, y, "spark")
      .setTint(COLORS.glow)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(width, height)
      .setAlpha(0.2);
    if (fx.motion) {
      const baseScaleX = glow.scaleX;
      this.tweens.add({
        targets: glow,
        alpha: { from: 0.11, to: 0.24 },
        scaleX: { from: baseScaleX * 0.96, to: baseScaleX * 1.04 },
        duration: 2300,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
    return glow;
  }

  /** The way on, built hidden — the reveal sequence brings it in last. */
  private buildContinueButton(
    x: number,
    y: number,
    maxWidth: number,
  ): Phaser.GameObjects.Container {
    // An act closing on this trial names its own way on ("The King's Messenger
    // Arrives"), because the button is the last beat before the story takes
    // over and "Enter the Shop" would give the wrong one.
    const ending = this.endingAhead();
    const label = ending
      ? ending.button
      : this.dataIn.outcome.phase === "victory"
        ? "Witness the Ascension"
        : "Enter the Shop";
    const button = bannerButton(
      this,
      x,
      y,
      label,
      () => this.continue(),
      maxWidth,
    );
    return button.setVisible(false);
  }

  /**
   * The gold receipt: the trial's total across the head of a block, with every
   * source that paid itemised beneath it. `width` is that block; `typeBasis` is
   * what the type scales off — the whole panel in the stacked layout, the column
   * in the folded one, so a narrow column doesn't drag the labels below their
   * legibility floor along with it.
   */
  private buildReceipt(
    cx: number,
    top: number,
    width: number,
    typeBasis: number,
    lineGap: number,
  ): { objects: Phaser.GameObjects.GameObject[]; bottom: number } {
    const o = this.dataIn.outcome;
    const lines = receiptLines(o, this.teachingReceipt());
    const bottom = top + receiptHeight(lines.length, lineGap);
    // The accounting sits straight on the felt, like every other line on this
    // screen. `width` still describes the block it occupies — it places the
    // labels and gives the tutorial callout something to point at.
    this.receiptRect = new Phaser.Geom.Rectangle(
      cx - width / 2,
      top,
      width,
      bottom - top,
    );

    const goldTitle = this.add
      .text(cx, top + RECEIPT_TITLE_INSET, `+${o.totalGoldEarned} GOLD`, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(typeBasis * 0.038, 23, 35)}px`,
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    // Inset off the type basis, then held inside the block itself, so a screen
    // wide enough to cap that width can't push the labels past its edge.
    const labelDx = Math.min(typeBasis * 0.3, width / 2 - 12);
    this.interestRect = undefined;
    const rows = lines.flatMap(([label, amount], i) => {
      const y = top + RECEIPT_LINES_INSET + i * lineGap;
      if (label === INTEREST_LABEL) {
        this.interestRect = new Phaser.Geom.Rectangle(
          cx - labelDx,
          y - lineGap / 2,
          labelDx * 2,
          lineGap,
        );
      }
      const name = this.add
        .text(cx - labelDx, y, label, {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(typeBasis * 0.019, 13, 18)}px`,
          color: CSS.parchment,
        })
        .setOrigin(0, 0.5);
      const amountText = this.add
        .text(cx + labelDx, y, amount < 0 ? `${amount}` : `+${amount}`, {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(typeBasis * 0.02, 13, 19)}px`,
          color: amount < 0 ? CSS.red : CSS.gold,
          fontStyle: "bold",
        })
        .setOrigin(1, 0.5);
      return [name, amountText];
    });

    return { objects: [goldTitle, ...rows], bottom };
  }

  /** Whether the receipt is being used to teach, which is what keeps the
   *  interest row on it while the purse is still too small to earn any. */
  private teachingReceipt(): boolean {
    const t = getTutorial(this.registry);
    return (
      t.active &&
      (t.stage === TutorialStage.Results || t.stage === TutorialStage.Interest)
    );
  }

  /** The first run's two results-screen steps: what the clear just paid, then
   *  the line on the receipt that pays for holding gold rather than earning it.
   *  Both wait for the reveal to finish, so a callout never dims a receipt that
   *  is still counting itself up. */
  private renderTutorial(): void {
    this.tutorialCallout?.destroy();
    this.tutorialCallout = undefined;
    const t = getTutorial(this.registry);
    if (!t.active) return;
    const step =
      t.stage === TutorialStage.Results || t.stage === TutorialStage.Interest
        ? t.stage
        : undefined;
    if (step === undefined) return;
    const anchor =
      step === TutorialStage.Results
        ? this.receiptRect
        : (this.interestRect ?? this.receiptRect);
    if (!anchor) return;
    this.tutorialCallout = showCallout(this, {
      anchor,
      text: TUTORIAL_TEXT[step],
      onContinue: () => {
        advanceTutorial(this.registry);
        this.renderTutorial();
      },
      interactiveAnchor: false,
    });
  }

  /** Heading, full item cards, and footnote for whatever this trial unlocked.
   * A trial that unlocked nothing returns no objects at all — an empty
   * announcement is not worth the row it would occupy. Each card carries the
   * deed that earned it, printed where a shop card prints its price.
   *
   * Cards stand apart while the band has room for them at a size their copy can
   * be written at; below that they close into a fan, sliding under one another
   * only as far as they must. A phone that unlocks four cards at once would
   * otherwise shrink them to a third of their size — small enough that every
   * type floor on the card is reached at once and the copy runs off the
   * parchment. A fanned card is covered by its neighbour, so touching or
   * hovering one pulls it clear; nothing on the screen depends on that, it is
   * only how a card in the middle of the hand gets read. */
  private buildUnlockSection(
    cx: number,
    regionTop: number,
    regionBottom: number,
    panelW: number,
  ): ResultsLayout["unlock"] {
    const defs = this.unlockedDefs();
    if (defs.length === 0)
      return { objects: [], burstX: cx, burstY: regionTop };

    const n = defs.length;
    const headingSize = Phaser.Math.Clamp(panelW * 0.026, 16, 24);
    const footSize = Phaser.Math.Clamp(panelW * 0.019, 12, 17);
    const gap = 14;
    const rowMaxW = Math.min(panelW * 0.92, 900);
    // A fan may run a little wider than a row: it has no gaps to spend, and the
    // margin it does need is for the corners its outermost cards throw out.
    const fanMaxW = Math.min(panelW * 0.96, 940);
    const chromeH = headingSize + 16 + 10 + footSize;

    // A plain row first. Only when that would drive the cards below the size
    // their copy is written for is the width bought back by overlapping them,
    // and then only as much as it takes to climb back to that size — a fan
    // that would not have to overlap is just a row, so it stays one.
    const rowScale = (rowMaxW - (n - 1) * gap) / (n * CARD_W);
    const stepFraction =
      n > 1
        ? Phaser.Math.Clamp(
            (fanMaxW / (READABLE_CARD_SCALE * CARD_W) - 1) / (n - 1),
            MIN_FAN_STEP,
            1,
          )
        : 1;
    const fanned = n > 1 && rowScale < READABLE_CARD_SCALE && stepFraction < 1;
    const widthScale = fanned
      ? fanMaxW / (CARD_W * (1 + (n - 1) * stepFraction) + FAN_BULGE)
      : rowScale;
    const heightScale = (regionBottom - regionTop - chromeH) / CARD_H;
    const scale = Phaser.Math.Clamp(
      Math.min(heightScale, widthScale),
      MIN_CARD_SCALE,
      1,
    );
    const cardW = CARD_W * scale;
    const cardH = CARD_H * scale;
    const step = fanned ? cardW * stepFraction : cardW + gap;
    const totalW = cardW + (n - 1) * step;

    const fanCenter = (n - 1) / 2;
    const arcStep = fanned ? Math.min(FAN_ARC_MAX, cardH * 0.02) : 0;
    const arcMax = arcStep * fanCenter;
    // Centre the block in its band so a roomy layout does not leave the cards
    // stranded against the receipt.
    const blockH = chromeH + cardH + arcMax;
    const top =
      regionTop + Math.max(0, (regionBottom - regionTop - blockH) / 2);
    const cardsY = top + headingSize + 16 + cardH / 2;

    const heading = this.add
      .text(cx, top + headingSize / 2, "NEW CARDS UNLOCKED", {
        fontFamily: SERIF,
        fontSize: `${headingSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    // A fan holds its middle card in front and its outermost behind. That is a
    // z-order, and a fan re-orders itself as cards are brought forward, so the
    // cards go in a container of their own rather than being sorted against the
    // rest of the screen. Reading order is restored before they are handed back,
    // so the reveal still lights the group up left to right.
    const parent = fanned ? this.add.container(0, 0) : undefined;
    const backToFront = defs
      .map((_, i) => i)
      .sort((a, b) => Math.abs(b - fanCenter) - Math.abs(a - fanCenter));
    const deal = (terse: boolean): Phaser.GameObjects.Container[] => {
      const dealt: Phaser.GameObjects.Container[] = [];
      for (const i of backToFront) {
        const def = defs[i];
        const offset = i - fanCenter;
        const card = buildItemCard(this, def, {
          locked: false,
          showCaption: false,
          displayScale: scale,
          compactType: fanned,
          terse,
          note: def.unlock ? describeUnlockAction(def.unlock) : undefined,
        });
        card.setPosition(
          cx - totalW / 2 + cardW / 2 + i * step,
          cardsY + Math.abs(offset) * arcStep,
        );
        if (parent) {
          card.setRotation(
            Phaser.Math.DegToRad(
              Phaser.Math.Clamp(
                (offset / Math.max(1, fanCenter)) * FAN_MAX_TILT_DEG,
                -FAN_MAX_TILT_DEG,
                FAN_MAX_TILT_DEG,
              ),
            ),
          );
          parent.add(card);
        }
        dealt[i] = card;
      }
      return dealt;
    };

    // Whether the copy fits is not a question of scale alone — it depends on how
    // long each item's description runs — so the cards are printed and then
    // asked. If any of them has run its fields together, they are all reprinted
    // with the title alone, and the details move behind a tap. All or none:
    // one terse card beside a full one reads as a card that failed to draw.
    let cards = deal(false);
    const terse = cards.some((card) => !card.getData("copyFits"));
    if (terse) {
      for (const card of cards) card.destroy();
      cards = deal(true);
    }
    if (parent) this.wireFan(parent, cards);

    const foot = this.add
      .text(
        cx,
        // Held inside the band even where the cards have bottomed out and the
        // block is taller than the room it was given: the line belongs to the
        // cards, and printing it over the way on below them helps nobody.
        Math.min(
          cardsY + arcMax + cardH / 2 + 10 + footSize / 2,
          regionBottom - footSize / 2,
        ),
        terse
          ? "Tap a card to read it · available next run."
          : "Unlocked cards become available next run.",
        {
          fontFamily: SERIF,
          fontSize: `${footSize}px`,
          color: CSS.dim,
          fontStyle: "italic",
        },
      )
      .setOrigin(0.5);
    fitTextWidth(foot, rowMaxW);
    if (terse) {
      this.wireExpansion({
        defs,
        cards,
        parent,
        cx,
        regionTop,
        regionBottom,
        maxWidth: fanMaxW,
        collapsedScale: scale,
        chrome: [heading, foot],
      });
    }
    return { objects: [heading, ...cards, foot], burstX: cx, burstY: cardsY };
  }

  /**
   * Terse cards carry only a rarity and a title — there was no room for more —
   * so a press grows a full one out of the card pressed, over the space the
   * heading, the footnote and the other cards give up while it is open. It is
   * only a way of reading a card: nothing on this screen waits on it, and the
   * way on stays where it was, outside the column.
   */
  private wireExpansion(opts: {
    defs: (typeof ITEMS)[number][];
    cards: Phaser.GameObjects.Container[];
    parent?: Phaser.GameObjects.Container;
    cx: number;
    regionTop: number;
    regionBottom: number;
    maxWidth: number;
    collapsedScale: number;
    chrome: Phaser.GameObjects.GameObject[];
  }): void {
    const { defs, cards, parent, cx, regionTop, regionBottom } = opts;
    // With the heading, the footnote and the other cards out of the way, an
    // opened card has the whole band to grow into — and, where the band alone
    // would still leave it too small to read, as much of the room above the band
    // as it takes to reach the size a card's copy is written for. It is opened
    // to be read, so being legible beats staying inside its lines; what it may
    // not do is reach down over the way on, which is why only its top edge is
    // allowed past the band.
    const openScale = Phaser.Math.Clamp(
      Math.max(
        Math.min((regionBottom - regionTop) / CARD_H, opts.maxWidth / CARD_W),
        READABLE_CARD_SCALE,
      ),
      opts.collapsedScale,
      Math.min(
        (regionBottom - EXPAND_HEADROOM) / CARD_H,
        opts.maxWidth / CARD_W,
        1,
      ),
    );
    const collapsedRatio = opts.collapsedScale / openScale;
    const openHalfH = (CARD_H * openScale) / 2;
    const openY = Phaser.Math.Clamp(
      (regionTop + regionBottom) / 2,
      EXPAND_HEADROOM + openHalfH,
      regionBottom - openHalfH,
    );
    const standAside = [...opts.chrome, ...cards];

    const fade = (alpha: number) => {
      for (const object of standAside) {
        this.tweens.killTweensOf(object);
        if (fx.motion) {
          this.tweens.add({
            targets: object,
            alpha,
            duration: EXPAND_MS,
            ease: "Sine.easeInOut",
          });
        } else {
          (object as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(
            alpha,
          );
        }
      }
      // A card faded out of the column must not answer a press meant for the
      // felt behind it.
      for (const card of cards) {
        if (alpha === 0) card.disableInteractive();
        else card.setInteractive({ useHandCursor: true });
      }
    };

    const close = () => {
      const open = this.expansion;
      if (!open) return;
      this.expansion = undefined;
      const source = cards[open.index];
      this.tweens.killTweensOf(open.card);
      fade(1);
      if (!fx.motion) {
        open.card.destroy();
        return;
      }
      this.tweens.add({
        targets: open.card,
        x: source.x,
        y: source.y,
        rotation: source.rotation,
        scaleX: collapsedRatio,
        scaleY: collapsedRatio,
        alpha: 0,
        duration: EXPAND_MS,
        ease: "Cubic.easeIn",
        onComplete: () => open.card.destroy(),
      });
    };

    const open = (index: number) => {
      // Only one card is ever open: the cards behind it have faded out of the
      // column and stopped answering presses, so the way to the next one is
      // through a press that closes this one.
      if (!this.complete || this.expansion) return;
      const def = defs[index];
      const source = cards[index];
      const card = buildItemCard(this, def, {
        locked: false,
        showCaption: false,
        displayScale: openScale,
        note: def.unlock ? describeUnlockAction(def.unlock) : undefined,
      });
      parent?.add(card);
      card
        .setPosition(source.x, source.y)
        .setRotation(source.rotation)
        .setScale(collapsedRatio)
        .setAlpha(0)
        .setInteractive({ useHandCursor: true });
      card.on("pointerdown", close);
      this.expansion = { index, card, close };
      fade(0);
      if (!fx.motion) {
        card.setPosition(cx, openY).setRotation(0).setScale(1).setAlpha(1);
        return;
      }
      this.tweens.add({
        targets: card,
        x: cx,
        y: openY,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        alpha: 1,
        duration: EXPAND_MS,
        ease: "Cubic.easeOut",
      });
    };

    cards.forEach((card, index) => {
      card.setInteractive({ useHandCursor: true });
      card.on("pointerdown", () => open(index));
    });
    this.expandables = [...cards];
  }

  /** Let a fanned card be brought out from under its neighbour. Focus is
   *  sticky — a press keeps the card forward, rather than dropping it back the
   *  moment a finger leaves — so the same gesture reads a card on a touchscreen
   *  and on a mouse. Held off until the reveal has finished, so a pointer
   *  resting over the fan cannot fight the entrance tween for the card's y. */
  private wireFan(
    parent: Phaser.GameObjects.Container,
    cards: Phaser.GameObjects.Container[],
  ): void {
    const restY = cards.map((card) => card.y);
    const focus = (index: number) => {
      if (!this.complete || this.fanFocus === index) return;
      const previous = this.fanFocus;
      this.fanFocus = index;
      const pose = (i: number, lifted: boolean) => {
        const card = cards[i];
        this.tweens.killTweensOf(card);
        const y = restY[i] - (lifted ? FAN_FOCUS_LIFT : 0);
        const scale = lifted ? FAN_FOCUS_SCALE : 1;
        if (!fx.motion) {
          card.setY(y).setScale(scale);
          return;
        }
        this.tweens.add({
          targets: card,
          y,
          scaleX: scale,
          scaleY: scale,
          duration: 160,
          ease: "Cubic.easeOut",
        });
      };
      if (previous !== undefined) pose(previous, false);
      pose(index, true);
      parent.bringToTop(cards[index]);
    };
    cards.forEach((card, index) => {
      card.setInteractive({ useHandCursor: true });
      card.on("pointerover", () => focus(index));
      card.on("pointerdown", () => focus(index));
    });
  }

  private revealGroup(
    objects: Phaser.GameObjects.GameObject[],
    stagger: number,
  ): void {
    objects.forEach((obj, i) => {
      const target = obj as Phaser.GameObjects.GameObject &
        Phaser.GameObjects.Components.Alpha &
        Phaser.GameObjects.Components.Transform;
      const restY = target.y;
      target.setAlpha(0).setY(restY + 12);
      this.tweens.add({
        targets: target,
        alpha: 1,
        y: restY,
        duration: 260,
        delay: i * stagger,
        ease: "Cubic.easeOut",
      });
    });
  }

  private schedule(delay: number, callback: () => void): void {
    this.timers.push(this.time.delayedCall(delay, callback));
  }

  private clearTimers(): void {
    this.timers.forEach((timer) => timer.remove());
    this.timers = [];
  }

  private revealAll(): void {
    if (this.complete) return;
    this.clearTimers();
    for (const obj of this.revealObjects) this.tweens.killTweensOf(obj);
    for (const obj of this.revealObjects) {
      const target = obj as unknown as Phaser.GameObjects.Components.Alpha &
        Phaser.GameObjects.Components.Visible;
      target.setVisible(true);
      target.setAlpha(1);
    }
    this.complete = true;
    this.renderTutorial();
  }

  /** The story act that follows the trial just cleared, if one does and this
   *  run has not already been told it. */
  private endingAhead(): EndingDef | null {
    const state = getRun(this.registry);
    return endingAfterTrial(
      this.dataIn.outcome.completedTrial,
      state.endingsSeen,
    );
  }

  private continue(): void {
    if (!this.complete || this.leaving) return;
    this.leaving = true;
    // An act takes precedence over both ordinary ways on: the rank-15 clear
    // reaches Victory through its closing sequence rather than instead of it,
    // and the rank-5 and rank-10 clears reach the shop through theirs.
    const ending = this.endingAhead();
    const checkpoint: ResumableCheckpoint = ending
      ? { scene: "Ending", id: ending.id }
      : this.dataIn.outcome.phase === "victory"
        ? { scene: "Victory" }
        : createFreshShopCheckpoint(getRun(this.registry));
    saveActiveRun(this.registry, checkpoint);
    slideSceneOut(
      this,
      () => this.scene.start(checkpoint.scene, checkpoint),
      this.slideBackdrop,
    );
  }
}
