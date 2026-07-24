import { makeDie, DieSides } from "../systems/Dice";
import { DicePool } from "../systems/DicePool";
import type { ShopItemId } from "../systems/Items";

export interface RunState {
  hardMode: boolean; // higher targets + pricier shop; set at run start, fixed for the run
  round: number; // 1-based
  roll: number; // rolls completed this round, 0..20
  // Score magnitudes are bigint: with millions of dice and compounding Prism /
  // Last Call multipliers they race past Number.MAX_SAFE_INTEGER within a run.
  score: bigint; // one pool: survival score AND shop currency
  roundScore: bigint; // peak `score` reached in the current round (for unlock criteria)
  totalScore: bigint; // cumulative points across the whole run, never reset
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
  bonusRollsThisRound: number; // Overtime — consumed at round end
  bonusRollsPerRound: number; // Metronome — permanent
  ownedLedger: boolean;
  hasSnakeEyes: boolean;
  hasAmplifier: boolean;
  hasVault: boolean;
  hasDoubleTheFun: boolean; // duplicate any die that rolls a 6
  hasLuckySeven: boolean;
  hasParade: boolean;
  hasMenagerie: boolean;
  hasUniform: boolean;
  hasHourglass: boolean;
  hasInsurancePolicy: boolean;
  hasCouponBook: boolean;
  hasDealersBell: boolean;
  hasShoppingCart: boolean;
  // Stacking passives — the count of each owned (incremented per purchase), read
  // at their relevant moment (scoring, round start, round clear). Unlike the
  // boolean flags above, these items are repeatable and their effects compound.
  pocketChange: number; // +2 pts every roll, per copy
  whetstone: number; // 10% chance per copy each roll to shrink a random die
  dividend: number; // +1 pt per 3 dice every roll, per copy
  momentum: number; // +2 × momentumStreak per copy on each scoring roll
  keenEdge: number; // +2 per copy when a d1 scores
  foundry: number; // +5 copies of the smallest die at round start, per copy
  jackpot: number; // 3+ matching dice score face×count, per copy
  genesis: number; // scoring dice spawn copies, cap +20/roll per copy
  reserve: number; // keep 75% of points on round clear, per copy
  prism: number; // ×3 all roll points per copy
  lastCall: number; // ×4 points on the final roll per copy
  brickMold: number; // add one d6 after every roll per copy
  // Always-maintained trackers that drive unlock criteria (not tied to owning
  // any particular item).
  scoreStreak: number; // consecutive scoring rolls this run; a dud resets it
  // Consecutive scoring rolls since Momentum was first purchased. Kept
  // separately so rolls before that purchase never increase its payout.
  momentumStreak: number;
  clutchClear: boolean; // has ever crossed the target on a round's final roll
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

export function newRun(
  shopUnlocks: readonly ShopItemId[] = [],
  hardMode = false,
): RunState {
  return {
    hardMode,
    round: 1,
    roll: 0,
    score: 0n,
    roundScore: 0n,
    totalScore: 0n,
    dice: DicePool.fromDice([makeDie(6)]),
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
    scoreStreak: 0,
    momentumStreak: 0,
    clutchClear: false,
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
