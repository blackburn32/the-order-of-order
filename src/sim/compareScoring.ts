/**
 * Side-by-side of the per-die scorer vs. the histogram/bucket scorer.
 *   npx tsx src/sim/compareScoring.ts
 *
 * Part 1 proves the two produce identical point totals on the same rolled dice.
 * Part 2 times the per-die roll+score path against the bucketed path as the dice
 * count explodes, so you can see where the linear cost stops mattering.
 *
 * Both scorers now read their dice explicitly (not state.dice, a bucketable pool)
 * and return bigint points.
 */
import { makeDie, rollAll, Die, DieSides, DIE_LADDER } from "../systems/Dice";
import { newRun, RunState } from "../state/RunState";
import { scoreRoll, ScoreModifier } from "../systems/Scoring";
import {
  aggFromDice,
  bucketDice,
  rollBucketsToAgg,
  scoreRollHistogram,
} from "../systems/ScoringHistogram";

/** A seeded RNG so the correctness check is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A scenario carries its dice separately from the RunState — the scorers take
 *  the dice array / agg directly, and state.dice (a DicePool) is left untouched. */
interface Scenario {
  name: string;
  state: RunState;
  dice: Die[];
  finalRoll: boolean;
}

function make(patch: Partial<RunState>): RunState {
  return { ...newRun(), ...patch };
}

function scenarios(): Scenario[] {
  const many = (n: number, sides: DieSides, opts = {}) =>
    Array.from({ length: n }, () => makeDie(sides, opts));
  const s = (
    name: string,
    dice: Die[],
    patch: Partial<RunState> = {},
    finalRoll = false,
  ): Scenario => ({ name, state: make(patch), dice, finalRoll });
  return [
    s("plain d6 x50", many(50, 6)),
    s("extra numbers + points", many(80, 6), {
      scoringNumbers: [1, 2, 3],
      extraNumberCount: 2,
      extraPoints: 3,
    }),
    s("keen edge on d1s", [...many(40, 1), ...many(40, 6)], { keenEdge: 4 }),
    s("snake eyes", many(60, 6), { hasSnakeEyes: true }),
    s("jackpot x3", many(120, 4), { jackpot: 3 }),
    s("windfall dice", [
      ...many(30, 20, { maxFaceBonus: true }),
      ...many(30, 6),
    ]),
    s("windfall d20+d100 (×2·×4)", [
      ...many(60, 20, { maxFaceBonus: true }),
      ...many(400, 100, { maxFaceBonus: true }),
      ...many(30, 6),
    ]),
    s(
      "loaded maxface (no windfall)",
      many(40, 6, { maxFaceBonus: true, loaded: true }),
    ),
    s("wild faces", [...many(20, 8, { wildFace: true }), ...many(20, 6)]),
    s("momentum streak", many(50, 6), {
      momentum: 2,
      scoreStreak: 7,
      momentumStreak: 4,
    }),
    s("pocket + dividend", many(90, 6), { pocketChange: 3, dividend: 2 }),
    s("prism + amplifier", many(50, 6), { prism: 2, hasAmplifier: true }),
    s("last call final roll", many(50, 6), { lastCall: 2 }, true),
    s("lucky seven digits", many(500, 100), { hasLuckySeven: true }),
    s(
      "royal seal scoring",
      [...many(80, 6), ...many(80, 20)],
      { royalSealSizes: [6, 20], extraPoints: 2 },
    ),
    s(
      "parade + menagerie",
      [...many(80, 4), ...many(80, 6), ...many(80, 8)],
      {
        scoringNumbers: [1, 2, 3],
        hasParade: true,
        hasMenagerie: true,
      },
    ),
    s("uniform + hourglass", many(100, 6), {
      hasUniform: true,
      hasHourglass: true,
      roll: 0,
    }),
    s(
      "kitchen sink",
      [
        ...many(40, 6, { maxFaceBonus: true }),
        ...many(20, 1),
        ...many(20, 20, { wildFace: true }),
        ...many(20, 4),
      ],
      {
        scoringNumbers: [1, 2, 3],
        extraPoints: 2,
        keenEdge: 3,
        hasSnakeEyes: true,
        jackpot: 2,
        momentum: 1,
        pocketChange: 1,
        dividend: 1,
        prism: 1,
        hasAmplifier: true,
        lastCall: 1,
        royalSealSizes: [4, 6],
        hasLuckySeven: true,
        hasParade: true,
        hasMenagerie: true,
        hasUniform: false,
        hasHourglass: true,
      },
      true,
    ),
  ];
}

function modMap(
  mods: ScoreModifier[],
): Record<string, { points: bigint; displayPoints: bigint; mult: bigint }> {
  const m: Record<
    string,
    { points: bigint; displayPoints: bigint; mult: bigint }
  > = {};
  for (const x of mods) {
    const current = m[x.id] ?? {
      points: 0n,
      displayPoints: 0n,
      mult: 1n,
    };
    current.points += x.points;
    current.displayPoints += x.displayPoints ?? 0n;
    current.mult *= x.mult ?? 1n;
    m[x.id] = current;
  }
  return m;
}

function correctness(): boolean {
  console.log(
    "\n=== Part 1: correctness (same rolled dice, both scorers) ===\n",
  );
  const rng = mulberry32(1234);
  let allOk = true;
  console.log(
    "scenario".padEnd(30),
    "orig total".padStart(14),
    "hist total".padStart(14),
    "  result",
  );
  for (const { name, state, dice, finalRoll } of scenarios()) {
    rollAll(dice, rng);
    const scoreStreakBefore = state.scoreStreak;
    const momentumStreakBefore = state.momentumStreak;

    const orig = scoreRoll(state, dice, { finalRoll });
    const streaksAfterOrig = [state.scoreStreak, state.momentumStreak];

    state.scoreStreak = scoreStreakBefore; // replay on identical dice
    state.momentumStreak = momentumStreakBefore;
    const agg = aggFromDice(
      dice,
      state.scoringNumbers,
      state.royalSealSizes,
    );
    const hist = scoreRollHistogram(state, agg, { finalRoll });
    const streaksAfterHist = [state.scoreStreak, state.momentumStreak];

    const totalsOk =
      orig.points === hist.points && orig.multiplier === hist.multiplier;
    const streakOk =
      streaksAfterOrig[0] === streaksAfterHist[0] &&
      streaksAfterOrig[1] === streaksAfterHist[1];
    const om = modMap(orig.modifiers);
    const hm = modMap(hist.modifiers);
    const modsOk = [...new Set([...Object.keys(om), ...Object.keys(hm)])].every(
      (k) =>
        (om[k]?.points ?? 0n) === (hm[k]?.points ?? 0n) &&
        (om[k]?.displayPoints ?? 0n) === (hm[k]?.displayPoints ?? 0n) &&
        (om[k]?.mult ?? 1n) === (hm[k]?.mult ?? 1n),
    );
    const ok = totalsOk && streakOk && modsOk;
    allOk &&= ok;
    console.log(
      name.padEnd(30),
      String(orig.points).padStart(14),
      String(hist.points).padStart(14),
      ok
        ? "  ✓"
        : `  ✗ ${!totalsOk ? "totals " : ""}${!streakOk ? "streak " : ""}${!modsOk ? "mods" : ""}`,
    );
  }
  console.log(`\n${allOk ? "ALL MATCH ✓" : "MISMATCH ✗"}`);
  return allOk;
}

/** A realistic-ish mixed grid: spread across the die ladder with some special dice. */
function mixedDice(n: number): Die[] {
  const dice: Die[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const sides = DIE_LADDER[i % DIE_LADDER.length] as DieSides;
    const opts =
      i % 11 === 0
        ? { maxFaceBonus: true }
        : i % 17 === 0
          ? { wildFace: true }
          : i % 23 === 0
            ? { loaded: true }
            : {};
    dice[i] = makeDie(sides, opts, i % 5 === 0 ? "genesis" : "starter");
  }
  return dice;
}

function timeIt(fn: () => void, iters: number): number {
  fn(); // warm up / JIT
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

function scaling(): void {
  console.log("\n=== Part 2: roll + score time as dice count grows ===\n");
  console.log(
    "dice".padStart(10),
    "buckets".padStart(9),
    "per-die ms".padStart(12),
    "bucketed ms".padStart(13),
    "speedup".padStart(9),
  );
  const counts = [100, 1_000, 10_000, 100_000, 1_000_000];
  for (const n of counts) {
    const state = make({
      scoringNumbers: [1, 2, 3],
      hasSnakeEyes: true,
      jackpot: 2,
      keenEdge: 2,
      extraPoints: 1,
      dividend: 1,
    });
    const dice = mixedDice(n);
    const buckets = bucketDice(dice); // built once, reused (as you'd maintain it)
    const iters = n >= 100_000 ? 5 : 50;

    const perDie = timeIt(() => {
      rollAll(dice);
      scoreRoll(state, dice);
    }, iters);

    const bucketed = timeIt(() => {
      const agg = rollBucketsToAgg(
        buckets,
        state.scoringNumbers,
        Math.random,
        state.royalSealSizes,
      );
      scoreRollHistogram(state, agg);
    }, iters);

    console.log(
      String(n).padStart(10),
      String(buckets.length).padStart(9),
      perDie.toFixed(3).padStart(12),
      bucketed.toFixed(3).padStart(13),
      `${(perDie / bucketed).toFixed(1)}x`.padStart(9),
    );
  }
}

correctness();
scaling();
