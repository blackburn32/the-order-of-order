import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { rankOf, trialName } from "../config";
import { getRun } from "../state/RunState";
import { toNumberPointMap } from "../systems/ItemPoints";
import { beginRun, completeTutorial } from "../systems/Tutorial";
import { formatScore } from "../ui/formatScore";
import { addFelt, bannerButton } from "../ui/widgets";
import { responsive } from "../ui/layout";
import { takePendingSubmission } from "../systems/GlobalScores";
import { ITEMS, type ShopItemId } from "../systems/Items";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";

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

    this.slideBackdrop = [addFelt(this)];

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
      .text(cx, top + step * 2.15, `You fell at rank ${rankOf(state.trial)}`, {
        fontFamily: SERIF,
        fontSize: "32px",
        color: CSS.parchment,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 2.75, `The ${trialName(state.trial)}`, {
        fontFamily: SERIF,
        fontSize: "32px",
        color: CSS.parchment,
      })
      .setOrigin(0.5);

    this.add
      .text(
        cx,
        top + step * 3.5,
        `Total score: ${formatScore(state.totalScore)}`,
        {
          fontFamily: SERIF,
          fontSize: "24px",
          color: CSS.goldLight,
        },
      )
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 4.4, `Your grid: ${state.dice.summary()}`, {
        fontFamily: SERIF,
        fontSize: "18px",
        color: CSS.dim,
        align: "center",
        wordWrap: { width: Math.min(900, W - 60) },
      })
      .setOrigin(0.5);

    if (this.unlocked.length > 0) {
      const names = this.unlocked.map(
        (id) => ITEMS.find((item) => item.id === id)?.name ?? id,
      );
      this.add
        .text(
          cx,
          top + step * 5.3,
          `New cards unlocked: ${names.join(", ")}\nAvailable next run.`,
          {
            fontFamily: SERIF,
            fontSize: "18px",
            color: CSS.goldLight,
            fontStyle: "bold",
            align: "center",
            wordWrap: { width: Math.min(820, W - 60) },
          },
        )
        .setOrigin(0.5);
    }

    const gap = Math.min(82, H * 0.12);
    const hasPoints =
      Object.keys(state.dicePoints).length > 0 ||
      Object.keys(state.itemPoints).length > 0;
    const rows = hasPoints ? 3 : 2;
    let btnY =
      Math.min(
        H - gap * rows - 20,
        top + step * (this.unlocked.length > 0 ? 6.1 : 5.3),
      ) + gap;
    if (hasPoints) {
      bannerButton(this, cx, btnY, "View Run Analysis", () =>
        this.openAnalysis(),
      );
      btnY += gap;
    }
    // No intro here (main-menu only); beginRun still re-arms the tutorial if the
    // player hasn't completed it yet, or clears it otherwise.
    bannerButton(this, cx, btnY, "Begin a New Run", () =>
      this.leave(() => beginRun(this)),
    );
    bannerButton(this, cx, btnY + gap, "Return to the Vestibule", () =>
      this.leave(() => this.scene.start("Menu")),
    );
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
      dicePoints: toNumberPointMap(state.dicePoints),
      itemPoints: toNumberPointMap(state.itemPoints),
    });
  }
}
