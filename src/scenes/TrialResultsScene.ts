import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { rankOf, trialName } from "../config";
import type { TrialEndOutcome } from "../sim/engine";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { ITEMS, type ShopItemId } from "../systems/Items";
import { formatScore } from "../ui/formatScore";
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

/** Native size of the 'card' texture buildItemCard draws on. */
const CARD_W = 260;
const CARD_H = 340;

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

/** The itemised gold lines worth printing: every source that paid, plus the
 *  trial reward itself even when it paid nothing (a receipt with no first
 *  line reads as an error rather than as a small reward). */
function receiptLines(o: TrialEndOutcome): Array<[string, number]> {
  const all: Array<[string, number]> = [
    ["Trial reward", o.goldBreakdown.base],
    ["Rolls left in hand", o.goldBreakdown.rolls],
    ["Interest", o.goldBreakdown.interest],
    ["Relics and boss rewards", o.goldBreakdown.items],
    ["Tithe Bowl during rolls", o.rollGold.titheBowl],
    ["Lucky Coin during rolls", o.rollGold.luckyCoin],
  ];
  return all.filter(([, amount], i) => amount > 0 || i === 0);
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
  private tutorialCallout?: CalloutHandle;

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
    const skip = () => this.revealAll();
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
      receiptLines(this.dataIn.outcome).length,
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
    return `${trialName(o.completedTrial)} of rank ${rankOf(o.completedTrial)} \u00b7 ${formatScore(o.completedScore)} / ${formatScore(o.completedGoal)}`;
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
    const label =
      this.dataIn.outcome.phase === "victory"
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
    const lines = receiptLines(o);
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
    const rows = lines.flatMap(([label, amount], i) => {
      const y = top + RECEIPT_LINES_INSET + i * lineGap;
      const name = this.add
        .text(cx - labelDx, y, label, {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(typeBasis * 0.019, 13, 18)}px`,
          color: CSS.parchment,
        })
        .setOrigin(0, 0.5);
      const amountText = this.add
        .text(cx + labelDx, y, `+${amount}`, {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(typeBasis * 0.02, 13, 19)}px`,
          color: CSS.gold,
          fontStyle: "bold",
        })
        .setOrigin(1, 0.5);
      return [name, amountText];
    });

    return { objects: [goldTitle, ...rows], bottom };
  }

  /** The first run's one results-screen step: what the clear just paid. It
   *  waits for the reveal to finish, so the callout never dims a receipt that
   *  is still counting itself up. */
  private renderTutorial(): void {
    this.tutorialCallout?.destroy();
    this.tutorialCallout = undefined;
    const t = getTutorial(this.registry);
    if (!t.active || t.stage !== TutorialStage.Results || !this.receiptRect)
      return;
    this.tutorialCallout = showCallout(this, {
      anchor: this.receiptRect,
      text: TUTORIAL_TEXT[TutorialStage.Results],
      onContinue: () => {
        advanceTutorial(this.registry);
        this.renderTutorial();
      },
      interactiveAnchor: false,
    });
  }

  /** Heading, full item cards, and footnote for whatever this trial unlocked.
   * A trial that unlocked nothing returns no objects at all — an empty
   * announcement is not worth the row it would occupy. Cards are scaled to fit
   * the band between the gold receipt and the continue button. */
  private buildUnlockSection(
    cx: number,
    regionTop: number,
    regionBottom: number,
    panelW: number,
  ): ResultsLayout["unlock"] {
    const defs = this.unlockedDefs();
    if (defs.length === 0)
      return { objects: [], burstX: cx, burstY: regionTop };

    const headingSize = Phaser.Math.Clamp(panelW * 0.026, 16, 24);
    const footSize = Phaser.Math.Clamp(panelW * 0.019, 12, 17);
    const gap = 14;
    const cardsMaxW = Math.min(panelW * 0.92, 900);
    const chromeH = headingSize + 16 + 10 + footSize;
    const scale = Phaser.Math.Clamp(
      Math.min(
        (regionBottom - regionTop - chromeH) / CARD_H,
        (cardsMaxW - (defs.length - 1) * gap) / (defs.length * CARD_W),
      ),
      0.3,
      1,
    );
    const cardW = CARD_W * scale;
    const cardH = CARD_H * scale;
    const totalW = defs.length * cardW + (defs.length - 1) * gap;
    // Centre the block in its band so a roomy layout does not leave the cards
    // stranded against the receipt.
    const top =
      regionTop + Math.max(0, (regionBottom - regionTop - chromeH - cardH) / 2);
    const cardsY = top + headingSize + 16 + cardH / 2;

    const heading = this.add
      .text(cx, top + headingSize / 2, "NEW CARDS UNLOCKED", {
        fontFamily: SERIF,
        fontSize: `${headingSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    const cards = defs.map((def, i) => {
      const card = buildItemCard(this, def, {
        locked: false,
        showCaption: false,
        displayScale: scale,
      });
      card.setPosition(cx - totalW / 2 + cardW / 2 + i * (cardW + gap), cardsY);
      return card;
    });
    const foot = this.add
      .text(
        cx,
        cardsY + cardH / 2 + 10 + footSize / 2,
        "Unlocked cards become available next run.",
        {
          fontFamily: SERIF,
          fontSize: `${footSize}px`,
          color: CSS.dim,
          fontStyle: "italic",
        },
      )
      .setOrigin(0.5);
    return { objects: [heading, ...cards, foot], burstX: cx, burstY: cardsY };
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

  private continue(): void {
    if (!this.complete || this.leaving) return;
    this.leaving = true;
    const destination =
      this.dataIn.outcome.phase === "victory" ? "Victory" : "Shop";
    slideSceneOut(
      this,
      () => this.scene.start(destination),
      this.slideBackdrop,
    );
  }
}
