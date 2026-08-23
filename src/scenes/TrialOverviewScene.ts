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
import {
  COMPACT_MARGIN,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
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
import { addFelt, bannerButton, fitTextWidth } from "../ui/widgets";
import { buildRunFooterLinks } from "../ui/runFooterLinks";

/** The line under the rank, in both mastheads. */
const RANK_SUBTITLE = "Three trials stand between you and ascension";

/** What the two masthead variants hand back: the halo — held still by the
 *  scene slide, like the felt and the sigil behind it — and the y the route
 *  begins at. */
interface TrialHeader {
  glow: Phaser.GameObjects.Image;
  contentTop: number;
}

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
      destroyAllChildren(this);
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

    // A handset in landscape has no height for a centred masthead above the
    // route above the button: the cards come out shorter than their own type
    // and the button lands in the footer links. So the masthead folds onto a
    // single line across the top, the same fold the Shop and the results
    // screen use — one `isCompactLandscape` gate, so a device that turns
    // folds all three at once.
    const compact = isCompactLandscape(W, H);
    const header = compact
      ? this.buildCompactHeader(W)
      : this.buildStackedHeader(W, H, panelW, panelH);

    const footerLinks = buildRunFooterLinks(this, "TrialOverview");
    this.slideBackdrop = [felt, ambient, header.glow, ...footerLinks];

    // Built before the cards so the route can take whatever height is left
    // above it: the button's height follows from its width, and folded there
    // is no spare room to guess it with.
    const start = bannerButton(
      this,
      W / 2,
      0,
      `Start ${trialName(this.state.trial)}`,
      () => this.startTrial(),
      // Folded, the button also has to stay clear of the Inventory/Settings
      // links pinned to the bottom-right corner — the row it now sits in.
      compact
        ? Phaser.Math.Clamp(W * 0.42, 200, 360)
        : Math.min(panelW * 0.72, 430),
    ).setDepth(3);
    const buttonY = compact
      ? H - COMPACT_MARGIN - start.height / 2
      : H / 2 + panelH / 2 - 56;
    start.setPosition(W / 2, buttonY);
    this.startRect = new Phaser.Geom.Rectangle(
      W / 2 - start.width / 2,
      buttonY - start.height / 2,
      start.width,
      start.height,
    );

    const portrait = !compact && H > W * 1.12;
    // Folded, the cards run edge to edge on the compact grid rather than
    // inside the centred panel: width is the one thing a short landscape
    // viewport has to spend, and three cards are what have to be read.
    const innerW = compact ? W - COMPACT_MARGIN * 2 : panelW * 0.9;
    const cardsTop = header.contentTop;
    const cardsH =
      (compact ? buttonY - start.height / 2 - 12 : buttonY - 54) - cardsTop;
    const cardGap = portrait ? 12 : Math.min(26, innerW * 0.025);
    const cardW = portrait ? innerW : (innerW - cardGap * 2) / 3;
    const cardH = portrait
      ? Math.max(88, (cardsH - cardGap * 2) / 3)
      : Math.max(72, Math.min(cardsH, 370));
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

  /** The tall masthead: the rank, a die-marked rule and the line about what a
   *  rank is, centred one under the other above the route. */
  private buildStackedHeader(
    W: number,
    H: number,
    panelW: number,
    panelH: number,
  ): TrialHeader {
    const titleY = H / 2 - panelH / 2 + Math.max(48, panelH * 0.1);
    const glow = this.buildTitleGlow(
      W / 2,
      titleY,
      Math.min(680, W * 0.76),
      230,
    );

    const titleSize = Phaser.Math.Clamp(panelW * 0.052, 26, 48);
    const title = this.add
      .text(W / 2, titleY, `RANK ${rankOf(this.state.trial)}`, {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        letterSpacing: 4,
        stroke: "#0d0a12",
        strokeThickness: Math.max(3, Math.round(titleSize * 0.09)),
      })
      .setOrigin(0.5)
      .setDepth(2)
      .setShadow(0, 4, "#000000", 10, true, true);
    const subtitle = this.add
      .text(W / 2, titleY + 52, RANK_SUBTITLE, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(panelW * 0.02, 13, 19)}px`,
        color: CSS.dim,
        fontStyle: "italic",
      })
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

    return { glow, contentTop: titleY + 94 };
  }

  /** The folded masthead: the rank at the left of one line, what a rank means
   *  at the right of it, and a hairline closing the line off — neither the
   *  die-marked rule nor a halo the width of the screen is something a
   *  viewport this short can pay for. */
  private buildCompactHeader(W: number): TrialHeader {
    const left = COMPACT_MARGIN;
    const right = W - COMPACT_MARGIN;
    const headerTop = 10;

    const titleSize = Math.round(Phaser.Math.Clamp(W * 0.05, 22, 34));
    const title = this.add
      .text(left, headerTop, `RANK ${rankOf(this.state.trial)}`, {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        letterSpacing: 4,
        stroke: "#0d0a12",
        strokeThickness: Math.max(3, Math.round(titleSize * 0.09)),
      })
      .setOrigin(0, 0)
      .setDepth(2)
      .setShadow(0, 3, "#000000", 8, true, true);
    // Sized and placed off the title, so it can only be built after it; its
    // depth puts it back behind, where light falling on the table belongs.
    const glow = this.buildTitleGlow(
      left + title.width / 2,
      headerTop + title.height / 2,
      Math.min(460, W * 0.5),
      140,
    );

    const subtitle = this.add
      .text(right, headerTop + title.height / 2, RANK_SUBTITLE, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(titleSize * 0.52, 12, 17))}px`,
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(1, 0.5)
      .setDepth(2);
    fitTextWidth(subtitle, Math.max(60, right - left - title.width - 18));

    const ruleY = Math.round(headerTop + title.height + 6);
    const rule = this.add.graphics().setDepth(2);
    rule.lineStyle(1, COLORS.gold, 0.32);
    rule.lineBetween(left, ruleY, right, ruleY);

    return { glow, contentTop: ruleY + 12 };
  }

  /** The breathing halo behind the rank. It is light on the table rather than
   *  part of the interface, so the scene slide holds it still along with the
   *  felt and the sigil. */
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
      .setAlpha(0.18)
      .setDepth(1);
    if (fx.motion) {
      // setDisplaySize bakes the stretch into scaleX, so the breathe swings
      // around that baked value rather than around 1.
      const baseScaleX = glow.scaleX;
      this.tweens.add({
        targets: glow,
        alpha: { from: 0.1, to: 0.22 },
        scaleX: { from: baseScaleX * 0.96, to: baseScaleX * 1.04 },
        duration: 2500,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
    return glow;
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
    const rows: Phaser.GameObjects.Text[] = [];
    rows.push(
      this.add
        .text(x, y - h * (compact ? 0.27 : 0.34), trialName(trial), {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.1, h * 0.14), 15, 27)}px`,
          color: ink,
          fontStyle: "bold",
          align: "center",
        })
        .setOrigin(0.5)
        .setDepth(4)
        .setAlpha(contentAlpha),
    );

    const meta = `Goal: ${formatScore(goalForTrial(trial, this.state.bossModifier))}\nRolls: ${trialRollTargetFor(this.state, trial)}`;
    const metaSize = Phaser.Math.Clamp(Math.min(w * 0.064, h * 0.085), 12, 18);
    rows.push(
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
        .setAlpha(contentAlpha),
    );

    // Only cleared trials and the waiting boss earn a footer line. "Next" and
    // "upcoming" are already carried by the card's own styling, so naming them
    // adds nothing.
    let foot = status.complete ? "CLEARED" : "";
    if (status.boss) {
      const boss = rankBoss(this.state);
      if (boss) foot = `${boss.name}\n${boss.desc}`;
    }
    if (foot) {
      rows.push(
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
          .setAlpha(contentAlpha),
      );
    }
    this.flowCardRows(rows, y, h);

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

  /**
   * Space a card's name, goal and footer out from the airy positions above
   * without letting them collide. A card with room to breathe — the desktop
   * and portrait layouts — already clears itself, and nothing moves. A short
   * landscape card is where a boss's three-line footer runs into the goal
   * above it, so each block is pushed below the one before it, and the group
   * slid back up if that ran it past the card's lower edge.
   */
  private flowCardRows(
    rows: Phaser.GameObjects.Text[],
    cy: number,
    h: number,
  ): void {
    const pad = Math.min(10, h * 0.06);
    const gap = Phaser.Math.Clamp(h * 0.04, 4, 12);
    let cursor = cy - h / 2 + pad;
    for (const row of rows) {
      const top = Math.max(row.y - row.height / 2, cursor);
      row.setY(top + row.height / 2);
      cursor = top + row.height + gap;
    }
    const overflow = cursor - gap - (cy + h / 2 - pad);
    if (overflow <= 0) return;
    const first = rows[0];
    const headroom = first.y - first.height / 2 - (cy - h / 2 + pad);
    const shift = Math.min(overflow, Math.max(0, headroom));
    for (const row of rows) row.setY(row.y - shift);
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
