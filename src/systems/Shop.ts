import { RunState } from "../state/RunState";
import {
  BOON_RARITY_WEIGHTS,
  RARITY_WEIGHTS,
  type RarityWeights,
} from "../config";
import {
  applyEffect,
  ITEMS,
  ItemDef,
  ItemTheme,
  PriceBand,
  Rarity,
  ShopItemId,
  StackPricing,
  itemsInTheme,
} from "./Items";

export type { Rarity, ShopItemId } from "./Items";

/** Every purchasable item id, in rough rarity/cost order. Used by the dev panel
 *  to grant any item on demand. */
export const ALL_SHOP_ITEM_IDS: ShopItemId[] = ITEMS.map((it) => it.id);

const BY_ID = new Map<ShopItemId, ItemDef>(ITEMS.map((it) => [it.id, it]));

export interface ShopOffer {
  id: ShopItemId;
  name: string;
  cost: number; // gold
  priceBand: PriceBand;
  desc: string;
  rarity: Rarity;
  needsTarget: boolean; // player must pick a die (shrink, twin, loaded_die, wild_face)
  targetCount?: number; // >1 for multi-pick items (grindstone)
  freeByCoupon?: boolean;
}

/**
 * Flat gold prices per strength band.
 *
 * Deliberately small, flat numbers rather than a share of the trial's goal:
 * gold is a separate currency from score, so it does not have to track the
 * exponential goal curve, and a player can learn what "8 gold" means once and
 * have it stay true for the whole run. Price bands remain independent of
 * rarity — rarity says how often a card shows up, the band says what it costs.
 */
export const PRICE_BANDS: Record<PriceBand, number> = {
  free: 0,
  low: 3,
  standard: 5,
  strong: 8,
  build: 12,
};

/** Each appearance rolls a visible ±25% market adjustment, so price stays an
 *  imperfect signal of power. */
export const PRICE_VARIANCE_MIN = 0.75;
export const PRICE_VARIANCE_MAX = 1.25;

/** Repeat-purchase surcharge per copy already owned. */
const STACK_FACTOR: Record<StackPricing, number> = {
  none: 1,
  linear: 1.35,
  explosive: 1.8,
};

/** Shopping Cart's across-the-board discount. */
const SHOPPING_CART_DISCOUNT = 0.15;
/** Pawnbroker's flat reduction, applied after every other adjustment. */
const PAWNBROKER_DISCOUNT = 2;

/** A reroll costs this, plus one more for each reroll already taken in the
 *  visit — cheap enough to use, expensive enough to be a real choice. */
export const REROLL_BASE_COST = 1;

export function rerollCost(rerollsThisVisit: number): number {
  return REROLL_BASE_COST + rerollsThisVisit;
}

/** Whether this shop visit's reroll is free (Dealer's Bell covers the first). */
export function rerollIsFree(
  state: RunState,
  rerollsThisVisit: number,
): boolean {
  return state.hasDealersBell && rerollsThisVisit === 0;
}

/** Resolve an item's concrete gold price for this exact shop visit: its band,
 *  the copies already bought, that visit's market adjustment, and the two
 *  discount items. Never drops below 1 gold for a non-free item — a card the
 *  player can take for nothing should be a Coupon Book moment, not a rounding
 *  artefact. */
export function priceFor(
  def: ItemDef,
  state: RunState,
  marketFactor = 1,
): number {
  if (def.priceBand === "free") return 0;

  const market = Math.min(
    PRICE_VARIANCE_MAX,
    Math.max(PRICE_VARIANCE_MIN, marketFactor),
  );
  const copies = state.purchases[def.id] ?? 0;
  const stack = Math.pow(STACK_FACTOR[def.stackPricing ?? "none"], copies);

  let price = PRICE_BANDS[def.priceBand] * stack * market;
  if (state.hasShoppingCart) price *= 1 - SHOPPING_CART_DISCOUNT;
  price = Math.ceil(price);
  if (state.hasPawnbroker) price -= PAWNBROKER_DISCOUNT;

  return Math.max(1, price);
}

/** A concrete, state-resolved offer for one item (its dynamic description
 *  baked in), ready to render on a shop card. */
export function offerFor(
  id: ShopItemId,
  state: RunState,
  marketFactor = 1,
): ShopOffer {
  const def = BY_ID.get(id)!;
  return {
    id: def.id,
    name: def.name,
    cost: priceFor(def, state, marketFactor),
    priceBand: def.priceBand,
    desc: typeof def.desc === "function" ? def.desc(state) : def.desc,
    rarity: def.rarity,
    needsTarget: def.needsTarget ?? false,
    targetCount: def.targetCount,
    freeByCoupon: false,
  };
}

/** ±25% in whole-percent steps, rolled fresh each time a card appears. */
function rollMarketFactor(rng: () => number): number {
  const steps = Math.round((PRICE_VARIANCE_MAX - PRICE_VARIANCE_MIN) * 100) + 1;
  return PRICE_VARIANCE_MIN + Math.floor(rng() * steps) / 100;
}

export function availableIds(state: RunState): ShopItemId[] {
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

/** The rarity odds this shop draws on. Clearing a Boss Trial buys one visit at
 *  the boosted table — the real reward for beating the boss. */
export function weightsFor(state: RunState): RarityWeights {
  return state.boonNextShop ? BOON_RARITY_WEIGHTS : RARITY_WEIGHTS;
}

// If the tier a card rolled has nothing left to offer, fall back toward
// common first, then to whatever tier still has eligible items.
const TIER_FALLBACK: Record<Rarity, Rarity[]> = {
  common: ["common", "uncommon", "rare"],
  uncommon: ["uncommon", "common", "rare"],
  rare: ["rare", "uncommon", "common"],
};

function rollTier(rng: () => number, weights: RarityWeights): Rarity {
  const total = weights.common + weights.uncommon + weights.rare;
  const r = rng() * total;
  if (r < weights.common) return "common";
  if (r < weights.common + weights.uncommon) return "uncommon";
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

function rollOffers(
  state: RunState,
  count: number,
  rng: () => number,
  weights: RarityWeights,
  includeTwoBricks: boolean,
): ShopOffer[] {
  const eligibleIds = availableIds(state).filter(
    (id) => includeTwoBricks || id !== "extra_die",
  );
  const groups = groupByTier(eligibleIds);
  const chosen: ShopItemId[] = [];

  for (let c = 0; c < count; c++) {
    const rolledTier = rollTier(rng, weights);
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
    offers.every((o) => o.cost > state.gold) &&
    eligibleIds.includes("extra_die")
  ) {
    offers[offers.length - 1] = offerFor("extra_die", state);
  }

  applyCouponFreebie(state, offers, rng);
  return offers;
}

/** Pick up to `count` distinct random offers valid for the current run state,
 *  each card rolling its rarity tier independently and falling back to an
 *  adjacent tier if that tier is exhausted. Initial shop rolls retain the
 *  free Two Bricks safety net. */
export function rollShopOffers(
  state: RunState,
  count = 3,
  rng: () => number = Math.random,
  weights: RarityWeights = weightsFor(state),
): ShopOffer[] {
  return rollOffers(state, count, rng, weights, true);
}

/** Rerolls never offer or inject Two Bricks. Otherwise a player can trade one
 *  gold for its free dice repeatedly by cycling the shop. */
export function rerollShopOffers(
  state: RunState,
  count = 3,
  rng: () => number = Math.random,
  weights: RarityWeights = weightsFor(state),
): ShopOffer[] {
  return rollOffers(state, count, rng, weights, false);
}

// ---- Booster packs --------------------------------------------------------

export type BoosterPackId =
  | "common_pack"
  | "uncommon_pack"
  | "rare_pack"
  | "swarm_pack"
  | "multiplier_pack"
  | "precision_pack"
  | "economy_pack"
  | "tempo_pack";

export interface BoosterPackDef {
  id: BoosterPackId;
  name: string;
  desc: string;
  cost: number;
  color: number;
  rarity?: Rarity;
  theme?: ItemTheme;
}

export interface BoosterOffer extends BoosterPackDef {
  sold: boolean;
}

/** Packs are priced below the strongest card they can contain, but above a
 * guaranteed cheap card: the player buys selection quality, not raw volume. */
export const BOOSTER_PACKS: readonly BoosterPackDef[] = [
  {
    id: "common_pack",
    name: "Common Parcel",
    desc: "Choose one Common card.",
    cost: 4,
    color: 0xa98b2b,
    rarity: "common",
  },
  {
    id: "uncommon_pack",
    name: "Uncommon Folio",
    desc: "Choose one Uncommon card.",
    cost: 6,
    color: 0x3569a9,
    rarity: "uncommon",
  },
  {
    id: "rare_pack",
    name: "Rare Reliquary",
    desc: "Choose one Rare card.",
    cost: 9,
    color: 0x763aa0,
    rarity: "rare",
  },
  {
    id: "swarm_pack",
    name: "Foundry Pack",
    desc: "Choose one grid-growth card.",
    cost: 6,
    color: 0x9b5a2d,
    theme: "swarm",
  },
  {
    id: "multiplier_pack",
    name: "Ritual Pack",
    desc: "Choose one multiplier card.",
    cost: 7,
    color: 0x7e315d,
    theme: "multiplier",
  },
  {
    id: "precision_pack",
    name: "Artificer's Pack",
    desc: "Choose one precision card.",
    cost: 6,
    color: 0x2f7770,
    theme: "precision",
  },
  {
    id: "economy_pack",
    name: "Treasury Pack",
    desc: "Choose one economy card.",
    cost: 6,
    color: 0x8a6f1d,
    theme: "economy",
  },
  {
    id: "tempo_pack",
    name: "Hourglass Pack",
    desc: "Choose one tempo card.",
    cost: 5,
    color: 0x526d93,
    theme: "tempo",
  },
];

export function boosterPrice(state: RunState, pack: BoosterPackDef): number {
  let discounted = state.hasShoppingCart
    ? Math.ceil(pack.cost * (1 - SHOPPING_CART_DISCOUNT))
    : pack.cost;
  if (state.hasPawnbroker) discounted -= PAWNBROKER_DISCOUNT;
  return Math.max(1, discounted);
}

function idsForPack(state: RunState, pack: BoosterPackDef): ShopItemId[] {
  const eligible = new Set(availableIds(state));
  const category = pack.rarity
    ? ITEMS.filter((item) => item.rarity === pack.rarity).map((item) => item.id)
    : itemsInTheme(pack.theme!);
  return category.filter((id) => eligible.has(id));
}

/** Two distinct sealed packs. A type needs enough live cards to honor the full
 * reveal count (five with Ledger), so a late-run shop never sells a half-empty
 * pack. Boss shops favor the two higher-rarity pack types. */
export function rollBoosterOffers(
  state: RunState,
  count = 2,
  boosted = state.boonNextShop,
  rng: () => number = Math.random,
): BoosterOffer[] {
  const pool = BOOSTER_PACKS.filter(
    (pack) => idsForPack(state, pack).length > 0,
  ).map((pack) => ({ pack, weight: pack.rarity === "rare" ? 0.7 : 1 }));
  if (boosted) {
    for (const entry of pool) {
      if (entry.pack.rarity === "rare") entry.weight *= 2.5;
      else if (entry.pack.rarity === "uncommon") entry.weight *= 1.7;
    }
  }
  const chosen: BoosterOffer[] = [];
  while (chosen.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = rng() * total;
    let index = 0;
    for (; index < pool.length - 1; index++) {
      roll -= pool[index].weight;
      if (roll < 0) break;
    }
    const [entry] = pool.splice(index, 1);
    chosen.push({ ...entry.pack, sold: false });
  }
  return chosen;
}

/** Reveal distinct, currently legal cards from a pack. Rarity packs are pure;
 * themed packs use the visit's rarity table inside their theme. */
export function openBooster(
  state: RunState,
  pack: BoosterPackDef,
  count = state.ownedLedger ? 5 : 3,
  rng: () => number = Math.random,
  weights: RarityWeights = weightsFor(state),
): ShopOffer[] {
  const ids = idsForPack(state, pack);
  const chosen: ShopItemId[] = [];
  if (pack.rarity) {
    while (chosen.length < count && ids.length > 0) {
      chosen.push(ids.splice(Math.floor(rng() * ids.length), 1)[0]);
    }
  } else {
    const groups = groupByTier(ids);
    while (chosen.length < count) {
      const tier = rollTier(rng, weights);
      let pool: ShopItemId[] | undefined;
      for (const fallback of TIER_FALLBACK[tier]) {
        if (groups[fallback].length > 0) {
          pool = groups[fallback];
          break;
        }
      }
      if (!pool) break;
      chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
  }
  // A late-run category can be depleted by unique purchases between the shop
  // opening and the pack being bought. Keep the pack's promised reveal count
  // by filling any empty seats from the full legal pool; the named category
  // still receives every available seat first.
  const fallbackIds = availableIds(state).filter((id) => !chosen.includes(id));
  const fallbackGroups = groupByTier(fallbackIds);
  while (chosen.length < count) {
    const tier = rollTier(rng, weights);
    let pool: ShopItemId[] | undefined;
    for (const fallback of TIER_FALLBACK[tier]) {
      if (fallbackGroups[fallback].length > 0) {
        pool = fallbackGroups[fallback];
        break;
      }
    }
    if (!pool) break;
    chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return chosen.map((id) => ({ ...offerFor(id, state), cost: 0 }));
}

/** Apply the chosen contents of a paid pack without charging for the card a
 * second time. */
export function applyBoosterChoice(
  state: RunState,
  offer: ShopOffer,
  targetIndex?: number,
  targetIndices?: number[],
): boolean {
  return applyOffer(
    state,
    { ...offer, cost: 0, freeByCoupon: false },
    targetIndex,
    targetIndices,
  );
}

/** Make one uniformly random paid card free when Coupon Book is active. */
export function applyCouponFreebie(
  state: RunState,
  offers: ShopOffer[],
  rng: () => number = Math.random,
): void {
  if (!state.hasCouponBook) return;
  const paid = offers.filter((offer) => offer.cost > 0);
  if (paid.length === 0) return;
  const chosen = paid[Math.floor(rng() * paid.length)];
  chosen.cost = 0;
  chosen.freeByCoupon = true;
}

/** Apply Pawnbroker to cards that were priced before it was purchased. Newly
 *  rolled offers already receive the discount through `priceFor`; this keeps
 *  the rest of the current row in sync without rerolling its market prices. */
export function discountOffersForPawnbroker(offers: ShopOffer[]): void {
  for (const offer of offers) {
    if (offer.cost === 0) continue;
    offer.cost = Math.max(1, offer.cost - PAWNBROKER_DISCOUNT);
  }
}

export function canAfford(state: RunState, offer: ShopOffer): boolean {
  return state.gold >= offer.cost;
}

/**
 * Apply a purchased offer. Deducts the gold and runs each of the item's
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
  state.gold -= offer.cost;
  return true;
}
