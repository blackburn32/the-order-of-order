// The roll's score callout, set out as the sum it is: the dice that scored, the
// points other effects added, a multiplier that climbs through every card and
// engine that raised it, and the total that comes of it.
//
//        ┌──────────────────────────┐
//        │      84 DICE SCORED      │
//        │        +575 BONUS        │  ← every other effect's points
//        │        [ ×148.8 ]        │  ← counts up a step at a time
//        │  THE CATECHISM ×1.77     │  ← the step that just raised it
//        │         +97,768          │  ← revealed last
//        └──────────────────────────┘
//
// Numbers come from systems/RollBreakdown; this file only stages them. The panel
// behind the rows is what keeps them legible over a grid of pale dice. Every
// timer runs on the scene clock and every tween through the scene's manager, so
// the capture studio's stepped clock drives it frame-exactly.

import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { SIGIL_INK_RADIUS } from "../art/textures";
import { fx } from "../systems/Effects";
import {
  formatHundredths,
  multiplierHundredths,
  ONE,
  type RollBreakdown,
} from "../systems/RollBreakdown";
import { formatScore } from "./formatScore";

export interface RollBreakdownOptions {
  x: number;
  /** The first row's centre. */
  top: number;
  /** Centre the whole panel on this y instead of hanging it from `top`. */
  centerY?: number;
  /** Distance between rows, already fitted to the screen by the caller. */
  rowStep: number;
  fontSize: number;
  /** The widest the panel may be. */
  maxWidth: number;
  /** Hand every object to the scene's overlay camera. */
  add<T extends Phaser.GameObjects.GameObject>(object: T): T;
  /** Speed the sequence up (2 = twice as fast) for a player mashing the seal. */
  pace?: number;
  /** Each time a bonus is added in, by its index. */
  onBonus?(index: number): void;
  /** Each time a step raises the multiplier, by its index. */
  onStep?(index: number): void;
  /** Celebrate the total: this roll carried the trial past its goal. */
  acclaim?: RollAcclaim;
}

/**
 * How loudly a callout celebrates the total it lands on.
 *
 * - `goal` — this roll carried the trial past its goal.
 * - `firstRoll` — it did that on the trial's very first roll, which is the
 *   rarest thing a roll can do and is staged as such.
 */
export type RollAcclaim = "goal" | "firstRoll";

export interface RollBreakdownView {
  /** The y just below the panel, for whatever stacks under it. */
  readonly bottomY: number;
  /** Scene-clock milliseconds from now until the total is shown. */
  readonly totalAtMs: number;
  /** Scene-clock time at which the callout will have faded away on its own. */
  readonly closedAt: number;
  /** Jump to the final numbers and clear away quickly: a new roll is starting. */
  hurry(): void;
  destroy(): void;
}

/** How many row steps the callout's panel spans: its dice row, the bonus and
 *  the line naming each bonus as it is added, the multiplier and the line
 *  naming each step when anything multiplied the roll, the total, and the
 *  panel's margins. */
export function breakdownRows(breakdown: RollBreakdown): number {
  const sum =
    (breakdown.dice > 0n ? 1 : 0) +
    (breakdown.subtotal > breakdown.dice ? BONUS_ROWS : 0);
  return sum + (breakdown.steps.length > 0 ? 4.8 : 2.1);
}

/** The bonus row plus the line under it naming the bonus being added. */
const BONUS_ROWS = 1.6;

/** Every duration below, and every count, runs at this share of its written
 *  length — the one dial for how long the whole callout takes. */
const TIME_SCALE = 0.6;

const POP_MS = 110;

/** How long a count of one item takes: the bonus adding one effect, or the
 *  multiplier taking one step. */
const COUNT_MS = 1000;
/** How much longer than that a long count may run. A count's items share its
 *  time, so a short list is read item by item and a long one zips through. */
const COUNT_STRETCH = 0.25;

/** A count of `items`: its whole length and the gap between items. One item
 *  takes COUNT_MS; the total rises toward COUNT_MS × 1.25 as the list grows. */
export function countPace(items: number): { total: number; gap: number } {
  if (items <= 0) return { total: 0, gap: 0 };
  const total = COUNT_MS * (1 + COUNT_STRETCH * (1 - 1 / items));
  return { total, gap: total / items };
}

/** The pause between the bonus's count and the multiplier's, and before a
 *  lone count starts: as unhurried as the counts either side of it. */
function transitionMs(bonusGap: number, stepGap: number): number {
  const gaps = [bonusGap, stepGap].filter((gap) => gap > 0);
  const pace = gaps.length ? Math.min(...gaps) : COUNT_MS;
  return Math.min(320, Math.max(120, pace * 0.4));
}
const HOLD_AFTER_TOTAL_MS = 650;
const FADE_MS = 300;

/** Extra rest an acclaimed callout takes before it clears away, on top of the
 *  ordinary hold. The flare lands on the total and then has to be *looked* at;
 *  at the plain hold the seal would barely finish turning once. */
const ACCLAIM_HOLD_MS: Record<RollAcclaim, number> = {
  goal: 900,
  firstRoll: 1600,
};

/** `COLORS.feltDark` carried `amount` of the way toward gold — the wash the
 *  panel takes when the roll met the goal. Mixed rather than drawn as a second
 *  translucent fill so the border and the rows still sit on one flat felt. */
function goldWash(amount: number): number {
  const mixed = Phaser.Display.Color.Interpolate.ColorWithColor(
    Phaser.Display.Color.ValueToColor(COLORS.feltDark),
    Phaser.Display.Color.ValueToColor(COLORS.gold),
    100,
    Math.round(amount * 100),
  );
  return Phaser.Display.Color.GetColor(mixed.r, mixed.g, mixed.b);
}

/** The line under the bonus while an effect is added: "CONSENSUS +399". */
function bonusStepText(name: string, points: bigint): string {
  return `${name.toUpperCase()} +${formatScore(points)}`;
}

type Piece =
  | Phaser.GameObjects.Text
  | Phaser.GameObjects.Container
  | Phaser.GameObjects.Graphics
  | Phaser.GameObjects.Image;

export function playRollBreakdown(
  scene: Phaser.Scene,
  breakdown: RollBreakdown,
  opts: RollBreakdownOptions,
): RollBreakdownView {
  const motion = fx.motion;
  const pace = Math.max(1, opts.pace ?? 1);
  // `scaled` is a written duration at the callout's speed; `ms` is the same
  // for the sequence's delays, which collapse to nothing when motion is off.
  const scaled = (value: number) => (value * TIME_SCALE) / pace;
  const ms = (value: number) => (motion ? scaled(value) : 0);
  const { x, fontSize, rowStep } = opts;

  const pieces: Piece[] = [];
  const text = (
    y: number,
    message: string,
    color: string,
    size: number,
  ): Phaser.GameObjects.Text => {
    const piece = opts.add(
      scene.add
        .text(x, y, message, {
          fontFamily: SERIF,
          fontSize: `${Math.round(size)}px`,
          color,
          fontStyle: "bold",
          stroke: "#0d0a12",
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setDepth(51),
    );
    pieces.push(piece);
    return piece;
  };

  // --- lay every row out up front, hidden, so the panel can be sized once -----
  // Two rows at most: the dice, and every other effect's points as one bonus
  // that counts up effect by effect, the way the multiplier does, with the
  // effect being added named underneath.
  let y = opts.top;
  const sumRows: Phaser.GameObjects.Text[] = [];
  if (breakdown.dice > 0n) {
    sumRows.push(
      text(
        y,
        `${formatScore(breakdown.dice)} ${breakdown.dice === 1n ? "DIE" : "DICE"} SCORED`,
        CSS.ivory,
        fontSize,
      ),
    );
    y += rowStep;
  }
  const bonus = breakdown.subtotal - breakdown.dice;
  const bonusText = (points: bigint) => `+${formatScore(points)} BONUS`;
  let bonusRow: Phaser.GameObjects.Text | undefined;
  let bonusLabel: Phaser.GameObjects.Text | undefined;
  const labelSize = Math.min(fontSize * 0.82, rowStep * 0.62);
  if (bonus > 0n) {
    bonusRow = text(y, bonusText(bonus), CSS.goldLight, fontSize);
    sumRows.push(bonusRow);
    bonusLabel = text(y + rowStep * 0.75, "", CSS.parchment, labelSize);
    y += rowStep * BONUS_ROWS;
  }

  // Everything below the sum is measured in rows, so a column squeezed onto a
  // short screen keeps its proportions instead of overlapping itself.
  // A roll nothing multiplied has no multiplier to show, and no room is kept
  // for one: the total follows the sum directly.
  const multiplied = breakdown.steps.length > 0;
  const pillH = rowStep * 1.5;
  const multSize = pillH / 1.3;
  const pill = scene.add.graphics();
  const multText = scene.add
    .text(0, 0, "×1", {
      fontFamily: SERIF,
      fontSize: `${Math.round(multSize)}px`,
      color: CSS.ivory,
      fontStyle: "bold",
    })
    .setOrigin(0.5);
  const drawPill = () => {
    const w = Math.max(pillH * 1.6, multText.width + multSize * 1.1);
    pill.clear();
    pill.fillStyle(COLORS.waxRedDark, 1);
    pill.fillRoundedRect(-w / 2, -pillH / 2, w, pillH, pillH / 2);
    pill.lineStyle(2, COLORS.goldLight, 0.95);
    pill.strokeRoundedRect(-w / 2, -pillH / 2, w, pillH, pillH / 2);
  };
  const multRow = opts.add(
    scene.add.container(x, 0, [pill, multText]).setDepth(51),
  );
  const stepLabel = text(0, "", CSS.parchment, labelSize);

  const totalSize = Math.min(fontSize * 1.9, rowStep * 1.25);
  let totalY: number;
  if (multiplied) {
    y += sumRows.length > 0 ? rowStep * 0.4 : pillH / 2 - rowStep / 2;
    multRow.y = y;
    pieces.push(multRow);
    stepLabel.y = y + pillH / 2 + rowStep * 0.45;
    totalY = stepLabel.y + rowStep * 1.1;
  } else {
    multRow.destroy();
    pieces.splice(pieces.indexOf(stepLabel), 1);
    stepLabel.destroy();
    totalY = y + (sumRows.length > 0 ? rowStep * 0.3 : 0);
  }
  const total = text(
    totalY,
    `+${formatScore(breakdown.points)}`,
    CSS.goldLight,
    totalSize,
  );

  // The panel is as wide as the widest thing it will ever hold: every row, the
  // final multiplier, and the longest step name.
  const finalHundredths = multiplierHundredths(breakdown.multiplier);
  const finalFractional = breakdown.multiplier.den !== 1n;
  let widest = Math.max(total.width, ...sumRows.map((row) => row.width));
  if (bonusLabel) {
    for (const effect of breakdown.bonuses) {
      bonusLabel.setText(bonusStepText(effect.name, effect.points));
      widest = Math.max(widest, bonusLabel.width);
    }
    bonusLabel.setText("");
  }
  if (multiplied) {
    multText.setText(`×${formatHundredths(finalHundredths, finalFractional)}`);
    widest = Math.max(widest, multText.width + multSize * 1.1);
    for (const step of breakdown.steps) {
      stepLabel.setText(`${step.name.toUpperCase()} ${step.factor}`);
      widest = Math.max(widest, stepLabel.width);
    }
    stepLabel.setText("");
    multText.setText("×1");
    drawPill();
  }

  const padX = fontSize * 1.1;
  const padY = rowStep * 0.55;
  const panelW = Math.min(
    opts.maxWidth,
    Math.max(fontSize * 13, widest + padX * 2),
  );
  let panelTop = opts.top - rowStep / 2 - padY * 0.45;
  let panelBottom = totalY + rowStep * 0.75;
  // Laid out from `top`; a centred callout slides everything down (or up) so
  // the panel's middle lands on `centerY`.
  if (opts.centerY !== undefined) {
    const shift = opts.centerY - (panelTop + panelBottom) / 2;
    for (const piece of pieces) piece.y += shift;
    panelTop += shift;
    panelBottom += shift;
  }
  const panelH = panelBottom - panelTop;
  const panelCenterY = panelTop + panelH / 2;
  const panelRadius = Math.min(18, fontSize * 0.8);
  const panel = opts.add(scene.add.graphics().setDepth(50));
  // Redrawn rather than layered over: the acclaim below washes this same felt
  // gold and thickens this same border, so there is only ever one panel.
  const drawPanel = (
    fill: number,
    stroke: number,
    lineWidth: number,
    strokeAlpha: number,
  ) => {
    panel.clear();
    panel.fillStyle(fill, 0.93);
    panel.fillRoundedRect(
      x - panelW / 2,
      panelTop,
      panelW,
      panelH,
      panelRadius,
    );
    panel.lineStyle(lineWidth, stroke, strokeAlpha);
    panel.strokeRoundedRect(
      x - panelW / 2,
      panelTop,
      panelW,
      panelH,
      panelRadius,
    );
  };
  drawPanel(COLORS.feltDark, COLORS.gold, 1.5, 0.55);
  pieces.unshift(panel);

  // Anything wider than the panel (a very long card name) shrinks to fit.
  const room = panelW - padX;
  for (const piece of [...sumRows, total])
    if (piece.width > room) piece.setScale(room / piece.width);

  // Every scale animation returns to the piece's resting scale, recorded here.
  // Reading the live scale instead (as fx.punch does) compounds when a punch
  // lands on a piece still mid-punch, and a multiplier punched on every step
  // would swell across the screen.
  const restScale = new Map<Piece, number>();
  const rest = (piece: Piece) => restScale.get(piece) ?? piece.scale;

  // Only ever stop the callout's own tweens. `killTweensOf` would also stop a
  // tween someone else put on these pieces — the scene's slide-out moves every
  // display object and waits for each of those tweens to complete, so killing
  // one left a finished trial that never changed scene.
  const own = new Map<Piece, Phaser.Tweens.Tween[]>();
  const tween = (
    piece: Piece,
    config: Omit<Phaser.Types.Tweens.TweenBuilderConfig, "targets">,
  ) => {
    const made = scene.tweens.add({ ...config, targets: piece });
    own.set(piece, [...(own.get(piece) ?? []), made]);
    return made;
  };
  const stopOwn = (piece: Piece) => {
    for (const made of own.get(piece) ?? []) made.stop();
    own.delete(piece);
  };

  const punch = (piece: Piece, amount: number, duration: number) => {
    if (!motion) return;
    const base = rest(piece);
    restScale.set(piece, base);
    stopOwn(piece);
    piece.setScale(base);
    tween(piece, {
      scale: base * amount,
      duration: scaled(duration),
      yoyo: true,
      ease: "Quad.easeOut",
      onComplete: () => piece.setScale(base),
    });
  };

  // --- the sequence -------------------------------------------------------------
  const timers: Phaser.Time.TimerEvent[] = [];
  const at = (delay: number, run: () => void) => {
    if (delay <= 0) run();
    else timers.push(scene.time.delayedCall(delay, run));
  };

  // --- the acclaim --------------------------------------------------------------
  // A roll that met the trial's goal says so when its total lands: the felt
  // takes a gold wash, a ribbon rides the panel's top edge, and a halo pulses
  // out behind it. A goal met on the trial's *first* roll says it far louder —
  // a deeper wash, a seal turning in the panel's own background, a second ring,
  // and a flare that keeps pulsing for as long as the callout holds.
  //
  // Everything is built here, hidden, and pushed onto `pieces`, so the fade-out
  // carries it away with the rest of the callout and nothing outlives the roll.
  const acclaim = opts.acclaim;
  const grand = acclaim === "firstRoll";
  let seal: Phaser.GameObjects.Image | undefined;
  let halo: Phaser.GameObjects.Image | undefined;
  let ribbon: Phaser.GameObjects.Container | undefined;
  if (acclaim) {
    // The halo is circular and scaled uniformly: `fadeOut` restores a piece's
    // resting `scale`, which is one number, so a piece stretched to an ellipse
    // would snap square the moment it started to clear away.
    const haloSize = Math.hypot(panelW, panelH) * 1.15;
    halo = opts.add(
      scene.add
        .image(x, panelCenterY, "spark")
        .setDisplaySize(haloSize, haloSize)
        .setTint(COLORS.glow)
        .setAlpha(0)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(49.5),
    );
    pieces.push(halo);
    restScale.set(halo, halo.scale);

    if (grand) {
      // Sized against the panel's shorter side so the mark stays inside the
      // felt: the callout has no mask, and a seal spilling past the border
      // would read as a second object rather than as the panel's background.
      const sealSize = (Math.min(panelW, panelH) * 0.94) / SIGIL_INK_RADIUS;
      seal = opts.add(
        scene.add
          .image(x, panelCenterY, "sigil")
          .setDisplaySize(sealSize, sealSize)
          .setTint(COLORS.glow)
          .setAlpha(0)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(50.5),
      );
      pieces.push(seal);
      restScale.set(seal, seal.scale);
    }

    const plate = scene.add.graphics();
    const ribbonText = scene.add
      .text(0, 0, grand ? "FIRST ROLL CLEAR" : "GOAL MET", {
        fontFamily: SERIF,
        fontSize: `${Math.round(labelSize)}px`,
        color: grand ? CSS.ink : CSS.goldLight,
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    const ribbonH = labelSize * 1.8;
    const ribbonW = Math.min(
      panelW - fontSize,
      ribbonText.width + labelSize * 1.8,
    );
    // A long name on a narrow phone shrinks to fit rather than widening the
    // panel every row was already laid out against.
    if (ribbonText.width > ribbonW - labelSize)
      ribbonText.setScale((ribbonW - labelSize) / ribbonText.width);
    plate.fillStyle(grand ? COLORS.goldLight : COLORS.feltDark, 1);
    plate.fillRoundedRect(
      -ribbonW / 2,
      -ribbonH / 2,
      ribbonW,
      ribbonH,
      ribbonH / 2,
    );
    plate.lineStyle(grand ? 2.5 : 2, grand ? COLORS.glow : COLORS.gold, 0.95);
    plate.strokeRoundedRect(
      -ribbonW / 2,
      -ribbonH / 2,
      ribbonW,
      ribbonH,
      ribbonH / 2,
    );
    // Set on the panel's top border rather than inside it: the first row's
    // text starts barely half a row below `panelTop`, and a ribbon centred on
    // the edge would sit on top of it.
    ribbon = opts.add(
      scene.add
        .container(x, panelTop - ribbonH * 0.45, [plate, ribbonText])
        .setDepth(52)
        .setAlpha(0),
    );
    pieces.push(ribbon);
    restScale.set(ribbon, 1);
  }

  let celebrated = false;
  const celebrate = () => {
    if (!acclaim || celebrated) return;
    celebrated = true;
    drawPanel(
      goldWash(grand ? 0.26 : 0.11),
      grand ? COLORS.glow : COLORS.goldLight,
      grand ? 3.5 : 2.5,
      1,
    );
    total.setColor(grand ? CSS.glow : CSS.goldLight);
    if (ribbon) {
      ribbon.setAlpha(1);
      punch(ribbon, 1.22, 150);
    }
    // The ring and the sparks belong to the scene rather than to `pieces`: both
    // tear themselves down on their own clock, and a second destroy from the
    // fade-out would be destroying something already gone.
    const ring = fx.shockwave(
      scene,
      x,
      panelCenterY,
      panelW * 0.66,
      COLORS.glow,
      scaled(520),
    );
    if (ring) opts.add(ring);
    const sparks = fx.burst(scene, x, panelCenterY, {
      count: grand ? 44 : 18,
      tint: COLORS.glow,
      speed: grand ? 360 : 220,
      gravityY: 90,
      lifespan: scaled(grand ? 1100 : 700),
    });
    if (sparks) opts.add(sparks);
    if (!motion) {
      // Reduced motion still gets the gold, just none of the turning.
      halo?.setAlpha(grand ? 0.3 : 0.16);
      seal?.setAlpha(0.45);
      return;
    }
    if (halo)
      tween(halo, {
        alpha: { from: 0, to: grand ? 0.42 : 0.2 },
        duration: scaled(grand ? 420 : 320),
        yoyo: true,
        repeat: grand ? 3 : 1,
        ease: "Sine.easeInOut",
      });
    if (seal) {
      const base = rest(seal);
      tween(seal, {
        alpha: { from: 0, to: 0.55 },
        duration: scaled(520),
        ease: "Quad.easeOut",
      });
      tween(seal, {
        scale: { from: base * 0.55, to: base },
        duration: scaled(640),
        ease: "Back.easeOut",
      });
      tween(seal, {
        rotation: Math.PI * 2,
        duration: scaled(4200),
        repeat: -1,
        ease: "Linear",
      });
    }
    if (grand)
      at(scaled(260), () => {
        const second = fx.shockwave(
          scene,
          x,
          panelCenterY,
          panelW * 0.95,
          COLORS.goldLight,
          scaled(640),
        );
        if (second) opts.add(second);
      });
  };
  const reveal = (piece: Piece, delay: number, pop = true) => {
    piece.setAlpha(0);
    at(delay, () => {
      piece.setAlpha(1);
      if (!motion || !pop) return;
      const base = rest(piece);
      restScale.set(piece, base);
      piece.setScale(base * 0.82);
      tween(piece, {
        scale: base,
        duration: scaled(POP_MS),
        ease: "Back.easeOut",
      });
    });
  };

  reveal(panel, 0, false);
  let delay = 0;
  const rowGap = Math.min(90, 380 / Math.max(1, sumRows.length));
  sumRows.forEach((row, index) => reveal(row, ms(index * rowGap)));
  delay += sumRows.length * rowGap;

  // The bonus opens at +0 and adds each effect in turn.
  let countEvent: Phaser.Time.TimerEvent | undefined;
  // The bonus lands on its total, and the line under it keeps naming the last
  // (largest) effect added until the callout closes.
  const lastBonus = breakdown.bonuses[breakdown.bonuses.length - 1];
  const settleBonus = () => {
    bonusRow?.setText(bonusText(bonus));
    if (lastBonus)
      bonusLabel?.setText(bonusStepText(lastBonus.name, lastBonus.points));
  };
  const bonusGap = countPace(breakdown.bonuses.length).gap;
  const stepGap = countPace(breakdown.steps.length).gap;
  const transition = transitionMs(bonusGap, stepGap);
  if (bonusRow && bonusLabel && breakdown.bonuses.length > 0 && motion) {
    const row = bonusRow;
    const label = bonusLabel;
    row.setText(bonusText(0n));
    let shown = 0n;
    breakdown.bonuses.forEach((effect, index) => {
      at(ms(delay + index * bonusGap), () => {
        const from = shown;
        shown += effect.points;
        label.setText(bonusStepText(effect.name, effect.points));
        countEvent?.remove();
        countEvent = fx.countUp(
          scene,
          from,
          shown,
          Math.max(1, ms(bonusGap * 0.7)),
          (value) => row.setText(bonusText(value)),
        );
        punch(row, 1.1, 80);
        opts.onBonus?.(index);
      });
    });
    delay += breakdown.bonuses.length * bonusGap;
    at(ms(delay), () => {
      countEvent?.remove();
      settleBonus();
    });
    delay += transition * 0.3;
  }

  if (multiplied) {
    reveal(multRow, ms(delay));
    delay += transition * 0.7;
  }

  const showMultiplier = (hundredths: bigint, fractional: boolean) => {
    multText.setText(`×${formatHundredths(hundredths, fractional)}`);
    drawPill();
  };
  let shownHundredths = multiplierHundredths(ONE);
  // The line under the multiplier keeps naming the last step until the
  // callout closes, as the bonus's does.
  const lastStep = breakdown.steps[breakdown.steps.length - 1];
  const settleStep = () => {
    if (!lastStep) return;
    stepLabel
      .setText(`${lastStep.name.toUpperCase()} ${lastStep.factor}`)
      .setColor(lastStep.id === "penalty" ? CSS.red : CSS.parchment);
  };
  breakdown.steps.forEach((step, index) => {
    at(ms(delay + index * stepGap), () => {
      const from = shownHundredths;
      const to = multiplierHundredths(step.after);
      const fractional = step.after.num % step.after.den !== 0n;
      shownHundredths = to;
      stepLabel
        .setText(`${step.name.toUpperCase()} ${step.factor}`)
        .setColor(step.id === "penalty" ? CSS.red : CSS.parchment);
      countEvent?.remove();
      countEvent = fx.countUp(
        scene,
        from,
        to,
        Math.max(1, ms(stepGap * 0.7)),
        (value) => showMultiplier(value, fractional),
      );
      punch(multRow, to >= from ? 1.14 : 0.88, 80);
      opts.onStep?.(index);
    });
  });
  delay += breakdown.steps.length * stepGap;

  const totalAtMs = ms(delay + 80);
  reveal(total, totalAtMs);
  at(totalAtMs, () => {
    // Land exactly on the roll's multiplier, whatever a count was mid-way on.
    countEvent?.remove();
    settleBonus();
    if (multiplied) {
      showMultiplier(finalHundredths, finalFractional);
      settleStep();
    }
    punch(total, grand ? 1.5 : acclaim ? 1.34 : 1.2, acclaim ? 190 : 120);
    celebrate();
  });

  let fading = false;
  const fadeOut = (duration: number) => {
    if (fading) return;
    fading = true;
    for (const piece of pieces) {
      stopOwn(piece);
      piece.setScale(rest(piece));
      tween(piece, {
        y: piece.y - 24,
        alpha: 0,
        duration,
        ease: "Quad.easeIn",
        onComplete: () => piece.destroy(),
      });
    }
  };
  const holdMs = HOLD_AFTER_TOTAL_MS + (acclaim ? ACCLAIM_HOLD_MS[acclaim] : 0);
  at(totalAtMs + scaled(holdMs), () => fadeOut(scaled(FADE_MS)));

  return {
    bottomY: panelBottom + rowStep * 0.5,
    totalAtMs,
    closedAt: scene.time.now + totalAtMs + scaled(holdMs) + scaled(FADE_MS),
    hurry() {
      for (const timer of timers) timer.remove();
      countEvent?.remove();
      // Nothing to hurry once the scene has torn the callout down.
      if (fading || !panel.scene) return;
      settleBonus();
      if (multiplied) {
        showMultiplier(finalHundredths, finalFractional);
        settleStep();
      }
      // The halo and the seal are washes the acclaim fades in itself, so they
      // are left out of the settle below — shown at full opacity first, they
      // would flash white for the frame before `celebrate` tweened them from 0.
      const flare = new Set<Piece>();
      for (const piece of [halo, seal]) if (piece) flare.add(piece);
      for (const piece of pieces) {
        stopOwn(piece);
        if (!flare.has(piece)) piece.setAlpha(1);
      }
      // The gold and the ribbon land even on a callout the player skipped past:
      // the roll met the goal whether or not they waited to be told.
      celebrate();
      fadeOut(160);
    },
    destroy() {
      for (const timer of timers) timer.remove();
      countEvent?.remove();
      if (!panel.scene) return;
      for (const piece of pieces) {
        stopOwn(piece);
        piece.destroy();
      }
    },
  };
}
