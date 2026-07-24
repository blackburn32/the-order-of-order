import { COLORS } from "../art/palette";
import { Die } from "./Dice";
import { RunState } from "../state/RunState";
import {
  countSevens,
  isHourglassRoll,
  RollResult,
  ScoreModifier,
  ScoreOpts,
} from "./Scoring";

/** Aggregate view of a rolled dice grid — everything scoreRoll actually needs,
 *  and nothing per-die. Building this is the only step whose cost depends on how
 *  the aggregate was produced: O(dice) if summarised from a Die[] (small counts),
 *  O(types × faces) if sampled straight from buckets (huge counts). Once you hold
 *  a DiceAgg, scoring is O(distinct face values) regardless of dice count. */
export interface DiceAgg {
  total: number; // dice.length
  valueCounts: Map<number, number>; // face value -> how many dice show it (all dice)
  scoringCount: number; // dice whose face is a scoring number, or that are wild
  scoringD1Count: number; // of those, how many are d1 (drives Keen Edge)
  extraNumberScoringCount: number; // scoring faces above 1 enabled by Extra Number
  wildFaceScoringCount: number; // dice that scored only because they are wild
  royalSealScoringCount: number; // dice that scored only because Royal Seal matched their maximum
  windfallScoringCount: number; // dice that scored only because top-face Windfall hit
  allSizes: Set<number>; // distinct die sizes present in the grid
  scoringSizes: Set<number>; // distinct die sizes that scored this roll
  windfallMult: bigint; // Π of the distinct Rollplayer/Centurion factors that
  // hit their current top face this roll (1n when none did)
}

/** O(dice) bridge from the existing per-die array to a DiceAgg. Use this below
 *  the bucketing threshold and to verify the sampled path against real rolls.
 *  Mirrors the scoring-detection logic in Scoring.ts exactly. */
export function aggFromDice(
  dice: Die[],
  scoringNumbers: number[],
  royalSealSizes: readonly number[] = [],
): DiceAgg {
  const valueCounts = new Map<number, number>();
  let scoringCount = 0;
  let scoringD1Count = 0;
  let extraNumberScoringCount = 0;
  let wildFaceScoringCount = 0;
  let royalSealScoringCount = 0;
  let windfallScoringCount = 0;
  const windfallFactors = new Set<number>();
  const scoring = new Set(scoringNumbers);
  const sealed = new Set(royalSealSizes);
  const allSizes = new Set<number>();
  const scoringSizes = new Set<number>();
  for (const die of dice) {
    allSizes.add(die.sides);
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
    if (windfallHit) windfallFactors.add(die.maxFaceBonus);
  }
  let windfallMult = 1n;
  for (const factor of windfallFactors) windfallMult *= BigInt(factor);
  return {
    total: dice.length,
    valueCounts,
    scoringCount,
    scoringD1Count,
    extraNumberScoringCount,
    wildFaceScoringCount,
    royalSealScoringCount,
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
      // Windfall only fires on a die's own top face; a loaded die (faces < sides)
      // can never show it, matching rollDie's behaviour.
      if (windfallHit) windfallFactors.add(b.maxFaceBonus);
    }
  }
  let windfallMult = 1n;
  for (const factor of windfallFactors) windfallMult *= BigInt(factor);
  return {
    total,
    valueCounts,
    scoringCount,
    scoringD1Count,
    extraNumberScoringCount,
    wildFaceScoringCount,
    royalSealScoringCount,
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

  // Raw counts (scoringCount, valueCounts) stay Number — exact to ~9e15 dice —
  // but every points value is BigInt, since value×count and the multiplier stack
  // blow past Number.MAX_SAFE_INTEGER well before dice counts do.
  const basePoints = agg.scoringCount;
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

  if (agg.extraNumberScoringCount > 0) {
    modifiers.push({
      id: "extraNumber",
      name: "Extra Number",
      points: 0n,
      displayPoints: BigInt(agg.extraNumberScoringCount),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  if (agg.wildFaceScoringCount > 0) {
    modifiers.push({
      id: "wildFace",
      name: "Wild Face",
      points: 0n,
      displayPoints: BigInt(agg.wildFaceScoringCount),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  if (agg.royalSealScoringCount > 0) {
    modifiers.push({
      id: "royalSeal",
      name: "Royal Seal",
      points: 0n,
      displayPoints: BigInt(agg.royalSealScoringCount),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  const extraPointBonus = agg.scoringCount * state.extraPoints;
  if (extraPointBonus > 0) {
    modifiers.push({
      id: "extraPoint",
      name: "Extra Point",
      points: BigInt(extraPointBonus),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  const keenEdgeBonus =
    state.keenEdge > 0 ? agg.scoringD1Count * state.keenEdge * 2 : 0;
  if (keenEdgeBonus > 0) {
    modifiers.push({
      id: "keenEdge",
      name: "Keen Edge",
      points: BigInt(keenEdgeBonus),
      color: COLORS.goldLight,
      dice: noDice,
      bigPulse: false,
      float: "aggregate",
    });
  }

  if (state.hasSnakeEyes) {
    let bonus = 0n;
    for (const [value, count] of agg.valueCounts)
      if (count >= 2) bonus += BigInt(value) * BigInt(count);
    if (bonus > 0n) {
      modifiers.push({
        id: "snakeEyes",
        name: "Snake Eyes",
        points: bonus,
        color: COLORS.glowGreen,
        dice: noDice,
        bigPulse: false,
        float: "aggregate",
      });
    }
  }

  if (state.jackpot > 0) {
    let bonus = 0n;
    for (const [value, count] of agg.valueCounts)
      if (count >= 3) bonus += BigInt(value) * BigInt(count);
    if (bonus > 0n) {
      modifiers.push({
        id: "jackpot",
        name: "Jackpot",
        points: bonus * BigInt(state.jackpot),
        color: COLORS.goldLight,
        dice: noDice,
        bigPulse: true,
        float: "aggregate",
      });
    }
  }

  if (state.hasLuckySeven) {
    let bonus = 0n;
    for (const [value, count] of agg.valueCounts)
      bonus += BigInt(countSevens(value) * 7) * BigInt(count);
    if (bonus > 0n) {
      modifiers.push({
        id: "luckySeven",
        name: "Lucky Seven",
        points: bonus,
        color: COLORS.goldLight,
        dice: noDice,
        bigPulse: true,
        float: "aggregate",
      });
    }
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
      name: "Momentum",
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
      name: "Pocket Change",
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
      name: "Dividend",
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
    agg.valueCounts.has(1) &&
    agg.valueCounts.has(2) &&
    agg.valueCounts.has(3);
  const menagerieActive =
    state.hasMenagerie && agg.scoringSizes.size >= 3;
  const uniformActive =
    state.hasUniform && agg.total > 0 && agg.allSizes.size === 1;
  const hourglassActive = state.hasHourglass && isHourglassRoll(state);
  const multiplier =
    (state.hasAmplifier ? 2n : 1n) *
    3n ** BigInt(state.prism) *
    (opts.finalRoll ? 4n ** BigInt(state.lastCall) : 1n) *
    (paradeActive ? 2n : 1n) *
    (menagerieActive ? 2n : 1n) *
    (uniformActive ? 3n : 1n) *
    (hourglassActive ? 2n : 1n) *
    agg.windfallMult;

  if (state.hasAmplifier) {
    modifiers.push({
      id: "amplifier",
      name: "Amplifier",
      points: 0n,
      mult: 2n,
      color: COLORS.goldLight,
      dice: noDice,
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
      dice: noDice,
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
      dice: noDice,
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
      dice: noDice,
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
      dice: noDice,
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
  return { points: subtotal * multiplier, multiplier, modifiers };
}
