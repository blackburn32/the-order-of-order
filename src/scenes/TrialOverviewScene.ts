import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { TRIALS_PER_RANK, rankOf, trialInRank, trialName } from "../config";
import { getRun, type RunState } from "../state/RunState";
import { goalForTrial, rankBoss } from "../systems/Boss";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { trialRollTargetFor } from "../systems/Trial";
import { AmbientLayer } from "../ui/AmbientLayer";
import { formatScore } from "../ui/formatScore";
import { onResizeCoalesced } from "../ui/layout";
import { RuleDice } from "../ui/RuleDice";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { CalloutHandle, showCallout } from "../ui/Callout";
import {
  advanceTutorial,
  atStage,
  getTutorial,
  TutorialStage,
  TUTORIAL_TEXT,
} from "../systems/Tutorial";
import { addFelt, bannerButton } from "../ui/widgets";
import { buildRunFooterLinks } from "../ui/runFooterLinks";

/** The route shown before every trial. It deliberately derives all
 * completion state from the one absolute trial counter, so it needs no second
 * progress model that could drift from the engine. */
export class TrialOverviewScene extends Phaser.Scene {
  private state!: RunState;
  private leaving = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  // Screen rects of the three trial cards, so the first-run tutorial can point
  // at them. Rebuilt with the rest of the scene on every resize.
  private cardRects: Phaser.Geom.Rectangle[] = [];
  // Screen rect of the start button, for the step that points at it. Captured
  // before the entrance tween offsets the button, so it describes where the
  // button comes to rest rather than where it starts.
  private startRect?: Phaser.Geom.Rectangle;
  private tutorialCallout?: CalloutHandle;

  constructor() {
    super("TrialOverview");
  }

  create(): void {
    this.state = getRun(this.registry);
    this.leaving = false;
    this.build();
    slideSceneIn(this, this.slideBackdrop);
    const off = onResizeCoalesced(this, () => {
      // removeAll destroys the callout's objects with everything else; drop the
      // stale handle before build() anchors a fresh one.
      this.tutorialCallout = undefined;
      this.startRect = undefined;
      this.children.removeAll(true);
      this.build();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, off);
  }

  private build(): void {
    this.cardRects = [];
    const W = this.scale.width;
    const H = this.scale.height;
    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(W / 2, H / 2).setDepth(0);
    ambient.setArea(W, H);
    ambient.setProgress(0.4 + trialInRank(this.state.trial) * 0.14, false);

    const panelW = Math.min(W - 28, 1180);
    const panelH = Math.min(H - 28, 720);

    const rank = rankOf(this.state.trial);
    const titleY = H / 2 - panelH / 2 + Math.max(48, panelH * 0.1);
    const titleGlow = this.add
      .image(W / 2, titleY, "spark")
      .setTint(COLORS.glow)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(Math.min(680, W * 0.76), 230)
      .setAlpha(0.18)
      .setDepth(1);
    if (fx.motion) {
      const baseScaleX = titleGlow.scaleX;
      this.tweens.add({
        targets: titleGlow,
        alpha: { from: 0.1, to: 0.22 },
        scaleX: { from: baseScaleX * 0.96, to: baseScaleX * 1.04 },
        duration: 2500,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
    const footerLinks = buildRunFooterLinks(this, "TrialOverview");
    this.slideBackdrop = [felt, ambient, titleGlow, ...footerLinks];

    const title = this.add
      .text(W / 2, titleY, `RANK ${rank}`, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(panelW * 0.052, 26, 48)}px`,
        color: CSS.gold,
        fontStyle: "bold",
        letterSpacing: 4,
        stroke: "#0d0a12",
        strokeThickness: Math.max(
          3,
          Math.round(Phaser.Math.Clamp(panelW * 0.052, 26, 48) * 0.09),
        ),
      })
      .setOrigin(0.5)
      .setDepth(2)
      .setShadow(0, 4, "#000000", 10, true, true);
    const subtitle = this.add
      .text(
        W / 2,
        titleY + 52,
        "Three trials stand between you and ascension",
        {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(panelW * 0.02, 13, 19)}px`,
          color: CSS.dim,
          fontStyle: "italic",
        },
      )
      .setOrigin(0.5)
      .setDepth(2);

    const ruleY = (title.getBounds().bottom + subtitle.getBounds().top) / 2;
    const ruleDice = new RuleDice(this, W / 2, ruleY, 11).setDepth(2);
    const ruleGap = ruleDice.width / 2 + 11;
    const ruleHalf = Math.min(title.width / 2 + 42, W / 2 - 24);
    const rule = this.add.graphics().setDepth(2);
    rule.lineStyle(1.5, COLORS.gold, 0.58);
    rule.lineBetween(W / 2 - ruleHalf, ruleY, W / 2 - ruleGap, ruleY);
    rule.lineBetween(W / 2 + ruleGap, ruleY, W / 2 + ruleHalf, ruleY);

    const portrait = H > W * 1.12;
    const innerW = panelW * 0.9;
    const cardsTop = titleY + 94;
    const buttonY = H / 2 + panelH / 2 - 56;
    const cardsH = buttonY - 54 - cardsTop;
    const cardGap = portrait ? 12 : Math.min(26, innerW * 0.025);
    const cardW = portrait ? innerW : (innerW - cardGap * 2) / 3;
    const cardH = portrait
      ? Math.max(88, (cardsH - cardGap * 2) / 3)
      : Math.min(cardsH, 370);
    const rankStart = this.state.trial - (trialInRank(this.state.trial) - 1);

    for (let slot = 0; slot < TRIALS_PER_RANK; slot++) {
      const trial = rankStart + slot;
      const complete = trial < this.state.trial;
      const current = trial === this.state.trial;
      const boss = slot === TRIALS_PER_RANK - 1;
      const x = portrait
        ? W / 2
        : W / 2 - innerW / 2 + cardW / 2 + slot * (cardW + cardGap);
      const y = portrait
        ? cardsTop + cardH / 2 + slot * (cardH + cardGap)
        : cardsTop + cardH / 2;
      this.buildTrialCard(x, y, cardW, cardH, trial, {
        complete,
        current,
        boss,
        index: slot,
      });
    }

    const start = bannerButton(
      this,
      W / 2,
      buttonY,
      `Start ${trialName(this.state.trial)}`,
      () => this.startTrial(),
      Math.min(panelW * 0.72, 430),
    ).setDepth(3);
    this.startRect = new Phaser.Geom.Rectangle(
      W / 2 - start.width / 2,
      buttonY - start.height / 2,
      start.width,
      start.height,
    );
    if (fx.motion) {
      start.setAlpha(0).setY(buttonY + 24);
      this.tweens.add({
        targets: start,
        y: buttonY,
        alpha: 1,
        duration: 380,
        delay: 300,
        ease: "Cubic.easeOut",
      });
    }

    this.renderTutorial();
  }

  /** The route's three tutorial steps: what a rank is, what waits at the end of
   *  it, and the button that starts the first one. The first two point at the
   *  cards themselves, which is the whole reason they live here rather than on
   *  the HUD. */
  private renderTutorial(): void {
    this.tutorialCallout?.destroy();
    this.tutorialCallout = undefined;
    const t = getTutorial(this.registry);
    if (!t.active || this.cardRects.length === 0) return;

    const advance = () => {
      advanceTutorial(this.registry);
      this.renderTutorial();
    };
    let anchor: Phaser.Geom.Rectangle;
    let text: string;
    // The start step is dismissed by the press it asks for, not by Continue.
    let onContinue: (() => void) | undefined = advance;
    let interactiveAnchor = false;
    if (t.stage === TutorialStage.Route) {
      anchor = this.cardRects.reduce(
        (all, rect) => Phaser.Geom.Rectangle.Union(all, rect),
        this.cardRects[0],
      );
      text = TUTORIAL_TEXT[TutorialStage.Route];
    } else if (t.stage === TutorialStage.RouteBoss) {
      anchor = this.cardRects[this.cardRects.length - 1];
      text = TUTORIAL_TEXT[TutorialStage.RouteBoss];
    } else if (t.stage === TutorialStage.RouteStart && this.startRect) {
      anchor = this.startRect;
      text = TUTORIAL_TEXT[TutorialStage.RouteStart];
      onContinue = undefined;
      interactiveAnchor = true; // starting the trial is what advances this step
    } else {
      return;
    }

    this.tutorialCallout = showCallout(this, {
      anchor,
      text,
      onContinue,
      interactiveAnchor,
    });
  }

  private buildTrialCard(
    x: number,
    y: number,
    w: number,
    h: number,
    trial: number,
    status: {
      complete: boolean;
      current: boolean;
      boss: boolean;
      index: number;
    },
  ): void {
    const upcoming = !status.complete && !status.current;
    const muted = status.complete && !status.boss;
    // The current card drops to the table's own felt color so it reads as a
    // window onto the board rather than another parchment slip; boss cards were
    // already dark. Both then need ivory type instead of ink.
    const onDark = status.boss || status.current;
    const fill = status.boss
      ? 0x2a1622
      : status.current
        ? COLORS.felt
        : muted
          ? 0x605e64
          : COLORS.parchment;
    const ink = onDark ? CSS.ivory : muted ? "#d0cbc2" : CSS.ink;
    const soft = onDark ? CSS.parchmentDark : muted ? "#aaa6ad" : CSS.inkSoft;
    // Boss cards retain their wax-and-gold hierarchy. Ordinary cleared cards
    // lose their gold edge so they read as history rather than another choice.
    const border = status.boss
      ? status.complete
        ? COLORS.gold
        : status.current
          ? COLORS.goldLight
          : COLORS.waxRed
      : status.complete
        ? 0x918e96
        : status.current
          ? COLORS.goldLight
          : COLORS.inkSoft;
    const cardAlpha = status.boss
      ? status.complete
        ? 0.78
        : 0.96
      : status.complete
        ? 0.84
        : upcoming
          ? 0.42
          : 0.9;
    const contentAlpha = status.boss ? 1 : muted ? 0.7 : upcoming ? 0.5 : 1;
    const card = this.add
      .rectangle(x, y, w, h, fill, cardAlpha)
      .setStrokeStyle(status.current ? 4 : 2, border, status.current ? 1 : 0.72)
      .setDepth(3);
    this.cardRects.push(new Phaser.Geom.Rectangle(x - w / 2, y - h / 2, w, h));

    const compact = h < 150;
    const nameY = y - h * (compact ? 0.27 : 0.34);
    this.add
      .text(x, nameY, trialName(trial), {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.1, h * 0.14), 15, 27)}px`,
        color: ink,
        fontStyle: "bold",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(4)
      .setAlpha(contentAlpha);

    const meta = `Goal: ${formatScore(goalForTrial(trial, this.state.bossModifier))}\nRolls: ${trialRollTargetFor(this.state, trial)}`;
    const metaSize = Phaser.Math.Clamp(Math.min(w * 0.064, h * 0.085), 12, 18);
    this.add
      .text(x, y - (compact ? 1 : h * 0.08), meta, {
        fontFamily: SERIF,
        fontSize: `${metaSize}px`,
        color: soft,
        align: "center",
        lineSpacing: Math.round(metaSize * 0.22),
        wordWrap: { width: w * 0.9 },
      })
      .setOrigin(0.5)
      .setDepth(4)
      .setAlpha(contentAlpha);

    // Only cleared trials and the waiting boss earn a footer line. "Next" and
    // "upcoming" are already carried by the card's own styling, so naming them
    // adds nothing.
    let foot = status.complete ? "CLEARED" : "";
    if (status.boss) {
      const boss = rankBoss(this.state);
      if (boss) foot = `${boss.name}\n${boss.desc}`;
    }
    if (foot) {
      this.add
        .text(x, y + h * (compact ? 0.25 : 0.28), foot, {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.055, h * 0.07), 11, 16)}px`,
          color: status.boss && !upcoming ? CSS.gold : soft,
          fontStyle: "bold",
          align: "center",
          wordWrap: { width: w * 0.88 },
        })
        .setOrigin(0.5)
        .setDepth(4)
        .setAlpha(contentAlpha);
    }

    if (status.complete) {
      const seal = this.add
        .image(x + w * 0.34, y - h * 0.32, "seal")
        .setDisplaySize(Math.min(62, h * 0.32), Math.min(62, h * 0.32))
        .setTint(status.boss ? COLORS.gold : 0xb0adb3)
        .setAlpha(status.boss ? 0.86 : 0.62)
        .setDepth(5)
        .setRotation(-0.16);
      if (fx.motion) seal.setScale(seal.scaleX * 1.02);
    }

    if (fx.motion) {
      card.setAlpha(0).setScale(0.94);
      this.tweens.add({
        targets: card,
        alpha: cardAlpha,
        scaleX: 1,
        scaleY: 1,
        duration: 340,
        delay: 70 * status.index,
        ease: "Back.easeOut",
      });
    }
  }

  private startTrial(): void {
    if (this.leaving) return;
    this.leaving = true;
    // The step that points at this button has no Continue; pressing it is the
    // dismissal, and leaves the Game scene showing the next step.
    if (atStage(this.registry, TutorialStage.RouteStart)) {
      advanceTutorial(this.registry);
    }
    audio.trialUp();
    slideSceneOut(this, () => this.scene.start("Game"), this.slideBackdrop);
  }
}
