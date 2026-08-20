import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { rankOf, trialName } from "../config";
import type { TrialEndOutcome } from "../sim/engine";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { ITEMS, type ShopItemId } from "../systems/Items";
import { formatScore } from "../ui/formatScore";
import { onResizeCoalesced } from "../ui/layout";
import { AmbientLayer } from "../ui/AmbientLayer";
import { RuleDice } from "../ui/RuleDice";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { addFelt, bannerButton } from "../ui/widgets";
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
      this.children.removeAll(true);
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
    const panelW = Math.min(W - 28, 980);
    const panelH = Math.min(H - 28, 700);

    const o = this.dataIn.outcome;
    const top = H / 2 - panelH / 2 + 48;
    const titleGlow = this.add
      .image(cx, top, "spark")
      .setTint(COLORS.glow)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(Math.min(700, W * 0.78), 250)
      .setAlpha(0.2);
    if (fx.motion) {
      const baseScaleX = titleGlow.scaleX;
      this.tweens.add({
        targets: titleGlow,
        alpha: { from: 0.11, to: 0.24 },
        scaleX: { from: baseScaleX * 0.96, to: baseScaleX * 1.04 },
        duration: 2300,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
    const footerLinks = buildRunFooterLinks(this, "TrialResults");
    this.slideBackdrop = [felt, ambient, titleGlow, ...footerLinks];
    const title = this.add
      .text(cx, top, o.insuranceUsed ? "TRIAL SURVIVED" : "TRIAL CLEARED", {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(panelW * 0.058, 28, 52)}px`,
        color: CSS.gold,
        fontStyle: "bold",
        letterSpacing: 3,
        stroke: "#0d0a12",
        strokeThickness: Math.max(
          3,
          Math.round(Phaser.Math.Clamp(panelW * 0.058, 28, 52) * 0.09),
        ),
      })
      .setOrigin(0.5)
      .setShadow(0, 4, "#000000", 10, true, true);
    const subtitle = this.add
      .text(
        cx,
        top + 50,
        `${trialName(o.completedTrial)} of rank ${rankOf(o.completedTrial)} · ${formatScore(o.completedScore)} / ${formatScore(o.completedGoal)}`,
        {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(panelW * 0.023, 14, 21)}px`,
          color: CSS.dim,
          fontStyle: "italic",
        },
      )
      .setOrigin(0.5);
    this.revealObjects.push(title, subtitle);

    const ruleY = top + 86;
    const ruleDice = new RuleDice(this, cx, ruleY, 12);
    const rule = this.add.graphics();
    const ruleHalf = panelW * 0.4;
    const ruleGap = ruleDice.width / 2 + 12;
    rule.lineStyle(1.5, COLORS.gold, 0.58);
    rule.lineBetween(cx - ruleHalf, ruleY, cx - ruleGap, ruleY);
    rule.lineBetween(cx + ruleGap, ruleY, cx + ruleHalf, ruleY);
    const goldTitle = this.add
      .text(cx, ruleY + 27, `+${o.totalGoldEarned} GOLD`, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(panelW * 0.038, 23, 35)}px`,
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    const lines: Array<[string, number]> = [
      ["Trial reward", o.goldBreakdown.base],
      ["Rolls left in hand", o.goldBreakdown.rolls],
      ["Interest", o.goldBreakdown.interest],
      ["Relics and boss rewards", o.goldBreakdown.items],
      ["Tithe Bowl during rolls", o.rollGold.titheBowl],
      ["Lucky Coin during rolls", o.rollGold.luckyCoin],
    ];
    const visible = lines.filter(([, amount], i) => amount > 0 || i === 0);
    const lineStart = ruleY + 62;
    const lineGap = Math.min(27, panelH * 0.042);
    const receiptBottom =
      lineStart + Math.max(0, visible.length - 1) * lineGap + 18;
    const receiptTop = ruleY + 13;
    const receipt = this.add
      .rectangle(
        cx,
        (receiptTop + receiptBottom) / 2,
        Math.min(panelW * 0.72, 660),
        receiptBottom - receiptTop,
        COLORS.feltDark,
        0.74,
      )
      .setStrokeStyle(1.5, COLORS.gold, 0.42);
    receipt.setDepth(1);
    this.receiptRect = new Phaser.Geom.Rectangle(
      receipt.x - receipt.width / 2,
      receiptTop,
      receipt.width,
      receiptBottom - receiptTop,
    );
    goldTitle.setDepth(2);
    const lineObjects = visible.map(([label, amount], i) => {
      const y = lineStart + i * lineGap;
      const left = this.add
        .text(cx - panelW * 0.3, y, label, {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(panelW * 0.019, 13, 18)}px`,
          color: CSS.parchment,
        })
        .setOrigin(0, 0.5)
        .setDepth(2);
      const right = this.add
        .text(cx + panelW * 0.3, y, `+${amount}`, {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(panelW * 0.02, 13, 19)}px`,
          color: CSS.gold,
          fontStyle: "bold",
        })
        .setOrigin(1, 0.5)
        .setDepth(2);
      return [left, right];
    });
    this.revealObjects.push(receipt, goldTitle, ...lineObjects.flat());

    const buttonY = H / 2 + panelH / 2 - 48;
    const unlockSection = this.buildUnlockSection(
      cx,
      receiptBottom + 14,
      buttonY - 42,
      panelW,
    );
    this.revealObjects.push(...unlockSection.objects);

    const nextLabel =
      o.phase === "victory" ? "Witness the Ascension" : "Enter the Shop";
    const button = bannerButton(
      this,
      cx,
      buttonY,
      nextLabel,
      () => this.continue(),
      Math.min(panelW * 0.65, 420),
    );
    button.setVisible(false);
    this.revealObjects.push(button);

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
    this.schedule(120, () => this.revealGroup([title, subtitle], 0));
    this.schedule(720, () => {
      audio.buy();
      this.revealGroup([goldTitle, ...lineObjects.flat()], 35);
    });
    if (unlockSection.objects.length > 0) {
      this.schedule(1450, () => {
        this.revealGroup(unlockSection.objects, 65);
        fx.burst(this, cx, unlockSection.burstY, {
          count: 30,
          tint: COLORS.goldLight,
          speed: 250,
        });
      });
    }
    // Nothing unlocked means nothing to wait for: the button arrives early.
    this.schedule(unlockSection.objects.length > 0 ? 2150 : 1400, () => {
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
  ): { objects: Phaser.GameObjects.GameObject[]; burstY: number } {
    const defs = this.dataIn.unlocked
      .map((id) => ITEMS.find((item) => item.id === id))
      .filter((item): item is (typeof ITEMS)[number] => !!item);
    if (defs.length === 0) return { objects: [], burstY: regionTop };

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
    return { objects: [heading, ...cards, foot], burstY: cardsY };
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
