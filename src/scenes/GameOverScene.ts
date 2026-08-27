import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { rankOf, trialName } from "../config";
import { getRun } from "../state/RunState";
import { toNumberPointMap } from "../systems/ItemPoints";
import { beginRun, completeTutorial } from "../systems/Tutorial";
import { formatScore } from "../ui/formatScore";
import { addFelt, bannerButton, BannerAction } from "../ui/widgets";
import { isCompactLandscape, responsive } from "../ui/layout";
import { buildCompactEndScreen, type EndScreenLine } from "../ui/endScreen";
import { takePendingSubmission } from "../systems/GlobalScores";
import { ITEMS, type ShopItemId } from "../systems/Items";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { AmbientLayer } from "../ui/AmbientLayer";

/** Fixed sigil brightness for the backdrop. Read together with the `danger`
 *  flag below rather than on its own: this screen is the one place outside the
 *  table where the layer's red is the truthful colour, so the value is set high
 *  enough for that red to actually register behind the verdict. */
const GAME_OVER_AMBIENCE = 0.75;

export class GameOverScene extends Phaser.Scene {
  private unlocked: ShopItemId[] = [];
  private leaving = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("GameOver");
  }

  init(data?: { unlocked?: ShopItemId[] }): void {
    this.unlocked = data?.unlocked ?? [];
  }

  create(): void {
    this.leaving = false;
    // Every ended run lands here — a loss or an abandon. The tutorial plays for
    // one run, so retire it whether or not the player reached its last step.
    completeTutorial(this.registry);
    responsive(this, () => this.build());
    slideSceneIn(this, this.slideBackdrop);

    // A new personal best queued by the run's end offers itself to the global
    // leaderboard via the arcade initials prompt (launched on top).
    const pending = takePendingSubmission();
    if (pending)
      this.scene.launch("InitialsPrompt", {
        score: pending.score,
        dicePoints: pending.dicePoints,
        itemPoints: pending.itemPoints,
        rank: pending.rank,
        trial: pending.trial,
        endless: pending.endless,
        returnTo: "GameOver",
      });
  }

  private build(): void {
    const state = getRun(this.registry);
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const felt = addFelt(this);
    // The same room every other screen is set in, turned red. The layer already
    // means "the rolls ran out with the target unmet" by that colour in-game,
    // and that is exactly the verdict being delivered here — so the backdrop
    // carries the ending rather than sitting neutral behind it.
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(GAME_OVER_AMBIENCE, true);
    this.slideBackdrop = [felt, ambient];

    const rankLine = `You fell at rank ${rankOf(state.trial)}`;
    const trialLine = `The ${trialName(state.trial)}`;
    const scoreLine = `Total score: ${formatScore(state.totalScore)}`;
    const gridLine = `Your grid: ${state.dice.summary()}`;
    const unlockedNames = this.unlocked.map(
      (id) => ITEMS.find((item) => item.id === id)?.name ?? id,
    );
    const unlockLine =
      unlockedNames.length > 0
        ? `New cards unlocked: ${unlockedNames.join(", ")}\nAvailable next run.`
        : undefined;

    const hasPoints =
      Object.keys(state.dicePoints).length > 0 ||
      Object.keys(state.itemPoints).length > 0;
    const actions: BannerAction[] = [];
    if (hasPoints) {
      actions.push({
        label: "View Run Analysis",
        onClick: () => this.openAnalysis(),
      });
    }
    actions.push(
      // No intro here (main-menu only); beginRun still re-arms the tutorial if
      // the player hasn't completed it yet, or clears it otherwise.
      {
        label: "Begin a New Run",
        onClick: () => this.leave(() => beginRun(this)),
      },
      {
        label: "Return to the Vestibule",
        onClick: () => this.leave(() => this.scene.start("Menu")),
      },
    );

    // Seven lines of type over three buttons need height this viewport doesn't
    // have: the verdict takes one column and the ways on the other.
    if (isCompactLandscape(W, H)) {
      const lines: EndScreenLine[] = [
        {
          text: "The Order does not tolerate disorder.",
          size: 15,
          color: CSS.dim,
          italic: true,
        },
        { text: rankLine, size: 22, color: CSS.parchment, gapBefore: 12 },
        { text: trialLine, size: 22, color: CSS.parchment, gapBefore: 2 },
        { text: scoreLine, size: 18, color: CSS.goldLight, gapBefore: 10 },
        { text: gridLine, size: 14, color: CSS.dim, gapBefore: 8 },
      ];
      if (unlockLine) {
        lines.push({
          text: unlockLine,
          size: 14,
          color: CSS.goldLight,
          bold: true,
          gapBefore: 10,
        });
      }
      buildCompactEndScreen(this, {
        title: "The Run Has Ended",
        titleColor: CSS.red,
        lines,
        actions,
      });
      return;
    }

    const top = H * 0.2;
    const step = Math.min(H * 0.09, 60);

    this.add
      .text(cx, top, "The Run Has Ended", {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.045, 30, 58))}px`,
        color: CSS.red,
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setShadow(0, 4, "#000000", 10, false, true);

    this.add
      .text(cx, top + step, "The Order does not tolerate disorder.", {
        fontFamily: SERIF,
        fontSize: "20px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 2.15, rankLine, {
        fontFamily: SERIF,
        fontSize: "32px",
        color: CSS.parchment,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 2.75, trialLine, {
        fontFamily: SERIF,
        fontSize: "32px",
        color: CSS.parchment,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 3.5, scoreLine, {
        fontFamily: SERIF,
        fontSize: "24px",
        color: CSS.goldLight,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 4.4, gridLine, {
        fontFamily: SERIF,
        fontSize: "18px",
        color: CSS.dim,
        align: "center",
        wordWrap: { width: Math.min(900, W - 60) },
      })
      .setOrigin(0.5);

    if (unlockLine) {
      this.add
        .text(cx, top + step * 5.3, unlockLine, {
          fontFamily: SERIF,
          fontSize: "18px",
          color: CSS.goldLight,
          fontStyle: "bold",
          align: "center",
          wordWrap: { width: Math.min(820, W - 60) },
        })
        .setOrigin(0.5);
    }

    const gap = Math.min(82, H * 0.12);
    let btnY =
      Math.min(
        H - gap * actions.length - 20,
        top + step * (unlockLine ? 6.1 : 5.3),
      ) + gap;
    for (const action of actions) {
      bannerButton(this, cx, btnY, action.label, action.onClick);
      btnY += gap;
    }
  }

  private leave(complete: () => void): void {
    if (this.leaving) return;
    this.leaving = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }

  private openAnalysis(): void {
    const state = getRun(this.registry);
    this.scene.launch("Analysis", {
      returnTo: "GameOver",
      title: "Run Analysis",
      subtitle: "where this run’s points came from",
      dicePoints: toNumberPointMap(state.dicePoints),
      itemPoints: toNumberPointMap(state.itemPoints),
    });
  }
}
