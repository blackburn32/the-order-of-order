import { RunState } from "../state/RunState";
import {
  afflictionsFor,
  blocksGrowthPermanently,
  type AfflictionId,
} from "../systems/Afflictions";
import {
  BOON_RARITY_WEIGHTS,
  CURSE_DRAW_WEIGHT,
  MAX_CURSES_PER_OFFER_SET,
  RARITY_WEIGHTS,
  type RarityWeights,
} from "../config";
import {
  applyEffect,
  enforceGridCap,
  ITEMS,
  ItemDef,
  ItemTheme,
  PriceBand,
  Rarity,
  SHOPPING_CART_DISCOUNT_PERCENT,
  ShopItemId,
  StackPricing,
  afflictionOf,
  itemGrowsGrid,
  itemsInTheme,
} from "./Items";
import { addItemValue, ITEM_VALUE_KIND } from "./ItemValue";
import { spendGold } from "./Gold";

export type { Rarity, ShopItemId } from "./Items";

/** Every purchasable item id, in rough rarity/cost order. Used by the dev panel
 *  to grant any item on demand. */
export const ALL_SHOP_ITEM_IDS: ShopItemId[] = ITEMS.map((it) => it.id);

const BY_ID = new Map<ShopItemId, ItemDef>(ITEMS.map((it) => [it.id, it]));

export interface ShopOffer {
  id: ShopItemId;
  name: string;
  cost: number; // gold, after the run's discount items
  /** What the card would cost with no discount item owned — its band, the
   *  copies already bought and this appearance's market roll, unrounded. Kept
   *  on the offer so a discount card bought mid-visit can reprice the row it is
   *  standing in without rerolling anyone's market price. Absent only on offers
   *  restored from a checkpoint written before it existed. */
  listPrice?: number;
  priceBand: PriceBand;
  desc: string;
  rarity: Rarity;
  needsTarget: boolean; // player must pick a die (shrink, twin, loaded_die, wild_face)
  targetsSize: boolean; // that pick only names a die size, not one specific die
  targetCount?: number; // >1 for multi-pick items (grindstone)
  cursed: boolean; // carries a standing drawback — marked on the card
  /** The drawback itself, when there is one. The card is stamped with its seal,
   *  so the offer carries the id rather than making the shop look the item up
   *  again. Null on every ordinary card, and on the rare cursed card that
   *  inflicts its cost some way other than an affliction. */
  affliction: AfflictionId | null;
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

/** Shopping Cart's across-the-board discount, as the card promises it. */
const SHOPPING_CART_DISCOUNT = SHOPPING_CART_DISCOUNT_PERCENT / 100;
/** Pawnbroker's flat reduction, applied after every other adjustment. */
const PAWNBROKER_DISCOUNT = 2;

/** How many times Sealed Doors runs a purchased card's effects. */
const SEALED_DOORS_APPLICATIONS = 2;

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

/** An item's price for this exact shop visit before any discount card: its
 *  band, the copies already bought, and that appearance's market adjustment.
 *  Left unrounded so the discount pass rounds exactly once. */
function listPriceFor(
  def: ItemDef,
  state: RunState,
  marketFactor: number,
): number {
  // The standing drawback is the price of a cursed card.
  if (def.cursed) return 0;
  if (def.priceBand === "free") return 0;

  const market = Math.min(
    PRICE_VARIANCE_MAX,
    Math.max(PRICE_VARIANCE_MIN, marketFactor),
  );
  const copies = state.purchases[def.id] ?? 0;
  // Repeated multiplication rather than Math.pow. IEEE multiplication is exactly
  // specified and so agrees on every engine; Math.pow is only
  // implementation-approximated, and the two already part company by an ulp from
  // the fifth explosive copy on. `discountedPrice` then takes a ceiling of this,
  // so an ulp is a whole gold — a card one device can afford and another cannot.
  // `copies` is a single-digit number, so the loop costs nothing.
  const factor = STACK_FACTOR[def.stackPricing ?? "none"];
  let stack = 1;
  for (let copy = 0; copy < copies; copy++) stack *= factor;

  return PRICE_BANDS[def.priceBand] * stack * market;
}

/** Take the run's discount cards off a list price. Never drops below 1 gold —
 *  a card the player can take for nothing should be a Coupon Book moment, not a
 *  rounding artefact. A card that was already free stays free. */
export function discountedPrice(state: RunState, listPrice: number): number {
  if (listPrice <= 0) return 0;

  let price = listPrice;
  if (state.hasShoppingCart) price *= 1 - SHOPPING_CART_DISCOUNT;
  price = Math.ceil(price);
  if (state.hasPawnbroker) price -= PAWNBROKER_DISCOUNT;

  return Math.max(1, price);
}

/** Resolve an item's concrete gold price for this exact shop visit: its band,
 *  the copies already bought, that visit's market adjustment, and the two
 *  discount items. */
export function priceFor(
  def: ItemDef,
  state: RunState,
  marketFactor = 1,
): number {
  return discountedPrice(state, listPriceFor(def, state, marketFactor));
}

/** A concrete, state-resolved offer for one item (its dynamic description
 *  baked in), ready to render on a shop card. */
export function offerFor(
  id: ShopItemId,
  state: RunState,
  marketFactor = 1,
): ShopOffer {
  const def = BY_ID.get(id)!;
  const listPrice = listPriceFor(def, state, marketFactor);
  return {
    id: def.id,
    name: def.name,
    cost: discountedPrice(state, listPrice),
    listPrice,
    priceBand: def.priceBand,
    desc: typeof def.desc === "function" ? def.desc(state) : def.desc,
    rarity: def.rarity,
    needsTarget: def.needsTarget ?? false,
    targetsSize: def.targetsSize ?? false,
    targetCount: def.targetCount,
    cursed: def.cursed ?? false,
    affliction: afflictionOf(def),
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
  // A run that has frozen its grid for good (Locust Idol) is never offered a
  // card that only adds dice. Permanent, not live: a boss that blocks growth for
  // its own trial should not also reshape the shop the player visits before it.
  // Items.applyEffect gates the purchase itself on the same question, so what is
  // offered here is always what can actually be bought.
  const frozen = blocksGrowthPermanently(state);
  return (
    ITEMS.filter((it) => !frozen || !itemGrowsGrid(it))
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

/** Remove and return one id, weighting cursed cards below ordinary cards in
 * the same tier. The pool is mutated just like Array.splice so every reveal is
 * distinct. */
function takeWeighted(pool: ShopItemId[], rng: () => number): ShopItemId {
  const weights = pool.map((id) =>
    BY_ID.get(id)!.cursed ? CURSE_DRAW_WEIGHT : 1,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.min(rng(), 1 - Number.EPSILON) * total;
  let index = pool.length - 1;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll < 0) {
      index = i;
      break;
    }
  }
  return pool.splice(index, 1)[0];
}

function removeCurses(groups: Record<Rarity, ShopItemId[]>): void {
  for (const tier of Object.keys(groups) as Rarity[]) {
    groups[tier] = groups[tier].filter((id) => !BY_ID.get(id)!.cursed);
  }
}

function rollOffers(
  state: RunState,
  count: number,
  rng: () => number,
  weights: RarityWeights,
  includeTwoBricks: boolean,
  couponFreebieAvailable: boolean,
): ShopOffer[] {
  const eligibleIds = availableIds(state).filter(
    (id) => includeTwoBricks || id !== "extra_die",
  );
  const groups = groupByTier(eligibleIds);
  const chosen: ShopItemId[] = [];
  let cursesChosen = 0;

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
    const id = takeWeighted(pool, rng);
    chosen.push(id);
    if (BY_ID.get(id)!.cursed) {
      cursesChosen += 1;
      if (cursesChosen >= MAX_CURSES_PER_OFFER_SET) removeCurses(groups);
    }
  }

  const offers = chosen.map((id) => offerFor(id, state, rollMarketFactor(rng)));

  // A shop where nothing is affordable is a dead screen: guarantee the free
  // Two Bricks in that case ('extra_die' is always in the pool).
  if (
    offers.length > 0 &&
    offers.filter((o) => !o.cursed).every((o) => o.cost > state.gold) &&
    eligibleIds.includes("extra_die")
  ) {
    offers[offers.length - 1] = offerFor("extra_die", state);
  }

  if (couponFreebieAvailable) applyCouponFreebie(state, offers, rng);
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
  return rollOffers(state, count, rng, weights, true, true);
}

/** Rerolls never offer or inject Two Bricks. Otherwise a player can trade one
 *  gold for its free dice repeatedly by cycling the shop. Coupon Book follows
 *  an unclaimed freebie onto the new row, but cannot award another card after
 *  its freebie for this visit has been claimed. */
export function rerollShopOffers(
  state: RunState,
  count = 3,
  rng: () => number = Math.random,
  weights: RarityWeights = weightsFor(state),
  couponFreebieAvailable = true,
): ShopOffer[] {
  return rollOffers(state, count, rng, weights, false, couponFreebieAvailable);
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
    name: "Gathering Pack",
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
  return discountedPrice(state, pack.cost);
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
  let cursesChosen = 0;
  const take = (pool: ShopItemId[]): void => {
    const id = takeWeighted(pool, rng);
    chosen.push(id);
    if (BY_ID.get(id)!.cursed) cursesChosen += 1;
  };
  const uncursedOnly = (pool: ShopItemId[]): void => {
    if (cursesChosen < MAX_CURSES_PER_OFFER_SET) return;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (BY_ID.get(pool[i])!.cursed) pool.splice(i, 1);
    }
  };
  if (pack.rarity) {
    while (chosen.length < count && ids.length > 0) {
      uncursedOnly(ids);
      if (ids.length === 0) break;
      take(ids);
    }
  } else {
    const groups = groupByTier(ids);
    while (chosen.length < count) {
      if (cursesChosen >= MAX_CURSES_PER_OFFER_SET) removeCurses(groups);
      const tier = rollTier(rng, weights);
      let pool: ShopItemId[] | undefined;
      for (const fallback of TIER_FALLBACK[tier]) {
        if (groups[fallback].length > 0) {
          pool = groups[fallback];
          break;
        }
      }
      if (!pool) break;
      take(pool);
    }
  }
  // A late-run category can be depleted by unique purchases between the shop
  // opening and the pack being bought. Keep the pack's promised reveal count
  // by filling any empty seats from the full legal pool; the named category
  // still receives every available seat first.
  const fallbackIds = availableIds(state).filter((id) => !chosen.includes(id));
  const fallbackGroups = groupByTier(fallbackIds);
  while (chosen.length < count) {
    if (cursesChosen >= MAX_CURSES_PER_OFFER_SET) removeCurses(fallbackGroups);
    const tier = rollTier(rng, weights);
    let pool: ShopItemId[] | undefined;
    for (const fallback of TIER_FALLBACK[tier]) {
      if (fallbackGroups[fallback].length > 0) {
        pool = fallbackGroups[fallback];
        break;
      }
    }
    if (!pool) break;
    take(pool);
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

/** Cards that change what everything else on the shelf costs. Buying one of
 *  these reprices the row it was taken from. */
const DISCOUNT_ITEM_IDS: ReadonlySet<ShopItemId> = new Set<ShopItemId>([
  "shopping_cart",
  "pawnbroker",
]);

/** Whether buying this card changes the price of the cards beside it. */
export function discountsShopPrices(id: ShopItemId): boolean {
  return DISCOUNT_ITEM_IDS.has(id);
}

/** Re-apply the run's discount cards to a row that was priced before one of
 *  them was bought. Newly rolled offers already receive the discount through
 *  `priceFor`; this keeps the rest of the current row in sync without rerolling
 *  its market prices. Recomputing from each card's list price rather than
 *  shaving the shown cost makes the call idempotent and order-independent: a
 *  Pawnbroker bought after a Shopping Cart lands on the same price as the other
 *  way round. A card that is already free — a free band, a Coupon Book freebie
 *  — stays free. */
export function repriceOffers(state: RunState, offers: ShopOffer[]): void {
  for (const offer of offers) {
    if (offer.cost === 0) continue;
    // A checkpoint written before offers carried a list price only has the
    // discounted cost to go on; treating it as the list price re-charges an
    // already-applied discount, which is the cheap end of being wrong.
    offer.cost = discountedPrice(state, offer.listPrice ?? offer.cost);
  }
}

export function canAfford(state: RunState, offer: ShopOffer): boolean {
  return state.gold >= offer.cost;
}

/** How many more cards this visit may take, given the purchases already made.
 *  Unlimited (Infinity) unless an affliction says otherwise — Sealed Doors
 *  allows exactly one. */
export function purchasesRemaining(
  state: RunState,
  purchasesMade: number,
): number {
  return afflictionsFor(state).purchaseLimit - purchasesMade;
}

/** Whether an affliction has closed the counter for the rest of this visit. */
export function shopClosed(state: RunState, purchasesMade: number): boolean {
  return purchasesRemaining(state, purchasesMade) <= 0;
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
  const diceBefore = state.dice.summarize();
  const sealsBefore = new Set(state.royalSealSizes);
  const rollsBefore = state.bonusRollsThisRound + state.bonusRollsPerRound;
  const scoringNumbersBefore = state.scoringNumbers.length;
  const goldBefore = state.gold;
  const sealedBeforePurchase = state.hasSealedDoors;
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

  // Sealed Doors buys one card a shop and takes it twice. The second pass is a
  // bonus rather than part of the purchase: an effect with nothing left to do —
  // a flag already set, a die already at the floor of the ladder — leaves the
  // card bought and paid for rather than failing the sale. It is also why the
  // card wants a stacking build; a shelf of one-time flags gains nothing here.
  const applications = state.hasSealedDoors ? SEALED_DOORS_APPLICATIONS : 1;
  for (let pass = 1; pass < applications; pass++) {
    for (const effect of def.effects) applyEffect(state, effect, ctx);
  }

  if (def.unique && !state.ownedUnique.includes(def.id))
    state.ownedUnique.push(def.id);
  // A unique card is recorded once however many times its effects ran — it is
  // one card on the shelf. A stacking card records every application, so its
  // rising price and its "one more copy buys you this" line both stay honest.
  state.purchases[def.id] =
    (state.purchases[def.id] ?? 0) + (def.unique ? 1 : applications);
  const kind = ITEM_VALUE_KIND[def.id];
  if (kind === "diceAdded")
    addItemValue(state, def.id, state.dice.length - stackTotal(diceBefore));
  else if (kind === "diceModified") {
    const transformed = changedDiceCount(diceBefore, state.dice.summarize());
    let newlySealed = 0;
    for (const sides of state.royalSealSizes)
      if (!sealsBefore.has(sides)) newlySealed += state.dice.countOfSize(sides);
    addItemValue(state, def.id, Math.max(transformed, newlySealed));
  } else if (kind === "rollsAdded") {
    addItemValue(
      state,
      def.id,
      state.bonusRollsThisRound + state.bonusRollsPerRound - rollsBefore,
    );
  } else if (kind === "scoringNumbersAdded") {
    addItemValue(
      state,
      def.id,
      state.scoringNumbers.length - scoringNumbersBefore,
    );
  } else if (kind === "goldReturned") {
    addItemValue(state, def.id, state.gold - goldBefore);
  }
  if (sealedBeforePurchase && def.id !== "sealed_doors")
    addItemValue(state, "sealed_doors", applications - 1);
  spendGold(state, offer.cost);
  // A card that grew the grid may have pushed it past a cap affliction; the
  // ceiling holds between rolls as well as during them.
  enforceGridCap(state);
  return true;
}

function stackKey(
  stack: ReturnType<RunState["dice"]["summarize"]>[number],
): string {
  return [
    stack.sides,
    stack.maxFaceBonus,
    stack.loaded ? 1 : 0,
    stack.wildFace ? 1 : 0,
    stack.source,
  ].join(":");
}

function stackTotal(stacks: ReturnType<RunState["dice"]["summarize"]>): number {
  return stacks.reduce((sum, stack) => sum + stack.count, 0);
}

/** Half the distribution distance is the number of dice whose size or aura
 * changed: a transformed die leaves one bucket and enters another. */
function changedDiceCount(
  before: ReturnType<RunState["dice"]["summarize"]>,
  after: ReturnType<RunState["dice"]["summarize"]>,
): number {
  const counts = new Map<string, number>();
  for (const stack of before)
    counts.set(
      stackKey(stack),
      (counts.get(stackKey(stack)) ?? 0) + stack.count,
    );
  for (const stack of after)
    counts.set(
      stackKey(stack),
      (counts.get(stackKey(stack)) ?? 0) - stack.count,
    );
  let distance = 0;
  for (const count of counts.values()) distance += Math.abs(count);
  return Math.floor(distance / 2);
}
