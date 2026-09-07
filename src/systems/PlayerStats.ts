// The player's lifetime record, folded one run at a time. Everything here is an
// aggregate over every run ever finished — unlike the Hall, which keeps only the
// best few entries, and unlike ItemAnalytics, which slices the same runs by the
// card that was carried through them.
//
// It is written once, by `recordRunEnd`, from the run that has just ended; a run
// abandoned mid-ladder counts exactly like one that was played out, because
// finalizeRun is the point at which the player stopped playing either way.
//
// Nothing is backfilled. Most of what a badge reports — ones rolled, gold spent,
// the grid's intake — was never recorded before this file existed, and the Hall
// only ever kept the best few entries, so any total reconstructed from the
// existing save would be a confident understatement of a number the player can
// check against their own memory. A record that starts at zero and is honest
// from there was chosen over one that starts wrong. An established player's
// first look at this screen is therefore all zeroes, by design.

import type { RunState } from "../state/RunState";
import type { RollSample } from "./RunHistory";

const KEY = "ooo_player_stats_v1";
/** Curves retained per metric — the same ten the item analysis keeps. */
const TOP_RUNS = 10;
/** Points per stored curve. Matches ItemAnalytics: enough to keep a long run's
 *  shape, few enough that thirty curves fit comfortably in one save. */
const CURVE_POINTS = 160;

/** The three series a run contributes, each ranked on its own final value. */
export type StatsMetric = "score" | "dice" | "gold";

export const STATS_METRICS: readonly StatsMetric[] = ["score", "dice", "gold"];

/** One run's shape in one metric, already thinned and in plain numbers. Scores
 *  past `Number.MAX_VALUE` are impossible in practice (a 300-digit run), but a
 *  non-finite conversion is clamped rather than stored, so a corrupt curve can
 *  never take the whole screen down. */
export interface StatsRunCurve {
  startedAt: number;
  won: boolean;
  rolls: number;
  final: number;
  values: number[];
}

export interface PlayerStats {
  runs: number;
  wins: number;
  goldEarned: number;
  goldSpent: number;
  cardsPurchased: number;
  onesRolled: number;
  /** Dice ever added to a grid, survivors and casualties alike. */
  diceCollected: number;
  rolls: number;
  /** Points across every run. Bigint for the same reason `totalScore` is. */
  points: bigint;
  best: Record<StatsMetric, StatsRunCurve[]>;
}

type SerializedPlayerStats = Omit<PlayerStats, "points"> & { points: string };

export function emptyPlayerStats(): PlayerStats {
  return {
    runs: 0,
    wins: 0,
    goldEarned: 0,
    goldSpent: 0,
    cardsPurchased: 0,
    onesRolled: 0,
    diceCollected: 0,
    rolls: 0,
    points: 0n,
    best: { score: [], dice: [], gold: [] },
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function validCurve(value: unknown): value is StatsRunCurve {
  if (!value || typeof value !== "object") return false;
  const curve = value as Partial<StatsRunCurve>;
  return (
    typeof curve.startedAt === "number" &&
    Number.isFinite(curve.startedAt) &&
    curve.startedAt > 0 &&
    typeof curve.won === "boolean" &&
    typeof curve.rolls === "number" &&
    Number.isInteger(curve.rolls) &&
    curve.rolls >= 0 &&
    typeof curve.final === "number" &&
    Number.isFinite(curve.final) &&
    curve.final >= 0 &&
    Array.isArray(curve.values) &&
    curve.values.length > 0 &&
    curve.values.every((n) => Number.isFinite(n) && n >= 0)
  );
}

function safeCurves(value: unknown): StatsRunCurve[] {
  return Array.isArray(value)
    ? value.filter(validCurve).slice(0, TOP_RUNS)
    : [];
}

/** Read the record, treating anything unreadable as a fresh one. A malformed
 *  save costs the player a screen of numbers, never a run. */
export function loadPlayerStats(): PlayerStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyPlayerStats();
    const parsed = JSON.parse(raw) as Partial<SerializedPlayerStats>;
    if (!parsed || typeof parsed !== "object") return emptyPlayerStats();
    const best = (parsed.best ?? {}) as Partial<
      Record<StatsMetric, StatsRunCurve[]>
    >;
    return {
      runs: nonNegative(parsed.runs),
      wins: nonNegative(parsed.wins),
      goldEarned: nonNegative(parsed.goldEarned),
      goldSpent: nonNegative(parsed.goldSpent),
      cardsPurchased: nonNegative(parsed.cardsPurchased),
      onesRolled: nonNegative(parsed.onesRolled),
      diceCollected: nonNegative(parsed.diceCollected),
      rolls: nonNegative(parsed.rolls),
      points: parseBigint(parsed.points),
      best: {
        score: safeCurves(best.score),
        dice: safeCurves(best.dice),
        gold: safeCurves(best.gold),
      },
    };
  } catch {
    return emptyPlayerStats();
  }
}

function parseBigint(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function savePlayerStats(stats: PlayerStats): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...stats, points: stats.points.toString() }),
    );
  } catch {
    // The record is supplemental; a storage ceiling must never lose the run.
  }
}

function finiteNumber(value: bigint): number {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : Number.MAX_VALUE;
}

/** One sample's value in each metric, so all three curves are read off the same
 *  timeline in one pass. */
function sampleValue(sample: RollSample, metric: StatsMetric): number {
  if (metric === "score") return finiteNumber(sample.score);
  if (metric === "dice") return sample.dice;
  return sample.gold;
}

/** Evenly-spaced indices covering the whole series, at most `CURVE_POINTS` of
 *  them — thinning rather than truncating, so a long run keeps its shape. */
function thinIndices(length: number): number[] {
  if (length <= CURVE_POINTS) return Array.from({ length }, (_, i) => i);
  const indices: number[] = [];
  for (let p = 0; p < CURVE_POINTS; p++)
    indices.push(Math.round((p * (length - 1)) / (CURVE_POINTS - 1)));
  return [...new Set(indices)];
}

function buildCurve(
  state: RunState,
  won: boolean,
  metric: StatsMetric,
  indices: number[],
  final: number,
): StatsRunCurve {
  const values = indices.map((index) =>
    sampleValue(state.rollHistory[index], metric),
  );
  // A run that recorded nothing — or one whose last sample predates its final
  // total — still ends where it actually ended.
  if (values.length === 0 || values[values.length - 1] !== final)
    values.push(final);
  return {
    startedAt: state.startedAt,
    won,
    rolls: state.rollsTaken,
    final,
    values,
  };
}

function fold(best: StatsRunCurve[], curve: StatsRunCurve): StatsRunCurve[] {
  const kept = [...best, curve].sort(
    (a, b) => b.final - a.final || b.startedAt - a.startedAt,
  );
  kept.length = Math.min(TOP_RUNS, kept.length);
  return kept;
}

/**
 * Fold one finished run into the lifetime record. Called by `recordRunEnd`
 * alongside the Hall entry and the per-item analysis, so the three always
 * describe the same set of runs.
 */
export function recordPlayerStatsRun(state: RunState, won: boolean): void {
  const stats = loadPlayerStats();
  stats.runs += 1;
  if (won) stats.wins += 1;
  stats.goldEarned += state.goldEarned;
  stats.goldSpent += state.goldSpent;
  stats.cardsPurchased += state.itemPurchases.length;
  stats.onesRolled += state.onesRolled;
  stats.diceCollected += state.dice.everAdded;
  stats.rolls += state.rollsTaken;
  stats.points += state.totalScore;

  const indices = thinIndices(state.rollHistory.length);
  const finals: Record<StatsMetric, number> = {
    score: finiteNumber(state.totalScore),
    dice: state.dice.length,
    gold: state.goldEarned,
  };
  for (const metric of STATS_METRICS) {
    stats.best[metric] = fold(
      stats.best[metric],
      buildCurve(state, won, metric, indices, finals[metric]),
    );
  }
  savePlayerStats(stats);
}

export function resetPlayerStats(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // non-fatal
  }
}
