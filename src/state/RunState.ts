import { Die, makeDie } from '../systems/Dice';

export interface RunState {
  round: number; // 1-based
  roll: number;  // rolls completed this round, 0..20
  score: number; // one pool: survival score AND shop currency
  dice: Die[];
  scoringNumbers: number[]; // starts [1]; Extra number adds 2,3,4,5,6
  extraPoints: number;      // +1 per stack each time a die scores
  extraNumberCount: number; // 0..5
  startedAt: number;        // epoch ms, for the Hall of High Scores
}

export function newRun(): RunState {
  return {
    round: 1,
    roll: 0,
    score: 0,
    dice: [makeDie(6)],
    scoringNumbers: [1],
    extraPoints: 0,
    extraNumberCount: 0,
    startedAt: Date.now()
  };
}

const KEY = 'run';

export function setRun(registry: Phaser.Data.DataManager, state: RunState): void {
  registry.set(KEY, state);
}

export function getRun(registry: Phaser.Data.DataManager): RunState {
  let state = registry.get(KEY) as RunState | undefined;
  if (!state) {
    state = newRun();
    registry.set(KEY, state);
  }
  return state;
}
