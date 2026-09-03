import { COLORS } from "../art/palette";
import {
  applyMultiplierPenalty,
  extraPointsFor,
  jackpotFor,
  keenEdgeFor,
  luckySevenFor,
  snakeEyesFor,
  suppresses,
} from "./Afflictions";
import { Die } from "./Dice";
import { RunState } from "../state/RunState";
import {
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
): DiceAgg {
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
    if (k < inert) continue;
    valueCounts.set(die.value, (valueCounts.get(die.value) ?? 0) + 1);
    const windfallHit =
      die.maxFaceBonus > 0 && !die.loaded && die.value === die.sides;
    const royalSealHit = sealed.has(die.sides) && die.value === die.sides;
    const numberScores = scoring.has(die.value);
    if (numberScores || die.wildFace || windfallHit || royalSealHit) {
      scoringCount += 1;
      scoringSizes.add(die.sides);
      if (die.sides === 1) scoringD1Count += 1;
      if (numberScores && die.value !== 1) extraNumberScoringCount += 1;
      else if (!numberScores && die.wildFace) wildFaceScoringCount += 1;
      else if (!numberScores && !die.wildFace && windfallHit)
        windfallScoringCount += 1;
      else if (!numberScores && !die.wildFace && !windfallHit && royalSealHit)
        royalSealScoringCount += 1;
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

/** Box–Muller standard normal. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
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
): DiceAgg {
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
    const faces = b.loaded ? Math.max(1, b.sides - 2) : b.sides;
    const faceCounts = sampleFaceCounts(b.count, faces, rng);
    for (let v = 1; v <= faces; v++) {
      const c = faceCounts[v - 1];
      if (c === 0) continue;
      valueCounts.set(v, (valueCounts.get(v) ?? 0) + c);
      const windfallHit = b.maxFaceBonus > 0 && !b.loaded && v === b.sides;
      const royalSealHit = sealed.has(b.sides) && v === b.sides;
      const numberScores = scoring.has(v);
      if (numberScores || b.wildFace || windfallHit || royalSealHit) {
        scoringCount += c;
        scoringSizes.add(b.sides);
        if (b.sides === 1) scoringD1Count += c;
        if (numberScores && v !== 1) extraNumberScoringCount += c;
        else if (!numberScores && b.wildFace) wildFaceScoringCount += c;
        else if (!numberScores && !b.wildFace && windfallHit)
          windfallScoringCount += c;
        else if (!numberScores && !b.wildFace && !windfallHit && royalSealHit)
          royalSealScoringCount += c;
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
  };
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
  const silenced = suppresses(state, "extraNumber");
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

  const extraPointBonus = scoringCount * extraPointsFor(state);
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

  const keenEdge = keenEdgeFor(state);
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

  if (snakeEyesFor(state)) {
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

  const jackpot = jackpotFor(state);
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
  const luckySevenActive = luckySevenFor(state) && showsASeven(valueCounts);
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
      agg.windfallMult,
  );

  modifiers.push(...flatMultiplierModifiers(state));
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
  return { points: subtotal * multiplier, multiplier, modifiers };
}
