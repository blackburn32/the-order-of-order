import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { WIN_RANK } from "../config";
import { getRun } from "../state/RunState";
import { toNumberPointMap } from "../systems/ItemPoints";
import { beginRun } from "../systems/Tutorial";
import { continueEndless } from "../sim/engine";
import { formatScore } from "../ui/formatScore";
import { addFelt, bannerButton } from "../ui/widgets";
import { responsive } from "../ui/layout";
import { takePendingSubmission } from "../systems/GlobalScores";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { finalizeRun } from "../systems/RunEnd";

interface VictoryData {
  runEnded?: boolean;
}

export class VictoryScene extends Phaser.Scene {
  private leaving = false;
  private runEnded = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("Victory");
  }

  init(data?: VictoryData): void {
    this.runEnded = data?.runEnded === true;
  }

  create(): void {
    this.leaving = false;
    responsive(this, () => this.build());
    slideSceneIn(this, this.slideBackdrop);

    if (this.runEnded) this.offerPendingSubmission();
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
      .text(cx, top, "The Order Is Complete", {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(W * 0.045, 30, 58))}px`,
        color: CSS.goldLight,
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setShadow(0, 4, "#000000", 10, false, true);

    this.add
      .text(cx, top + step, "You have brought order to the dice.", {
        fontFamily: SERIF,
        fontSize: "20px",
        color: CSS.dim,
        fontStyle: "italic",
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 2.3, `You attained rank ${WIN_RANK}`, {
        fontFamily: SERIF,
        fontSize: "32px",
        color: CSS.parchment,
      })
      .setOrigin(0.5);

    this.add
      .text(
        cx,
        top + step * 3.2,
        `Total score: ${formatScore(state.totalScore)}`,
        {
          fontFamily: SERIF,
          fontSize: "24px",
          color: CSS.goldLight,
        },
      )
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 4.1, `Your grid: ${state.dice.summary()}`, {
        fontFamily: SERIF,
        fontSize: "18px",
        color: CSS.dim,
        align: "center",
        wordWrap: { width: Math.min(900, W - 60) },
      })
      .setOrigin(0.5);

    const gap = Math.min(82, H * 0.12);
    const hasPoints =
      Object.keys(state.dicePoints).length > 0 ||
      Object.keys(state.itemPoints).length > 0;
    const rows = hasPoints ? 3 : 2;
    let btnY = Math.min(H - gap * rows - 20, top + step * 5.0) + gap;
    if (hasPoints) {
      bannerButton(this, cx, btnY, "View Run Analysis", () =>
        this.openAnalysis(),
      );
      btnY += gap;
    }
    if (!this.runEnded) {
      bannerButton(this, cx, btnY, "End Run & Submit Score", () =>
        this.endRun(),
      );
      bannerButton(this, cx, btnY + gap, "Press On — Endless", () =>
        this.continueRun(),
      );
    } else {
      // No intro here (main-menu only); beginRun still re-arms the tutorial if
      // the player hasn't completed it yet, or clears it otherwise.
      bannerButton(this, cx, btnY, "Begin a New Run", () =>
        this.leave(() => beginRun(this)),
      );
      bannerButton(this, cx, btnY + gap, "Return to the Vestibule", () =>
        this.leave(() => this.scene.start("Menu")),
      );
    }
  }

  /** Finish at rank 5. Continuing into endless deliberately skips this so the
   * score remains live until that run fails or is abandoned. */
  private endRun(): void {
    if (this.runEnded || this.leaving) return;
    this.runEnded = true;
    finalizeRun(getRun(this.registry), true);
    this.children.removeAll(true);
    this.build();
    this.offerPendingSubmission();
  }

  private offerPendingSubmission(): void {
    const pending = takePendingSubmission();
    if (!pending) return;
    this.scene.launch("InitialsPrompt", {
      score: pending.score,
      dicePoints: pending.dicePoints,
      itemPoints: pending.itemPoints,
      rank: pending.rank,
      trial: pending.trial,
      endless: pending.endless,
      returnTo: "Victory",
    });
  }

  /** Carry the winning run on past the final rank. The goals grow faster than
   *  any build can from here, so this is a "how far can you get" epilogue
   *  rather than a second game. */
  private continueRun(): void {
    const state = getRun(this.registry);
    continueEndless(state);
    // The winning Boss Trial still earned its shop and boon. Endless begins
    // only after the player has had the same post-trial shopping opportunity
    // as every other clear.
    this.leave(() => this.scene.start("Shop"));
  }

  private leave(complete: () => void): void {
    if (this.leaving) return;
    this.leaving = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }

  private openAnalysis(): void {
    const state = getRun(this.registry);
    this.scene.launch("Analysis", {
      returnTo: "Victory",
      title: "Run Analysis",
      dicePoints: toNumberPointMap(state.dicePoints),
      itemPoints: toNumberPointMap(state.itemPoints),
    });
  }
}
