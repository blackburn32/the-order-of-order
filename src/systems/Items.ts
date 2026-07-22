import { MAX_EXTRA_NUMBERS, roundTarget, WIN_ROUND } from '../config';
import { RunState } from '../state/RunState';
import { canLoad, canShrink, cloneDie, Die, DieOpts, DieSides, makeDie, shrinkDie } from './Dice';

export type ShopItemId =
  | 'extra_die'
  | 'extra_dice'
  | 'extra_point'
  | 'extra_number'
  | 'mult2'
  | 'mult3'
  | 'shrink'
  | 'rollplayer'
  | 'spike'
  | 'chip'
  | 'pocket_change'
  | 'whetstone'
  | 'twin'
  | 'overtime'
  | 'metronome'
  | 'grindstone'
  | 'loaded_die'
  | 'snake_eyes'
  | 'ledger'
  | 'amplifier'
  | 'refinement'
  | 'wild_face'
  | 'centurion'
  | 'vault'
  | 'double_the_fun'
  | 'dividend'
  | 'momentum'
  | 'keen_edge'
  | 'foundry'
  | 'jackpot'
  | 'last_call'
  | 'genesis'
  | 'reserve'
  | 'prism';

export type Rarity = 'common' | 'uncommon' | 'rare';

/** Boolean run flags an item can switch on (Snake Eyes, Ledger, etc.). */
type RunFlag = 'ownedLedger' | 'hasSnakeEyes' | 'hasAmplifier' | 'hasVault' | 'hasDoubleTheFun';

/** Integer run counters a repeatable item bumps on each purchase — its effect
 *  compounds with the count (see the stacking passives on RunState). */
type RunCounter =
  | 'dividend' | 'momentum' | 'keenEdge' | 'foundry' | 'jackpot'
  | 'genesis' | 'reserve' | 'prism' | 'lastCall';

/**
 * A persistent-unlock condition on an item. Items without one are available
 * from the start; those with one only enter the shop pool once the player has
 * met the criterion (checked against the live run — see `meetsCriterion` and
 * SaveData.evaluateAndUnlock). Add new kinds here as new unlocks are designed.
 */
export type UnlockCriterion =
  | { kind: 'diceInGrid'; count: number }   // more than `count` dice in the grid at once
  | { kind: 'winGame' }                     // clear the final round
  | { kind: 'reachRound'; round: number }   // reach at least this round
  | { kind: 'scoreInRound'; points: number } // score at least this many points in one round
  | { kind: 'diceOfSize'; sides: DieSides; count: number } // hold `count`+ dice of this size at once
  | { kind: 'scoreStreak'; count: number }  // score on `count` rolls in a row (one run)
  | { kind: 'sameFaceCount'; count: number } // show one face on `count`+ dice in a single roll
  | { kind: 'clutchClear' }                 // cross the target on a round's final roll
  | { kind: 'scoreVsTarget'; factor: number }; // reach `factor`× the current round's target

/**
 * The mutations an item can apply to the run. Items are composed from these
 * instead of each getting a bespoke branch — `applyEffect` is the one place
 * that knows how to carry each kind out.
 */
export type Effect =
  | { kind: 'addDice'; sides: DieSides; count: number; opts?: DieOpts }
  | { kind: 'addPoints'; amount: number }
  | { kind: 'extraPoint' }
  | { kind: 'extraNumber' }
  | { kind: 'multiplyDice'; factor: number }
  | { kind: 'shrinkTarget' }   // shrink the chosen die(s) — ctx.index or ctx.indices
  | { kind: 'shrinkRandom' }   // shrink one random shrinkable die
  | { kind: 'shrinkAll' }      // shrink every die one step
  | { kind: 'twinTarget' }     // duplicate the chosen die
  | { kind: 'loadTarget' }     // load the chosen die
  | { kind: 'wildTarget' }     // make the chosen die wild
  | { kind: 'bonusRollThisRound' }
  | { kind: 'bonusRollPerRound' }
  | { kind: 'setFlag'; flag: RunFlag }
  | { kind: 'incCounter'; counter: RunCounter };

/** Which die/dice a target-consuming effect should act on. `index` is a single
 *  chosen die (shrink, twin, loaded, wild); `indices` are the multi-pick dice
 *  (grindstone). */
export interface EffectContext {
  index?: number;
  indices?: number[];
}

// Effect constructors — small, so item definitions read as declarative lists.
const addDice = (sides: DieSides, count = 1, opts?: DieOpts): Effect => ({ kind: 'addDice', sides, count, opts });
const addPoints = (amount: number): Effect => ({ kind: 'addPoints', amount });
const extraPoint = (): Effect => ({ kind: 'extraPoint' });
const extraNumber = (): Effect => ({ kind: 'extraNumber' });
const multiplyDice = (factor: number): Effect => ({ kind: 'multiplyDice', factor });
const shrinkTarget = (): Effect => ({ kind: 'shrinkTarget' });
const shrinkRandom = (): Effect => ({ kind: 'shrinkRandom' });
const shrinkAll = (): Effect => ({ kind: 'shrinkAll' });
const twinTarget = (): Effect => ({ kind: 'twinTarget' });
const loadTarget = (): Effect => ({ kind: 'loadTarget' });
const wildTarget = (): Effect => ({ kind: 'wildTarget' });
const bonusRollThisRound = (): Effect => ({ kind: 'bonusRollThisRound' });
const bonusRollPerRound = (): Effect => ({ kind: 'bonusRollPerRound' });
const setFlag = (flag: RunFlag): Effect => ({ kind: 'setFlag', flag });
const incCounter = (counter: RunCounter): Effect => ({ kind: 'incCounter', counter });

export interface ItemDef {
  id: ShopItemId;
  name: string;
  cost: number;
  rarity: Rarity;
  /** Card text — a function when it depends on run state (e.g. Extra Number). */
  desc: string | ((state: RunState) => string);
  needsTarget?: boolean; // player must pick a die (shrink, twin, loaded_die, wild_face)
  targetCount?: number;  // >1 for multi-pick items (grindstone)
  /** Single-time item: a second copy would do nothing (boolean-flag items like
   *  Snake Eyes). Once purchased it's recorded in `state.ownedUnique` and no
   *  longer offered. */
  unique?: boolean;
  /** When present, the item only appears in the shop while this holds. */
  available?: (state: RunState) => boolean;
  /** When present, the item is hidden from the shop until the player has met
   *  this persistent-unlock condition (see `meetsCriterion`). */
  unlock?: UnlockCriterion;
  effects: Effect[];
}

/** Every item, in rough rarity/cost order. This array is the single source of
 *  truth: the shop's offer pool, the dev panel's grant list, and each item's
 *  effects all derive from it. */
export const ITEMS: ItemDef[] = [
  { id: 'extra_die', name: 'Extra Die', cost: 0, rarity: 'common',
    desc: 'Add one d6 to your grid.', effects: [addDice(6)] },
  { id: 'chip', name: 'Chip', cost: 0, rarity: 'uncommon',
    desc: 'Add a d2 to your grid.', effects: [addDice(2)] },
  { id: 'pocket_change', name: 'Pocket Change', cost: 0, rarity: 'common',
    desc: 'Gain 2 points immediately.', effects: [addPoints(2)] },
  { id: 'spike', name: 'Spike', cost: 1, rarity: 'common',
    desc: 'Add a d4 to your grid.', effects: [addDice(4)] },
  { id: 'shrink', name: 'Shrink Die', cost: 1, rarity: 'common',
    desc: 'Shrink a die of your choice one step.', needsTarget: true,
    available: (s) => s.dice.some(canShrink), effects: [shrinkTarget()] },
  { id: 'whetstone', name: 'Whetstone', cost: 1, rarity: 'common',
    desc: 'Shrink a random die one step.',
    available: (s) => s.dice.some(canShrink), effects: [shrinkRandom()] },
  { id: 'twin', name: 'Twin', cost: 1, rarity: 'common',
    desc: 'Duplicate a die of your choice, same size.', needsTarget: true,
    effects: [twinTarget()] },
  { id: 'overtime', name: 'Overtime', cost: 1, rarity: 'common',
    desc: 'Add one roll to this round only.', effects: [bonusRollThisRound()] },
  { id: 'extra_dice', name: 'Extra Dice', cost: 1, rarity: 'uncommon',
    desc: 'Add three d6 to your grid.', effects: [addDice(6, 3)] },
  { id: 'rollplayer', name: 'Rollplayer', cost: 1, rarity: 'uncommon',
    desc: 'Add a d20. Rolling a 20 on it grants 20 points.',
    effects: [addDice(20, 1, { maxFaceBonus: true })] },
  { id: 'mult2', name: 'Multiply Dice ×2', cost: 2, rarity: 'uncommon',
    desc: 'Duplicate every die in your grid.', effects: [multiplyDice(2)] },
  { id: 'metronome', name: 'Metronome', cost: 2, rarity: 'uncommon',
    desc: 'Add one permanent roll to every round.', effects: [bonusRollPerRound()] },
  { id: 'grindstone', name: 'Grindstone', cost: 2, rarity: 'uncommon',
    desc: 'Shrink three dice of your choice one step each.', needsTarget: true, targetCount: 3,
    available: (s) => s.dice.filter(canShrink).length >= 3, effects: [shrinkTarget()] },
  { id: 'loaded_die', name: 'Loaded Die', cost: 2, rarity: 'uncommon',
    desc: 'Choose a die. It never rolls its highest face.', needsTarget: true,
    available: (s) => s.dice.some(canLoad), effects: [loadTarget()] },
  { id: 'snake_eyes', name: 'Snake Eyes', cost: 2, rarity: 'uncommon', unique: true,
    desc: 'When 2+ dice show the same number, score that number (once per number).',
    effects: [setFlag('hasSnakeEyes')] },
  { id: 'ledger', name: 'Ledger', cost: 2, rarity: 'uncommon', unique: true,
    desc: 'The shop offers 4 cards from now on.',
    effects: [setFlag('ownedLedger')] },
  { id: 'extra_point', name: 'Extra Point', cost: 1, rarity: 'rare',
    desc: 'Each scoring die grants +1 more point.', effects: [extraPoint()] },
  { id: 'mult3', name: 'Multiply Dice ×3', cost: 3, rarity: 'rare',
    desc: 'Triple every die in your grid.', effects: [multiplyDice(3)] },
  { id: 'extra_number', name: 'Extra Number', cost: 3, rarity: 'rare',
    desc: (s) => `Dice showing ${2 + s.extraNumberCount} also score.`,
    available: (s) => s.extraNumberCount < MAX_EXTRA_NUMBERS, effects: [extraNumber()] },
  { id: 'amplifier', name: 'Amplifier', cost: 3, rarity: 'rare', unique: true,
    desc: 'Double all points earned from rolls.', effects: [setFlag('hasAmplifier')] },
  { id: 'refinement', name: 'Refinement', cost: 3, rarity: 'rare',
    desc: 'Shrink every die in your grid one step.',
    available: (s) => s.dice.some(canShrink), effects: [shrinkAll()] },
  { id: 'wild_face', name: 'Wild Face', cost: 3, rarity: 'rare',
    desc: 'Choose a die. It scores on every face.', needsTarget: true,
    effects: [wildTarget()] },
  { id: 'centurion', name: 'Centurion', cost: 3, rarity: 'rare',
    desc: 'Add a d100. Rolling its top face grants 100 points.',
    effects: [addDice(100, 1, { maxFaceBonus: true })] },
  { id: 'vault', name: 'Vault', cost: 3, rarity: 'rare', unique: true,
    desc: 'Keep 20% of your points (rounded down) when a round clears.',
    effects: [setFlag('hasVault')] },
  { id: 'double_the_fun', name: 'Double the Fun', cost: 1, rarity: 'uncommon', unique: true,
    desc: 'Whenever any die rolls a 6, add another copy of that die to your grid.',
    unlock: { kind: 'diceInGrid', count: 1000 },
    effects: [setFlag('hasDoubleTheFun')] },
  // --- Unlockable stacking passives ---------------------------------------
  { id: 'dividend', name: 'Dividend', cost: 1, rarity: 'common',
    desc: 'At the start of each round, gain 1 point for every 5 dice you own.',
    unlock: { kind: 'reachRound', round: 6 },
    effects: [incCounter('dividend')] },
  { id: 'momentum', name: 'Momentum', cost: 1, rarity: 'common',
    desc: 'Each consecutive roll that scores adds +1 to points earned; a scoreless roll resets it to 0.',
    unlock: { kind: 'scoreStreak', count: 12 },
    effects: [incCounter('momentum')] },
  { id: 'keen_edge', name: 'Keen Edge', cost: 1, rarity: 'common',
    desc: 'Each d1 scores +1 bonus when it scores (a d1 is worth 2).',
    unlock: { kind: 'diceOfSize', sides: 1, count: 10 },
    available: (s) => s.dice.some((d) => d.sides === 1),
    effects: [incCounter('keenEdge')] },
  { id: 'foundry', name: 'Foundry', cost: 2, rarity: 'uncommon',
    desc: 'At the start of each round, add 3 copies of your smallest die.',
    unlock: { kind: 'diceInGrid', count: 29 },
    effects: [incCounter('foundry')] },
  { id: 'jackpot', name: 'Jackpot', cost: 2, rarity: 'uncommon',
    desc: 'When 4+ dice show the same face, score that face × the number of dice showing it (each face separately).',
    unlock: { kind: 'sameFaceCount', count: 6 },
    effects: [incCounter('jackpot')] },
  { id: 'last_call', name: 'Last Call', cost: 2, rarity: 'uncommon',
    desc: 'Points earned on the final roll of each round are tripled.',
    unlock: { kind: 'clutchClear' },
    effects: [incCounter('lastCall')] },
  { id: 'genesis', name: 'Genesis', cost: 3, rarity: 'rare',
    desc: 'Whenever a die scores, add a copy of that die to the grid (max +10 dice per roll).',
    unlock: { kind: 'reachRound', round: 10 },
    effects: [incCounter('genesis')] },
  { id: 'reserve', name: 'Reserve', cost: 3, rarity: 'rare',
    desc: 'Keep 50% of your points (rounded down) when a round clears.',
    unlock: { kind: 'scoreVsTarget', factor: 2 },
    effects: [incCounter('reserve')] },
  { id: 'prism', name: 'Prism', cost: 3, rarity: 'rare',
    desc: 'Triple all points earned from rolls (multiplies with Amplifier).',
    unlock: { kind: 'winGame' },
    effects: [incCounter('prism')] }
];

/** Human-readable hint for a locked item's unlock condition (shown in the
 *  Items gallery under a still-locked card). */
export function describeCriterion(c: UnlockCriterion): string {
  switch (c.kind) {
    case 'diceInGrid':
      return `Locked — hold over ${c.count} dice in one run`;
    case 'winGame':
      return 'Locked — win a run';
    case 'reachRound':
      return `Locked — reach round ${c.round}`;
    case 'scoreInRound':
      return `Locked — score ${c.points} in a single round`;
    case 'diceOfSize':
      return `Locked — hold ${c.count} d${c.sides} at once`;
    case 'scoreStreak':
      return `Locked — score on ${c.count} rolls in a row`;
    case 'sameFaceCount':
      return `Locked — show the same number on ${c.count} dice in one roll`;
    case 'clutchClear':
      return 'Locked — clear a round on its final roll';
    case 'scoreVsTarget':
      return `Locked — reach ${c.factor}× the round's target score`;
  }
}

/** Past-tense description of the deed that just satisfied an unlock criterion,
 *  shown on the "New item unlocked" banner so the player knows what earned it.
 *  Where `describeCriterion` frames the condition as a still-locked goal, this
 *  frames it as an accomplishment. */
export function describeUnlockAction(c: UnlockCriterion): string {
  switch (c.kind) {
    case 'diceInGrid':
      return `Held over ${c.count} dice in one run`;
    case 'winGame':
      return 'Won a run';
    case 'reachRound':
      return `Reached round ${c.round}`;
    case 'scoreInRound':
      return `Scored ${c.points} in a single round`;
    case 'diceOfSize':
      return `Held ${c.count} d${c.sides} at once`;
    case 'scoreStreak':
      return `Scored on ${c.count} rolls in a row`;
    case 'sameFaceCount':
      return `Showed the same number on ${c.count} dice in one roll`;
    case 'clutchClear':
      return 'Cleared a round on its final roll';
    case 'scoreVsTarget':
      return `Reached ${c.factor}× the round's target score`;
  }
}

/** Whether the current run satisfies an unlock criterion. `roundScore` is the
 *  peak points reached within the current round (see RunState). */
export function meetsCriterion(c: UnlockCriterion, state: RunState): boolean {
  switch (c.kind) {
    case 'diceInGrid':
      return state.dice.length > c.count;
    case 'winGame':
      return state.round >= WIN_ROUND;
    case 'reachRound':
      return state.round >= c.round;
    case 'scoreInRound':
      return state.roundScore >= c.points;
    case 'diceOfSize':
      return state.dice.filter((d) => d.sides === c.sides).length >= c.count;
    case 'scoreStreak':
      return state.scoreStreak >= c.count;
    case 'sameFaceCount': {
      const counts = new Map<number, number>();
      for (const die of state.dice) counts.set(die.value, (counts.get(die.value) ?? 0) + 1);
      for (const n of counts.values()) if (n >= c.count) return true;
      return false;
    }
    case 'clutchClear':
      return state.clutchClear;
    case 'scoreVsTarget':
      return state.score >= c.factor * roundTarget(state.round);
  }
}

/**
 * Apply one effect to the run. Returns false if the effect couldn't be carried
 * out (e.g. a target die that can't shrink) — the caller aborts the purchase.
 */
export function applyEffect(state: RunState, effect: Effect, ctx: EffectContext): boolean {
  switch (effect.kind) {
    case 'addDice':
      for (let i = 0; i < effect.count; i++) state.dice.push(makeDie(effect.sides, effect.opts));
      return true;
    case 'addPoints':
      state.score += effect.amount;
      return true;
    case 'extraPoint':
      state.extraPoints += 1;
      return true;
    case 'extraNumber':
      if (state.extraNumberCount >= MAX_EXTRA_NUMBERS) return false;
      state.extraNumberCount += 1;
      state.scoringNumbers.push(1 + state.extraNumberCount);
      return true;
    case 'multiplyDice': {
      const copies: Die[] = [];
      for (let f = 1; f < effect.factor; f++) copies.push(...state.dice.map(cloneDie));
      state.dice = state.dice.concat(copies);
      return true;
    }
    case 'shrinkTarget': {
      const indices = ctx.indices ?? (ctx.index !== undefined ? [ctx.index] : []);
      if (indices.length === 0) return false;
      for (const i of indices) {
        const die = state.dice[i];
        if (!die || !shrinkDie(die)) return false;
      }
      return true;
    }
    case 'shrinkRandom': {
      const shrinkable = state.dice.filter(canShrink);
      if (shrinkable.length === 0) return false;
      shrinkDie(shrinkable[Math.floor(Math.random() * shrinkable.length)]);
      return true;
    }
    case 'shrinkAll':
      state.dice.forEach((d) => shrinkDie(d));
      return true;
    case 'twinTarget': {
      const die = ctx.index !== undefined ? state.dice[ctx.index] : undefined;
      if (!die) return false;
      state.dice.push(cloneDie(die));
      return true;
    }
    case 'loadTarget': {
      const die = ctx.index !== undefined ? state.dice[ctx.index] : undefined;
      if (!die || !canLoad(die)) return false;
      die.loaded = true;
      return true;
    }
    case 'wildTarget': {
      const die = ctx.index !== undefined ? state.dice[ctx.index] : undefined;
      if (!die) return false;
      die.wildFace = true;
      return true;
    }
    case 'bonusRollThisRound':
      state.bonusRollsThisRound += 1;
      return true;
    case 'bonusRollPerRound':
      state.bonusRollsPerRound += 1;
      return true;
    case 'setFlag':
      state[effect.flag] = true;
      return true;
    case 'incCounter':
      state[effect.counter] += 1;
      return true;
  }
}

/**
 * Apply the round-start passives (Dividend income, Foundry dice) to the run and
 * return the number of dice added, so the caller can decide whether to re-lay
 * the grid. Called once as each round begins (see GameScene.afterRoll).
 */
export function applyRoundStart(state: RunState): number {
  if (state.dividend > 0) {
    state.score += state.dividend * Math.floor(state.dice.length / 5);
  }
  if (state.foundry > 0 && state.dice.length > 0) {
    const smallest = state.dice.reduce((m, d) => (d.sides < m.sides ? d : m));
    const copies: Die[] = [];
    for (let i = 0; i < 3 * state.foundry; i++) copies.push(cloneDie(smallest));
    state.dice.push(...copies);
    return copies.length;
  }
  return 0;
}
