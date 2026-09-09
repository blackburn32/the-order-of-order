import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Preferences } from "@capacitor/preferences";
import type Phaser from "phaser";
import type { RarityWeights } from "../config";
import { newRun, setRun, type RunState } from "../state/RunState";
import { isSeed, legacySeed, streamFor } from "./Rng";
import type { TrialEndOutcome } from "../sim/engine";
import { AFFLICTIONS, type AfflictionId } from "./Afflictions";
import { BOSS_MODIFIERS } from "./Boss";
import { ENDINGS, type EndingId } from "./Endings";
import { DIE_LADDER } from "./Dice";
import { DicePool, type DiceStack } from "./DicePool";
import { ITEMS, type ShopItemId } from "./Items";
import type { RivalState } from "./Rival";
import {
  hydrateRollHistory,
  serializeRollHistory,
  type SerializedRollSample,
} from "./RunHistory";
import {
  rollBoosterOffers,
  rollShopOffers,
  type BoosterOffer,
  type ShopOffer,
  weightsFor,
} from "./Shop";
import { TutorialStage, type TutorialState } from "./Tutorial";
import { addItemValue } from "./ItemValue";

export const ACTIVE_RUN_STORAGE_KEY = "the-order-of-order.active-run";
const ACTIVE_RUN_TOMBSTONE_KEY = `${ACTIVE_RUN_STORAGE_KEY}.cleared-at`;
const SCHEMA = 1 as const;

/** The mirror rival, flattened the same way the run's own grid and score are:
 *  the pool as stacks, the score as a decimal string. */
interface SerializedRival {
  dice: DiceStack[];
  score: string;
  roll: number;
}

type SerializedRunState = Omit<
  RunState,
  | "dice"
  | "score"
  | "trialScore"
  | "totalScore"
  | "dicePoints"
  | "itemPoints"
  | "rival"
  | "rollHistory"
> & {
  dice: DiceStack[];
  /** The grid's intake (see `DicePool.everAdded`). A stack summary is only the
   *  survivors, so a resume would otherwise forget every die the run lost. */
  diceEverAdded: number;
  score: string;
  trialScore: string;
  totalScore: string;
  dicePoints: Record<string, string>;
  itemPoints: Record<string, string>;
  rival: SerializedRival | null;
  rollHistory: SerializedRollSample[];
};

type SerializedTrialEndOutcome = Omit<
  TrialEndOutcome,
  "completedScore" | "completedGoal"
> & {
  completedScore: string;
  completedGoal: string;
};

export interface ShopCheckpointState {
  offers: ShopOffer[];
  packs: BoosterOffer[];
  packChoices?: ShopOffer[];
  openingPackId?: BoosterOffer["id"];
  /** Actual price already paid for the open pack, later assigned to its pick. */
  openingPackCost?: number;
  visitWeights: RarityWeights;
  boonSpent: boolean;
  purchasesMade: number;
  rerollsThisVisit: number;
  /** Packs opened so far this visit. Unlike the counters above it earns no
   *  gameplay rule of its own — it exists to name the stream each pack's cards
   *  are drawn from, so re-opening a shop deals the same pack twice rather than
   *  a fresh one (see systems/Rng). */
  packsOpenedThisVisit: number;
  couponFreebieClaimedThisVisit: boolean;
  pickerOffer?: ShopOffer;
  pickedIndices: number[];
}

export type ResumableCheckpoint =
  | { scene: "TrialOverview" }
  | { scene: "Game"; unlocked: ShopItemId[] }
  | {
      scene: "TrialResults";
      outcome: TrialEndOutcome;
      unlocked: ShopItemId[];
    }
  | ({ scene: "Shop" } & ShopCheckpointState)
  // A story sequence, and the drawback screen that some of them hand off to.
  // The Tribute's cards are carried on the checkpoint rather than re-rolled on
  // resume, so reloading cannot deal the King a friendlier set of demands.
  | { scene: "Ending"; id: EndingId }
  | {
      scene: "Tribute";
      gift: "kingsDemands" | "betrayal";
      choices: AfflictionId[];
    }
  | { scene: "Victory" };

type SerializedCheckpoint =
  | Exclude<ResumableCheckpoint, { scene: "TrialResults" }>
  | {
      scene: "TrialResults";
      outcome: SerializedTrialEndOutcome;
      unlocked: ShopItemId[];
    };

interface ActiveRunSaveV1 {
  schema: typeof SCHEMA;
  savedAt: number;
  run: SerializedRunState;
  tutorial: TutorialState;
  checkpoint: SerializedCheckpoint;
}

export interface RestoredActiveRun {
  run: RunState;
  tutorial: TutorialState;
  checkpoint: ResumableCheckpoint;
}

const itemIds: ReadonlySet<string> = new Set(ITEMS.map((item) => item.id));
const bossIds: ReadonlySet<string> = new Set(
  BOSS_MODIFIERS.map((boss) => boss.id),
);
const afflictionIds: ReadonlySet<string> = new Set(Object.keys(AFFLICTIONS));
const endingIds: ReadonlySet<string> = new Set(ENDINGS.map((e) => e.id));
const dieSides = new Set<number>(DIE_LADDER);
const packIds = new Set([
  "common_pack",
  "uncommon_pack",
  "rare_pack",
  "swarm_pack",
  "multiplier_pack",
  "precision_pack",
  "economy_pack",
  "tempo_pack",
]);

let latestRaw: string | null = null;
let latestCheckpoint: ResumableCheckpoint | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function parseBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function cloneOffer(value: ShopOffer): ShopOffer {
  return { ...value };
}

function clonePack(value: BoosterOffer): BoosterOffer {
  return { ...value };
}

function serializePointMap(
  values: Record<string, bigint>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value.toString()]),
  );
}

export function serializeRunState(state: RunState): SerializedRunState {
  return {
    ...state,
    score: state.score.toString(),
    trialScore: state.trialScore.toString(),
    totalScore: state.totalScore.toString(),
    dice: state.dice.summarize().map((stack) => ({ ...stack })),
    diceEverAdded: state.dice.everAdded,
    trialRollGold: { ...state.trialRollGold },
    bossModifiers: [...state.bossModifiers],
    scoringNumbers: [...state.scoringNumbers],
    loadedSizes: [...state.loadedSizes],
    wildSizes: [...state.wildSizes],
    royalSealSizes: [...state.royalSealSizes],
    afflictions: [...state.afflictions],
    endingsSeen: [...state.endingsSeen],
    rival: state.rival
      ? {
          dice: state.rival.dice.summarize().map((stack) => ({ ...stack })),
          score: state.rival.score.toString(),
          roll: state.rival.roll,
        }
      : null,
    shopUnlocks: [...state.shopUnlocks],
    ownedUnique: [...state.ownedUnique],
    purchases: { ...state.purchases },
    itemPurchases: state.itemPurchases.map((purchase) => ({ ...purchase })),
    itemValues: { ...state.itemValues },
    dicePoints: serializePointMap(state.dicePoints),
    itemPoints: serializePointMap(state.itemPoints),
    rollHistory: serializeRollHistory(state.rollHistory),
  };
}

function hydratePointMap(value: unknown): Record<string, bigint> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, bigint> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = parseBigInt(raw);
    if (!key || parsed === null) return null;
    result[key] = parsed;
  }
  return result;
}

function hydrateDice(value: unknown, everAdded?: unknown): DicePool | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const stacks: DiceStack[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !dieSides.has(raw.sides as number) ||
      !isFiniteNumber(raw.maxFaceBonus) ||
      raw.maxFaceBonus < 0 ||
      typeof raw.loaded !== "boolean" ||
      typeof raw.wildFace !== "boolean" ||
      typeof raw.source !== "string" ||
      !raw.source ||
      !isNonNegativeInteger(raw.count) ||
      raw.count === 0
    ) {
      return null;
    }
    stacks.push(raw as unknown as DiceStack);
  }
  // A save written before the intake was tracked starts it at the grid it
  // restored: the run resumes perfectly, and only its own dice-collected tally
  // is short by whatever it had already lost. The rival's mirror passes nothing
  // — it is never counted toward the player's own.
  return DicePool.fromStacks(
    stacks,
    isNonNegativeInteger(everAdded) ? everAdded : undefined,
  );
}

function validIdArray(
  value: unknown,
  ids: ReadonlySet<string>,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === "string" && ids.has(id))
  );
}

/** Hydrate only known fields, using current defaults for fields added after V1. */
export function hydrateRunState(value: unknown): RunState | null {
  if (!isRecord(value)) return null;
  const defaults = newRun();
  const hydrated = { ...defaults } as RunState;

  for (const [key, fallback] of Object.entries(defaults)) {
    // `rival` carries a pool and a bigint, so it is hydrated by hand below; the
    // generic pass would only shallow-copy the serialized shape over it.
    if (
      key === "dice" ||
      key === "rival" ||
      key === "rollHistory" ||
      key.endsWith("Score") ||
      key.endsWith("Points")
    )
      continue;
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof fallback === "number") {
      if (!isFiniteNumber(candidate)) return null;
      (hydrated as unknown as Record<string, unknown>)[key] = candidate;
    } else if (typeof fallback === "boolean") {
      if (typeof candidate !== "boolean") return null;
      (hydrated as unknown as Record<string, unknown>)[key] = candidate;
    } else if (Array.isArray(fallback)) {
      if (!Array.isArray(candidate)) return null;
      (hydrated as unknown as Record<string, unknown>)[key] = [...candidate];
    } else if (isRecord(fallback)) {
      if (!isRecord(candidate)) return null;
      (hydrated as unknown as Record<string, unknown>)[key] = { ...candidate };
    }
  }

  const score = parseBigInt(value.score);
  const trialScore = parseBigInt(value.trialScore);
  const totalScore = parseBigInt(value.totalScore);
  const dice = hydrateDice(value.dice, value.diceEverAdded);
  const dicePoints = hydratePointMap(value.dicePoints);
  const itemPoints = hydratePointMap(value.itemPoints);
  if (
    score === null ||
    trialScore === null ||
    totalScore === null ||
    !dice ||
    !dicePoints ||
    !itemPoints ||
    !Number.isInteger(hydrated.trial) ||
    hydrated.trial < 1 ||
    !isNonNegativeInteger(hydrated.roll) ||
    !isNonNegativeInteger(hydrated.gold) ||
    !isNonNegativeInteger(hydrated.startedAt) ||
    !isRecord(value.trialRollGold) ||
    !isNonNegativeInteger(value.trialRollGold.titheBowl) ||
    !isNonNegativeInteger(value.trialRollGold.luckyCoin) ||
    !validIdArray(value.bossModifiers ?? [], bossIds) ||
    !validIdArray(value.afflictions ?? [], afflictionIds) ||
    !validIdArray(value.endingsSeen ?? [], endingIds) ||
    !validNullableId(value.kingsDemand, afflictionIds) ||
    !isNonNegativeInteger(hydrated.defectors) ||
    !validIdArray(value.shopUnlocks ?? [], itemIds) ||
    !validIdArray(value.ownedUnique ?? [], itemIds) ||
    !Array.isArray(value.scoringNumbers) ||
    !value.scoringNumbers.every(isNonNegativeInteger) ||
    !validSidesArray(value.loadedSizes) ||
    !validSidesArray(value.wildSizes) ||
    !validSidesArray(value.royalSealSizes) ||
    !validPurchases(value.purchases) ||
    !validItemPurchases(value.itemPurchases ?? []) ||
    !validItemValues(value.itemValues ?? {})
  ) {
    return null;
  }

  hydrated.score = score;
  hydrated.trialScore = trialScore;
  hydrated.totalScore = totalScore;
  hydrated.dice = dice;
  hydrated.dicePoints = dicePoints;
  hydrated.itemPoints = itemPoints;
  // A save written before the run timeline existed simply has no curves to
  // draw; the run itself is still perfectly resumable, so this never fails the
  // hydration the way a malformed grid or score does.
  hydrated.rollHistory = hydrateRollHistory(value.rollHistory);
  // `rollsTaken` is what spaces the samples, so it may never outlive them: a
  // save with no readable timeline restarts the count along with the series.
  if (hydrated.rollHistory.length === 0) hydrated.rollsTaken = 0;
  // The seed decides every roll the rest of this run will make, so a save that
  // carries a bad one is not repairable by falling back to a fresh seed: the
  // dice would change under a player mid-run. An unreadable seed fails the whole
  // hydration, exactly as a malformed grid does. A save from before seeds
  // existed carries none at all, which is not a failure — it gets a seed derived
  // from when the run began, so reloading it twice cannot produce two runs.
  if (value.seed === undefined) {
    hydrated.seed = legacySeed(hydrated.startedAt);
  } else if (!isSeed(value.seed)) {
    return null;
  } else {
    hydrated.seed = value.seed;
  }
  // The generic pass above copied `forcedRolls` in as whatever the save held, so
  // check the shape here: these keys go straight into stream lookups, and a
  // non-string among them would quietly rig the wrong roll.
  if (
    !hydrated.forcedRolls.every(
      (key) => typeof key === "string" && /^\d+:\d+$/.test(key),
    )
  )
    return null;
  hydrated.trialRollGold = {
    titheBowl: value.trialRollGold.titheBowl,
    luckyCoin: value.trialRollGold.luckyCoin,
  };
  // A null default means the generic pass above skipped these two entirely, so
  // both are read straight off the saved shape.
  hydrated.kingsDemand = (value.kingsDemand as AfflictionId | null) ?? null;
  if (value.rival !== undefined && value.rival !== null) {
    const rival = hydrateRival(value.rival);
    if (!rival) return null;
    hydrated.rival = rival;
  }
  return hydrated;
}

/** A saved id that is allowed to be absent or null, but not to be unknown. */
function validNullableId(value: unknown, ids: ReadonlySet<string>): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && ids.has(value);
}

function hydrateRival(value: unknown): RivalState | null {
  if (!isRecord(value)) return null;
  const dice = hydrateDice(value.dice);
  const score = parseBigInt(value.score);
  if (!dice || score === null || !isNonNegativeInteger(value.roll)) return null;
  return { dice, score, roll: value.roll };
}

function validSidesArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((side) => dieSides.has(side as number))
  );
}

function validPurchases(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([id, count]) => itemIds.has(id) && isNonNegativeInteger(count),
    )
  );
}

function validItemPurchases(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (purchase) =>
        isRecord(purchase) &&
        typeof purchase.id === "string" &&
        itemIds.has(purchase.id) &&
        isNonNegativeInteger(purchase.cost) &&
        isNonNegativeInteger(purchase.trial) &&
        purchase.trial >= 1,
    )
  );
}

function validItemValues(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([id, amount]) => itemIds.has(id) && isNonNegativeInteger(amount),
    )
  );
}

function validOffer(value: unknown): value is ShopOffer {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    itemIds.has(value.id) &&
    typeof value.name === "string" &&
    isNonNegativeInteger(value.cost) &&
    (value.listPrice === undefined ||
      (typeof value.listPrice === "number" &&
        Number.isFinite(value.listPrice) &&
        value.listPrice >= 0)) &&
    ["free", "low", "standard", "strong", "build"].includes(
      value.priceBand as string,
    ) &&
    typeof value.desc === "string" &&
    ["common", "uncommon", "rare"].includes(value.rarity as string) &&
    typeof value.needsTarget === "boolean" &&
    typeof value.targetsSize === "boolean" &&
    (value.targetCount === undefined ||
      isNonNegativeInteger(value.targetCount)) &&
    typeof value.cursed === "boolean" &&
    (value.freeByCoupon === undefined ||
      typeof value.freeByCoupon === "boolean")
  );
}

function validPack(value: unknown): value is BoosterOffer {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    packIds.has(value.id) &&
    typeof value.name === "string" &&
    typeof value.desc === "string" &&
    isNonNegativeInteger(value.cost) &&
    isFiniteNumber(value.color) &&
    typeof value.sold === "boolean"
  );
}

function validWeights(value: unknown): value is RarityWeights {
  return (
    isRecord(value) &&
    isFiniteNumber(value.common) &&
    value.common >= 0 &&
    isFiniteNumber(value.uncommon) &&
    value.uncommon >= 0 &&
    isFiniteNumber(value.rare) &&
    value.rare >= 0
  );
}

function serializeOutcome(outcome: TrialEndOutcome): SerializedTrialEndOutcome {
  return {
    ...outcome,
    completedScore: outcome.completedScore.toString(),
    completedGoal: outcome.completedGoal.toString(),
    goldBreakdown: { ...outcome.goldBreakdown },
    rollGold: { ...outcome.rollGold },
  };
}

function hydrateOutcome(value: unknown): TrialEndOutcome | null {
  if (!isRecord(value)) return null;
  const completedScore = parseBigInt(value.completedScore);
  const completedGoal = parseBigInt(value.completedGoal);
  const goldBreakdown = value.goldBreakdown;
  const rollGold = value.rollGold;
  // Results checkpoints written before the receipt displayed the actual roll
  // count have no `rollsLeft`. Keep those runs resumable; zero is the only
  // honest fallback once the trial's roll counter has already been reset.
  const rollsLeft = isRecord(goldBreakdown)
    ? (goldBreakdown.rollsLeft ?? 0)
    : 0;
  if (
    !["victory", "gameOver", "advanced"].includes(value.phase as string) ||
    completedScore === null ||
    completedGoal === null ||
    !isNonNegativeInteger(value.completedTrial) ||
    !isNonNegativeInteger(value.goldEarned) ||
    !isRecord(goldBreakdown) ||
    !["base", "rolls", "interest", "items", "total"].every((key) =>
      isFiniteNumber(goldBreakdown[key]),
    ) ||
    !isNonNegativeInteger(rollsLeft) ||
    !isNonNegativeInteger(value.goldForfeited) ||
    !isRecord(rollGold) ||
    !["titheBowl", "luckyCoin", "total"].every((key) =>
      isNonNegativeInteger(rollGold[key]),
    ) ||
    !isNonNegativeInteger(value.totalGoldEarned) ||
    !isFiniteNumber(value.diceAdded) ||
    typeof value.insuranceUsed !== "boolean" ||
    typeof value.bossCleared !== "boolean"
  )
    return null;
  // Likewise for `rollsPaid`, added when the receipt began striking through the
  // rolls the ceiling did not pay for. Assuming every roll left was paid is the
  // fallback that prints no strike, which is the honest reading of a receipt
  // that never recorded a ceiling.
  const rollsPaid = isNonNegativeInteger(goldBreakdown.rollsPaid)
    ? Math.min(goldBreakdown.rollsPaid, rollsLeft)
    : rollsLeft;
  return {
    ...(value as unknown as TrialEndOutcome),
    completedScore,
    completedGoal,
    goldBreakdown: {
      ...goldBreakdown,
      rollsLeft,
      rollsPaid,
    } as unknown as TrialEndOutcome["goldBreakdown"],
    rollGold: { ...rollGold } as unknown as TrialEndOutcome["rollGold"],
  };
}

function serializeCheckpoint(
  checkpoint: ResumableCheckpoint,
): SerializedCheckpoint {
  if (checkpoint.scene === "TrialResults") {
    return {
      scene: checkpoint.scene,
      outcome: serializeOutcome(checkpoint.outcome),
      unlocked: [...checkpoint.unlocked],
    };
  }
  if (checkpoint.scene === "Game")
    return { ...checkpoint, unlocked: [...checkpoint.unlocked] };
  if (checkpoint.scene === "Shop") return cloneShopCheckpoint(checkpoint);
  if (checkpoint.scene === "Tribute")
    return { ...checkpoint, choices: [...checkpoint.choices] };
  return { ...checkpoint };
}

function hydrateCheckpoint(value: unknown): ResumableCheckpoint | null {
  if (!isRecord(value) || typeof value.scene !== "string") return null;
  if (value.scene === "TrialOverview" || value.scene === "Victory") {
    return { scene: value.scene };
  }
  if (value.scene === "Game") {
    const unlocked = value.unlocked ?? [];
    if (!validIdArray(unlocked, itemIds)) return null;
    return { scene: "Game", unlocked: [...unlocked] as ShopItemId[] };
  }
  if (value.scene === "TrialResults") {
    const outcome = hydrateOutcome(value.outcome);
    if (!outcome || !validIdArray(value.unlocked, itemIds)) return null;
    return {
      scene: "TrialResults",
      outcome,
      unlocked: [...value.unlocked] as ShopItemId[],
    };
  }
  if (value.scene === "Ending") {
    if (typeof value.id !== "string" || !endingIds.has(value.id)) return null;
    return { scene: "Ending", id: value.id as EndingId };
  }
  if (value.scene === "Tribute") {
    if (value.gift !== "kingsDemands" && value.gift !== "betrayal") return null;
    if (!validIdArray(value.choices, afflictionIds)) return null;
    return {
      scene: "Tribute",
      gift: value.gift,
      choices: [...value.choices] as AfflictionId[],
    };
  }
  if (value.scene !== "Shop") return null;
  if (
    !Array.isArray(value.offers) ||
    !value.offers.every(validOffer) ||
    !Array.isArray(value.packs) ||
    !value.packs.every(validPack) ||
    (value.packChoices !== undefined &&
      (!Array.isArray(value.packChoices) ||
        !value.packChoices.every(validOffer))) ||
    (value.openingPackId !== undefined &&
      !packIds.has(value.openingPackId as string)) ||
    (value.openingPackCost !== undefined &&
      !isNonNegativeInteger(value.openingPackCost)) ||
    !validWeights(value.visitWeights) ||
    typeof value.boonSpent !== "boolean" ||
    !isNonNegativeInteger(value.purchasesMade) ||
    !isNonNegativeInteger(value.rerollsThisVisit) ||
    // Absent in a save from before packs named their own stream; such a visit
    // simply resumes as though no pack had been opened yet.
    (value.packsOpenedThisVisit !== undefined &&
      !isNonNegativeInteger(value.packsOpenedThisVisit)) ||
    typeof value.couponFreebieClaimedThisVisit !== "boolean" ||
    (value.pickerOffer !== undefined && !validOffer(value.pickerOffer)) ||
    !Array.isArray(value.pickedIndices) ||
    !value.pickedIndices.every(isNonNegativeInteger)
  )
    return null;
  return cloneShopCheckpoint(
    value as unknown as ResumableCheckpoint & { scene: "Shop" },
  );
}

function cloneShopCheckpoint(
  checkpoint: { scene: "Shop" } & ShopCheckpointState,
): { scene: "Shop" } & ShopCheckpointState {
  return {
    scene: "Shop",
    offers: checkpoint.offers.map(cloneOffer),
    packs: checkpoint.packs.map(clonePack),
    packChoices: checkpoint.packChoices?.map(cloneOffer),
    openingPackId: checkpoint.openingPackId,
    openingPackCost: checkpoint.openingPackCost,
    visitWeights: { ...checkpoint.visitWeights },
    boonSpent: checkpoint.boonSpent,
    purchasesMade: checkpoint.purchasesMade,
    rerollsThisVisit: checkpoint.rerollsThisVisit,
    packsOpenedThisVisit: checkpoint.packsOpenedThisVisit ?? 0,
    couponFreebieClaimedThisVisit: checkpoint.couponFreebieClaimedThisVisit,
    pickerOffer: checkpoint.pickerOffer
      ? cloneOffer(checkpoint.pickerOffer)
      : undefined,
    pickedIndices: [...checkpoint.pickedIndices],
  };
}

/** A save written before deferred steps existed carries no list at all, which
 *  reads as an empty one rather than as a corrupt save: a run resumed from it
 *  simply owes nothing. */
function isTutorialStageList(
  value: unknown,
): value is TutorialStage[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (stage) => isNonNegativeInteger(stage) && stage <= TutorialStage.Done,
      ))
  );
}

function serializeEnvelope(
  run: RunState,
  tutorial: TutorialState,
  checkpoint: ResumableCheckpoint,
): string {
  const envelope: ActiveRunSaveV1 = {
    schema: SCHEMA,
    // A replacement run created in the same millisecond as a clear must still
    // sort after that clear's tombstone on the next native launch.
    savedAt: Math.max(Date.now(), localTombstone() + 1),
    run: serializeRunState(run),
    tutorial: { ...tutorial, deferred: [...tutorial.deferred] },
    checkpoint: serializeCheckpoint(checkpoint),
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(
  raw: string | null,
): (RestoredActiveRun & { savedAt: number }) | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.schema !== SCHEMA ||
      !isFiniteNumber(value.savedAt)
    )
      return null;
    const run = hydrateRunState(value.run);
    const checkpoint = hydrateCheckpoint(value.checkpoint);
    const tutorial = value.tutorial;
    if (
      !run ||
      !checkpoint ||
      !isRecord(tutorial) ||
      typeof tutorial.active !== "boolean" ||
      !isNonNegativeInteger(tutorial.stage) ||
      tutorial.stage > TutorialStage.Done ||
      !isTutorialStageList(tutorial.deferred)
    )
      return null;
    return {
      run,
      checkpoint,
      tutorial: {
        active: tutorial.active,
        stage: tutorial.stage,
        deferred: [...(tutorial.deferred ?? [])],
      },
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

function localGet(): string | null {
  try {
    return localStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function localSet(raw: string): void {
  try {
    localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, raw);
  } catch {
    /* non-fatal */
  }
}

function localRemove(): void {
  try {
    localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}

function localTombstone(): number {
  try {
    const value = Number(localStorage.getItem(ACTIVE_RUN_TOMBSTONE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function setLocalTombstone(value: number): void {
  try {
    localStorage.setItem(ACTIVE_RUN_TOMBSTONE_KEY, String(value));
  } catch {
    /* non-fatal */
  }
}

function clearLocalTombstone(): void {
  try {
    localStorage.removeItem(ACTIVE_RUN_TOMBSTONE_KEY);
  } catch {
    /* non-fatal */
  }
}

function enqueueNativeWrite(operation: () => Promise<unknown>): void {
  if (!Capacitor.isNativePlatform()) return;
  writeQueue = writeQueue
    .then(async () => {
      await operation();
    })
    .catch(() => undefined);
}

/** Load the native Preferences copy before Phaser boots and mirror the newest valid copy locally. */
export async function initializeActiveRunStorage(): Promise<void> {
  const localRaw = localGet();
  let chosenRaw = localRaw;
  let localParsed = parseEnvelope(localRaw);
  let clearedAt = localTombstone();
  if (Capacitor.isNativePlatform()) {
    try {
      const [active, tombstone] = await Promise.all([
        Preferences.get({ key: ACTIVE_RUN_STORAGE_KEY }),
        Preferences.get({ key: ACTIVE_RUN_TOMBSTONE_KEY }),
      ]);
      const nativeRaw = active.value;
      const nativeClearedAt = Number(tombstone.value);
      if (Number.isFinite(nativeClearedAt)) {
        clearedAt = Math.max(clearedAt, nativeClearedAt);
      }
      const nativeParsed = parseEnvelope(nativeRaw);
      if (
        nativeParsed &&
        (!localParsed || nativeParsed.savedAt >= localParsed.savedAt)
      ) {
        chosenRaw = nativeRaw;
        localParsed = nativeParsed;
      }
    } catch {
      /* WebView storage remains a safe fallback. */
    }
  }
  if (localParsed && localParsed.savedAt <= clearedAt) {
    localParsed = null;
    chosenRaw = null;
  }
  latestRaw = localParsed ? chosenRaw : null;
  if (latestRaw) localSet(latestRaw);
  else if (localRaw) localRemove();
}

export function restoreActiveRun(
  registry: Phaser.Data.DataManager,
): RestoredActiveRun | null {
  const restored = parseEnvelope(latestRaw ?? localGet());
  if (!restored) {
    if (latestRaw || localGet()) clearActiveRun();
    return null;
  }
  setRun(registry, restored.run);
  registry.set("tutorial", restored.tutorial);
  latestCheckpoint = restored.checkpoint;
  return restored;
}

export function saveActiveRun(
  registry: Phaser.Data.DataManager,
  checkpoint: ResumableCheckpoint,
): void {
  const run = registry.get("run") as RunState | undefined;
  const tutorial = registry.get("tutorial") as TutorialState | undefined;
  if (!run || !tutorial) return;
  const raw = serializeEnvelope(run, tutorial, checkpoint);
  latestCheckpoint = checkpoint;
  latestRaw = raw;
  clearLocalTombstone();
  localSet(raw);
  enqueueNativeWrite(async () => {
    await Preferences.remove({ key: ACTIVE_RUN_TOMBSTONE_KEY });
    await Preferences.set({ key: ACTIVE_RUN_STORAGE_KEY, value: raw });
  });
}

/** Re-save the current stable checkpoint after tutorial-only registry mutations. */
export function refreshActiveRun(registry: Phaser.Data.DataManager): void {
  if (latestCheckpoint) saveActiveRun(registry, latestCheckpoint);
}

export function clearActiveRun(): void {
  const clearedAt = Date.now();
  latestRaw = null;
  latestCheckpoint = null;
  setLocalTombstone(clearedAt);
  localRemove();
  enqueueNativeWrite(async () => {
    await Preferences.set({
      key: ACTIVE_RUN_TOMBSTONE_KEY,
      value: String(clearedAt),
    });
    await Preferences.remove({ key: ACTIVE_RUN_STORAGE_KEY });
  });
}

export async function flushActiveRun(): Promise<void> {
  await writeQueue;
}

export function createFreshShopCheckpoint(
  state: RunState,
): { scene: "Shop" } & ShopCheckpointState {
  const visitWeights = { ...weightsFor(state) };
  const boonSpent = state.boonNextShop;
  const checkpoint: { scene: "Shop" } & ShopCheckpointState = {
    scene: "Shop",
    // Keyed by the trial the shop opens after, and by a reroll count of zero:
    // this is the visit's first shelf, and rerollShopOffers takes it from there.
    offers: rollShopOffers(
      state,
      state.ownedLedger ? 5 : 3,
      streamFor(state.seed, "shop", `${state.trial}:0`),
      visitWeights,
    ),
    packs: rollBoosterOffers(
      state,
      2,
      boonSpent,
      streamFor(state.seed, "packs", state.trial),
    ),
    visitWeights,
    boonSpent,
    purchasesMade: 0,
    rerollsThisVisit: 0,
    packsOpenedThisVisit: 0,
    couponFreebieClaimedThisVisit: false,
    pickedIndices: [],
  };
  state.boonNextShop = false;
  if (state.ownedLedger) addItemValue(state, "ledger", 2);
  return checkpoint;
}

export function installActiveRunLifecycle(): void {
  const flush = () => {
    void flushActiveRun();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  if (import.meta.hot) import.meta.hot.dispose(flush);
  if (Capacitor.isNativePlatform()) {
    void App.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) flush();
    });
  }
}
