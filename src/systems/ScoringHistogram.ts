import { COLORS } from "../art/palette";
import {
  type ActiveAfflictions,
  applyMultiplierPenalty,
  extraPointsFor,
  jackpotFor,
  keenEdgeFor,
  luckySevenFor,
  snakeEyesFor,
  suppresses,
} from "./Afflictions";
import { Die, DieSides, faceFloor, faceRange, isVoiceDie } from "./Dice";
import type { RollRules } from "./DicePool";
import { probit } from "./ExactMath";
import { RunState } from "../state/RunState";
import { groupScores, growRoll, type VigilGroup } from "./GrowthEngines";
import {
  counterpointDice,
  solitudePoints,
  voiceDice,
  DOWNBEAT_MULT,
  flatMultiplier,
  flatMultiplierModifiers,
  HAIR_TRIGGER_MULT,
  isDownbeatRoll,
  isFirstRoll,
  isHourglassRoll,
  OUROBOROS_BONUS,
  JACKPOT_DICE,
  JACKPOT_POINTS,
  LUCKY_SEVEN_MULT,
  RollResult,
  ScoreModifier,
  ScoreOpts,
  showsASeven,
  growthModifiers,
  treeMultiplierModifiers,
  treeMultiplierProduct,
  treeMultipliers,
} from "./Scoring";

/** Aggregate view of a rolled dice grid — everything scoreRoll actually needs,
 *  and nothing per-die. Building this is the only step whose cost depends on how
 *  the aggregate was produced: O(dice) if summarised from a Die[] (small counts),
 *  O(types × faces) if sampled straight from buckets (huge counts). Once you hold
 *  a DiceAgg, scoring is O(distinct face values) regardless of dice count. */
export interface DiceAgg {
  total: number; // dice.length — the whole grid, inert dice included, since that
  // is what a grid-size rule (Dividend, Uniform) is counting
  inertCount: number; // of those, how many rolled but went unread: the grid's
  // inert head (see Afflictions.inertDiceCount). Every OTHER count below is over
  // the live dice alone, so nothing downstream has to subtract this — it is here
  // for the rules that need the live total, and for the UI to name the penalty
  valueCounts: Map<number, number>; // face value -> how many LIVE dice show it
  scoringCount: number; // dice whose face is a scoring number, or that are wild
  scoringD1Count: number; // of those, how many are d1 (drives Keen Edge)
  extraNumberScoringCount: number; // scoring faces above 1 enabled by Extra Number
  wildFaceScoringCount: number; // dice that scored only because they are wild
  royalSealScoringCount: number; // dice that scored only because Royal Seal matched their maximum
  royalSealBonus: number; // face value ABOVE the base point, summed over every
  // sealed-size die showing its maximum (sides - 1 each)
  windfallScoringCount: number; // dice that scored only because top-face Windfall hit
  allSizes: Set<number>; // distinct die sizes present in the grid
  scoringSizes: Set<number>; // distinct die sizes that scored this roll
  windfallMult: bigint; // Π of the distinct Rollplayer/Centurion factors that
  // hit their current top face this roll (1n when none did)
  scoringValueCounts: Map<number, number>; // face value -> LIVE dice showing it
  // that scored (Counterpoint pays the lone faces that did not)
  voiceValueCounts: Map<number, number>; // face value -> LIVE A New Voice dice
  // showing it that did not score (they score when alone on their face)
  faceValueBonus: number; // under The Scales, face value ABOVE the base point,
  // summed over every scoring die
  sidesTotal: number; // the sides of every die in the grid, inert ones included
  vigil: VigilGroup[]; // the scoring dice carrying The Vigil's score counts
}

/** O(dice) bridge from the existing per-die array to a DiceAgg. Use this below
 *  the bucketing threshold and to verify the sampled path against real rolls.
 *  Mirrors the scoring-detection logic in Scoring.ts exactly — including which
 *  dice it declines to read: the leading `inertCount` of them roll and are
 *  counted in `total`, and are invisible to everything else. */
export function aggFromDice(
  dice: Die[],
  scoringNumbers: number[],
  royalSealSizes: readonly number[] = [],
  inertCount = 0,
  rules: RollRules = {},
): DiceAgg {
  const scales = rules.scales ?? false;
  const scoringValueCounts = new Map<number, number>();
  const voiceValueCounts = new Map<number, number>();
  const vigil = new Map<string, VigilGroup>();
  let faceValueBonus = 0;
  let sidesTotal = 0;
  const valueCounts = new Map<number, number>();
  let scoringCount = 0;
  let scoringD1Count = 0;
  let extraNumberScoringCount = 0;
  let wildFaceScoringCount = 0;
  let royalSealScoringCount = 0;
  let royalSealBonus = 0;
  let windfallScoringCount = 0;
  const windfallFactors = new Set<number>();
  const scoring = new Set(scoringNumbers);
  const sealed = new Set(royalSealSizes);
  const allSizes = new Set<number>();
  const scoringSizes = new Set<number>();
  const inert = Math.max(0, Math.min(dice.length, Math.floor(inertCount)));
  for (let k = 0; k < dice.length; k++) {
    const die = dice[k];
    // A die's size is a fact about the grid, not about the roll, so the inert
    // head still counts toward Uniform and the rest of `allSizes`.
    allSizes.add(die.sides);
    sidesTotal += die.sides;
    if (k < inert) continue;
    valueCounts.set(die.value, (valueCounts.get(die.value) ?? 0) + 1);
    const windfallHit =
      die.maxFaceBonus > 0 && !die.loaded && die.value === die.sides;
    const royalSealHit =
      !scales && sealed.has(die.sides) && die.value === die.sides;
    const numberScores = scales
      ? die.value * 2 > die.sides
      : scoring.has(die.value);
    if (numberScores || die.wildFace || windfallHit || royalSealHit) {
      scoringCount += 1;
      scoringSizes.add(die.sides);
      scoringValueCounts.set(
        die.value,
        (scoringValueCounts.get(die.value) ?? 0) + 1,
      );
      if (scales) faceValueBonus += die.value - 1;
      groupScores(vigil, die.scores, 1);
      if (die.sides === 1) scoringD1Count += 1;
      if (numberScores && die.value !== 1) {
        if (!scales) extraNumberScoringCount += 1;
      } else if (!numberScores && die.wildFace) wildFaceScoringCount += 1;
      else if (!numberScores && !die.wildFace && windfallHit)
        windfallScoringCount += 1;
      else if (!numberScores && !die.wildFace && !windfallHit && royalSealHit)
        royalSealScoringCount += 1;
    } else if (isVoiceDie(die)) {
      voiceValueCounts.set(
        die.value,
        (voiceValueCounts.get(die.value) ?? 0) + 1,
      );
    }
    // The seal pays the whole face, and the base point is already counted above.
    if (royalSealHit) royalSealBonus += die.sides - 1;
    if (windfallHit) windfallFactors.add(die.maxFaceBonus);
  }
  let windfallMult = 1n;
  for (const factor of windfallFactors) windfallMult *= BigInt(factor);
  return {
    total: dice.length,
    inertCount: inert,
    valueCounts,
    scoringCount,
    scoringD1Count,
    extraNumberScoringCount,
    wildFaceScoringCount,
    royalSealScoringCount,
    royalSealBonus,
    windfallScoringCount,
    allSizes,
    scoringSizes,
    windfallMult,
    scoringValueCounts,
    voiceValueCounts,
    faceValueBonus,
    sidesTotal,
    vigil: [...vigil.values()],
  };
}

/** A group of identical dice. At any dice count the number of buckets stays tiny
 *  (≤ 8 sides × a few flag combos × a handful of item sources), so a run with
 *  100k dice still has only a few dozen buckets. Maintain these incrementally in
 *  the shop instead of walking state.dice every roll. */
export interface DiceBucket {
  sides: number;
  maxFaceBonus: number;
  loaded: boolean;
  wildFace: boolean;
  source: string;
  count: number;
}

/** Collapse a Die[] into buckets. In production you would never rebuild this per
 *  roll — you'd mutate bucket counts as dice are added/shrunk/loaded. */
export function bucketDice(dice: Die[]): DiceBucket[] {
  const map = new Map<string, DiceBucket>();
  for (const d of dice) {
    const key = `${d.sides}|${d.maxFaceBonus}|${d.loaded}|${d.wildFace}|${d.source}`;
    const b = map.get(key);
    if (b) b.count += 1;
    else
      map.set(key, {
        sides: d.sides,
        maxFaceBonus: d.maxFaceBonus,
        loaded: d.loaded,
        wildFace: d.wildFace,
        source: d.source,
        count: 1,
      });
  }
  return [...map.values()];
}

/**
 * Standard normal, by inverting the normal CDF of one uniform draw.
 *
 * This was Box–Muller, which is the obvious way to write it and the wrong way
 * to write it here: `Math.log` and `Math.cos` are implementation-approximated,
 * so two engines sampling the same seeded stream can disagree about a bucketed
 * roll, and every seeded run would only be replayable on the engine that played
 * it. `probit` is rational polynomials over the central 85% and needs nothing
 * but `sqrt` and an exact `ln` in the tails — see systems/ExactMath.
 *
 * It also costs one draw rather than two, which is the reason a stream position
 * is not comparable across this change.
 */
function gaussian(rng: () => number): number {
  let u = 0;
  // Never hand probit a zero: the inverse CDF is unbounded there.
  while (u === 0) u = rng();
  return probit(u);
}

/** Draw from Binomial(n, p). Exact (sum of Bernoulli) for small n so tiny buckets
 *  stay faithful; normal approximation for large n where it's indistinguishable
 *  and O(1) instead of O(n). */
function sampleBinomial(n: number, p: number, rng: () => number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (n < 100) {
    let k = 0;
    for (let i = 0; i < n; i++) if (rng() < p) k++;
    return k;
  }
  const x = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * gaussian(rng));
  return x < 0 ? 0 : x > n ? n : x;
}

/** Sample how many of `n` dice with `faces` equally-likely faces land on each
 *  face, via sequential binomial. Returns counts[i] = number showing value i+1.
 *  O(faces), not O(n) — this is what replaces rolling each die individually. */
export function sampleFaceCounts(
  n: number,
  faces: number,
  rng: () => number,
): number[] {
  const counts = new Array<number>(faces).fill(0);
  let remaining = n;
  for (let f = 0; f < faces - 1 && remaining > 0; f++) {
    const c = sampleBinomial(remaining, 1 / (faces - f), rng);
    counts[f] = c;
    remaining -= c;
  }
  counts[faces - 1] = remaining;
  return counts;
}

/** Roll a set of buckets straight into a DiceAgg without ever touching an
 *  individual die. Cost is O(buckets × faces). This is the fast path for huge
 *  dice counts; the resulting aggregate feeds scoreRollHistogram unchanged. */
export function rollBucketsToAgg(
  buckets: DiceBucket[],
  scoringNumbers: number[],
  rng: () => number = Math.random,
  royalSealSizes: readonly number[] = [],
  rules: RollRules = {},
): DiceAgg {
  const scales = rules.scales ?? false;
  const ballast = new Set<number>(rules.ballastSizes ?? []);
  const anvil = rules.anvil ?? false;
  const scoringValueCounts = new Map<number, number>();
  const voiceValueCounts = new Map<number, number>();
  let faceValueBonus = 0;
  let sidesTotal = 0;
  const valueCounts = new Map<number, number>();
  let total = 0;
  let scoringCount = 0;
  let scoringD1Count = 0;
  let extraNumberScoringCount = 0;
  let wildFaceScoringCount = 0;
  let royalSealScoringCount = 0;
  let royalSealBonus = 0;
  let windfallScoringCount = 0;
  const windfallFactors = new Set<number>();
  const scoring = new Set(scoringNumbers);
  const sealed = new Set(royalSealSizes);
  const allSizes = new Set<number>();
  const scoringSizes = new Set<number>();
  for (const b of buckets) {
    allSizes.add(b.sides);
    total += b.count;
    sidesTotal += b.sides * b.count;
    const [low, faces] = faceRange(
      b.sides,
      b.loaded,
      ballast.has(b.sides as DieSides),
      faceFloor(b.sides, anvil),
    );
    const faceCounts = sampleFaceCounts(b.count, faces - low + 1, rng);
    for (let v = low; v <= faces; v++) {
      const c = faceCounts[v - low];
      if (c === 0) continue;
      valueCounts.set(v, (valueCounts.get(v) ?? 0) + c);
      const windfallHit = b.maxFaceBonus > 0 && !b.loaded && v === b.sides;
      const royalSealHit = !scales && sealed.has(b.sides) && v === b.sides;
      const numberScores = scales ? v * 2 > b.sides : scoring.has(v);
      if (numberScores || b.wildFace || windfallHit || royalSealHit) {
        scoringCount += c;
        scoringSizes.add(b.sides);
        scoringValueCounts.set(v, (scoringValueCounts.get(v) ?? 0) + c);
        if (scales) faceValueBonus += (v - 1) * c;
        if (b.sides === 1) scoringD1Count += c;
        if (numberScores && v !== 1) {
          if (!scales) extraNumberScoringCount += c;
        } else if (!numberScores && b.wildFace) wildFaceScoringCount += c;
        else if (!numberScores && !b.wildFace && windfallHit)
          windfallScoringCount += c;
        else if (!numberScores && !b.wildFace && !windfallHit && royalSealHit)
          royalSealScoringCount += c;
      } else if (isVoiceDie(b)) {
        voiceValueCounts.set(v, (voiceValueCounts.get(v) ?? 0) + c);
      }
      if (royalSealHit) royalSealBonus += (b.sides - 1) * c;
      // Windfall only fires on a die's own top face; a loaded die (faces < sides)
      // can never show it, matching rollDie's behaviour.
      if (windfallHit) windfallFactors.add(b.maxFaceBonus);
    }
  }
  let windfallMult = 1n;
  for (const factor of windfallFactors) windfallMult *= BigInt(factor);
  return {
    total,
    inertCount: 0,
    valueCounts,
    scoringCount,
    scoringD1Count,
    extraNumberScoringCount,
    wildFaceScoringCount,
    royalSealScoringCount,
    royalSealBonus,
    windfallScoringCount,
    allSizes,
    scoringSizes,
    windfallMult,
    scoringValueCounts,
    voiceValueCounts,
    faceValueBonus,
    sidesTotal,
    // A bucket summary carries no score counts; the grid's own pool does.
    vigil: [],
  };
}

/** Whether every live die on this roll scored — the roll The Catechism grows on.
 *  Inert dice are left out, as every count on the aggregate already leaves them
 *  out: a die the Toll crossed through produced no outcome to fail with. Dice
 *  that scored only on a number The Silence has muted did not score. */
export function everyLiveDieScored(
  state: RunState,
  agg: DiceAgg,
  afflictions?: ActiveAfflictions,
): boolean {
  const live = agg.total - agg.inertCount;
  const scored =
    agg.scoringCount -
    (suppresses(state, "extraNumber", afflictions)
      ? agg.extraNumberScoringCount
      : 0);
  return live > 0 && scored >= live;
}

/** Histogram-based twin of scoreRoll. Produces identical point totals from a
 *  DiceAgg; modifiers carry no `dice` indices (meaningless at scale — the UI
 *  would show aggregate floats, not per-die flashes). Like scoreRoll it mutates
 *  both streak trackers exactly once. */
export function scoreRollHistogram(
  state: RunState,
  agg: DiceAgg,
  opts: ScoreOpts = {},
): RollResult {
  const modifiers: ScoreModifier[] = [];
  const noDice: number[] = [];

  // The Silence is applied HERE, on the aggregate, and not only by the caller
  // choosing which numbers to roll against: `extraNumberScoringCount` is exactly
  // "dice that scored only because of an unlocked number", so subtracting it is
  // the whole modifier. Doing it here means a caller that passes the unfiltered
  // scoring numbers still gets the right answer, and doing it on a caller that
  // already filtered them is a no-op (the count is already zero).
  const silenced = suppresses(state, "extraNumber", opts.afflictions);
  const extraNumberScored = silenced ? 0 : agg.extraNumberScoringCount;

  // Nothing here has to account for the inert dice. Whoever rolled the grid
  // named them (Afflictions.inertDiceCount), and the aggregate arrived with
  // their faces already left out of every count below — which is why the grid
  // can draw a cross through exactly those dice and be telling the truth.
  const scoringCount =
    agg.scoringCount - (silenced ? agg.extraNumberScoringCount : 0);
  const scoringD1Count = agg.scoringD1Count;
  const valueCounts = agg.valueCounts;

  // Raw counts (scoringCount, valueCounts) stay Number — exact to ~9e15 dice —
  // but every points value is BigInt, since value×count and the multiplier stack
  // blow past Number.MAX_SAFE_INTEGER well before dice counts do.
  const basePoints = scoringCount;
  if (basePoints > 0) {
    modifiers.push({
      id: "scoring",
      name: "Scoring",
      points: BigInt(basePoints),
      color: COLORS.glow,
      dice: noDice,
      bigPulse: false,
      float: "none",
    });
  }

  // Ouroboros pays ten for a die where the grid pays one — the nine above the
  // base point, so the two stack rather than one replacing the other.
  if (state.hasOuroboros && basePoints > 0) {
    modifiers.push({
      id: "ouroboros",
      name: "Ouroboros",
      points: BigInt(basePoints) * OUROBOROS_BONUS,
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: true,
      float: "aggregate",
    });
  }

  const extraNumberScoringCount = extraNumberScored;
  if (extraNumberScoringCount > 0) {
    modifiers.push({
      id: "extraNumber",
      name: "Extra Number",
      points: 0n,
      displayPoints: BigInt(extraNumberScoringCount),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  const wildFaceScoringCount = agg.wildFaceScoringCount;
  if (wildFaceScoringCount > 0) {
    modifiers.push({
      id: "wildFace",
      name: "Contentment",
      points: 0n,
      displayPoints: BigInt(wildFaceScoringCount),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  const royalSealScoringCount = agg.royalSealScoringCount;
  const royalSealBonus = agg.royalSealBonus;
  if (royalSealScoringCount > 0 || royalSealBonus > 0) {
    modifiers.push({
      id: "royalSeal",
      name: "Royal Seal",
      // Its own contribution is the face value above the base point each sealed
      // die already scored under Scoring, hence the split with displayPoints.
      points: BigInt(royalSealBonus),
      displayPoints: BigInt(royalSealScoringCount + royalSealBonus),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  if (agg.faceValueBonus > 0) {
    modifiers.push({
      id: "scales",
      name: "The Scales",
      points: BigInt(agg.faceValueBonus),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  const extraPointBonus =
    scoringCount * extraPointsFor(state, opts.afflictions);
  if (extraPointBonus > 0) {
    modifiers.push({
      id: "extraPoint",
      name: "Deeper Stillness",
      points: BigInt(extraPointBonus),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  const keenEdge = keenEdgeFor(state, opts.afflictions);
  const keenEdgeBonus = keenEdge > 0 ? scoringD1Count * keenEdge * 2 : 0;
  if (keenEdgeBonus > 0) {
    modifiers.push({
      id: "keenEdge",
      name: "Enlightenment",
      points: BigInt(keenEdgeBonus),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  if (snakeEyesFor(state, opts.afflictions)) {
    let bonus = 0n;
    for (const [value, count] of valueCounts)
      if (count >= 2) bonus += BigInt(value) * BigInt(count);
    if (bonus > 0n) {
      modifiers.push({
        id: "snakeEyes",
        name: "Consensus",
        points: bonus,
        color: COLORS.glowGreen,
        dice: noDice,
        bigPulse: false,
        float: "aggregate",
      });
    }
  }

  const jackpot = jackpotFor(state, opts.afflictions);
  const jackpotSets = Math.floor(scoringCount / JACKPOT_DICE);
  if (jackpot > 0 && jackpotSets > 0) {
    modifiers.push({
      id: "jackpot",
      name: "The Congregation",
      points: BigInt(jackpotSets * JACKPOT_POINTS * jackpot),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: true,
      float: "aggregate",
    });
  }

  const voices = state.hasCounterpoint
    ? 0
    : voiceDice(valueCounts, agg.voiceValueCounts);
  if (voices > 0) {
    modifiers.push({
      id: "aNewVoice",
      name: "A New Voice",
      points: BigInt(voices * (1 + extraPointsFor(state, opts.afflictions))),
      color: COLORS.glow,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  const counterpoint = state.hasCounterpoint
    ? counterpointDice(valueCounts, agg.scoringValueCounts)
    : 0;
  if (counterpoint > 0) {
    modifiers.push({
      id: "counterpoint",
      name: "Counterpoint",
      points: BigInt(
        counterpoint * (1 + extraPointsFor(state, opts.afflictions)),
      ),
      color: COLORS.glow,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  if (agg.windfallMult > 1n) {
    // Display-only: points 0, factor folded into the run multiplier below.
    modifiers.push({
      id: "windfall",
      name: "Windfall",
      points: 0n,
      displayPoints: BigInt(agg.windfallScoringCount),
      mult: agg.windfallMult,
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: true,
      float: "perDie",
    });
  }

  const rollScored = modifiers.some((m) => m.points > 0n);
  state.scoreStreak = rollScored ? state.scoreStreak + 1 : 0;
  state.momentumStreak =
    state.momentum > 0 && rollScored ? state.momentumStreak + 1 : 0;
  if (state.momentum > 0 && rollScored) {
    modifiers.push({
      id: "momentum",
      name: "Rhythm",
      points: BigInt(state.momentumStreak * state.momentum * 2),
      color: COLORS.glowGreen,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  if (state.pocketChange > 0) {
    modifiers.push({
      id: "pocketChange",
      name: "Small Mercies",
      points: BigInt(2 * state.pocketChange),
      color: COLORS.glow,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }
  const solitude = solitudePoints(state, agg.total);
  if (solitude > 0) {
    modifiers.push({
      id: "solitude",
      name: "Solitude",
      points: BigInt(solitude),
      color: COLORS.glow,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }
  const dividendPoints = state.dividend * Math.floor(agg.total / 3);
  if (dividendPoints > 0) {
    modifiers.push({
      id: "dividend",
      name: "Strength in Numbers",
      points: BigInt(dividendPoints),
      color: COLORS.glow,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  const subtotal = modifiers.reduce((sum, m) => sum + m.points, 0n);
  const paradeActive =
    state.hasParade &&
    valueCounts.has(1) &&
    valueCounts.has(2) &&
    valueCounts.has(3);
  const menagerieActive = state.hasMenagerie && agg.scoringSizes.size >= 3;
  const uniformActive =
    state.hasUniform && agg.total > 0 && agg.allSizes.size === 1;
  const hourglassActive = state.hasHourglass && isHourglassRoll(state);
  const downbeatActive = state.downbeat > 0 && isDownbeatRoll(state);
  const hairTriggerActive = state.hasHairTrigger && isFirstRoll(state);
  const luckySevenActive =
    luckySevenFor(state, opts.afflictions) && showsASeven(valueCounts);
  const treeMults = treeMultipliers(state, agg);
  const multiplier = applyMultiplierPenalty(
    state,
    flatMultiplier(state) *
      3n ** BigInt(state.prism) *
      (opts.finalRoll ? 4n ** BigInt(state.lastCall) : 1n) *
      (paradeActive ? 2n : 1n) *
      (menagerieActive ? 2n : 1n) *
      (uniformActive ? 3n : 1n) *
      (hourglassActive ? 2n : 1n) *
      (downbeatActive ? DOWNBEAT_MULT ** BigInt(state.downbeat) : 1n) *
      (hairTriggerActive ? HAIR_TRIGGER_MULT : 1n) *
      (luckySevenActive ? LUCKY_SEVEN_MULT : 1n) *
      treeMultiplierProduct(treeMults) *
      agg.windfallMult,
    opts.afflictions,
  );

  modifiers.push(...flatMultiplierModifiers(state));
  modifiers.push(...treeMultiplierModifiers(treeMults));
  if (state.prism > 0) {
    modifiers.push({
      id: "prism",
      name: "Clarity",
      points: 0n,
      mult: 3n ** BigInt(state.prism),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (opts.finalRoll && state.lastCall > 0) {
    modifiers.push({
      id: "lastCall",
      name: "Vespers",
      points: 0n,
      mult: 4n ** BigInt(state.lastCall),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (downbeatActive) {
    modifiers.push({
      id: "downbeat",
      name: "The Toll",
      points: 0n,
      mult: DOWNBEAT_MULT ** BigInt(state.downbeat),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (hairTriggerActive) {
    modifiers.push({
      id: "hairTrigger",
      name: "First Light",
      points: 0n,
      mult: HAIR_TRIGGER_MULT,
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: true,
      float: "aggregate",
    });
  }
  if (paradeActive) {
    modifiers.push({
      id: "parade",
      name: "The Procession",
      points: 0n,
      mult: 2n,
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (menagerieActive) {
    modifiers.push({
      id: "menagerie",
      name: "The Whole Order",
      points: 0n,
      mult: 2n,
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }
  if (uniformActive) {
    modifiers.push({
      id: "uniform",
      name: "Of One Mind",
      points: 0n,
      mult: 3n,
      color: COLORS.goldLight,
      dice: noDice,
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
      dice: noDice,
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
      dice: noDice,
      bigPulse: true,
      float: "aggregate",
    });
  }
  const multiplied = subtotal * multiplier;
  const { points, shares } = growRoll(state, multiplied, {
    groups: agg.vigil,
    scoring: agg.scoringCount,
    total: agg.total,
  });
  const growth = points - multiplied;
  modifiers.push(...growthModifiers(shares));
  return { points, multiplier, modifiers, growth, growthShares: shares };
}
