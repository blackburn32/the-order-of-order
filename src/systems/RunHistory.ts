// The run's per-roll timeline: one sample per roll, from the run's first to its
// last, kept so the analysis screen can chart how a run actually unfolded rather
// than only where its points ended up. Written by the engine's `resolveRoll`, so
// the live game and the headless sim record the same series; persisted with the
// active run and with the Hall entry the run is filed under.

import type { RunState } from "../state/RunState";
import { snapshotItemValues } from "./ItemValue";

/** One roll's snapshot, taken after the roll has scored and the grid has grown,
 *  shrunk or been culled — the state the player is left looking at. */
export interface RollSample {
  /** The run-long trial number the roll belonged to (1-based). */
  trial: number;
  /** Cumulative points across the whole run so far (`RunState.totalScore`). */
  score: bigint;
  /** Dice in the pool once the roll's passives had run. */
  dice: number;
  /** Cumulative points credited to each item/source at this point in the run.
   *  Optional only for timelines written before item series were recorded. */
  pointsByItem?: Record<string, bigint>;
  /** Dice currently in the pool, grouped by the item/source that provided them.
   *  Optional only for timelines written before item series were recorded. */
  diceByItem?: Record<string, number>;
  /** Cumulative payoff in each item's authored analysis unit. */
  valueByItem?: Record<string, number>;
}

/**
 * Most samples a run keeps. A full ladder is under 400 rolls, so this only ever
 * binds on an endless run that refuses to die; past it the series is thinned
 * rather than truncated, so the chart keeps the shape of the whole run instead
 * of stopping partway through it.
 */
export const ROLL_HISTORY_CAP = 1024;

/**
 * Rolls between kept samples for a run that has taken `rollsTaken` of them: 1
 * until the cap is reached, then doubling. Derived rather than stored, so the
 * stride can never drift out of step with the series it describes.
 */
export function historyStride(rollsTaken: number): number {
  let stride = 1;
  while (Math.floor(rollsTaken / stride) + 1 > ROLL_HISTORY_CAP) stride *= 2;
  return stride;
}

function snapshot(state: RunState): RollSample {
  const pointsByItem: Record<string, bigint> = { ...state.dicePoints };
  for (const [id, points] of Object.entries(state.itemPoints))
    pointsByItem[id] = (pointsByItem[id] ?? 0n) + points;

  const diceByItem: Record<string, number> = {};
  for (const stack of state.dice.summarize())
    diceByItem[stack.source] = (diceByItem[stack.source] ?? 0) + stack.count;

  return {
    trial: state.trial,
    score: state.totalScore,
    dice: state.dice.length,
    pointsByItem,
    diceByItem,
    valueByItem: snapshotItemValues(state),
  };
}

/** The run's starting point — roll zero, no points, the starter grid. Called as
 *  a run begins so the curves rise from an origin rather than from wherever the
 *  first roll happened to land. */
export function seedRollHistory(state: RunState): void {
  state.rollsTaken = 0;
  state.rollHistory = [snapshot(state)];
}

/** Fold the roll just resolved into the run's timeline. */
export function recordRollSample(state: RunState): void {
  const history = state.rollHistory;
  const before = historyStride(state.rollsTaken);
  state.rollsTaken += 1;
  const stride = historyStride(state.rollsTaken);
  if (stride !== before) {
    // The cap has just been reached. Drop every other sample, so what is kept
    // is still one sample every `stride` rolls right back to the run's first —
    // evenly spaced, which is what lets the chart place a sample by its index.
    const kept = Math.floor((history.length - 1) / 2) + 1;
    for (let i = 1; i < kept; i++) history[i] = history[i * 2];
    history.length = kept;
  }
  if (state.rollsTaken % stride === 0) history.push(snapshot(state));
}

/** The persisted form: bigints do not survive JSON, and the keys are short
 *  because a long run writes hundreds of these into one save. */
export interface SerializedRollSample {
  t: number;
  s: string;
  d: number;
  /** Changes since the preceding sample. Delta encoding avoids repeating every
   *  item id hundreds of times in the active-run and Hall saves. */
  p?: Record<string, string>;
  i?: Record<string, number>;
  /** Delta-encoded authored payoff values. */
  v?: Record<string, number>;
}

export function serializeRollHistory(
  history: readonly RollSample[],
): SerializedRollSample[] {
  let previousPoints: Record<string, bigint> = {};
  let previousDice: Record<string, number> = {};
  let previousValues: Record<string, number> = {};
  return history.map((sample) => {
    const serialized: SerializedRollSample = {
      t: sample.trial,
      s: sample.score.toString(),
      d: sample.dice,
    };
    // Both maps are written together. Their absence is the backward-compatible
    // marker for an aggregate-only sample from the previous timeline format.
    if (sample.pointsByItem && sample.diceByItem) {
      serialized.p = bigintDeltas(previousPoints, sample.pointsByItem);
      serialized.i = numberDeltas(previousDice, sample.diceByItem);
      previousPoints = sample.pointsByItem;
      previousDice = sample.diceByItem;
    } else {
      previousPoints = {};
      previousDice = {};
    }
    if (sample.valueByItem) {
      serialized.v = numberDeltas(previousValues, sample.valueByItem);
      previousValues = sample.valueByItem;
    } else {
      previousValues = {};
    }
    return serialized;
  });
}

function bigintDeltas(
  before: Record<string, bigint>,
  after: Record<string, bigint>,
): Record<string, string> {
  const deltas: Record<string, string> = {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[id] ?? 0n) - (before[id] ?? 0n);
    if (delta !== 0n) deltas[id] = delta.toString();
  }
  return deltas;
}

function numberDeltas(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[id] ?? 0) - (before[id] ?? 0);
    if (delta !== 0) deltas[id] = delta;
  }
  return deltas;
}

/**
 * Rebuild a timeline from its persisted form. Anything malformed reads as "this
 * run has no timeline" rather than as a corrupt save: the chart is a nicety, and
 * losing it must never cost a player their run.
 */
export function hydrateRollHistory(value: unknown): RollSample[] {
  if (!Array.isArray(value)) return [];
  const history: RollSample[] = [];
  let pointsByItem: Record<string, bigint> = {};
  let diceByItem: Record<string, number> = {};
  let valueByItem: Record<string, number> = {};
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return [];
    const sample = raw as Partial<SerializedRollSample>;
    if (
      !Number.isInteger(sample.t) ||
      (sample.t as number) < 0 ||
      !Number.isFinite(sample.d) ||
      (sample.d as number) < 0 ||
      typeof sample.s !== "string" ||
      !/^\d+$/.test(sample.s)
    ) {
      return [];
    }
    const sampleOut: RollSample = {
      trial: sample.t as number,
      score: BigInt(sample.s),
      dice: sample.d as number,
    };

    const hasPoints = sample.p !== undefined;
    const hasDice = sample.i !== undefined;
    if (hasPoints !== hasDice) return [];
    if (hasPoints) {
      if (!plainRecord(sample.p) || !plainRecord(sample.i)) return [];
      const nextPoints = { ...pointsByItem };
      for (const [id, rawDelta] of Object.entries(sample.p!)) {
        if (!id || typeof rawDelta !== "string" || !/^-?\d+$/.test(rawDelta))
          return [];
        const value = (nextPoints[id] ?? 0n) + BigInt(rawDelta);
        if (value < 0n) return [];
        if (value === 0n) delete nextPoints[id];
        else nextPoints[id] = value;
      }
      const nextDice = { ...diceByItem };
      for (const [id, rawDelta] of Object.entries(sample.i!)) {
        if (!id || !Number.isInteger(rawDelta)) return [];
        const value = (nextDice[id] ?? 0) + rawDelta;
        if (value < 0) return [];
        if (value === 0) delete nextDice[id];
        else nextDice[id] = value;
      }
      pointsByItem = nextPoints;
      diceByItem = nextDice;
      sampleOut.pointsByItem = { ...pointsByItem };
      sampleOut.diceByItem = { ...diceByItem };
    } else {
      // A newer attributed sample after an old aggregate-only one is encoded
      // relative to an empty map, so reset the delta bases at the boundary.
      pointsByItem = {};
      diceByItem = {};
    }
    if (sample.v !== undefined) {
      if (!plainRecord(sample.v)) return [];
      const nextValues = { ...valueByItem };
      for (const [id, rawDelta] of Object.entries(sample.v)) {
        if (!id || !Number.isFinite(rawDelta) || !Number.isInteger(rawDelta))
          return [];
        const value = (nextValues[id] ?? 0) + rawDelta;
        if (!Number.isFinite(value) || value < 0) return [];
        if (value === 0) delete nextValues[id];
        else nextValues[id] = value;
      }
      valueByItem = nextValues;
      sampleOut.valueByItem = { ...valueByItem };
    } else {
      valueByItem = {};
    }
    history.push(sampleOut);
  }
  return history;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
