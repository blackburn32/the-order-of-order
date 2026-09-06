import type { RunState } from "../state/RunState";
import type { ShopItemId } from "./Items";

/** The unit an item's lifetime analysis uses. One stable unit per item keeps
 * every badge and every overlaid run curve directly comparable. */
export type ItemValueKind =
  | "points"
  | "diceAdded"
  | "diceModified"
  | "scoringNumbersAdded"
  | "rollsAdded"
  | "goldReturned"
  | "choicesAdded"
  | "trialsSaved"
  | "bonusApplications";

export interface ItemPurchaseEvent {
  id: ShopItemId;
  /** Actual gold paid. A booster choice carries the price of its pack. */
  cost: number;
  /** Run-long trial on which the card was first/next taken. */
  trial: number;
}

/** Authored-mechanic -> payoff unit. Scoring flags and counters use the exact
 * point attribution already maintained by ItemPoints; everything else is
 * counted at the moment its concrete benefit occurs. */
export const ITEM_VALUE_KIND: Record<ShopItemId, ItemValueKind> = {
  extra_die: "diceAdded",
  extra_dice: "diceAdded",
  extra_point: "points",
  extra_number: "scoringNumbersAdded",
  mult2: "diceAdded",
  mult3: "diceAdded",
  shrink: "diceModified",
  rollplayer: "diceAdded",
  spike: "diceAdded",
  chip: "diceAdded",
  pocket_change: "points",
  whetstone: "diceModified",
  twin: "diceAdded",
  overtime: "rollsAdded",
  metronome: "rollsAdded",
  rain_check: "rollsAdded",
  downbeat: "points",
  crunch_time: "points",
  grindstone: "diceModified",
  loaded_die: "diceModified",
  snake_eyes: "points",
  ledger: "choicesAdded",
  amplifier: "points",
  refinement: "diceModified",
  wild_face: "diceModified",
  centurion: "diceAdded",
  vault: "goldReturned",
  double_the_fun: "diceAdded",
  dividend: "points",
  momentum: "points",
  keen_edge: "points",
  foundry: "diceAdded",
  jackpot: "points",
  last_call: "points",
  genesis: "diceAdded",
  reserve: "goldReturned",
  prism: "points",
  lucky_seven: "points",
  royal_seal: "diceModified",
  parade: "points",
  menagerie: "points",
  uniform: "points",
  hourglass: "points",
  insurance_policy: "trialsSaved",
  coupon_book: "goldReturned",
  dealers_bell: "goldReturned",
  shopping_cart: "goldReturned",
  brick_mold: "diceAdded",
  chip_mold: "diceAdded",
  spike_mold: "diceAdded",
  tithe_bowl: "goldReturned",
  lucky_coin: "goldReturned",
  counting_house: "goldReturned",
  deep_pockets: "goldReturned",
  prospector: "goldReturned",
  reliquary: "goldReturned",
  pawnbroker: "goldReturned",
  blood_price: "points",
  ouroboros: "points",
  famished_idol: "points",
  the_bloat: "points",
  iron_debt: "points",
  paupers_vow: "points",
  sealed_doors: "bonusApplications",
  devils_bargain: "goldReturned",
  leaden_dice: "points",
  locust_idol: "diceAdded",
  gamblers_curse: "points",
  the_reckoning: "points",
  hair_trigger: "points",
  long_night: "rollsAdded",
  tollkeeper: "points",
};

export interface ItemValueMeta {
  kind: ItemValueKind;
  badgeLabel: string;
  chartTitle: string;
  unit: string;
}

const META: Record<ItemValueKind, Omit<ItemValueMeta, "kind">> = {
  points: {
    badgeLabel: "Points contributed",
    chartTitle: "Cumulative points contributed",
    unit: "points",
  },
  diceAdded: {
    badgeLabel: "Dice added",
    chartTitle: "Cumulative dice added",
    unit: "dice",
  },
  diceModified: {
    badgeLabel: "Dice modified",
    chartTitle: "Cumulative dice modified",
    unit: "dice",
  },
  scoringNumbersAdded: {
    badgeLabel: "Scoring numbers added",
    chartTitle: "Cumulative scoring numbers added",
    unit: "numbers",
  },
  rollsAdded: {
    badgeLabel: "Rolls added",
    chartTitle: "Cumulative rolls added",
    unit: "rolls",
  },
  goldReturned: {
    badgeLabel: "Gold returned",
    chartTitle: "Cumulative gold returned",
    unit: "gold",
  },
  choicesAdded: {
    badgeLabel: "Extra choices shown",
    chartTitle: "Cumulative extra choices shown",
    unit: "choices",
  },
  trialsSaved: {
    badgeLabel: "Trials saved",
    chartTitle: "Cumulative trials saved",
    unit: "trials",
  },
  bonusApplications: {
    badgeLabel: "Bonus applications",
    chartTitle: "Cumulative bonus applications",
    unit: "effects",
  },
};

export function itemValueMeta(id: ShopItemId): ItemValueMeta {
  const kind = ITEM_VALUE_KIND[id];
  return { kind, ...META[kind] };
}

export function addItemValue(
  state: RunState,
  id: ShopItemId,
  amount: number,
): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  state.itemValues[id] = (state.itemValues[id] ?? 0) + amount;
}

export function recordRunItemPurchase(
  state: RunState,
  id: ShopItemId,
  cost: number,
): void {
  state.itemPurchases.push({
    id,
    cost: Number.isFinite(cost) ? Math.max(0, cost) : 0,
    trial: state.trial,
  });
}

function finiteBigintNumber(value: bigint): number {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : Number.MAX_VALUE;
}

/** The cumulative payoff at the current instant. Point items read the exact
 * attribution maps; mechanic-count items read their event counter. */
export function itemValueAt(state: RunState, id: ShopItemId): number {
  if (ITEM_VALUE_KIND[id] === "points") {
    return finiteBigintNumber(
      (state.dicePoints[id] ?? 0n) + (state.itemPoints[id] ?? 0n),
    );
  }
  return state.itemValues[id] ?? 0;
}

/** Compact per-roll map: only items that have appeared or paid out are kept. */
export function snapshotItemValues(
  state: RunState,
): Partial<Record<ShopItemId, number>> {
  const ids = new Set<ShopItemId>();
  for (const event of state.itemPurchases) ids.add(event.id);
  for (const id of Object.keys(state.itemValues) as ShopItemId[]) ids.add(id);
  for (const id of Object.keys(state.dicePoints) as ShopItemId[]) ids.add(id);
  for (const id of Object.keys(state.itemPoints) as ShopItemId[]) ids.add(id);
  const out: Partial<Record<ShopItemId, number>> = {};
  for (const id of ids) out[id] = itemValueAt(state, id);
  return out;
}
