import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { addFelt, BannerAction, stackBannerButtons } from "../ui/widgets";
import { formatScore } from "../ui/formatScore";
import {
  compactColumns,
  COMPACT_LANDSCAPE_MAX_H,
  isCompactLandscape,
  responsive,
} from "../ui/layout";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import {
  getInitials,
  normalizeInitials,
  PointMap,
  setInitials,
  submitScore,
} from "../systems/GlobalScores";

export interface InitialsPromptData {
  score: bigint;
  /** This run's per-item point attribution, packed into the leaderboard metadata
   *  (see systems/ItemPoints / GlobalScores.encodeMeta). */
  dicePoints?: PointMap;
  itemPoints?: PointMap;
  /** Whether the run was played on Hard Mode (tags the leaderboard entry). */
  rank: number;
  trial: number;
  endless?: boolean;
  /** Scene key to re-enable input on when the prompt closes. */
  returnTo: string;
}

/**
 * Arcade "NEW HIGH SCORE — enter your initials" overlay, launched on top of
 * GameOver/Victory when a run earns a new personal best. It runs as its own
 * scene (rather than objects inside GameOver) so the base scene's `responsive`
 * rebuild-on-resize can't wipe it mid-entry. Three letter slots, editable by
 * hardware keyboard *or* on-screen up/down arrows (the game targets touch), then
 * Confirm submits to the global leaderboard, or Skip dismisses without posting.
 * The base scene's input is disabled while we're open and restored on close.
 */
export class InitialsPromptScene extends Phaser.Scene {
  private score = 0n;
  private dicePoints: PointMap = {};
  private itemPoints: PointMap = {};
  private run = { rank: 1, trial: 1, endless: false };
  private returnTo = "Menu";
  private slots: string[] = ["A", "A", "A"];
  private sel = 0;
  private slotTexts: Phaser.GameObjects.Text[] = [];
  private slotRules: Phaser.GameObjects.Rectangle[] = [];

  constructor() {
    super("InitialsPrompt");
  }

  init(data: InitialsPromptData): void {
    this.score = data.score;
    this.dicePoints = data.dicePoints ?? {};
    this.itemPoints = data.itemPoints ?? {};
    this.run = {
      rank: data.rank,
      trial: data.trial,
      endless: data.endless ?? false,
    };
    this.returnTo = data.returnTo;
    const seed = normalizeInitials(getInitials());
    this.slots = [seed[0] ?? "A", seed[1] ?? "A", seed[2] ?? "A"];
    this.sel = 0;
  }

  create(): void {
    // Block the scene underneath from reacting to taps/hovers while we're open.
    const base = this.scene.get(this.returnTo);
    if (base) base.input.enabled = false;

    responsive(this, () => this.build());

    this.input.keyboard?.on("keydown", this.onKey, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off("keydown", this.onKey, this);
      const b = this.scene.get(this.returnTo);
      if (b) b.input.enabled = true;
    });
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const cy = H / 2;

    // Give the prompt a complete room of its own. It is launched over the end
    // screen, but an opaque felt layer keeps the two interfaces from tangling,
    // and also swallows taps that would otherwise reach the scene underneath.
    addFelt(this)
      .setInteractive()
      .on("pointerdown", () => {});
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, cy);
    ambient.setArea(W, H);
    ambient.setProgress(0.72, false);

    this.slotTexts = [];
    this.slotRules = [];

    const actions: BannerAction[] = [
      { label: "Confirm", onClick: () => this.confirm() },
      { label: "Skip", onClick: () => this.close() },
    ];

    // The shared threshold rules out columns below 500px because the denser
    // game screens need more width. This prompt has only three letters and two
    // short actions, so it can keep folding on even narrower landscape views.
    const compact =
      isCompactLandscape(W, H) || (W > H && H < COMPACT_LANDSCAPE_MAX_H);
    if (compact) {
      this.buildCompact(actions);
    } else {
      this.buildStacked(actions);
    }
  }

  /** The normal portrait/roomy layout: masthead, initials, then the actions. */
  private buildStacked(actions: BannerAction[]): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const header = buildSceneHeader(this, {
      title: "New High Score",
      subtitle: `Score ${formatScore(this.score)} — enter your initials`,
      y: Math.max(46, Math.min(H * 0.13, 88)),
      width: Math.min(W, 720),
    });

    // Two full-size banners are 140px tall together; reserve enough room for
    // their gap and the 16px outer margin instead of letting the lower one hug
    // or cross the viewport edge.
    const actionTop = Math.max(header.bottom + 150, H - 168);
    const slotTop = header.bottom + 8;
    const slotBottom = Math.max(slotTop + 120, actionTop - 8);
    const slotY = (slotTop + slotBottom) / 2;
    const letterSize = Math.round(Phaser.Math.Clamp(W * 0.12, 38, 68));
    this.buildSlots(cx, Math.min(W - 32, 470), slotY, letterSize);

    stackBannerButtons(
      this,
      { cx, width: Math.min(W - 32, 340) },
      {
        top: actionTop,
        height: Math.max(0, H - 16 - actionTop),
      },
      actions,
    );
  }

  /** A handset in landscape has width but almost no height. Put the initials
   *  and score in one column and the two decisions in the other. */
  private buildCompact(actions: BannerAction[]): void {
    const columns = compactColumns(this, { leftFraction: 0.56 });
    const { left, right } = columns;

    const header = buildSceneHeader(this, {
      title: "New High Score",
      subtitle: `Score ${formatScore(this.score)} — enter your initials`,
      x: left.cx,
      y: columns.top + 30,
      width: left.width,
    });

    const slotTop = header.bottom + 5;
    const slotY = slotTop + Math.max(54, (columns.bottom - slotTop) * 0.52);
    const letterSize = Math.round(Phaser.Math.Clamp(left.width * 0.14, 34, 50));
    this.buildSlots(left.cx, left.width, slotY, letterSize);
    stackBannerButtons(this, right, columns, actions);
  }

  /** Three letter slots with generous touch targets and tap arrows above and
   *  below. The visible controls sit directly on the sigil-backed felt. */
  private buildSlots(
    cx: number,
    width: number,
    slotY: number,
    letterSize: number,
  ): void {
    const slotGap = Math.min(width * 0.3, 130);
    const arrowSize = Math.round(letterSize * 0.56);
    const arrowDy = Math.max(42, letterSize * 0.92);

    this.slots.forEach((letter, i) => {
      const x = cx + (i - 1) * slotGap;
      const selected = i === this.sel;

      this.makeArrow(x, slotY - arrowDy, "▲", arrowSize, () =>
        this.cycle(i, +1),
      );
      this.makeArrow(x, slotY + arrowDy, "▼", arrowSize, () =>
        this.cycle(i, -1),
      );

      // Keep the tap target comfortably larger than a narrow letter glyph.
      this.add
        .rectangle(x, slotY, Math.max(44, letterSize), letterSize * 1.2, 0, 0)
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => {
          this.sel = i;
          this.refreshSlots();
        });

      const t = this.add
        .text(x, slotY, letter, {
          fontFamily: SERIF,
          fontSize: `${letterSize}px`,
          color: selected ? CSS.goldLight : CSS.parchment,
          fontStyle: "bold",
        })
        .setOrigin(0.5);

      const rule = this.add
        .rectangle(
          x,
          slotY + letterSize * 0.62,
          letterSize * 0.8,
          3,
          selected ? COLORS.goldLight : COLORS.parchmentDark,
          selected ? 1 : 0.58,
        )
        .setOrigin(0.5);
      this.slotTexts.push(t);
      this.slotRules.push(rule);
    });
  }

  private makeArrow(
    x: number,
    y: number,
    glyph: string,
    size: number,
    onTap: () => void,
  ): void {
    const text = this.add
      .text(x, y, glyph, {
        fontFamily: SERIF,
        fontSize: `${size}px`,
        color: CSS.parchmentDark,
      })
      .setOrigin(0.5);
    this.add
      .rectangle(
        x,
        y,
        Math.max(44, size * 1.5),
        Math.max(40, size * 1.25),
        0,
        0,
      )
      .setInteractive({ useHandCursor: true })
      .on("pointerover", () => text.setColor(CSS.goldLight))
      .on("pointerout", () => text.setColor(CSS.parchmentDark))
      .on("pointerdown", onTap);
  }

  /** Update the three mutable glyphs in place. Rebuilding the entire scene for
   *  each keypress would restart and randomly replace the animated sigil. */
  private refreshSlots(): void {
    this.slotTexts.forEach((text, i) => {
      const selected = i === this.sel;
      text.setText(this.slots[i]);
      text.setColor(selected ? CSS.goldLight : CSS.parchment);
      this.slotRules[i]?.setFillStyle(
        selected ? COLORS.goldLight : COLORS.parchmentDark,
        selected ? 1 : 0.58,
      );
    });
  }

  /** Advance a slot's letter by dir (+1/-1), wrapping A–Z. */
  private cycle(i: number, dir: number): void {
    const code = this.slots[i].charCodeAt(0) - 65;
    const next = (((code + dir) % 26) + 26) % 26;
    this.slots[i] = String.fromCharCode(65 + next);
    this.refreshSlots();
  }

  private onKey(ev: KeyboardEvent): void {
    const key = ev.key;
    if (/^[a-zA-Z]$/.test(key)) {
      this.slots[this.sel] = key.toUpperCase();
      this.sel = Math.min(this.sel + 1, 2);
      this.refreshSlots();
    } else if (key === "ArrowLeft") {
      this.sel = Math.max(0, this.sel - 1);
      this.refreshSlots();
    } else if (key === "ArrowRight") {
      this.sel = Math.min(2, this.sel + 1);
      this.refreshSlots();
    } else if (key === "ArrowUp") {
      this.cycle(this.sel, +1);
    } else if (key === "ArrowDown") {
      this.cycle(this.sel, -1);
    } else if (key === "Backspace") {
      this.slots[this.sel] = "A";
      this.sel = Math.max(0, this.sel - 1);
      this.refreshSlots();
    } else if (key === "Enter") {
      this.confirm();
    } else if (key === "Escape") {
      this.close();
    }
  }

  private confirm(): void {
    const initials = this.slots.join("");
    setInitials(initials);
    // Fire-and-forget: don't block closing on the network round-trip.
    void submitScore(
      this.score,
      initials,
      this.dicePoints,
      this.itemPoints,
      this.run,
    );
    this.close();
  }

  private close(): void {
    this.scene.stop();
  }
}
