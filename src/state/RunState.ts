import { STARTING_DICE } from "../config";
import { makeDie, DieSides } from "../systems/Dice";
import { DicePool } from "../systems/DicePool";
import type { BossModifierId } from "../systems/Boss";
import type { AfflictionId } from "../systems/Afflictions";
import type { EndingId } from "../systems/Endings";
import type { RivalState } from "../systems/Rival";
import { STARTING_GOLD } from "../systems/Gold";
import type { ShopItemId } from "../systems/Items";

export interface RunState {
  // Ladder position. `trial` runs straight through the whole run (1..30 for the
  // ten ranks, then 31+ in endless); rank and trial-within-rank are derived
  // from it by config's rankOf/trialInRank rather than stored.
  trial: number; // 1-based
  endless: boolean; // set when the player continues past the final rank
  roll: number; // rolls completed this trial
  // The bosses assigned to this rank. Previewable on all three trials but only
  // active during the Boss Trial (see systems/Boss.activeBosses). A list rather
  // than one id because an affliction can raise the count a Boss Trial rolls
  // (The Long Night rolls two); an ordinary rank holds exactly one.
  bossModifiers: BossModifierId[];
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
  // Cursed cards. Each is two halves: the boon lives in a flag here (and, for
  // the flat multipliers, in Scoring.FLAT_MULTIPLIERS), while the drawback is an
  // id on `afflictions` below — kept apart so a boss that inflicts a curse's
  // drawback never hands out its boon along with it.
  hasCrunchTime: boolean; // shorter trials, tripled points
  hasBloodPrice: boolean; // scoring dice may shatter, quadrupled points
  hasOuroboros: boolean; // scoring dice pay ten and usually shatter
  hasFamishedIdol: boolean; // the grid is capped, points ×5
  hasBloat: boolean; // dice grow a rung each trial, points ×4
  hasSealedDoors: boolean; // one purchase a shop, but it takes effect twice
  hasGamblersCurse: boolean; // a roll may score nothing, points ×4
  hasReckoning: boolean; // every goal doubled, points doubled
  hasHairTrigger: boolean; // a trial's first roll ×10, every later roll halved
  // Every standing drawback in force for the rest of the run, by id. Cursed
  // cards push theirs here on purchase; a Boss Trial's modifiers are folded in
  // on top for its own trial only (see systems/Afflictions.afflictionsFor).
  afflictions: AfflictionId[];
  // The story acts already played this run (see systems/Endings). A sequence
  // fires off the trial it is pinned to, so this is what stops a resumed
  // checkpoint — or the trial the ending sits in front of — from replaying it.
  endingsSeen: EndingId[];
  // The drawback taken from the King's Demands at rank 3. Held by id as well as
  // on `afflictions` because endless lifts this one specifically, and by then
  // the list no longer records where any of it came from.
  kingsDemand: AfflictionId | null;
  // Dice lost to Betrayal across the whole run. Never spent — it is the tally
  // the story quotes back at the player.
  defectors: number;
  // The Order of Disorder's mirror of the grid, alive only during the final
  // Boss Trial (see systems/Rival).
  rival: RivalState | null;
  hasCouponBook: boolean; // one card free in every shop
  hasDealersBell: boolean; // first reroll each shop is free
  hasShoppingCart: boolean; // every card costs less
  hasProspector: boolean; // gold per die held, on a clear
  hasReliquary: boolean; // a share on top of every trial's gold payout
  hasPawnbroker: boolean; // every card costs less, flat
  // Stacking passives — the count of each owned (incremented per purchase), read
  // at their relevant moment (scoring, trial start, trial clear). Unlike the
  // boolean flags above, these items are repeatable and their effects compound.
  pocketChange: number; // +2 pts every roll, per copy
  whetstone: number; // 10% chance per copy each roll to shrink a random die
  dividend: number; // +1 pt per 3 dice every roll, per copy
  momentum: number; // +2 × momentumStreak per copy on each scoring roll
  keenEdge: number; // +2 per copy when a d1 scores
  foundry: number; // doubles the smallest die size at trial start, per copy
  jackpot: number; // a purse per 5 scoring dice, per copy
  genesis: number; // scoring dice spawn copies, cap +20/roll per copy
  reserve: number; // +1 gold per unused roll on a clear, per copy
  rainCheck: number; // rolls left on a clear carried into the next trial, per copy
  downbeat: number; // x2 per copy on every DOWNBEAT_INTERVAL-th roll of a trial
  prism: number; // ×3 all roll points per copy
  lastCall: number; // ×4 points on the final roll per copy
  // The molds: each adds one die of its own size after every roll, per copy
  // (see Items.MOLDS, which is what the roll loop actually iterates).
  chipMold: number; // d2
  spikeMold: number; // d4
  brickMold: number; // d6
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
  // Most rolls ever left in hand when a trial cleared this run. Latched here
  // rather than read off the live trial because a clear resets the roll counter
  // before unlocks are evaluated.
  peakRollsLeftOnClear: number;
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
    bossModifiers: [],
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
    hasCrunchTime: false,
    hasBloodPrice: false,
    hasOuroboros: false,
    hasFamishedIdol: false,
    hasBloat: false,
    hasSealedDoors: false,
    hasGamblersCurse: false,
    hasReckoning: false,
    hasHairTrigger: false,
    afflictions: [],
    endingsSeen: [],
    kingsDemand: null,
    defectors: 0,
    rival: null,
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
    rainCheck: 0,
    downbeat: 0,
    prism: 0,
    lastCall: 0,
    chipMold: 0,
    spikeMold: 0,
    brickMold: 0,
    titheBowl: 0,
    luckyCoin: 0,
    countingHouse: 0,
    scoreStreak: 0,
    momentumStreak: 0,
    clutchClear: false,
    peakGold: STARTING_GOLD,
    peakRollsLeftOnClear: 0,
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
