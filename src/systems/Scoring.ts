import { RunState } from '../state/RunState';

export interface RollResult {
  points: number;
  scoringIndices: number[];  // dice that matched a scoring number
  jackpotIndices: number[];  // rollplayer d20s that rolled 20 (+20 pts each)
}

/** Score the dice's current face values against the run's scoring numbers. */
export function scoreRoll(state: RunState): RollResult {
  const result: RollResult = { points: 0, scoringIndices: [], jackpotIndices: [] };
  state.dice.forEach((die, i) => {
    if (state.scoringNumbers.includes(die.value)) {
      result.points += 1 + state.extraPoints;
      result.scoringIndices.push(i);
    }
    if (die.rollplayer && die.value === 20) {
      result.points += 20;
      result.jackpotIndices.push(i);
    }
  });
  return result;
}
