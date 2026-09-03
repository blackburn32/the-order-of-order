import { WIN_TRIAL } from "../config";
import type { RunState } from "../state/RunState";
import {
  AFFLICTIONS,
  scoringNumbersFor,
  type Affliction,
  type AfflictionId,
} from "../systems/Afflictions";
import { ITEMS, type Effect } from "../systems/Items";
import {
  FLAT_MULTIPLIERS,
  HAIR_TRIGGER_MULT,
  OUROBOROS_BONUS,
} from "../systems/Scoring";
import type { ShopOffer } from "../systems/Shop";
import { trialRollTarget } from "../systems/Trial";

const ITEM_BY_ID = new Map(ITEMS.map((def) => [def.id, def]));
const MIN_RETENTION = 0.05;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function trialsRemaining(state: RunState): number {
  return Math.max(0, WIN_TRIAL - state.trial);
}

function remainingShare(state: RunState): number {
  return trialsRemaining(state) / Math.max(1, WIN_TRIAL);
}

/** Expected share of the current grid that scores on one roll. This reads the
 * actual sizes and auras, so destructive curses are judged against the build
 * they would destroy rather than against an imaginary all-d6 grid. */
function scoringChance(
  state: RunState,
  extraNumbers = 0,
  forceLoaded = false,
): number {
  if (state.dice.length === 0) return 0;
  const numbers = new Set(scoringNumbersFor(state));
  for (let i = 0; i < extraNumbers; i++)
    numbers.add(2 + state.extraNumberCount + i);

  let expected = 0;
  for (const { die, count } of state.dice.groups()) {
    if (die.wildFace) {
      expected += count;
      continue;
    }
    const loaded = forceLoaded || die.loaded;
    const faces = loaded ? Math.max(1, die.sides - 2) : die.sides;
    let hits = 0;
    for (let face = 1; face <= faces; face++) {
      if (
        numbers.has(face) ||
        (state.royalSealSizes.includes(die.sides) && face === die.sides)
      )
        hits += 1;
    }
    expected += count * (hits / faces);
  }
  return clamp(expected / state.dice.length, 0, 1);
}

function positive(value: number): number {
  return Math.max(MIN_RETENTION, value);
}

/** Risk expressed as log-cost. Zero is harmless; larger values are worse.
 * Adding log-costs makes independent penalties compound, while letting exact
 * ratios such as a doubled goal remain exact. */
export function afflictionRisk(
  state: RunState,
  idOrAffliction: AfflictionId | Affliction,
): number {
  const a =
    typeof idOrAffliction === "string"
      ? AFFLICTIONS[idOrAffliction]
      : idOrAffliction;
  const budget = Math.max(1, trialRollTarget(state));
  const remaining = trialsRemaining(state);
  const future = remainingShare(state);
  const economyWeight = 0.2 + future * 0.8;
  const scoreChance = scoringChance(state);
  let risk = 0;

  if (a.goalMultMilli && a.goalMultMilli > 0)
    risk += Math.log(a.goalMultMilli / 1_000);

  if (a.rollDelta && a.rollDelta < 0) {
    const retained = Math.max(1, budget + a.rollDelta) / budget;
    risk -= Math.log(positive(retained));
  }

  if (a.dieBreakChance)
    risk += budget * scoreChance * clamp(a.dieBreakChance, 0, 1);
  if (a.defectChance)
    risk += budget * (1 - scoreChance) * clamp(a.defectChance, 0, 1);

  if (a.dudRollChance) risk -= Math.log(positive(1 - a.dudRollChance));
  if (a.deadDiceFraction) risk -= Math.log(positive(1 - a.deadDiceFraction));
  if (a.lateRollDeadFraction) {
    const retained =
      1 - (a.lateRollDeadFraction * Math.max(0, budget - 1)) / budget;
    risk -= Math.log(positive(retained));
  }

  if (a.gridCap && Number.isFinite(a.gridCap) && state.dice.length > a.gridCap)
    risk -= Math.log(positive(a.gridCap / state.dice.length));

  if (a.dieGrowthPerTrial) {
    const growableShare =
      state.dice
        .groups()
        .reduce(
          (sum, group) => sum + (group.die.sides > 1 ? group.count : 0),
          0,
        ) / Math.max(1, state.dice.length);
    risk += Math.min(
      2.5,
      remaining * a.dieGrowthPerTrial * growableShare * 0.045,
    );
  }

  if (a.blocksGrowth) {
    const gridPressure =
      state.dice.length < 100 ? 0.8 : state.dice.length < 500 ? 0.55 : 0.3;
    risk += future * gridPressure;
  }

  if (a.clearGoldMultMilli !== undefined) {
    const retained = a.clearGoldMultMilli / 1_000;
    risk -= Math.log(positive(retained)) * economyWeight;
  }
  if (a.goldCeiling !== undefined && Number.isFinite(a.goldCeiling)) {
    const immediate =
      state.gold > a.goldCeiling
        ? -Math.log(positive(a.goldCeiling / Math.max(1, state.gold)))
        : 0;
    risk += immediate + future * 0.18;
  }
  if (a.rollGoldCost) {
    const trialCost = budget * a.rollGoldCost;
    const retained = 1 - trialCost / Math.max(trialCost + 1, state.gold + 12);
    risk -= Math.log(positive(retained)) * economyWeight;
  }
  if (a.purchaseLimit !== undefined && Number.isFinite(a.purchaseLimit)) {
    const retained = Math.min(1, a.purchaseLimit / 2.25);
    risk -= Math.log(positive(retained)) * future;
  }

  if (a.bossModifierCount && a.bossModifierCount > 1) {
    const bossesRemaining = Math.ceil(remaining / 3);
    risk += (a.bossModifierCount - 1) * bossesRemaining * 0.1;
  }
  if (a.loadsAllDice) {
    const loadedChance = scoringChance(state, 0, true);
    const retained =
      scoreChance > 0 ? Math.min(1, loadedChance / scoreChance) : 1;
    risk -= Math.log(positive(retained));
    risk += 0.12;
  }
  if (a.halveMultiplier) {
    const hasMultiplier = FLAT_MULTIPLIERS.some(
      (multiplier) => state[multiplier.flag],
    );
    if (hasMultiplier) risk += Math.log(2);
  }
  if (a.suppress) {
    for (const bonus of a.suppress) {
      if (bonus === "extraPoint") risk += state.extraPoints > 0 ? 0.28 : 0.05;
      else if (bonus === "extraNumber")
        risk += state.extraNumberCount > 0 ? 0.3 : 0.05;
      else if (bonus === "keenEdge") risk += state.keenEdge > 0 ? 0.24 : 0.04;
      else
        risk +=
          state.hasSnakeEyes || state.jackpot > 0 || state.hasLuckySeven
            ? 0.24
            : 0.04;
    }
  }

  return Math.max(0, risk);
}

function countEffects(
  effects: readonly Effect[],
  kind: Effect["kind"],
): number {
  return effects.filter((effect) => effect.kind === kind).length;
}

function boonValue(state: RunState, offer: ShopOffer): number {
  const def = ITEM_BY_ID.get(offer.id);
  if (!def) return 1;
  let value = 1;

  const flat = FLAT_MULTIPLIERS.find(
    (multiplier) => multiplier.item === def.id,
  );
  if (flat) value *= Number(flat.mult);

  if (def.id === "ouroboros") {
    const base = Math.max(1, 1 + state.extraPoints);
    value *= (base + Number(OUROBOROS_BONUS)) / base;
  }

  const extraPoints = countEffects(def.effects, "extraPoint");
  if (extraPoints > 0)
    value *= (1 + state.extraPoints + extraPoints) / (1 + state.extraPoints);

  const extraNumbers = countEffects(def.effects, "extraNumber");
  if (extraNumbers > 0) {
    const before = scoringChance(state);
    const after = scoringChance(state, extraNumbers);
    value *= before > 0 ? after / before : 1;
  }

  for (const effect of def.effects) {
    if (effect.kind === "multiplyDice") value *= effect.factor;
    else if (effect.kind === "bonusRollPerRound")
      value *=
        (trialRollTarget(state) + (effect.count ?? 1)) / trialRollTarget(state);
    else if (effect.kind === "addGold") {
      const leverage = 0.5 + remainingShare(state) * 0.5;
      value *= 1 + (effect.amount / Math.max(20, state.gold + 20)) * leverage;
    } else if (effect.kind === "setFlag" && effect.flag === "hasHairTrigger") {
      const budget = Math.max(1, trialRollTarget(state));
      value *= (Number(HAIR_TRIGGER_MULT) + Math.max(0, budget - 1)) / budget;
    } else if (effect.kind === "setFlag" && effect.flag === "hasSealedDoors") {
      value *= 1 + remainingShare(state) * 0.65;
    }
  }

  return value;
}

/** What a cursed offer is worth to this run right now. Above 1 means the boon
 * outweighs the drawback; 1 is break-even. */
export function appraiseCurse(state: RunState, offer: ShopOffer): number {
  if (!offer.cursed || !offer.affliction) return 1;
  return (
    boonValue(state, offer) * Math.exp(-afflictionRisk(state, offer.affliction))
  );
}

/** Appetite 0 accepts only clear bargains; appetite 1 accepts anything that is
 * not actively suicidal. Values between them interpolate that threshold. */
export function curseThreshold(appetite: number): number {
  return 1.2 - clamp(appetite, 0, 1) * 0.65;
}

export function acceptsCurse(
  state: RunState,
  offer: ShopOffer,
  appetite: number,
): boolean {
  return (
    !offer.cursed || appraiseCurse(state, offer) >= curseThreshold(appetite)
  );
}
