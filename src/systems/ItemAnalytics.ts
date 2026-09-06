import type { RunState } from "../state/RunState";
import type { ShopItemId } from "./Items";
import { itemValueAt, ITEM_VALUE_KIND } from "./ItemValue";

const KEY = "ooo_item_analysis_v1";
const TOP_RUNS = 10;
const CURVE_POINTS = 160;

export interface ItemRunCurve {
  startedAt: number;
  won: boolean;
  rolls: number;
  finalValue: number;
  trials: number[];
  values: number[];
}

export interface ItemLifetimeAnalysis {
  runs: number;
  wins: number;
  losses: number;
  /** Purchases observed since item analysis tracking was introduced. */
  purchases: number;
  goldSpent: number;
  totalValue: number;
  /** First pickup trial, one observation per run. */
  pickupTrials: Record<string, number>;
  /** Actual card selections in a run, not Sealed Doors applications. */
  purchasesPerRun: Record<string, number>;
  topRuns: ItemRunCurve[];
}

type ItemAnalyticsSave = Partial<Record<ShopItemId, ItemLifetimeAnalysis>>;

function empty(): ItemLifetimeAnalysis {
  return {
    runs: 0,
    wins: 0,
    losses: 0,
    purchases: 0,
    goldSpent: 0,
    totalValue: 0,
    pickupTrials: {},
    purchasesPerRun: {},
    topRuns: [],
  };
}

function loadAll(): ItemAnalyticsSave {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ItemAnalyticsSave;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function safeAnalysis(
  value: ItemLifetimeAnalysis | undefined,
): ItemLifetimeAnalysis {
  if (!value || typeof value !== "object") return empty();
  return {
    runs: nonNegative(value.runs),
    wins: nonNegative(value.wins),
    losses: nonNegative(value.losses),
    purchases: nonNegative(value.purchases),
    goldSpent: nonNegative(value.goldSpent),
    totalValue: nonNegative(value.totalValue),
    pickupTrials: histogram(value.pickupTrials),
    purchasesPerRun: histogram(value.purchasesPerRun),
    topRuns: Array.isArray(value.topRuns)
      ? value.topRuns.filter(validCurve).slice(0, TOP_RUNS)
      : [],
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function histogram(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value))
    if (/^\d+$/.test(key) && nonNegative(count) > 0)
      out[key] = Math.floor(nonNegative(count));
  return out;
}

function validCurve(value: unknown): value is ItemRunCurve {
  if (!value || typeof value !== "object") return false;
  const curve = value as Partial<ItemRunCurve>;
  return (
    typeof curve.startedAt === "number" &&
    Number.isFinite(curve.startedAt) &&
    curve.startedAt > 0 &&
    typeof curve.won === "boolean" &&
    typeof curve.rolls === "number" &&
    Number.isInteger(curve.rolls) &&
    curve.rolls >= 0 &&
    typeof curve.finalValue === "number" &&
    Number.isFinite(curve.finalValue) &&
    curve.finalValue >= 0 &&
    Array.isArray(curve.trials) &&
    Array.isArray(curve.values) &&
    curve.trials.length === curve.values.length &&
    curve.trials.every((n) => Number.isInteger(n) && n >= 1) &&
    curve.values.every((n) => Number.isFinite(n) && n >= 0)
  );
}

export function loadItemAnalysis(id: ShopItemId): ItemLifetimeAnalysis {
  return safeAnalysis(loadAll()[id]);
}

export function histogramMedian(
  values: Record<string, number>,
  discrete = false,
): number | undefined {
  const entries = Object.entries(values)
    .map(([value, count]) => ({ value: Number(value), count }))
    .filter((entry) => Number.isFinite(entry.value) && entry.count > 0)
    .sort((a, b) => a.value - b.value);
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  if (total <= 0) return undefined;
  const at = (target: number) => {
    let seen = 0;
    for (const entry of entries) {
      seen += entry.count;
      if (seen > target) return entry.value;
    }
    return entries[entries.length - 1].value;
  };
  const lower = at(Math.floor((total - 1) / 2));
  if (discrete) return lower;
  return (lower + at(Math.floor(total / 2))) / 2;
}

function bump(hist: Record<string, number>, value: number): void {
  const key = String(Math.max(0, Math.floor(value)));
  hist[key] = (hist[key] ?? 0) + 1;
}

function sampleValue(state: RunState, id: ShopItemId, index: number): number {
  const sample = state.rollHistory[index];
  const authored = sample.valueByItem?.[id];
  if (authored !== undefined) return authored;
  if (ITEM_VALUE_KIND[id] === "points") {
    const value = sample.pointsByItem?.[id] ?? 0n;
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : Number.MAX_VALUE;
  }
  return 0;
}

function thinIndices(length: number): number[] {
  if (length <= CURVE_POINTS) return Array.from({ length }, (_, i) => i);
  const indices: number[] = [];
  for (let p = 0; p < CURVE_POINTS; p++)
    indices.push(Math.round((p * (length - 1)) / (CURVE_POINTS - 1)));
  return [...new Set(indices)];
}

function buildCurve(
  state: RunState,
  id: ShopItemId,
  won: boolean,
): ItemRunCurve {
  const finalValue = itemValueAt(state, id);
  const indices = thinIndices(state.rollHistory.length);
  const trials = indices.map((index) => state.rollHistory[index].trial);
  const values = indices.map((index) => sampleValue(state, id, index));
  if (values.length === 0) {
    trials.push(state.trial);
    values.push(finalValue);
  } else if (values[values.length - 1] !== finalValue) {
    trials.push(state.trial);
    values.push(finalValue);
  }
  return {
    startedAt: state.startedAt,
    won,
    rolls: state.rollsTaken,
    finalValue,
    trials,
    values,
  };
}

/** Fold one completed run into compact lifetime aggregates and retain only the
 * ten strongest curves for each item. Runs where the item was never selected
 * do not enter its win/loss denominator or medians. */
export function recordItemAnalysisRun(state: RunState, won: boolean): void {
  if (state.itemPurchases.length === 0) return;
  const save = loadAll();
  const byItem = new Map<ShopItemId, typeof state.itemPurchases>();
  for (const purchase of state.itemPurchases) {
    const events = byItem.get(purchase.id) ?? [];
    events.push(purchase);
    byItem.set(purchase.id, events);
  }
  for (const [id, purchases] of byItem) {
    const stats = safeAnalysis(save[id]);
    const value = itemValueAt(state, id);
    stats.runs += 1;
    if (won) stats.wins += 1;
    else stats.losses += 1;
    stats.purchases += purchases.length;
    stats.goldSpent += purchases.reduce((sum, event) => sum + event.cost, 0);
    stats.totalValue = Math.min(Number.MAX_VALUE, stats.totalValue + value);
    bump(stats.pickupTrials, purchases[0].trial);
    bump(stats.purchasesPerRun, purchases.length);
    stats.topRuns.push(buildCurve(state, id, won));
    stats.topRuns.sort(
      (a, b) => b.finalValue - a.finalValue || b.startedAt - a.startedAt,
    );
    stats.topRuns.length = Math.min(TOP_RUNS, stats.topRuns.length);
    save[id] = stats;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    // Analysis is supplemental; a storage ceiling must never lose the run.
  }
}

export function resetItemAnalysis(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // non-fatal
  }
}
