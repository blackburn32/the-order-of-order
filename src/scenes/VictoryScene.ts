import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { WIN_ROUND } from "../config";
import { getRun } from "../state/RunState";
import { toNumberPointMap } from "../systems/ItemPoints";
import { beginRun } from "../systems/Tutorial";
import { formatScore } from "../ui/formatScore";
import { addFelt, bannerButton, checkboxRow } from "../ui/widgets";
import { responsive } from "../ui/layout";
import { takePendingSubmission } from "../systems/GlobalScores";
import { loadSettings, saveSettings } from "../systems/SaveData";

export class VictoryScene extends Phaser.Scene {
  constructor() {
    super("Victory");
  }

  create(): void {
    responsive(this, () => this.build());

    // A new personal best queued by the run's end offers itself to the global
    // leaderboard via the arcade initials prompt (launched on top).
    const pending = takePendingSubmission();
    if (pending)
      this.scene.launch("InitialsPrompt", {
        score: pending.score,
        dicePoints: pending.dicePoints,
        itemPoints: pending.itemPoints,
        hard: pending.hard,
        returnTo: "Victory",
      });
  }

  private build(): void {
    const state = getRun(this.registry);
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    addFelt(this);

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
      .text(cx, top + step * 2.3, `You survived all ${WIN_ROUND} rounds`, {
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
    // Beating the game unlocks Hard Mode, so the toggle is always offered here.
    const rows = (hasPoints ? 3 : 2) + 1;
    let btnY = Math.min(H - gap * rows - 20, top + step * 5.0) + gap;
    if (hasPoints) {
      bannerButton(this, cx, btnY, "View Run Analysis", () =>
        this.openAnalysis(),
      );
      btnY += gap;
    }
    checkboxRow(
      this,
      cx,
      btnY,
      "Hard Mode ☠",
      loadSettings().hardMode,
      (value) => {
        const s = loadSettings();
        s.hardMode = value;
        saveSettings(s);
      },
      26,
      // On the dark felt, use light text + a parchment border like the intro.
      { textColor: CSS.ivory, boxStroke: COLORS.parchment },
    );
    btnY += gap;
    // No intro here (main-menu only); beginRun still re-arms the tutorial if the
    // player hasn't completed it yet, or clears it otherwise.
    bannerButton(this, cx, btnY, "Begin a New Run", () => beginRun(this));
    bannerButton(this, cx, btnY + gap, "Return to the Vestibule", () =>
      this.scene.start("Menu"),
    );
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
