import { COLORS } from "../art/palette";
import {
  applyBossMultiplier,
  applyDeadDice,
  applyDeadDiceCounts,
  bossSuppresses,
  extraPointsFor,
  jackpotFor,
  keenEdgeFor,
  luckySevenFor,
  scoringNumbersFor,
  snakeEyesFor,
} from "./Boss";
import { Die } from "./Dice";
import { RunState } from "../state/RunState";
import { trialRollTarget } from "./Trial";

/** Jackpot pays this much per full set of scoring dice, per copy owned... */
export const JACKPOT_POINTS = 25;
/** ...and pays nothing at all until a roll puts up this many scoring dice. */
export const JACKPOT_DICE = 5;
/** Lucky Seven's factor on a roll that turned up a seven anywhere. */
export const LUCKY_SEVEN_MULT = 7n;

/** Whether any die on this roll shows a value with a 7 written in it — the
 *  condition Lucky Seven multiplies on. Counts are read rather than keys,
 *  because The Toll scales a face's count to zero without dropping it. */
export function showsASeven(valueCounts: Map<number, number>): boolean {
  for (const [value, count] of valueCounts)
    if (count > 0 && countSevens(value) > 0) return true;
  return false;
}

export function countSevens(value: number): number {
  let remaining = Math.abs(Math.trunc(value));
  let count = 0;
  while (remaining > 0) {
    if (remaining % 10 === 7) count += 1;
    remaining = Math.floor(remaining / 10);
  }
  return count;
}

export function isHourglassRoll(state: RunState): boolean {
  const roll = state.roll + 1;
  const total = trialRollTarget(state);
  return roll <= 2 || roll >= total - 1;
}

/** How a scoring modifier surfaces itself as floating text:
 *  - `none`: no float of its own (it still feeds the grand total).
 *  - `aggregate`: one float showing the modifier's total (Snake Eyes, Jackpot).
 *  - `perDie`: a text-only float at each die it hit (Windfall). */
export type ScoreFloat = "none" | "aggregate" | "perDie";

/** One source of points in a roll. The UI iterates these to flash dice and
 *  float text; the total is the sum of their `points` times any run multiplier.
 *  Adding a new scoring rule means pushing another modifier here, not adding a
 *  field to `RollResult` and threading it through the scene. */
export interface ScoreModifier {
  id: string;
  name: string; // shown in float text, e.g. 'Jackpot', 'Snake Eyes'
  points: bigint; // points contributed, before the run multiplier (bigint: a
  // single roll's points can exceed Number.MAX_SAFE_INTEGER)
  color: number; // COLORS.* used to flash the dice it hit
  dice: number[]; // indices of dice this modifier flashes (empty when bucketed)
  bigPulse: boolean; // stronger bounce on those dice (Jackpot)
  float: ScoreFloat;
  // Some item effects identify points already included in another modifier
  // (Extra Number / Wild Face). This lets the UI list that contribution without
  // adding it to the subtotal a second time.
  displayPoints?: bigint;
  // Display-only multiplier (Windfall, Amplifier, Prism, Last Call): a factor
  // this modifier folds into the roll multiplier rather than adding points.
  // When set, `points` is 0 and the UI derives the points the factor added.
  mult?: bigint;
}

export interface RollResult {
  points: bigint; // grand total, after the run multiplier
  multiplier: bigint; // run-wide multiplier applied (Amplifier -> 2)
  modifiers: ScoreModifier[]; // additive and multiplier item effects in display order
}

/** Options that vary a roll's scoring beyond the run state itself. */
export interface ScoreOpts {
  finalRoll?: boolean; // this is the last roll of the trial (Last Call multiplies it)
}

/** Score an explicit array of rolled dice against the run's scoring numbers.
 *  Reference per-die implementation used by the parity harness only; it takes
 *  the dice directly (not `state.dice`, which is a bucketable DicePool). The live
 *  game and sim use scoreRollHistogram. */
export function scoreRoll(
  state: RunState,
  dice: Die[],
  opts: ScoreOpts = {},
): RollResult {
  const scoringDice: number[] = [];
  const keenDice: number[] = [];
  const luckySevenDice: number[] = [];
  const windfallDice: number[] = [];
  const windfallFactors = new Set<number>();
  const allSizes = new Set<number>();
  const scoringSizes = new Set<number>();
  const seenFaces = new Set<number>();
  const rawValueCounts = new Map<number, number>();
  let rawScoringCount = 0;
  let rawScoringD1Count = 0;
  let extraNumberScoringCount = 0;
  let wildFaceScoringCount = 0;
  let royalSealScoringCount = 0;
  let rawRoyalSealBonus = 0;
  let windfallScoringCount = 0;

  // Boss suppressions are read through the shared accessors so this reference
  // scorer and the live histogram scorer can never disagree about them.
  const scoringNumbers = scoringNumbersFor(state);

  dice.forEach((die, i) => {
    allSizes.add(die.sides);
    seenFaces.add(die.value);
    rawValueCounts.set(die.value, (rawValueCounts.get(die.value) ?? 0) + 1);
    const numberScores = scoringNumbers.includes(die.value);
    const windfallHit =
      die.maxFaceBonus > 0 && !die.loaded && die.value === die.sides;
    const royalSealHit =
      state.royalSealSizes.includes(die.sides) && die.value === die.sides;
    // A Rollplayer/Centurion die's current highest face is always a scoring
    // face, even when that number has not otherwise been unlocked.
    if (numberScores || die.wildFace || windfallHit || royalSealHit) {
      rawScoringCount += 1;
      scoringSizes.add(die.sides);
      if (numberScores && die.value !== 1) extraNumberScoringCount += 1;
      else if (!numberScores && die.wildFace) wildFaceScoringCount += 1;
      else if (!numberScores && !die.wildFace && windfallHit)
        windfallScoringCount += 1;
      else if (!numberScores && !die.wildFace && !windfallHit && royalSealHit)
        royalSealScoringCount += 1;
      if (die.sides === 1) {
        rawScoringD1Count += 1;
        keenDice.push(i);
      }
      scoringDice.push(i);
    }
    // A sealed size pays its whole face; the base point every scoring die earns
    // is already counted above, so the seal adds the rest of the face's value.
    if (royalSealHit) rawRoyalSealBonus += die.sides - 1;
    if (windfallHit) {
      // Rollplayer/Centurion multiply the whole roll when they hit their top
      // face — once per card effect, so the factor stays bounded at ×8.
      windfallFactors.add(die.maxFaceBonus);
      windfallDice.push(i);
    }
    if (countSevens(die.value) > 0) luckySevenDice.push(i);
  });
  let windfallMult = 1n;
  for (const factor of windfallFactors) windfallMult *= BigInt(factor);

  // The Toll makes a fraction of the grid inert. Scaling the COUNTS (rather than
  // dropping specific dice) is what keeps this identical to the histogram
  // scorer, which has no individual dice to drop once the pool is bucketed.
  // The Silence: mirrors the histogram scorer exactly — `scoringNumbersFor`
  // above already excluded them, so this subtraction is a no-op here, but the
  // two scorers state the rule identically rather than relying on it.
  const silenced = bossSuppresses(state, "extraNumber");
  const extraNumberScored = silenced ? 0 : extraNumberScoringCount;
  const basePoints = applyDeadDice(
    state,
    rawScoringCount - (silenced ? extraNumberScoringCount : 0),
  );
  const scoringD1Count = applyDeadDice(state, rawScoringD1Count);
  const valueCounts = applyDeadDiceCounts(state, rawValueCounts);
  extraNumberScoringCount = applyDeadDice(state, extraNumberScored);
  wildFaceScoringCount = applyDeadDice(state, wildFaceScoringCount);
  royalSealScoringCount = applyDeadDice(state, royalSealScoringCount);
  const royalSealBonus = applyDeadDice(state, rawRoyalSealBonus);
  windfallScoringCount = applyDeadDice(state, windfallScoringCount);

  const extraPointBonus = basePoints * extraPointsFor(state);
  const keenEdge = keenEdgeFor(state);
  const keenEdgeBonus = keenEdge > 0 ? scoringD1Count * keenEdge * 2 : 0;
  // NOTE: this per-die scoreRoll is retained only for the parity harness
  // (src/sim/compareScoring.ts). The live game and sim score through
  // scoreRollHistogram, which is O(distinct faces) and works when bucketed.

  const modifiers: ScoreModifier[] = [];

  if (basePoints > 0) {
    modifiers.push({
      id: "scoring",
      name: "Scoring",
      points: BigInt(basePoints),
      color: COLORS.glow,
      dice: scoringDice,
      bigPulse: false,
      float: "none",
    });
  }

  // These points are already present in the base Scoring total. Carry them as
  // display-only modifiers so the item-effect list can show which item enabled
  // those faces without adding the same points twice.
  if (extraNumberScoringCount > 0) {
    modifiers.push({
      id: "extraNumber",
      name: "Extra Number",
      points: 0n,
      displayPoints: BigInt(extraNumberScoringCount),
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (wildFaceScoringCount > 0) {
    modifiers.push({
      id: "wildFace",
      name: "Wild Face",
      points: 0n,
      displayPoints: BigInt(wildFaceScoringCount),
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (royalSealScoringCount > 0 || royalSealBonus > 0) {
    modifiers.push({
      id: "royalSeal",
      name: "Royal Seal",
      // Its own contribution is the face value above the base point each sealed
      // die already scored under `Scoring`, hence the split with displayPoints.
      points: BigInt(royalSealBonus),
      displayPoints: BigInt(royalSealScoringCount + royalSealBonus),
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }

  // Extra Point / Keen Edge feed the same scoring dice but are surfaced as their
  // own callouts (rather than silently inflating the Scoring total) so the
  // player sees the item earning its keep, like Snake Eyes and Jackpot do.
  if (extraPointBonus > 0) {
    modifiers.push({
      id: "extraPoint",
      name: "Extra Point",
      points: BigInt(extraPointBonus),
      color: COLORS.goldLight,
      dice: scoringDice,
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (keenEdgeBonus > 0) {
    modifiers.push({
      id: "keenEdge",
      name: "Keen Edge",
      points: BigInt(keenEdgeBonus),
      color: COLORS.goldLight,
      dice: keenDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  // Snake Eyes: any face value shared by 2+ dice scores that value times the
  // number of dice showing it, regardless of whether it's a scoring number.
  // Every die showing a matched value flashes for feedback.
  if (snakeEyesFor(state)) {
    let bonus = 0n;
    for (const [value, count] of valueCounts) {
      if (count >= 2) bonus += BigInt(value) * BigInt(count);
    }
    if (bonus > 0n) {
      const flash: number[] = [];
      dice.forEach((die, i) => {
        if ((valueCounts.get(die.value) ?? 0) >= 2) flash.push(i);
      });
      modifiers.push({
        id: "snakeEyes",
        name: "Snake Eyes",
        points: bonus,
        color: COLORS.glowGreen,
        dice: flash,
        bigPulse: false,
        float: "aggregate",
      });
    }
  }

  // Jackpot (item): pays for the SIZE of a scoring roll rather than for matching
  // faces, which was Snake Eyes' rule at a higher threshold. Nothing at all
  // until JACKPOT_DICE dice score, then a flat purse for every full set of them,
  // scaled by the copies owned.
  const jackpot = jackpotFor(state);
  const jackpotSets = Math.floor(basePoints / JACKPOT_DICE);
  if (jackpot > 0 && jackpotSets > 0) {
    modifiers.push({
      id: "jackpot",
      name: "Jackpot",
      points: BigInt(jackpotSets * JACKPOT_POINTS * jackpot),
      color: COLORS.goldLight,
      dice: scoringDice,
      bigPulse: true,
      float: "aggregate",
    });
  }

  // Windfall: a max-face-bonus die (Rollplayer, Centurion) that rolled its top
  // face multiplies the whole roll rather than adding a flat sum, so it keeps
  // pace with a growing grid. Its top face already contributes one base scoring
  // point above. Carried as a display-only modifier (points 0); the factor folds
  // into the run multiplier below.
  if (windfallMult > 1n) {
    modifiers.push({
      id: "windfall",
      name: "Windfall",
      points: 0n,
      displayPoints: BigInt(windfallScoringCount),
      mult: windfallMult,
      color: COLORS.goldLight,
      dice: windfallDice,
      bigPulse: true,
      float: "perDie",
    });
  }

  // Keep the always-on unlock streak separate from Momentum's payout streak.
  // Momentum only advances while owned, so its first scoring roll starts at 1.
  // is the one place scoreRoll mutates state — it runs exactly once per roll.
  const rollScored = modifiers.some((m) => m.points > 0n);
  state.scoreStreak = rollScored ? state.scoreStreak + 1 : 0;
  state.momentumStreak =
    state.momentum > 0 && rollScored ? state.momentumStreak + 1 : 0;
  if (state.momentum > 0 && rollScored) {
    modifiers.push({
      id: "momentum",
      name: "Momentum",
      points: BigInt(state.momentumStreak * state.momentum * 2),
      color: COLORS.glowGreen,
      dice: scoringDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  // Pocket Change (flat +2/copy) and Dividend (+1/copy per 3 dice owned) both
  // pay out every roll regardless of what the dice did. Added after the streak
  // check above so they never keep Momentum's streak alive on a roll where no
  // die actually scored.
  if (state.pocketChange > 0) {
    modifiers.push({
      id: "pocketChange",
      name: "Pocket Change",
      points: BigInt(2 * state.pocketChange),
      color: COLORS.glow,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  const dividendPoints = state.dividend * Math.floor(dice.length / 3);
  if (dividendPoints > 0) {
    modifiers.push({
      id: "dividend",
      name: "Dividend",
      points: BigInt(dividendPoints),
      color: COLORS.glow,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }

  const subtotal = modifiers.reduce((sum, m) => sum + m.points, 0n);
  const paradeActive =
    state.hasParade && seenFaces.has(1) && seenFaces.has(2) && seenFaces.has(3);
  const menagerieActive = state.hasMenagerie && scoringSizes.size >= 3;
  const uniformActive =
    state.hasUniform && dice.length > 0 && allSizes.size === 1;
  const hourglassActive = state.hasHourglass && isHourglassRoll(state);
  const luckySevenActive = luckySevenFor(state) && showsASeven(valueCounts);
  // Amplifier ×2, Prism ×3 per copy, Last Call ×4 per copy on the final roll,
  // Lucky Seven ×7 on a roll that turned up a seven, and Windfall
  // (Rollplayer/Centurion top-face) — all compound into one run multiplier.
  const multiplier = applyBossMultiplier(
    state,
    (state.hasAmplifier ? 2n : 1n) *
      3n ** BigInt(state.prism) *
      (opts.finalRoll ? 4n ** BigInt(state.lastCall) : 1n) *
      (paradeActive ? 2n : 1n) *
      (menagerieActive ? 2n : 1n) *
      (uniformActive ? 3n : 1n) *
      (hourglassActive ? 2n : 1n) *
      (luckySevenActive ? LUCKY_SEVEN_MULT : 1n) *
      windfallMult,
  );

  // Surface every item-owned multiplier through the same modifier list as the
  // additive effects. These entries are display-only; the factors above remain
  // the single source of scoring truth.
  if (state.hasAmplifier) {
    modifiers.push({
      id: "amplifier",
      name: "Amplifier",
      points: 0n,
      mult: 2n,
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (state.prism > 0) {
    modifiers.push({
      id: "prism",
      name: "Prism",
      points: 0n,
      mult: 3n ** BigInt(state.prism),
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (opts.finalRoll && state.lastCall > 0) {
    modifiers.push({
      id: "lastCall",
      name: "Last Call",
      points: 0n,
      mult: 4n ** BigInt(state.lastCall),
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (paradeActive) {
    modifiers.push({
      id: "parade",
      name: "Parade",
      points: 0n,
      mult: 2n,
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (menagerieActive) {
    modifiers.push({
      id: "menagerie",
      name: "Menagerie",
      points: 0n,
      mult: 2n,
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (uniformActive) {
    modifiers.push({
      id: "uniform",
      name: "Uniform",
      points: 0n,
      mult: 3n,
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (hourglassActive) {
    modifiers.push({
      id: "hourglass",
      name: "Hourglass",
      points: 0n,
      mult: 2n,
      color: COLORS.goldLight,
      dice: [],
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (luckySevenActive) {
    modifiers.push({
      id: "luckySeven",
      name: "Lucky Seven",
      points: 0n,
      mult: LUCKY_SEVEN_MULT,
      color: COLORS.goldLight,
      dice: luckySevenDice,
      bigPulse: true,
      float: "aggregate",
    });
  }

  return { points: subtotal * multiplier, multiplier, modifiers };
}
