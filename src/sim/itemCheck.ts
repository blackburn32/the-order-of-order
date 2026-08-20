import { STARTING_DICE } from "../config";
import { newRun } from "../state/RunState";
import { applyDeadDice, goalFor } from "../systems/Boss";
import { makeDie } from "../systems/Dice";
import {
  applyOffer,
  offerFor,
  rerollShopOffers,
  rollShopOffers,
} from "../systems/Shop";
import { scoreRoll } from "../systems/Scoring";
import { scoreRollHistogram } from "../systems/ScoringHistogram";
import { resolveRoll, resolveTrialEnd } from "./engine";

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function die(sides: 4 | 6 | 8 | 100, value: number) {
  const d = makeDie(sides);
  d.value = value;
  return d;
}

// Lucky Seven counts every written 7, not merely values divisible by seven.
{
  const state = newRun();
  state.hasLuckySeven = true;
  const result = scoreRoll(state, [
    die(100, 7),
    die(100, 17),
    die(100, 27),
    die(100, 77),
  ]);
  const lucky = result.modifiers.find((mod) => mod.id === "luckySeven");
  check(lucky?.points === 35n, "Lucky Seven should score 7+7+7+14");
}

// Royal Seal is a size aura and its scoring face feeds the ordinary scorer.
{
  const state = newRun();
  const offer = { ...offerFor("royal_seal", state), cost: 0 };
  check(applyOffer(state, offer, 0), "Royal Seal purchase should succeed");
  check(state.royalSealSizes.includes(6), "Royal Seal should remember d6");
  state.dice.roll(() => 0.999, state.scoringNumbers, state.royalSealSizes);
  const { result } = resolveRoll(state, () => 0);
  // Every starting die is a d6 and every one of them rolls its maximum here, so
  // the seal should score the whole opening grid.
  check(
    result.points === BigInt(STARTING_DICE),
    "A Royal-Sealed d6 maximum should score",
  );
  check(
    result.modifiers.some((mod) => mod.id === "royalSeal"),
    "Royal Seal should appear in the score breakdown",
  );
}

// Conditional multipliers remain separate, visible score components.
{
  const parade = newRun();
  parade.hasParade = true;
  const paradeResult = scoreRoll(parade, [die(6, 1), die(6, 2), die(6, 3)]);
  check(paradeResult.points === 2n, "Parade should double a 1/2/3 roll");

  const menagerie = newRun();
  menagerie.hasMenagerie = true;
  const menagerieResult = scoreRoll(menagerie, [
    die(4, 1),
    die(6, 1),
    die(8, 1),
  ]);
  check(
    menagerieResult.points === 6n,
    "Menagerie should double three scoring sizes",
  );

  const uniform = newRun();
  uniform.hasUniform = true;
  uniform.hasHourglass = true;
  const uniformResult = scoreRoll(uniform, [die(6, 1)]);
  check(
    uniformResult.points === 6n,
    "Uniform and Hourglass should compound to x6",
  );
}

// Insurance clears at the exact 75% comparison and is removed after use.
{
  const state = newRun();
  // Deep enough that 75% of the goal is a distinct value from the goal itself —
  // the early goals are single digits, where the rounded-up 75% lands ON the
  // goal and the trial simply clears.
  state.trial = 12;
  state.hasInsurancePolicy = true;
  state.ownedUnique.push("insurance_policy");
  state.purchases.insurance_policy = 1;
  const goal = goalFor(state);
  state.score = (goal * 3n + 3n) / 4n;
  const outcome = resolveTrialEnd(state);
  check(outcome.phase === "advanced", "Insurance should clear a 75% trial");
  check(outcome.insuranceUsed, "Insurance use should be reported");
  check(!state.hasInsurancePolicy, "Insurance should be destroyed");
  check(
    !state.ownedUnique.includes("insurance_policy"),
    "Destroyed Insurance should be purchasable again",
  );
}

// Coupon Book marks exactly one otherwise-paid offer as the free random card.
{
  const state = newRun();
  state.hasCouponBook = true;
  state.gold = 1_000;
  let seed = 0x12345678;
  const rng = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const offers = rollShopOffers(state, 5, rng);
  const freebies = offers.filter((offer) => offer.freeByCoupon);
  check(freebies.length === 1, "Coupon Book should free one random paid card");
  check(freebies[0].cost === 0, "Coupon Book card should cost zero");
}

// Two Bricks is an initial-shop safety net, never a reroll reward.
{
  const state = newRun();
  state.gold = 0;
  let seed = 0x9e3779b9;
  const rng = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let i = 0; i < 100; i++) {
    const offers = rerollShopOffers(state, 5, rng);
    check(
      !offers.some((offer) => offer.id === "extra_die"),
      "Rerolls should never offer Two Bricks",
    );
  }
}

// Brick Mold creates a source-tagged d6 after scoring, for the scene indicator.
{
  const state = newRun();
  state.brickMold = 1;
  const before = state.dice.length;
  state.dice.roll(() => 0, state.scoringNumbers, state.royalSealSizes);
  const outcome = resolveRoll(state, () => 0);
  check(
    outcome.spawnedBySource.brickMold === 1,
    "Brick Mold should report one d6",
  );
  check(state.dice.length === before + 1, "Brick Mold should grow the grid");
  check(
    state.dice.dieAt(state.dice.length - 1)?.source === "brick_mold",
    "Brick Mold d6 should carry its item source",
  );
}

// --- Boss modifiers ---------------------------------------------------------

// The Toll takes a tenth of the grid out of play. Defined on the aggregate, so
// a hundred dice under it must score exactly what ninety dice score without it —
// that equivalence is what lets it mean the same thing once the pool is
// bucketed and individual dice no longer exist.
{
  const tolled = newRun();
  tolled.trial = 3;
  tolled.bossModifier = "toll";
  tolled.dice.addDice(6, 99, {}, "test"); // 100 dice
  tolled.dice.roll(() => 0, tolled.scoringNumbers, tolled.royalSealSizes);
  const withToll = scoreRollHistogram(tolled, tolled.dice.agg());

  const plain = newRun();
  plain.dice.addDice(6, 89, {}, "test"); // 90 dice
  plain.dice.roll(() => 0, plain.scoringNumbers, plain.royalSealSizes);
  const without = scoreRollHistogram(plain, plain.dice.agg());

  check(
    withToll.points === without.points,
    "The Toll on 100 dice should score exactly what 90 dice score",
  );
  check(
    applyDeadDice(tolled, 100) === 90,
    "The Toll should retire a tenth of a die count",
  );
}

// The Famine switches off the two per-scoring-die bonuses.
{
  const state = newRun();
  state.trial = 3;
  state.extraPoints = 5;
  state.keenEdge = 3;
  state.dice.roll(() => 0, state.scoringNumbers, state.royalSealSizes);
  const free = scoreRollHistogram(state, state.dice.agg());
  state.bossModifier = "famine";
  const starved = scoreRollHistogram(state, state.dice.agg());
  check(
    starved.points < free.points,
    "The Famine should cut Extra Point and Keen Edge",
  );
  check(
    !starved.modifiers.some((mod) => mod.id === "extraPoint"),
    "The Famine should remove Extra Point from the breakdown",
  );
}

// The Eclipse halves the compounded run multiplier, never below x1.
{
  const state = newRun();
  state.trial = 3;
  state.hasAmplifier = true;
  state.prism = 1; // x2 * x3 = x6
  state.dice.roll(() => 0, state.scoringNumbers, state.royalSealSizes);
  const bright = scoreRollHistogram(state, state.dice.agg());
  state.bossModifier = "eclipse";
  const dark = scoreRollHistogram(state, state.dice.agg());
  check(bright.multiplier === 6n, "Amplifier and Prism should compound to x6");
  check(dark.multiplier === 3n, "The Eclipse should halve it to x3");

  const bare = newRun();
  bare.trial = 3;
  bare.bossModifier = "eclipse";
  bare.dice.roll(() => 0, bare.scoringNumbers, bare.royalSealSizes);
  check(
    scoreRollHistogram(bare, bare.dice.agg()).multiplier === 1n,
    "The Eclipse should floor the multiplier at x1",
  );
}

// The Drought stops every source of new dice for its trial.
{
  const state = newRun();
  state.trial = 3;
  state.bossModifier = "drought";
  state.brickMold = 2;
  state.genesis = 1;
  const before = state.dice.length;
  state.dice.roll(() => 0, state.scoringNumbers, state.royalSealSizes);
  const outcome = resolveRoll(state, () => 0);
  check(outcome.spawnedCount === 0, "The Drought should spawn no dice");
  check(state.dice.length === before, "and leave the grid untouched");
}

// The Hoard raises the goal it has to be measured against.
{
  const plain = newRun();
  plain.trial = 3;
  const hoard = newRun();
  hoard.trial = 3;
  hoard.bossModifier = "hoard";
  check(
    goalFor(hoard) > goalFor(plain),
    "The Hoard should raise its trial's goal",
  );
}

// --- Repurposed and new gold items -----------------------------------------

// Vault and Reserve pay in gold now, not in carried-over score.
{
  const state = newRun();
  state.trial = 1;
  state.score = 1_000_000n;
  state.trialCleared = true;
  state.hasVault = true;
  state.reserve = 2;
  resolveTrialEnd(state);
  check(
    state.score === 0n,
    "Score should reset on advance regardless of Vault or Reserve",
  );
}

// The six gold items apply their flag or counter on purchase.
{
  const goldItems: [string, (s: ReturnType<typeof newRun>) => boolean][] = [
    ["tithe_bowl", (s) => s.titheBowl === 1],
    ["lucky_coin", (s) => s.luckyCoin === 1],
    ["counting_house", (s) => s.countingHouse === 1],
    ["prospector", (s) => s.hasProspector],
    ["reliquary", (s) => s.hasReliquary],
    ["pawnbroker", (s) => s.hasPawnbroker],
  ];
  for (const [id, applied] of goldItems) {
    const state = newRun();
    state.gold = 100;
    const offer = offerFor(id as never, state);
    check(applyOffer(state, offer), `${id} should be purchasable`);
    check(applied(state), `${id} should apply its effect`);
    check(state.purchases[id as never] === 1, `${id} should be recorded`);
  }
}

console.log("Item mechanics check: ALL PASS");
