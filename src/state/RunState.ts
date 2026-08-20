import { STARTING_DICE } from "../config";
import { makeDie, DieSides } from "../systems/Dice";
import { DicePool } from "../systems/DicePool";
import type { BossModifierId } from "../systems/Boss";
import { STARTING_GOLD } from "../systems/Gold";
import type { ShopItemId } from "../systems/Items";

export interface RunState {
  // Ladder position. `trial` runs straight through the whole run (1..15 for the
  // five ranks, then 16+ in endless); rank and trial-within-rank are derived
  // from it by config's rankOf/trialInRank rather than stored.
  trial: number; // 1-based
  endless: boolean; // set when the player continues past the final rank
  roll: number; // rolls completed this trial
  // The boss assigned to this rank. It is previewable on all three trials but
  // only active during the Boss Trial (see systems/Boss.activeBoss).
  bossModifier: BossModifierId | null;
  // Set by clearing a Boss Trial; makes the next shop draw with the boosted
  // rarity odds, then cleared when that shop opens.
  boonNextShop: boolean;
  bossesCleared: number;
  // Set the moment a roll takes `score` to the trial's goal: the trial ends
  // there rather than burning its remaining rolls. Latched (rather than
  // recomputed from `score`) so nothing later in the trial can un-clear it.
  // Reset on advance.
  trialCleared: boolean;
  // Score magnitudes are bigint: with millions of dice and compounding Prism /
  // Last Call multipliers they race past Number.MAX_SAFE_INTEGER within a run.
  score: bigint; // progress toward this trial's goal; resets to 0 every trial
  trialScore: bigint; // peak `score` reached in the current trial (unlock criteria)
  totalScore: bigint; // cumulative points across the whole run, never reset
  // The shop currency, kept deliberately separate from `score` — and a plain
  // `number`, not a bigint, because it is designed to stay in the low double
  // digits all run. See systems/Gold.ts.
  gold: number;
  goldEarned: number; // lifetime gold earned this run, for the run summary
  // Gold earned during rolls in the current trial. Clear rewards are returned
  // by resolveTrialEnd; these two counters let Results account for the whole
  // trial, including Tithe Bowl and Lucky Coin.
  trialRollGold: { titheBowl: number; luckyCoin: number };
  dice: DicePool; // the grid; per-die below BUCKET_THRESHOLD, bucketed above
  scoringNumbers: number[]; // starts [1]; Extra number adds 2, then 3
  // Persistent size auras (Loaded Die / Wild Face). A die size listed here means
  // every die of that size — current and any added later — carries the property,
  // so the aura keeps scaling as the grid grows rather than affecting one die.
  loadedSizes: DieSides[]; // sizes forced to never roll their two highest faces
  wildSizes: DieSides[]; // sizes that score on every face
  royalSealSizes: DieSides[]; // sizes whose maximum face is also a scoring face
  extraPoints: number; // +1 per stack each time a die scores
  extraNumberCount: number; // 0..3
  startedAt: number; // epoch ms, for the Hall of High Scores
  bonusRollsThisRound: number; // Overtime — consumed at trial end
  bonusRollsPerRound: number; // Metronome — permanent
  ownedLedger: boolean;
  hasSnakeEyes: boolean;
  hasAmplifier: boolean;
  hasVault: boolean; // raises the gold interest cap
  hasDoubleTheFun: boolean; // duplicate any die that rolls a 6
  hasLuckySeven: boolean;
  hasParade: boolean;
  hasMenagerie: boolean;
  hasUniform: boolean;
  hasHourglass: boolean;
  hasInsurancePolicy: boolean;
  hasCouponBook: boolean; // one card free in every shop
  hasDealersBell: boolean; // first reroll each shop is free
  hasShoppingCart: boolean; // every card costs less
  hasProspector: boolean; // gold per die held, on a clear
  hasReliquary: boolean; // gold for every Boss Trial cleared
  hasPawnbroker: boolean; // every card costs less, flat
  // Stacking passives — the count of each owned (incremented per purchase), read
  // at their relevant moment (scoring, trial start, trial clear). Unlike the
  // boolean flags above, these items are repeatable and their effects compound.
  pocketChange: number; // +2 pts every roll, per copy
  whetstone: number; // 10% chance per copy each roll to shrink a random die
  dividend: number; // +1 pt per 3 dice every roll, per copy
  momentum: number; // +2 × momentumStreak per copy on each scoring roll
  keenEdge: number; // +2 per copy when a d1 scores
  foundry: number; // +5 copies of the smallest die at trial start, per copy
  jackpot: number; // 3+ matching dice score face×count, per copy
  genesis: number; // scoring dice spawn copies, cap +20/roll per copy
  reserve: number; // +1 gold per unused roll on a clear, per copy
  prism: number; // ×3 all roll points per copy
  lastCall: number; // ×4 points on the final roll per copy
  brickMold: number; // add one d6 after every roll per copy
  titheBowl: number; // +1 gold per copy on a roll that scores nothing
  luckyCoin: number; // 10% chance per copy each roll of +1 gold
  countingHouse: number; // +1 gold per copy at every trial clear
  // Always-maintained trackers that drive unlock criteria (not tied to owning
  // any particular item).
  scoreStreak: number; // consecutive scoring rolls this run; a dud resets it
  // Consecutive scoring rolls since Momentum was first purchased. Kept
  // separately so rolls before that purchase never increase its payout.
  momentumStreak: number;
  clutchClear: boolean; // has ever crossed the goal on a trial's final roll
  peakGold: number; // highest gold ever held this run (unlock criteria)
  // Snapshot of persistent unlocks taken when this run began. Newly-earned
  // cards are persisted immediately, but do not enter the shop until the next
  // run takes a fresh snapshot.
  shopUnlocks: ShopItemId[];
  ownedUnique: ShopItemId[]; // single-time items already purchased this run
  // Every item bought this run, keyed by id, with the number of times purchased.
  // The single source of truth for the inventory screen (ownership is otherwise
  // scattered across flags/counters/dice and can't be reconstructed by id).
  purchases: Partial<Record<ShopItemId, number>>;
  // Per-item point attribution, accumulated every roll by accumulatePoints (see
  // systems/ItemPoints). `dicePoints` credits base rolling points (1 per scoring
  // die) to each die's source; `itemPoints` credits bonus and multiplier points
  // to the item that produced them. Together they sum to `totalScore`.
  dicePoints: Record<string, bigint>;
  itemPoints: Record<string, bigint>;
}

export function newRun(shopUnlocks: readonly ShopItemId[] = []): RunState {
  return {
    trial: 1,
    endless: false,
    roll: 0,
    bossModifier: null,
    boonNextShop: false,
    bossesCleared: 0,
    trialCleared: false,
    score: 0n,
    trialScore: 0n,
    totalScore: 0n,
    gold: STARTING_GOLD,
    goldEarned: STARTING_GOLD,
    trialRollGold: { titheBowl: 0, luckyCoin: 0 },
    dice: DicePool.fromDice(
      Array.from({ length: STARTING_DICE }, () => makeDie(6)),
    ),
    scoringNumbers: [1],
    loadedSizes: [],
    wildSizes: [],
    royalSealSizes: [],
    extraPoints: 0,
    extraNumberCount: 0,
    startedAt: Date.now(),
    bonusRollsThisRound: 0,
    bonusRollsPerRound: 0,
    ownedLedger: false,
    hasSnakeEyes: false,
    hasAmplifier: false,
    hasVault: false,
    hasDoubleTheFun: false,
    hasLuckySeven: false,
    hasParade: false,
    hasMenagerie: false,
    hasUniform: false,
    hasHourglass: false,
    hasInsurancePolicy: false,
    hasCouponBook: false,
    hasDealersBell: false,
    hasShoppingCart: false,
    hasProspector: false,
    hasReliquary: false,
    hasPawnbroker: false,
    pocketChange: 0,
    whetstone: 0,
    dividend: 0,
    momentum: 0,
    keenEdge: 0,
    foundry: 0,
    jackpot: 0,
    genesis: 0,
    reserve: 0,
    prism: 0,
    lastCall: 0,
    brickMold: 0,
    titheBowl: 0,
    luckyCoin: 0,
    countingHouse: 0,
    scoreStreak: 0,
    momentumStreak: 0,
    clutchClear: false,
    peakGold: STARTING_GOLD,
    shopUnlocks: [...shopUnlocks],
    ownedUnique: [],
    purchases: {},
    dicePoints: {},
    itemPoints: {},
  };
}

const KEY = "run";

export function setRun(
  registry: Phaser.Data.DataManager,
  state: RunState,
): void {
  registry.set(KEY, state);
}

export function getRun(registry: Phaser.Data.DataManager): RunState {
  let state = registry.get(KEY) as RunState | undefined;
  if (!state) {
    state = newRun();
    registry.set(KEY, state);
  }
  return state;
}
