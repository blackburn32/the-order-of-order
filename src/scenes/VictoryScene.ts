import Phaser from "phaser";
import { CSS, SERIF } from "../art/palette";
import { WIN_RANK } from "../config";
import { getRun } from "../state/RunState";
import { toNumberPointMap } from "../systems/ItemPoints";
import { beginRun } from "../systems/Tutorial";
import { continueEndless } from "../sim/engine";
import { formatScore } from "../ui/formatScore";
import { addFelt, bannerButton, BannerAction } from "../ui/widgets";
import {
  destroyAllChildren,
  isCompactLandscape,
  responsive,
} from "../ui/layout";
import { buildCompactEndScreen } from "../ui/endScreen";
import { takePendingSubmission } from "../systems/GlobalScores";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { finalizeRun } from "../systems/RunEnd";
import { AmbientLayer } from "../ui/AmbientLayer";
import {
  createFreshShopCheckpoint,
  saveActiveRun,
} from "../systems/ActiveRunPersistence";

/** Fixed sigil brightness for the backdrop. The other rooms sit at fixed mid
 *  values because they have no trial to report; this screen does, and the
 *  answer is that the Order's work is finished — so it gets the top of the
 *  range, the brightest and fastest sigil the layer draws. */
const VICTORY_AMBIENCE = 1;

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
    if (!this.runEnded) saveActiveRun(this.registry, { scene: "Victory" });
    responsive(this, () => this.build());
    slideSceneIn(this, this.slideBackdrop);

    if (this.runEnded) this.offerPendingSubmission();
  }

  private build(): void {
    const state = getRun(this.registry);
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(VICTORY_AMBIENCE, false);
    this.slideBackdrop = [felt, ambient];

    const rankLine = `You attained rank ${WIN_RANK}`;
    // Endless releases the King's tribute and the Betrayal — see
    // engine.continueEndless. Worth saying on the button's own screen, because
    // for a run carrying both it is the largest thing pressing on offers.
    const liftLine =
      state.kingsDemand || state.afflictions.includes("betrayal")
        ? "Press on and the Crown's tribute and the Betrayal are lifted."
        : null;
    const scoreLine = `Total score: ${formatScore(state.totalScore)}`;
    const gridLine = `Your grid: ${state.dice.summary()}`;

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
    if (!this.runEnded) {
      actions.push(
        { label: "End Run & Submit Score", onClick: () => this.endRun() },
        { label: "Press On \u2014 Endless", onClick: () => this.continueRun() },
      );
    } else {
      actions.push(
        // No intro here (main-menu only); beginRun still re-arms the tutorial
        // if the player hasn't completed it yet, or clears it otherwise.
        {
          label: "Begin a New Run",
          onClick: () => this.leave(() => beginRun(this)),
        },
        {
          label: "Return to the Vestibule",
          onClick: () => this.leave(() => this.scene.start("Menu")),
        },
      );
    }

    // Six lines of type over three buttons need height this viewport doesn't
    // have: the verdict takes one column and the ways on the other.
    if (isCompactLandscape(W, H)) {
      buildCompactEndScreen(this, {
        title: "The Order Is Complete",
        titleColor: CSS.goldLight,
        lines: [
          {
            text: "You have brought order to the dice.",
            size: 15,
            color: CSS.dim,
            italic: true,
          },
          { text: rankLine, size: 24, color: CSS.parchment, gapBefore: 14 },
          { text: scoreLine, size: 19, color: CSS.goldLight },
          { text: gridLine, size: 15, color: CSS.dim, gapBefore: 10 },
          ...(liftLine
            ? [
                {
                  text: liftLine,
                  size: 14,
                  color: CSS.goldLight,
                  italic: true,
                  gapBefore: 8,
                },
              ]
            : []),
        ],
        actions,
      });
      return;
    }

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
      .text(cx, top + step * 2.3, rankLine, {
        fontFamily: SERIF,
        fontSize: "32px",
        color: CSS.parchment,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 3.2, scoreLine, {
        fontFamily: SERIF,
        fontSize: "24px",
        color: CSS.goldLight,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + step * 4.1, gridLine, {
        fontFamily: SERIF,
        fontSize: "18px",
        color: CSS.dim,
        align: "center",
        wordWrap: { width: Math.min(900, W - 60) },
      })
      .setOrigin(0.5);

    if (liftLine) {
      this.add
        .text(cx, top + step * 4.8, liftLine, {
          fontFamily: SERIF,
          fontSize: "16px",
          color: CSS.goldLight,
          fontStyle: "italic",
          align: "center",
          wordWrap: { width: Math.min(900, W - 60) },
        })
        .setOrigin(0.5);
    }

    const gap = Math.min(82, H * 0.12);
    let btnY = Math.min(H - gap * actions.length - 20, top + step * 5.0) + gap;
    for (const action of actions) {
      bannerButton(this, cx, btnY, action.label, action.onClick);
      btnY += gap;
    }
  }

  /** Finish at the final rank. Continuing into endless deliberately skips this
   * so the score remains live until that run fails or is abandoned. */
  private endRun(): void {
    if (this.runEnded || this.leaving) return;
    this.runEnded = true;
    finalizeRun(getRun(this.registry), true);
    destroyAllChildren(this);
    this.build();
    this.offerPendingSubmission();
  }

  private offerPendingSubmission(): void {
    const pending = takePendingSubmission();
    if (!pending) return;
    this.scene.launch("InitialsPrompt", {
      score: pending.score,
      startedAt: pending.startedAt,
      rank: pending.rank,
      trial: pending.trial,
      endless: pending.endless,
      returnTo: "Victory",
    });
  }

  /** Carry the winning run on past the final rank. The goals grow faster than
   *  any build can from here, so this is a "how far can you get" epilogue
   *  rather than a second game — and since the realm the story left behind has
   *  no King and no rival order in it, `continueEndless` lifts both of the
   *  drawbacks they imposed on the way through. */
  private continueRun(): void {
    const state = getRun(this.registry);
    continueEndless(state);
    // The winning Boss Trial still earned its shop and boon. Endless begins
    // only after the player has had the same post-trial shopping opportunity
    // as every other clear.
    const checkpoint = createFreshShopCheckpoint(state);
    saveActiveRun(this.registry, checkpoint);
    this.leave(() => this.scene.start("Shop", checkpoint));
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
      subtitle: "where this run’s points came from",
      dicePoints: toNumberPointMap(state.dicePoints),
      itemPoints: toNumberPointMap(state.itemPoints),
      history: state.rollHistory,
      rolls: state.rollsTaken,
    });
  }
}
