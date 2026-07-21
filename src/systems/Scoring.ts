import { COLORS } from '../art/palette';
import { RunState } from '../state/RunState';

/** How a scoring modifier surfaces itself as floating text:
 *  - `none`: no float of its own (it still feeds the grand total).
 *  - `aggregate`: one float showing the modifier's total (Snake Eyes, Jackpot).
 *  - `perDie`: a float at each die it hit (Windfall, showing that die's bonus). */
export type ScoreFloat = 'none' | 'aggregate' | 'perDie';

/** One source of points in a roll. The UI iterates these to flash dice and
 *  float text; the total is the sum of their `points` times any run multiplier.
 *  Adding a new scoring rule means pushing another modifier here, not adding a
 *  field to `RollResult` and threading it through the scene. */
export interface ScoreModifier {
  id: string;
  name: string;      // shown in float text, e.g. 'Jackpot', 'Snake Eyes'
  points: number;    // points contributed, before the run multiplier
  color: number;     // COLORS.* used to flash the dice it hit
  dice: number[];    // indices of dice this modifier flashes
  bigPulse: boolean; // stronger bounce on those dice (Jackpot)
  float: ScoreFloat;
}

export interface RollResult {
  points: number;              // grand total, after the run multiplier
  multiplier: number;          // run-wide multiplier applied (Amplifier -> 2)
  modifiers: ScoreModifier[];  // in flash order (scoring, Snake Eyes, Jackpot, Windfall, Momentum)
}

/** Options that vary a roll's scoring beyond the run state itself. */
export interface ScoreOpts {
  finalRoll?: boolean; // this is the last roll of the round (Last Call triples it)
}

/** Score the dice's current face values against the run's scoring numbers. */
export function scoreRoll(state: RunState, opts: ScoreOpts = {}): RollResult {
  const scoringDice: number[] = [];
  const windfallDice: number[] = [];
  let scoringPoints = 0;
  let windfallPoints = 0;

  state.dice.forEach((die, i) => {
    if (state.scoringNumbers.includes(die.value) || die.wildFace) {
      // Keen Edge: a scoring d1 is worth an extra point per copy owned.
      scoringPoints += 1 + state.extraPoints + (die.sides === 1 ? state.keenEdge : 0);
      scoringDice.push(i);
    }
    if (die.maxFaceBonus && die.value === die.sides) {
      windfallPoints += die.sides;
      windfallDice.push(i);
    }
  });

  const modifiers: ScoreModifier[] = [];

  if (scoringDice.length > 0) {
    modifiers.push({
      id: 'scoring', name: 'Scoring', points: scoringPoints,
      color: COLORS.glow, dice: scoringDice, bigPulse: false, float: 'none'
    });
  }

  // Snake Eyes: any face value shared by 2+ dice scores that value once per
  // roll, regardless of whether it's a scoring number. Every die showing a
  // matched value flashes for feedback.
  if (state.hasSnakeEyes) {
    const valueCounts = new Map<number, number>();
    for (const die of state.dice) {
      valueCounts.set(die.value, (valueCounts.get(die.value) ?? 0) + 1);
    }
    let bonus = 0;
    for (const [value, count] of valueCounts) {
      if (count >= 2) bonus += value;
    }
    if (bonus > 0) {
      const dice: number[] = [];
      state.dice.forEach((die, i) => {
        if ((valueCounts.get(die.value) ?? 0) >= 2) dice.push(i);
      });
      modifiers.push({
        id: 'snakeEyes', name: 'Snake Eyes', points: bonus,
        color: COLORS.glowGreen, dice, bigPulse: false, float: 'aggregate'
      });
    }
  }

  // Jackpot (item): any face shown by 4+ dice scores that face × the number of
  // dice showing it; each qualifying face adds separately, and the whole payout
  // scales with the number of Jackpot copies owned.
  if (state.jackpot > 0) {
    const valueCounts = new Map<number, number>();
    for (const die of state.dice) valueCounts.set(die.value, (valueCounts.get(die.value) ?? 0) + 1);
    let bonus = 0;
    for (const [value, count] of valueCounts) {
      if (count >= 4) bonus += value * count;
    }
    if (bonus > 0) {
      const dice: number[] = [];
      state.dice.forEach((die, i) => {
        if ((valueCounts.get(die.value) ?? 0) >= 4) dice.push(i);
      });
      modifiers.push({
        id: 'jackpot', name: 'Jackpot', points: bonus * state.jackpot,
        color: COLORS.goldLight, dice, bigPulse: true, float: 'aggregate'
      });
    }
  }

  // Windfall: a max-face-bonus die (Rollplayer, Centurion) that rolled its top
  // face scores its full size.
  if (windfallDice.length > 0) {
    modifiers.push({
      id: 'windfall', name: 'Windfall', points: windfallPoints,
      color: COLORS.goldLight, dice: windfallDice, bigPulse: true, float: 'perDie'
    });
  }

  // Momentum: track the consecutive-scoring-roll streak (always, for the unlock)
  // and, per copy owned, award the current streak length as bonus points. This
  // is the one place scoreRoll mutates state — it runs exactly once per roll.
  const rollScored = modifiers.some((m) => m.points > 0);
  state.scoreStreak = rollScored ? state.scoreStreak + 1 : 0;
  if (state.momentum > 0 && rollScored) {
    modifiers.push({
      id: 'momentum', name: 'Momentum', points: state.scoreStreak * state.momentum,
      color: COLORS.glowGreen, dice: scoringDice, bigPulse: false, float: 'aggregate'
    });
  }

  const subtotal = modifiers.reduce((sum, m) => sum + m.points, 0);
  // Amplifier ×2, Prism ×3 per copy, Last Call ×3 per copy on the final roll —
  // all compound into one run multiplier.
  const multiplier =
    (state.hasAmplifier ? 2 : 1) *
    3 ** state.prism *
    (opts.finalRoll ? 3 ** state.lastCall : 1);

  return { points: subtotal * multiplier, multiplier, modifiers };
}
