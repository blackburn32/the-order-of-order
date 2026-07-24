import { survivalTarget } from "../config";
import { newRun } from "../state/RunState";
import { makeDie } from "../systems/Dice";
import { applyOffer, offerFor, rollShopOffers } from "../systems/Shop";
import { scoreRoll } from "../systems/Scoring";
import { resolveRoll, resolveRoundEnd } from "./engine";

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
  const offer = { ...offerFor("royal_seal", state), cost: 0n };
  check(applyOffer(state, offer, 0), "Royal Seal purchase should succeed");
  check(state.royalSealSizes.includes(6), "Royal Seal should remember d6");
  state.dice.roll(() => 0.999, state.scoringNumbers, state.royalSealSizes);
  const { result } = resolveRoll(state, () => 0);
  check(result.points === 1n, "A Royal-Sealed d6 maximum should score");
  check(
    result.modifiers.some((mod) => mod.id === "royalSeal"),
    "Royal Seal should appear in the score breakdown",
  );
}

// Conditional multipliers remain separate, visible score components.
{
  const parade = newRun();
  parade.hasParade = true;
  const paradeResult = scoreRoll(parade, [
    die(6, 1),
    die(6, 2),
    die(6, 3),
  ]);
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
  state.round = 2;
  state.hasInsurancePolicy = true;
  state.ownedUnique.push("insurance_policy");
  state.purchases.insurance_policy = 1;
  const target = survivalTarget(state.round, state.hardMode);
  state.score = (target * 3n + 3n) / 4n;
  const outcome = resolveRoundEnd(state);
  check(outcome.phase === "advanced", "Insurance should clear a 75% round");
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
  state.score = 1_000_000n;
  let seed = 0x12345678;
  const rng = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const offers = rollShopOffers(state, 5, rng);
  const freebies = offers.filter((offer) => offer.freeByCoupon);
  check(freebies.length === 1, "Coupon Book should free one random paid card");
  check(freebies[0].cost === 0n, "Coupon Book card should cost zero");
}

// Brick Mold creates a source-tagged d6 after scoring, for the scene indicator.
{
  const state = newRun();
  state.brickMold = 1;
  const before = state.dice.length;
  state.dice.roll(() => 0, state.scoringNumbers, state.royalSealSizes);
  const outcome = resolveRoll(state, () => 0);
  check(outcome.spawnedBySource.brickMold === 1, "Brick Mold should report one d6");
  check(state.dice.length === before + 1, "Brick Mold should grow the grid");
  check(
    state.dice.dieAt(state.dice.length - 1)?.source === "brick_mold",
    "Brick Mold d6 should carry its item source",
  );
}

console.log("Item mechanics check: ALL PASS");
