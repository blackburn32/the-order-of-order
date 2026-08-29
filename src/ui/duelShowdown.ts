// The closing sequence of the mirror duel.
//
// Every other trial ends against a number that has been on screen the whole
// time: the HUD's GOAL plaque, filled in before the first roll. The duel's
// opposing number is only settled by its last roll, and until then the two
// totals sit at opposite ends of the HUD strip with three unrelated plaques
// between them. So the run's final comparison — the one the whole ladder has
// been climbing toward — is the one comparison the interface never actually
// makes.
//
// This makes it. The table goes dark, the two totals are carried in from either
// side and set down next to each other, they count up together, and only then
// does the game say which way it went. Nothing here decides the outcome; the
// engine settled that before this was built (see systems/Rival). This is the
// reading of the result, and it holds until the player chooses to leave it.
//
// Built as a plain overlay over the live GameScene rather than as a scene of
// its own, so the felt, the sigil and the grid the duel was played on are still
// underneath it — the verdict is delivered at the table, not on a results
// screen.

import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { formatScore } from "./formatScore";
import { bannerButton, fitTextWidth } from "./widgets";

/** The showdown owns the top of the display list: it must sit over the banner
 *  stack (90), any shockwave the last roll is still fading out (55), and the
 *  dice themselves. */
const DEPTH_SCRIM = 200;
const DEPTH_CONTENT = 202;
const DEPTH_FLASH = 208;

const SCRIM_ALPHA = 0.93;
const SCRIM_FADE_MS = 260;
/** How long the two totals take to travel in from the edges and meet. */
const INTRO_MS = 460;
/** The count-up, which both sides run at once so they are read against each
 *  other rather than one after the other. */
const COUNT_MS = 950;
/** The beat between the totals landing and the verdict — long enough for the
 *  player to do the comparison themselves first. */
const HOLD_MS = 400;
/** The verdict headline's own entrance, after which the way on appears. */
const VERDICT_MS = 560;

export interface DuelShowdownOptions {
  /** Final totals. Both are already settled — nothing here reads RunState. */
  playerScore: bigint;
  rivalScore: bigint;
  /** True when the player outscored the Order of Disorder. A tie is a loss (see
   *  `Rival.playerLeadsDuel`), so this is passed in rather than recomputed from
   *  the two numbers above, which cannot express that rule. */
  won: boolean;
  /** What the way on says. */
  continueLabel: string;
  onContinue: () => void;
  /** Routes freshly-created objects through the owning scene's overlay camera,
   *  exactly as `BannerStack` does — GameScene draws its grid through a second
   *  camera, and anything left on the main camera would be covered by dice. */
  register?: (objs: Phaser.GameObjects.GameObject[]) => void;
}

/** One side of the tally: a plaque, the house it belongs to, and its total. */
interface Side {
  container: Phaser.GameObjects.Container;
  plaque: Phaser.GameObjects.Image;
  house: Phaser.GameObjects.Text;
  score: Phaser.GameObjects.Text;
  /** Where it comes in from: -1 off the left edge, +1 off the right. */
  from: -1 | 1;
  total: bigint;
  /** What the plaque is currently reading, so a resize can re-render it at the
   *  new size without disturbing a count-up in flight. */
  shown: bigint;
  count?: Phaser.Time.TimerEvent;
  scoreColor: string;
  flareColor: number;
}

interface Metrics {
  cx: number;
  colW: number;
  colH: number;
  rowY: number;
  kickerY: number;
  verdictY: number;
  marginY: number;
  buttonY: number;
  buttonW: number;
  buttonH: number;
  kickerFont: number;
  houseFont: number;
  scoreFont: number;
  verdictFont: number;
  marginFont: number;
}

export class DuelShowdown {
  private objects: Phaser.GameObjects.GameObject[] = [];
  private scrim!: Phaser.GameObjects.Rectangle;
  private kicker!: Phaser.GameObjects.Text;
  private sides!: [Side, Side];
  private divider!: Phaser.GameObjects.Graphics;
  private verdict!: Phaser.GameObjects.Text;
  private margin!: Phaser.GameObjects.Text;
  private button?: Phaser.GameObjects.Container;
  private introTweens: Phaser.Tweens.Tween[] = [];
  private timers: Phaser.Time.TimerEvent[] = [];
  private metrics!: Metrics;
  private stage: "intro" | "verdict" | "done" | "leaving" = "intro";
  private destroyed = false;

  constructor(
    private scene: Phaser.Scene,
    private opts: DuelShowdownOptions,
  ) {
    this.build();
    this.layout();
    this.start();
  }

  /** What the owning scene should hold still while its interface slides away.
   *  The scrim is the room the verdict was delivered in, and sliding it off
   *  would flash the table the player has just finished with back into view for
   *  the length of the transition. */
  get backdrop(): Phaser.GameObjects.GameObject[] {
    return [this.scrim];
  }

  // ---- construction --------------------------------------------------------

  private build(): void {
    const scene = this.scene;
    const { width, height } = scene.scale;

    this.scrim = scene.add
      .rectangle(0, 0, width, height, COLORS.feltDark, SCRIM_ALPHA)
      .setOrigin(0)
      .setDepth(DEPTH_SCRIM)
      .setAlpha(0);
    // Swallows presses so the roll seal underneath cannot be hit, and doubles
    // as the way to hurry the sequence along on a replay.
    this.scrim.setInteractive();
    this.scrim.on("pointerdown", () => this.skip());

    this.kicker = this.text("The Final Tally", CSS.dim, "italic");
    this.divider = scene.add.graphics().setDepth(DEPTH_CONTENT);
    this.objects.push(this.scrim, this.divider);
    this.register([this.scrim, this.divider]);

    this.sides = [
      this.buildSide({
        house: "THE ORDER OF ORDER",
        total: this.opts.playerScore,
        from: -1,
        scoreColor: CSS.goldLight,
        flareColor: COLORS.goldLight,
      }),
      this.buildSide({
        house: "THE ORDER OF DISORDER",
        total: this.opts.rivalScore,
        from: 1,
        scoreColor: CSS.red,
        flareColor: COLORS.waxRed,
      }),
    ];

    this.verdict = this.text(
      this.opts.won ? "The Order Holds" : "Disorder Prevails",
      this.opts.won ? CSS.goldLight : CSS.red,
    ).setAlpha(0);
    this.margin = this.text(
      this.marginCopy(),
      CSS.parchment,
      "italic",
    ).setAlpha(0);
  }

  private buildSide(spec: {
    house: string;
    total: bigint;
    from: -1 | 1;
    scoreColor: string;
    flareColor: number;
  }): Side {
    const scene = this.scene;
    const plaque = scene.add.image(0, 0, "plaque");
    const house = scene.add
      .text(0, 0, spec.house, {
        fontFamily: SERIF,
        fontSize: "13px",
        color: CSS.dim,
        fontStyle: "bold",
        align: "center",
      })
      .setOrigin(0.5);
    const score = scene.add
      .text(0, 0, "0", {
        fontFamily: SERIF,
        fontSize: "40px",
        color: spec.scoreColor,
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    const container = scene.add
      .container(0, 0, [plaque, house, score])
      .setDepth(DEPTH_CONTENT)
      .setAlpha(0);
    this.objects.push(container);
    this.register([container]);
    return {
      container,
      plaque,
      house,
      score,
      from: spec.from,
      total: spec.total,
      shown: 0n,
      scoreColor: spec.scoreColor,
      flareColor: spec.flareColor,
    };
  }

  private text(
    content: string,
    color: string,
    fontStyle = "",
  ): Phaser.GameObjects.Text {
    const object = this.scene.add
      .text(0, 0, content, {
        fontFamily: SERIF,
        fontSize: "24px",
        color,
        fontStyle,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(DEPTH_CONTENT);
    this.objects.push(object);
    this.register([object]);
    return object;
  }

  private register(objects: Phaser.GameObjects.GameObject[]): void {
    this.opts.register?.(objects);
  }

  /** The one line that says how close it was — the number neither plaque shows
   *  and the only one that answers "by how much". A tie names itself, since
   *  "behind by 0" would read as a bug rather than as the rule it is. */
  private marginCopy(): string {
    const gap = this.opts.playerScore - this.opts.rivalScore;
    if (gap === 0n) return "A dead heat — and a dead heat is not a lead.";
    const size = formatScore(gap < 0n ? -gap : gap);
    return gap > 0n ? `Ahead by ${size}.` : `Behind by ${size}.`;
  }

  // ---- layout --------------------------------------------------------------

  /** Re-lay the whole sequence for the current viewport. Safe at any point: an
   *  entrance still in flight is snapped home first, and both plaques are
   *  re-rendered at whatever they are currently reading, so a resize mid
   *  count-up neither restarts nor freezes it. */
  layout(): void {
    if (this.destroyed) return;
    this.snapIntro();
    const m = this.measure();
    this.metrics = m;
    const { width, height } = this.scene.scale;

    this.scrim.setPosition(0, 0).setSize(width, height);
    // setSize leaves the input hit area at the old rectangle, which would let
    // presses through wherever the viewport has grown.
    this.scrim.setInteractive();

    this.kicker
      .setScale(1)
      .setFontSize(m.kickerFont)
      .setPosition(m.cx, m.kickerY);
    fitTextWidth(this.kicker, width - 40);

    const offset = m.colW / 2 + this.gap(m) / 2;
    this.sides[0].container.setPosition(m.cx - offset, m.rowY);
    this.sides[1].container.setPosition(m.cx + offset, m.rowY);
    for (const side of this.sides) this.layoutSide(side, m);

    this.drawDivider(m);

    this.verdict.setFontSize(m.verdictFont).setPosition(m.cx, m.verdictY);
    fitTextWidth(this.verdict, width - 40);
    this.margin
      .setScale(1)
      .setFontSize(m.marginFont)
      .setPosition(m.cx, m.marginY);
    fitTextWidth(this.margin, width - 48);

    if (this.button) this.buildButton();
  }

  private layoutSide(side: Side, m: Metrics): void {
    side.plaque.setDisplaySize(m.colW, m.colH);
    side.house
      .setScale(1)
      .setFontSize(m.houseFont)
      .setPosition(0, -m.colH * 0.28);
    fitTextWidth(side.house, m.colW - 18);
    side.score.setPosition(0, m.colH * 0.12);
    this.renderScore(side);
  }

  /** The air between the two plaques, which the divider stands in. */
  private gap(m: Metrics): number {
    return Math.max(18, Math.min(64, m.colW * 0.22));
  }

  private measure(): Metrics {
    const { width: W, height: H } = this.scene.scale;
    const basis = Math.min(W, H);
    const cx = W / 2;
    // Both plaques and the air between them have to fit the width, so the
    // column is solved from the room rather than clamped into it: a phone in
    // portrait gets two narrow plaques rather than two that overlap.
    const colW = Phaser.Math.Clamp((W - 32) / 2 - 12, 96, 360);
    const colH = Phaser.Math.Clamp(H * 0.26, 88, 190);
    const rowY = H * 0.44;
    return {
      cx,
      colW,
      colH,
      rowY,
      kickerY: rowY - colH / 2 - Math.max(20, H * 0.06),
      verdictY: rowY + colH / 2 + Math.max(26, H * 0.09),
      marginY: rowY + colH / 2 + Math.max(52, H * 0.155),
      buttonY: H - Math.max(40, H * 0.11),
      buttonW: Math.min(340, W - 48),
      buttonH: Math.max(38, H * 0.11),
      kickerFont: Phaser.Math.Clamp(basis * 0.042, 13, 22),
      houseFont: Phaser.Math.Clamp(basis * 0.03, 9, 15),
      scoreFont: Phaser.Math.Clamp(basis * 0.1, 22, 46),
      verdictFont: Phaser.Math.Clamp(basis * 0.075, 22, 40),
      marginFont: Phaser.Math.Clamp(basis * 0.04, 12, 20),
    };
  }

  /** A hairline rule with a lozenge at its middle, standing between the two
   *  totals: the comparison, drawn. */
  private drawDivider(m: Metrics): void {
    const g = this.divider;
    const half = m.colH * 0.34;
    g.clear();
    g.lineStyle(1.5, COLORS.gold, 0.55);
    g.lineBetween(m.cx, m.rowY - half, m.cx, m.rowY - 7);
    g.lineBetween(m.cx, m.rowY + 7, m.cx, m.rowY + half);
    g.fillStyle(COLORS.gold, 0.9);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(m.cx, m.rowY - 6),
        new Phaser.Math.Vector2(m.cx + 4.5, m.rowY),
        new Phaser.Math.Vector2(m.cx, m.rowY + 6),
        new Phaser.Math.Vector2(m.cx - 4.5, m.rowY),
      ],
      true,
    );
  }

  /** Print a side's current reading at the size the layout allows, shrinking
   *  only where a very large total would otherwise run off its plaque. */
  private renderScore(side: Side): void {
    side.score
      .setScale(1)
      .setFontSize(this.metrics?.scoreFont ?? 40)
      .setText(formatScore(side.shown));
    fitTextWidth(side.score, (this.metrics?.colW ?? 200) - 20);
  }

  // ---- sequence ------------------------------------------------------------

  private start(): void {
    const scene = this.scene;
    scene.tweens.add({
      targets: this.scrim,
      alpha: SCRIM_ALPHA,
      duration: SCRIM_FADE_MS,
    });
    this.kicker.setAlpha(0);
    scene.tweens.add({
      targets: this.kicker,
      alpha: 1,
      duration: SCRIM_FADE_MS,
      delay: 120,
    });
    this.divider.setAlpha(0);

    // The two totals are carried in from the edges they were kept on all trial
    // — the player's from the left, the Order of Disorder's from the right —
    // and set down together. With motion off they simply appear where they
    // belong.
    if (fx.motion) {
      const travel = scene.scale.width * 0.6;
      for (const side of this.sides) {
        const home = side.container.x;
        side.container.setX(home + side.from * travel);
        this.introTweens.push(
          scene.tweens.add({
            targets: side.container,
            x: home,
            alpha: 1,
            duration: INTRO_MS,
            delay: 120,
            ease: "Cubic.easeOut",
          }),
        );
      }
      this.introTweens.push(
        scene.tweens.add({
          targets: this.divider,
          alpha: 1,
          duration: 200,
          delay: 120 + INTRO_MS,
        }),
      );
    } else {
      for (const side of this.sides) side.container.setAlpha(1);
      this.divider.setAlpha(1);
    }

    const introEnd = fx.motion ? 120 + INTRO_MS : 0;
    this.after(introEnd, () => this.countUp());
    this.after(introEnd + COUNT_MS + HOLD_MS, () => this.reveal());
  }

  /** Both totals climb at once and land together, however far apart they end
   *  up: the point of the sequence is the comparison, and staggering them would
   *  give one side the last word before the verdict does. */
  private countUp(): void {
    if (this.stage !== "intro" || this.destroyed) return;
    for (const side of this.sides) {
      side.count?.remove();
      // With effects off `countUp` returns nothing and calls back once with the
      // final total, so both paths land in the same place.
      side.count = fx.countUp(this.scene, 0n, side.total, COUNT_MS, (value) => {
        side.shown = value;
        this.renderScore(side);
      });
    }
    audio.roll(6);
  }

  /** Jump straight to the verdict. Reachable by pressing the table, so a player
   *  who has seen the sequence before is never held by it. */
  private skip(): void {
    if (this.stage !== "intro") return;
    this.reveal();
  }

  private reveal(): void {
    if (this.stage !== "intro" || this.destroyed) return;
    this.stage = "verdict";
    this.clearTimers();
    this.snapIntro();
    for (const side of this.sides) {
      side.count?.remove();
      side.count = undefined;
      side.shown = side.total;
      this.renderScore(side);
    }

    const scene = this.scene;
    const m = this.metrics;
    const won = this.opts.won;
    const winner = this.sides[won ? 0 : 1];
    const loser = this.sides[won ? 1 : 0];

    if (won) audio.victory();
    else audio.gameOver();
    this.flash(winner.flareColor, won ? 0.34 : 0.26);

    // The losing side is dimmed rather than removed: the number that lost still
    // has to be there to be read against the one that won.
    scene.tweens.add({
      targets: loser.container,
      alpha: 0.42,
      duration: 320,
      ease: "Quad.easeOut",
    });
    fx.punch(scene, winner.container, 1.1, 200);
    fx.glow(winner.plaque, winner.flareColor, 6);

    const ring = fx.shockwave(
      scene,
      winner.container.x,
      winner.container.y,
      m.colW * 0.9,
      winner.flareColor,
      won ? 900 : 640,
    );
    if (ring) {
      ring.setDepth(DEPTH_CONTENT - 1);
      this.register([ring]);
    }
    const burst = fx.burst(scene, winner.container.x, winner.container.y, {
      count: won ? 90 : 34,
      tint: won ? COLORS.glow : COLORS.waxRed,
      speed: won ? 540 : 300,
      lifespan: won ? 1600 : 820,
      gravityY: 190,
    });
    if (burst) {
      burst.setDepth(DEPTH_CONTENT + 1);
      this.register([burst]);
    }
    // A loss lands as a blow rather than a flourish. The showdown is drawn by
    // the overlay camera, so the two plaques are shaken directly — a camera
    // shake here would move everything except the thing being read.
    if (!won) {
      for (const side of this.sides) {
        fx.shakeObject(scene, side.container, 420, 9);
      }
    }

    this.verdict.setAlpha(0).setScale(fx.motion ? 0.86 : 1);
    scene.tweens.add({
      targets: this.verdict,
      alpha: 1,
      scaleX: 1,
      scaleY: 1,
      duration: 320,
      ease: "Back.easeOut",
    });
    scene.tweens.add({
      targets: this.margin,
      alpha: 1,
      duration: 300,
      delay: 240,
    });

    this.after(VERDICT_MS, () => {
      this.stage = "done";
      this.buildButton();
    });
  }

  /** The way on, built last and rebuilt on resize — `bannerButton` bakes its
   *  label at a size derived from the room it was given, so it is remade rather
   *  than rescaled. */
  private buildButton(): void {
    if (this.destroyed) return;
    const m = this.metrics;
    const previous = this.button;
    if (previous) {
      this.objects = this.objects.filter((o) => o !== previous);
      previous.destroy();
    }
    const button = bannerButton(
      this.scene,
      m.cx,
      m.buttonY,
      this.opts.continueLabel,
      () => {
        if (this.stage !== "done") return;
        // Latched, so a double press cannot start the next scene twice.
        this.stage = "leaving";
        this.opts.onContinue();
      },
      m.buttonW,
      m.buttonH,
    ).setDepth(DEPTH_CONTENT);
    this.button = button;
    this.objects.push(button);
    this.register([button]);
    if (fx.motion && !previous) {
      button.setAlpha(0);
      this.scene.tweens.add({ targets: button, alpha: 1, duration: 260 });
    }
  }

  /** A full-viewport colour hit. `fx.flash` drives a camera, and the showdown
   *  is not on the camera the scene's chrome is — so the hit is an object of
   *  its own, over everything, gone in under half a second. */
  private flash(color: number, peak: number): void {
    if (!fx.motion) return;
    const { width, height } = this.scene.scale;
    const rect = this.scene.add
      .rectangle(0, 0, width, height, color, peak)
      .setOrigin(0)
      .setDepth(DEPTH_FLASH)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.register([rect]);
    this.scene.tweens.add({
      targets: rect,
      alpha: 0,
      duration: 420,
      ease: "Quad.easeOut",
      onComplete: () => rect.destroy(),
    });
  }

  private after(delay: number, fn: () => void): void {
    this.timers.push(this.scene.time.delayedCall(Math.max(0, delay), fn));
  }

  private clearTimers(): void {
    for (const timer of this.timers) timer.remove();
    this.timers = [];
  }

  /** Put the entrance where it was going. Called before any re-layout and by
   *  the reveal, so nothing is left mid-flight against stale coordinates.
   *  Only the entrance's own fades are forced home: past the verdict the losing
   *  side is deliberately dimmed, and a resize must not undo that. */
  private snapIntro(): void {
    for (const tween of this.introTweens) tween.stop();
    this.introTweens = [];
    this.divider.setAlpha(1);
    this.kicker.setAlpha(1);
    if (this.stage !== "intro") return;
    for (const side of this.sides) side.container.setAlpha(1);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    for (const side of this.sides) side.count?.remove();
    for (const tween of this.introTweens) tween.stop();
    this.introTweens = [];
    for (const object of this.objects) object.destroy();
    this.objects = [];
  }
}
