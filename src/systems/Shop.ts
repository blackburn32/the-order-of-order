import { RunState } from "../state/RunState";
import { hardPriceMult, SHOP_ROLLS, survivalTarget } from "../config";
import {
  applyEffect,
  ITEMS,
  ItemDef,
  PriceBand,
  Rarity,
  ShopItemId,
  StackPricing,
} from "./Items";

export type { Rarity, ShopItemId } from "./Items";

/** Every purchasable item id, in rough rarity/cost order. Used by the dev panel
 *  to grant any item on demand. */
export const ALL_SHOP_ITEM_IDS: ShopItemId[] = ITEMS.map((it) => it.id);

const BY_ID = new Map<ShopItemId, ItemDef>(ITEMS.map((it) => [it.id, it]));

export interface ShopOffer {
  id: ShopItemId;
  name: string;
  cost: bigint;
  priceBand: PriceBand;
  desc: string;
  rarity: Rarity;
  needsTarget: boolean; // player must pick a die (shrink, twin, loaded_die, wild_face)
  targetCount?: number; // >1 for multi-pick items (grindstone)
  freeByCoupon?: boolean;
}

interface BandPricing {
  rateBps: bigint;
  minimum: bigint;
}

/** Price bands are deliberately independent of rarity. The rate is a share of
 *  the current round target in basis points (100 bps = 1%). */
export const PRICE_BANDS: Record<PriceBand, BandPricing> = {
  free: { rateBps: 0n, minimum: 0n },
  low: { rateBps: 300n, minimum: 1n },
  standard: { rateBps: 600n, minimum: 1n },
  strong: { rateBps: 1_000n, minimum: 2n },
  build: { rateBps: 1_500n, minimum: 3n },
};

const BASIS = 10_000n;
const LATE_SHOP_FACTOR = 7_500n; // 75% after roll 15: less useful life remains.
export const PRICE_VARIANCE_MIN_BPS = 7_500n;
export const PRICE_VARIANCE_MAX_BPS = 12_500n;

const STACK_FACTOR: Record<
  StackPricing,
  { numerator: bigint; denominator: bigint }
> = {
  none: { numerator: 1n, denominator: 1n },
  linear: { numerator: 135n, denominator: 100n },
  explosive: { numerator: 180n, denominator: 100n },
};

function ceilDiv(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

/** Round upward to a readable shop number without letting display rounding
 *  silently make an item cheaper than its balance price. */
function nicePrice(value: bigint): bigint {
  const step =
    value < 10n ? 1n : value < 100n ? 5n : value < 1_000n ? 25n : 100n;
  return ceilDiv(value, step) * step;
}

/** Resolve an item's concrete point price for this exact shop visit. Prices
 *  scale with the survival target, are 25% lower at the late checkpoint, and
 *  rise for repeat purchases according to the item's stacking behavior. */
export function priceFor(
  def: ItemDef,
  state: RunState,
  marketFactorBps: bigint = BASIS,
): bigint {
  const band = PRICE_BANDS[def.priceBand];
  if (def.priceBand === "free") return 0n;

  const timing = state.roll >= (SHOP_ROLLS[1] ?? 15) ? LATE_SHOP_FACTOR : BASIS;
  const market =
    marketFactorBps < PRICE_VARIANCE_MIN_BPS
      ? PRICE_VARIANCE_MIN_BPS
      : marketFactorBps > PRICE_VARIANCE_MAX_BPS
        ? PRICE_VARIANCE_MAX_BPS
        : marketFactorBps;
  let raw = ceilDiv(
    survivalTarget(state.round, state.hardMode) * band.rateBps * timing * market,
    BASIS * BASIS * BASIS,
  );

  // Hard Mode makes items relatively pricier: the price already rose with the
  // higher survival target above; this is the extra bump on top of that.
  if (state.hardMode) {
    raw = ceilDiv(raw * BigInt(Math.round(hardPriceMult() * 1000)), 1000n);
  }

  const copies = state.purchases[def.id] ?? 0;
  const factor = STACK_FACTOR[def.stackPricing ?? "none"];
  if (copies > 0 && factor.numerator !== factor.denominator) {
    raw = ceilDiv(
      raw * factor.numerator ** BigInt(copies),
      factor.denominator ** BigInt(copies),
    );
  }

  return nicePrice(raw > band.minimum ? raw : band.minimum);
}

/** A concrete, state-resolved offer for one item (its dynamic description
 *  baked in), ready to render on a shop card. */
export function offerFor(
  id: ShopItemId,
  state: RunState,
  marketFactorBps: bigint = BASIS,
): ShopOffer {
  const def = BY_ID.get(id)!;
  return {
    id: def.id,
    name: def.name,
    cost: priceFor(def, state, marketFactorBps),
    priceBand: def.priceBand,
    desc: typeof def.desc === "function" ? def.desc(state) : def.desc,
    rarity: def.rarity,
    needsTarget: def.needsTarget ?? false,
    targetCount: def.targetCount,
    freeByCoupon: false,
  };
}

/** Each appearance rolls a visible ±25% market adjustment in whole-percent
 *  steps. Price remains an imperfect signal of power without letting the noise
 *  overwhelm the item's strength band. */
function rollMarketFactor(rng: () => number): bigint {
  const percentSteps =
    Number((PRICE_VARIANCE_MAX_BPS - PRICE_VARIANCE_MIN_BPS) / 100n) + 1;
  return (
    PRICE_VARIANCE_MIN_BPS + BigInt(Math.floor(rng() * percentSteps)) * 100n
  );
}

function availableIds(state: RunState): ShopItemId[] {
  const unlocked = new Set(state.shopUnlocks);
  return (
    ITEMS
      // Criterion-gated items stay out of the pool unless they were unlocked
      // before this run began. Mid-run unlocks become eligible next run.
      .filter((it) => !it.unlock || unlocked.has(it.id))
      .filter((it) => !(it.unique && state.ownedUnique.includes(it.id)))
      .filter((it) => it.available?.(state) ?? true)
      .map((it) => it.id)
  );
}

const RARITY_WEIGHTS: [Rarity, number][] = [
  ["common", 60],
  ["uncommon", 30],
  ["rare", 10],
];

// If the tier a card rolled has nothing left to offer, fall back toward
// common first, then to whatever tier still has eligible items.
const TIER_FALLBACK: Record<Rarity, Rarity[]> = {
  common: ["common", "uncommon", "rare"],
  uncommon: ["uncommon", "common", "rare"],
  rare: ["rare", "uncommon", "common"],
};

function rollTier(rng: () => number): Rarity {
  const r = rng() * 100;
  let cumulative = 0;
  for (const [tier, weight] of RARITY_WEIGHTS) {
    cumulative += weight;
    if (r < cumulative) return tier;
  }
  return "rare";
}

function groupByTier(ids: ShopItemId[]): Record<Rarity, ShopItemId[]> {
  const groups: Record<Rarity, ShopItemId[]> = {
    common: [],
    uncommon: [],
    rare: [],
  };
  for (const id of ids) groups[BY_ID.get(id)!.rarity].push(id);
  return groups;
}

/** Pick up to `count` distinct random offers valid for the current run state,
 *  each card rolling its rarity tier independently against the 60/30/10
 *  weights and falling back to an adjacent tier if that tier is exhausted. */
export function rollShopOffers(
  state: RunState,
  count = 3,
  rng: () => number = Math.random,
): ShopOffer[] {
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

  const offers = chosen.map((id) => offerFor(id, state, rollMarketFactor(rng)));

  // A shop where nothing is affordable is a dead screen: guarantee the free
  // Two Bricks in that case ('extra_die' is always in the pool).
  if (
    offers.length > 0 &&
    offers.every((o) => o.cost > state.score) &&
    availableIds(state).includes("extra_die")
  ) {
    offers[offers.length - 1] = offerFor("extra_die", state);
  }

  applyCouponFreebie(state, offers, rng);
  return offers;
}

/** Make one uniformly random paid card free when Coupon Book is active. */
export function applyCouponFreebie(
  state: RunState,
  offers: ShopOffer[],
  rng: () => number = Math.random,
): void {
  if (!state.hasCouponBook) return;
  const paid = offers.filter((offer) => offer.cost > 0n);
  if (paid.length === 0) return;
  const chosen = paid[Math.floor(rng() * paid.length)];
  chosen.cost = 0n;
  chosen.freeByCoupon = true;
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
  targetIndices?: number[],
): boolean {
  if (!canAfford(state, offer)) return false;

  const def = BY_ID.get(offer.id)!;
  if (
    def.targetCount &&
    def.targetCount > 1 &&
    (!targetIndices || targetIndices.length < def.targetCount)
  ) {
    return false;
  }

  const ctx = { index: targetIndex, indices: targetIndices, source: def.id };
  for (const effect of def.effects) {
    if (!applyEffect(state, effect, ctx)) return false;
  }

  if (def.unique && !state.ownedUnique.includes(def.id))
    state.ownedUnique.push(def.id);
  state.purchases[def.id] = (state.purchases[def.id] ?? 0) + 1;
  state.score -= offer.cost;
  return true;
}
