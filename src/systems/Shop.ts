import { MAX_EXTRA_NUMBERS } from '../config';
import { RunState } from '../state/RunState';
import { canShrink, cloneDie, makeDie, shrinkDie } from './Dice';

export type ShopItemId =
  | 'extra_die'
  | 'extra_dice'
  | 'extra_point'
  | 'extra_number'
  | 'mult2'
  | 'mult3'
  | 'shrink'
  | 'rollplayer'
  | 'spike';

export interface ShopOffer {
  id: ShopItemId;
  name: string;
  cost: number;
  desc: string;
  needsTarget: boolean; // shrink asks the player to pick a die
}

function offerFor(id: ShopItemId, state: RunState): ShopOffer {
  switch (id) {
    case 'extra_die':
      return { id, name: 'Extra Die', cost: 0, desc: 'Add one d6 to your grid.', needsTarget: false };
    case 'extra_dice':
      return { id, name: 'Extra Dice', cost: 1, desc: 'Add three d6 to your grid.', needsTarget: false };
    case 'extra_point':
      return { id, name: 'Extra Point', cost: 1, desc: 'Each scoring die grants +1 more point.', needsTarget: false };
    case 'extra_number': {
      const next = 2 + state.extraNumberCount;
      return { id, name: 'Extra Number', cost: 3, desc: `Dice showing ${next} also score.`, needsTarget: false };
    }
    case 'mult2':
      return { id, name: 'Multiply Dice ×2', cost: 2, desc: 'Duplicate every die in your grid.', needsTarget: false };
    case 'mult3':
      return { id, name: 'Multiply Dice ×3', cost: 3, desc: 'Triple every die in your grid.', needsTarget: false };
    case 'shrink':
      return { id, name: 'Shrink Die', cost: 1, desc: 'Shrink a die of your choice one step.', needsTarget: true };
    case 'rollplayer':
      return { id, name: 'Rollplayer', cost: 1, desc: 'Add a d20. Rolling a 20 on it grants 20 points.', needsTarget: false };
    case 'spike':
      return { id, name: 'Spike', cost: 1, desc: 'Add a d4 to your grid.', needsTarget: false };
  }
}

function availableIds(state: RunState): ShopItemId[] {
  const ids: ShopItemId[] = ['extra_die', 'extra_dice', 'rollplayer', 'spike', 'mult2', 'mult3', 'extra_point'];
  if (state.extraNumberCount < MAX_EXTRA_NUMBERS) ids.push('extra_number');
  if (state.dice.some(canShrink)) ids.push('shrink');
  return ids;
}

/** Pick up to `count` distinct random offers valid for the current run state. */
export function rollShopOffers(state: RunState, count = 3, rng: () => number = Math.random): ShopOffer[] {
  const pool = availableIds(state);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const offers = pool.slice(0, count).map((id) => offerFor(id, state));

  // A shop where nothing is affordable is a dead screen: guarantee the free
  // Extra Die in that case ('extra_die' is always in the pool).
  if (
    offers.length > 0 &&
    offers.every((o) => o.cost > state.score) &&
    pool.includes('extra_die')
  ) {
    offers[offers.length - 1] = offerFor('extra_die', state);
  }

  return offers;
}

export function canAfford(state: RunState, offer: ShopOffer): boolean {
  return state.score >= offer.cost;
}

/**
 * Apply a purchased offer. Deducts the cost. For 'shrink', targetIndex must be
 * the index of the die to shrink. Returns false if the purchase was invalid.
 */
export function applyOffer(state: RunState, offer: ShopOffer, targetIndex?: number): boolean {
  if (!canAfford(state, offer)) return false;

  switch (offer.id) {
    case 'extra_die':
      state.dice.push(makeDie(6));
      break;
    case 'extra_dice':
      for (let i = 0; i < 3; i++) state.dice.push(makeDie(6));
      break;
    case 'extra_point':
      state.extraPoints += 1;
      break;
    case 'extra_number': {
      if (state.extraNumberCount >= MAX_EXTRA_NUMBERS) return false;
      state.extraNumberCount += 1;
      state.scoringNumbers.push(1 + state.extraNumberCount);
      break;
    }
    case 'mult2':
      state.dice = state.dice.concat(state.dice.map(cloneDie));
      break;
    case 'mult3':
      state.dice = state.dice.concat(state.dice.map(cloneDie), state.dice.map(cloneDie));
      break;
    case 'shrink': {
      const die = targetIndex !== undefined ? state.dice[targetIndex] : undefined;
      if (!die || !shrinkDie(die)) return false;
      break;
    }
    case 'rollplayer':
      state.dice.push(makeDie(20, true));
      break;
    case 'spike':
      state.dice.push(makeDie(4));
      break;
  }

  state.score -= offer.cost;
  return true;
}
