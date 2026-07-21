import { RunState } from '../state/RunState';
import { applyEffect, ITEMS, ItemDef, Rarity, ShopItemId } from './Items';
import { loadProgress } from './SaveData';

export type { Rarity, ShopItemId } from './Items';

/** Every purchasable item id, in rough rarity/cost order. Used by the dev panel
 *  to grant any item on demand. */
export const ALL_SHOP_ITEM_IDS: ShopItemId[] = ITEMS.map((it) => it.id);

const BY_ID = new Map<ShopItemId, ItemDef>(ITEMS.map((it) => [it.id, it]));

export interface ShopOffer {
  id: ShopItemId;
  name: string;
  cost: number;
  desc: string;
  rarity: Rarity;
  needsTarget: boolean;  // player must pick a die (shrink, twin, loaded_die, wild_face)
  targetCount?: number;  // >1 for multi-pick items (grindstone)
}

/** A concrete, state-resolved offer for one item (its dynamic description
 *  baked in), ready to render on a shop card. */
export function offerFor(id: ShopItemId, state: RunState): ShopOffer {
  const def = BY_ID.get(id)!;
  return {
    id: def.id,
    name: def.name,
    cost: def.cost,
    desc: typeof def.desc === 'function' ? def.desc(state) : def.desc,
    rarity: def.rarity,
    needsTarget: def.needsTarget ?? false,
    targetCount: def.targetCount
  };
}

function availableIds(state: RunState): ShopItemId[] {
  const unlocked = new Set(loadProgress().unlocked);
  return ITEMS
    // Criterion-gated items stay out of the pool until the player unlocks them.
    .filter((it) => !it.unlock || unlocked.has(it.id))
    .filter((it) => !(it.unique && state.ownedUnique.includes(it.id)))
    .filter((it) => it.available?.(state) ?? true)
    .map((it) => it.id);
}

const RARITY_WEIGHTS: [Rarity, number][] = [['common', 60], ['uncommon', 30], ['rare', 10]];

// If the tier a card rolled has nothing left to offer, fall back toward
// common first, then to whatever tier still has eligible items.
const TIER_FALLBACK: Record<Rarity, Rarity[]> = {
  common: ['common', 'uncommon', 'rare'],
  uncommon: ['uncommon', 'common', 'rare'],
  rare: ['rare', 'uncommon', 'common']
};

function rollTier(rng: () => number): Rarity {
  const r = rng() * 100;
  let cumulative = 0;
  for (const [tier, weight] of RARITY_WEIGHTS) {
    cumulative += weight;
    if (r < cumulative) return tier;
  }
  return 'rare';
}

function groupByTier(ids: ShopItemId[]): Record<Rarity, ShopItemId[]> {
  const groups: Record<Rarity, ShopItemId[]> = { common: [], uncommon: [], rare: [] };
  for (const id of ids) groups[BY_ID.get(id)!.rarity].push(id);
  return groups;
}

/** Pick up to `count` distinct random offers valid for the current run state,
 *  each card rolling its rarity tier independently against the 60/30/10
 *  weights and falling back to an adjacent tier if that tier is exhausted. */
export function rollShopOffers(state: RunState, count = 3, rng: () => number = Math.random): ShopOffer[] {
  const groups = groupByTier(availableIds(state));
  const chosen: ShopItemId[] = [];

  for (let c = 0; c < count; c++) {
    const rolledTier = rollTier(rng);
    let pool: ShopItemId[] | undefined;
    for (const tier of TIER_FALLBACK[rolledTier]) {
      if (groups[tier].length > 0) {
        pool = groups[tier];
        break;
      }
    }
    if (!pool) break; // nothing eligible left in any tier
    const idx = Math.floor(rng() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]);
  }

  const offers = chosen.map((id) => offerFor(id, state));

  // A shop where nothing is affordable is a dead screen: guarantee the free
  // Extra Die in that case ('extra_die' is always in the pool).
  if (
    offers.length > 0 &&
    offers.every((o) => o.cost > state.score) &&
    availableIds(state).includes('extra_die')
  ) {
    offers[offers.length - 1] = offerFor('extra_die', state);
  }

  return offers;
}

export function canAfford(state: RunState, offer: ShopOffer): boolean {
  return state.score >= offer.cost;
}

/**
 * Apply a purchased offer. Deducts the cost and runs each of the item's
 * effects in turn. `targetIndex` is the die index for single-target items
 * (shrink, twin, loaded_die, wild_face); `targetIndices` is the die indices
 * for multi-pick items (Grindstone). Returns false — without charging — if the
 * purchase was invalid (unaffordable, missing targets, or an effect that
 * couldn't be carried out).
 */
export function applyOffer(
  state: RunState,
  offer: ShopOffer,
  targetIndex?: number,
  targetIndices?: number[]
): boolean {
  if (!canAfford(state, offer)) return false;

  const def = BY_ID.get(offer.id)!;
  if (def.targetCount && def.targetCount > 1 && (!targetIndices || targetIndices.length < def.targetCount)) {
    return false;
  }

  const ctx = { index: targetIndex, indices: targetIndices };
  for (const effect of def.effects) {
    if (!applyEffect(state, effect, ctx)) return false;
  }

  if (def.unique && !state.ownedUnique.includes(def.id)) state.ownedUnique.push(def.id);
  state.purchases[def.id] = (state.purchases[def.id] ?? 0) + 1;
  state.score -= offer.cost;
  return true;
}
