import {
  isBossTrial,
  MAX_CURSES_PER_OFFER_SET,
  STARTING_DICE,
  WIN_TRIAL,
} from "../config";
import { newRun, type RunState } from "../state/RunState";
import { bossesForRank, goalFor } from "../systems/Boss";
import {
  applyTrialStart,
  enforceGridCap,
  itemDisabledDuringTrialByAffliction,
  ITEMS,
  type ShopItemId,
} from "../systems/Items";
import { makeDie, type DieOpts, type DieSides } from "../systems/Dice";
import { DicePool } from "../systems/DicePool";
import {
  hydrateRunState,
  serializeRunState,
} from "../systems/ActiveRunPersistence";
import {
  applyBoosterChoice,
  applyOffer,
  availableIds,
  BOOSTER_PACKS,
  leaveShop,
  offerFor,
  openBooster,
  shopClosed,
  rerollShopOffers,
  rollShopOffers,
  setItemTreesForSimulation,
  offerDrawWeight,
  isTreeUpgrade,
  metaUnlockOwner,
} from "../systems/Shop";
import {
  CRUNCH_TIME_MULT,
  DOWNBEAT_INTERVAL,
  FLAT_MULTIPLIERS,
  HAIR_TRIGGER_MULT,
  JACKPOT_POINTS,
  scoreRoll,
} from "../systems/Scoring";
import { trialRollTarget } from "../systems/Trial";
import {
  INNER_CIRCLE_POUR,
  setCardReworksForSimulation,
  setGridCurseGoalPerDoublingForSimulation,
} from "../systems/CardReworks";
import { applyGoldCeiling, trialPayout } from "../systems/Gold";
import {
  AFFLICTIONS,
  afflictionsFor,
  CRUNCH_TIME_ROLL_COST,
  fold,
  inertDiceCount,
  isInertIndex,
  type AfflictionId,
  NO_AFFLICTIONS,
} from "../systems/Afflictions";
import { rollsForTrial } from "../config";
import { scoreRollHistogram } from "../systems/ScoringHistogram";
import {
  openTrial,
  prepareDuel,
  resolveRoll,
  resolveTrialEnd,
  rollPool,
} from "./engine";
import { formatMultiplier, rollBreakdown } from "../systems/RollBreakdown";
import { mulberry32 } from "./localStorageShim";

/** A percent → count table, as the growth engines and The Vigil store them. */
function atPercents(counts: Record<number, number>): number[] {
  const table: number[] = [];
  for (const [percent, count] of Object.entries(counts)) {
    while (table.length <= Number(percent)) table.push(0);
    table[Number(percent)] = count;
  }
  return table;
}

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function die(sides: 4 | 6 | 8 | 100, value: number) {
  const d = makeDie(sides);
  d.value = value;
  return d;
}

// The Boss Trial HUD crosses out exactly the cards whose live contribution an
// affliction stops. The mapping follows effect kinds, including trial-time
// growth passives, while an instant purchase whose dice already exist remains
// active inventory rather than being retroactively crossed out.
{
  const item = (id: ShopItemId) => ITEMS.find((def) => def.id === id)!;
  check(
    itemDisabledDuringTrialByAffliction(item("extra_point"), "famine"),
    "Famine should disable Deeper Stillness",
  );
  check(
    itemDisabledDuringTrialByAffliction(item("keen_edge"), "famine"),
    "Famine should disable Enlightenment",
  );
  check(
    itemDisabledDuringTrialByAffliction(item("snake_eyes"), "warden"),
    "Warden should disable Consensus",
  );
  check(
    itemDisabledDuringTrialByAffliction(item("extra_number"), "silence"),
    "Silence should disable Decree",
  );
  check(
    itemDisabledDuringTrialByAffliction(item("genesis"), "drought"),
    "Drought should disable trial-time growth cards",
  );
  check(
    !itemDisabledDuringTrialByAffliction(item("extra_die"), "drought"),
    "Drought should not retroactively disable an instant dice purchase",
  );
  check(
    !itemDisabledDuringTrialByAffliction(item("snake_eyes"), "famine"),
    "Famine should leave unrelated pattern cards active",
  );
  check(
    !itemDisabledDuringTrialByAffliction(item("amplifier"), "eclipse"),
    "Eclipse should halve the total without deactivating Amplifier",
  );
}

// Lucky Seven multiplies the whole roll, on any value with a 7 written in it.
{
  check(
    ITEMS.find((item) => item.id === "lucky_seven")?.rarity === "rare",
    "Lucky Seven should be rare enough for its sevenfold roll multiplier",
  );
  const state = newRun();
  state.hasLuckySeven = true;
  const sevenless = scoreRoll(state, [die(6, 1), die(6, 1)]);
  check(
    sevenless.multiplier === 1n,
    "a roll with no 7 should not be multiplied",
  );

  const state7 = newRun();
  state7.hasLuckySeven = true;
  // Two scoring 1s and a 17 nobody scored: the 7 is in the written value.
  const lucky = scoreRoll(state7, [die(6, 1), die(6, 1), die(100, 17)]);
  check(lucky.multiplier === 7n, "a written 7 should multiply the roll by 7");
  check(lucky.points === 14n, "and multiply the points the roll did score");
  check(
    lucky.modifiers.some((mod) => mod.id === "luckySeven" && mod.mult === 7n),
    "Lucky Seven should appear in the breakdown as a multiplier",
  );
}

// Jackpot pays per full set of scoring dice, and nothing below the threshold.
{
  const four = newRun();
  four.jackpot = 1;
  const shy = scoreRoll(
    four,
    Array.from({ length: 4 }, () => die(6, 1)),
  );
  check(
    !shy.modifiers.some((mod) => mod.id === "jackpot"),
    "four scoring dice should pay no Jackpot",
  );

  const eleven = newRun();
  eleven.jackpot = 2;
  const paid = scoreRoll(
    eleven,
    Array.from({ length: 11 }, () => die(6, 1)),
  );
  const jackpot = paid.modifiers.find((mod) => mod.id === "jackpot");
  check(
    jackpot?.points === BigInt(2 * JACKPOT_POINTS * 2),
    "eleven scoring dice should pay two sets, doubled by two copies",
  );
}

// Without the card reworks (a simulation's baseline), Foundry doubles the
// smallest size on the grid, once per copy owned.
{
  setCardReworksForSimulation(false);
  const state = newRun();
  state.dice.addDice(2, 5, {}, "test");
  state.dice.addDice(20, 3, {}, "test");
  state.foundry = 2; // x4
  const added = applyTrialStart(state);
  check(added === 15, "two Foundry copies should quadruple five d2");
  check(state.dice.countOfSize(2) === 20, "leaving twenty d2");
  check(state.dice.countOfSize(20) === 3, "and the larger dice untouched");
  setCardReworksForSimulation(true);
}

// The trial-start passives wait for the trial to open, not for the last one to
// end: an Inner Circle bought in the shop between the two fires on the very
// next trial, and only once however often that trial is opened.
{
  const state = newRun(); // the starter d6
  state.trialCleared = true;
  resolveTrialEnd(state);
  const before = state.dice.length;
  state.foundry = 1; // bought in the shop that follows
  check(
    openTrial(state) === INNER_CIRCLE_POUR &&
      state.dice.length === before + INNER_CIRCLE_POUR,
    "an Inner Circle bought in the shop should pour into the next trial",
  );
  check(
    openTrial(state) === 0 && state.dice.length === before + INNER_CIRCLE_POUR,
    "and a trial opened again (a resumed save) should not pour twice",
  );
}

// The card reworks: The Inner Circle pours ten of the most common size per copy,
// The Curious copies only a d6 or larger showing its highest face, and the
// stacking multipliers stop at two copies. A simulation's baseline ignores them.
{
  const circle = newRun(); // the starter d6
  circle.dice.addDice(2, 5, {}, "test");
  circle.dice.addDice(20, 3, {}, "test");
  circle.foundry = 2;
  check(
    applyTrialStart(circle) === 20 && circle.dice.countOfSize(2) === 25,
    "a reworked Inner Circle should pour ten of the most common size per copy",
  );
  const emptied = newRun();
  emptied.dice.removeAt(0); // the starter d6, leaving nothing
  emptied.foundry = 1;
  check(
    emptied.dice.length === 0 && applyTrialStart(emptied) === 0,
    "and pour nothing, rather than throw, onto an empty grid",
  );

  const curious = newRun(); // the starter d6
  curious.dice.addDice(4, 3, {}, "test");
  curious.dice.addDice(8, 2, {}, "test");
  curious.dice.roll(() => 0.55, curious.scoringNumbers); // d8s show 5, d6 a 4
  check(
    curious.dice.doubleTheFun(true) === 0,
    "a reworked Curious should not copy a d8 showing 5",
  );
  curious.dice.roll(() => 0.999, curious.scoringNumbers); // every die at its top
  check(
    curious.dice.doubleTheFun(true) === 3 &&
      curious.dice.countOfSize(4) === 3 &&
      curious.dice.countOfSize(8) === 4,
    "but should copy the d6 and d8s at their highest face, and never a d4",
  );
  const chancy = newRun(); // the starter d6
  chancy.dice.addDice(8, 3, {}, "test");
  chancy.dice.roll(() => 0.999, chancy.scoringNumbers); // every die at its top
  check(
    chancy.dice.doubleTheFun(true, 0.5, () => 0.7) === 0 &&
      chancy.dice.doubleTheFun(true, 0.5, () => 0.3) === 4,
    "and, swept below every time, copy each qualifying die only at its chance",
  );

  const stack = newRun();
  stack.shopUnlocks.push("momentum"); // Resonance's root, which unlocks its tree
  stack.purchases.downbeat = 1; // the tier-2 card that opens Vespers
  stack.purchases.last_call = 1;
  check(
    availableIds(stack).includes("last_call"),
    "a reworked Vespers should still sell a second copy",
  );
  stack.purchases.last_call = 2;
  check(!availableIds(stack).includes("last_call"), "but not a third");
  stack.shopUnlocks.push("hair_trigger");
  check(
    !availableIds(stack).includes("hair_trigger"),
    "and Hair Trigger should be retired from the reworked shop",
  );
  setCardReworksForSimulation(false);
  check(
    availableIds(stack).includes("last_call") &&
      availableIds(stack).includes("hair_trigger"),
    "and a baseline without the reworks should ignore them",
  );
  setCardReworksForSimulation(true);
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
  // the seal should pay each of them its own face value.
  check(
    result.points === BigInt(STARTING_DICE) * 6n,
    "A Royal-Sealed d6 maximum should score the face, not a flat point",
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

  const unclaimedReroll = rerollShopOffers(state, 5, rng);
  check(
    unclaimedReroll.filter((offer) => offer.freeByCoupon).length === 1,
    "Coupon Book should follow an unclaimed freebie onto a rerolled row",
  );

  const claimedReroll = rerollShopOffers(state, 5, rng, undefined, false);
  check(
    !claimedReroll.some((offer) => offer.freeByCoupon),
    "Coupon Book should not award another freebie after one was claimed",
  );
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
    const initial = rollShopOffers(state, 5, rng);
    check(
      initial.some((offer) => offer.id === "extra_die"),
      "A free curse must not suppress the Two Bricks safety net",
    );
    const offers = rerollShopOffers(state, 5, rng);
    check(
      !offers.some((offer) => offer.id === "extra_die"),
      "Rerolls should never offer Two Bricks",
    );
  }
}

// A reveal set never carries more than one curse, whether it is a shelf, a
// rarity pack, or a themed pack with a fallback fill.
{
  const state = newRun(ITEMS.filter((def) => def.unlock).map((def) => def.id));
  state.gold = 1_000;
  const rng = mulberry32(0xc0ffee);
  for (let i = 0; i < 250; i++) {
    const shelf = rollShopOffers(state, 5, rng);
    check(
      shelf.filter((offer) => offer.cursed).length <= MAX_CURSES_PER_OFFER_SET,
      "A shop shelf should contain at most one curse",
    );
    for (const pack of BOOSTER_PACKS) {
      const reveal = openBooster(state, pack, 5, rng);
      check(
        reveal.filter((offer) => offer.cursed).length <=
          MAX_CURSES_PER_OFFER_SET,
        `${pack.name} should reveal at most one curse`,
      );
    }
  }
}

// Every mold pours its own size after scoring, source-tagged for the scene.
{
  const state = newRun();
  state.chipMold = 1;
  state.spikeMold = 1;
  state.brickMold = 2;
  const before = state.dice.length;
  state.dice.roll(() => 0, state.scoringNumbers, state.royalSealSizes);
  const outcome = resolveRoll(state, () => 0);
  const poured = new Map(
    outcome.spawnedBySource.molds.map((mold) => [mold.id, mold.count]),
  );
  check(poured.get("chip_mold") === 1, "Chip Mold should report one d2");
  check(poured.get("spike_mold") === 1, "Spike Mold should report one d4");
  check(poured.get("brick_mold") === 2, "two Brick Molds should report two d6");
  check(state.dice.length === before + 4, "the molds should grow the grid");
  check(
    state.dice.dieAt(state.dice.length - 1)?.source === "brick_mold",
    "a moulded die should carry its item source",
  );
}

// --- Boss modifiers ---------------------------------------------------------

// The Toll takes a tenth of the grid out of play — a named tenth: the first ten
// dice of a hundred, which the grid draws struck out. So a hundred dice under it
// must score exactly what ninety dice score without it, and the roll has to say
// which ten paid, or the cross-out on screen would be decoration.
{
  const tolled = newRun();
  tolled.trial = 3;
  tolled.bossModifiers = ["toll"];
  tolled.dice.addDice(6, 99, {}, "test"); // 100 dice
  rollPool(tolled, tolled.dice, () => 0);
  const withToll = scoreRollHistogram(tolled, tolled.dice.agg());

  const plain = newRun();
  plain.dice.addDice(6, 89, {}, "test"); // 90 dice
  rollPool(plain, plain.dice, () => 0);
  const without = scoreRollHistogram(plain, plain.dice.agg());

  check(
    withToll.points === without.points,
    "The Toll on 100 dice should score exactly what 90 dice score",
  );
  check(
    inertDiceCount(tolled, 100) === 10 &&
      isInertIndex(tolled, 9, 100) &&
      !isInertIndex(tolled, 10, 100),
    "The Toll should make the first tenth of the grid inert",
  );
  // The block is anchored at the head precisely so that growth cannot reach the
  // dice a player has just won: it widens into the ranks behind them instead.
  check(
    !isInertIndex(tolled, 100, 140) && inertDiceCount(tolled, 140) === 14,
    "and forty dice won under it should all still be live",
  );
  const tolledAgg = tolled.dice.agg();
  check(
    tolledAgg.total === 100 &&
      tolledAgg.inertCount === 10 &&
      tolledAgg.scoringCount === 90,
    "and the roll should report the whole grid, the inert tail, and the rest",
  );
  check(
    inertDiceCount(plain, 90) === 0,
    "while an untolled grid has no inert dice at all",
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
  state.bossModifiers = ["famine"];
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
  state.bossModifiers = ["eclipse"];
  const dark = scoreRollHistogram(state, state.dice.agg());
  check(bright.multiplier === 6n, "Amplifier and Prism should compound to x6");
  check(dark.multiplier === 3n, "The Eclipse should halve it to x3");

  const bare = newRun();
  bare.trial = 3;
  bare.bossModifiers = ["eclipse"];
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
  state.bossModifiers = ["drought"];
  state.chipMold = 1;
  state.brickMold = 2;
  state.genesis = 1;
  const before = state.dice.length;
  state.dice.roll(() => 0, state.scoringNumbers, state.royalSealSizes);
  const outcome = resolveRoll(state, () => 0);
  check(outcome.spawnedCount === 0, "The Drought should spawn no dice");
  check(state.dice.length === before, "and leave the grid untouched");
}

// ...but it stops at the shop door. The ladder has already advanced onto the
// Boss Trial by the time its shop opens, so reading the live afflictions here
// would offer every dice-adding card and then refuse to sell it — a card that
// does nothing when pressed. Only a permanent block (Locust Idol) closes the
// counter on growth.
{
  const state = newRun();
  state.trial = 3;
  state.bossModifiers = ["drought"];
  state.gold = 200;
  const offered = availableIds(state);
  check(
    offered.includes("extra_die") && offered.includes("spike"),
    "a shop before The Drought should still offer dice-adding cards",
  );
  const before = state.dice.length;
  check(
    applyOffer(state, offerFor("extra_die", state)),
    "and should sell them",
  );
  // The same cards claimed free from a booster pack, which is the path that
  // reaches applyOffer with the cost already paid.
  check(
    applyBoosterChoice(state, { ...offerFor("spike", state), cost: 0 }),
    "and a pack should hand them over",
  );
  check(
    state.dice.length === before + 4,
    "with the dice actually landing on the grid",
  );
}

// The Hoard raises the goal it has to be measured against.
{
  const plain = newRun();
  plain.trial = 12;
  const hoard = newRun();
  hoard.trial = 12;
  hoard.bossModifiers = ["hoard"];
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

// The gold items apply their flag or counter on purchase.
{
  const goldItems: [string, (s: ReturnType<typeof newRun>) => boolean][] = [
    ["tithe_bowl", (s) => s.titheBowl === 1],
    ["lucky_coin", (s) => s.luckyCoin === 1],
    ["counting_house", (s) => s.countingHouse === 1],
    ["deep_pockets", (s) => s.deepPockets === 1],
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

// --- Tempo items ------------------------------------------------------------

// Rain Check carries unused rolls into the next trial, one per copy, and never
// more than were actually left in hand.
{
  const state = newRun();
  state.trial = 1; // 7 rolls
  state.rainCheck = 2;
  state.roll = 1; // cleared with 6 to spare
  state.score = goalFor(state);
  state.trialCleared = true;
  resolveTrialEnd(state);
  check(
    state.bonusRollsThisRound === 2,
    "Rain Check should carry one roll per copy into the next trial",
  );
  check(
    state.peakRollsLeftOnClear === 6,
    "and record the rolls left for its own unlock",
  );

  // A clear with less to spare than the copies owned carries only what was left.
  const thin = newRun();
  thin.trial = 1;
  thin.rainCheck = 3;
  thin.roll = rollsForTrial(1) - 1; // one roll to spare
  thin.score = goalFor(thin);
  thin.trialCleared = true;
  resolveTrialEnd(thin);
  check(
    thin.bonusRollsThisRound === 1,
    "Rain Check should never carry more rolls than were left",
  );

  // The carried rolls are the next trial's, and expire with it like Overtime's.
  const spent = newRun();
  spent.trial = 1;
  spent.rainCheck = 2;
  spent.roll = 0;
  spent.score = goalFor(spent);
  spent.trialCleared = true;
  resolveTrialEnd(spent);
  check(
    trialRollTarget(spent) === rollsForTrial(spent.trial) + 2,
    "the carried rolls should lengthen the trial they land in",
  );
  spent.score = goalFor(spent);
  spent.trialCleared = true;
  spent.rainCheck = 0;
  resolveTrialEnd(spent);
  check(
    spent.bonusRollsThisRound === 0,
    "and are not kept past it once nothing carries them",
  );
}

// A failed trial survived on Insurance carries nothing: it was not cleared.
{
  const state = newRun();
  state.trial = 1;
  state.rainCheck = 2;
  state.hasInsurancePolicy = true;
  state.roll = rollsForTrial(1);
  state.score = (goalFor(state) * 3n) / 4n + 1n;
  resolveTrialEnd(state);
  check(
    state.bonusRollsThisRound === 0,
    "Insurance should not pay Rain Check's carry",
  );
  check(state.peakRollsLeftOnClear === 0, "nor count toward its unlock");
}

// Downbeat multiplies only the rolls that land on its beat.
{
  const dice = Array.from({ length: 40 }, () => die(6, 1));
  const plain = newRun();
  plain.roll = DOWNBEAT_INTERVAL - 2; // the roll before the beat
  const base = scoreRoll(plain, dice);

  const offBeat = newRun();
  offBeat.downbeat = 2;
  offBeat.roll = DOWNBEAT_INTERVAL - 2;
  check(
    scoreRoll(offBeat, dice).multiplier === 1n,
    "Downbeat should not multiply a roll off its beat",
  );

  const onBeat = newRun();
  onBeat.downbeat = 2;
  onBeat.roll = DOWNBEAT_INTERVAL - 1; // the next roll IS the beat
  const beat = scoreRoll(onBeat, dice);
  check(beat.multiplier === 4n, "two copies should multiply the beat by four");
  check(
    beat.points === base.points * 4n,
    "and multiply the points that roll scored",
  );
  check(
    beat.modifiers.some((mod) => mod.id === "downbeat" && mod.mult === 4n),
    "Downbeat should appear in the breakdown as a multiplier",
  );
}

// Crunch Time: shorter trials, tripled points, and the two are one purchase.
// Its two halves are separate on the run — the boon is the flag, the drawback is
// the affliction — so this buys the card rather than setting either by hand.
{
  const plain = newRun();
  const cursed = newRun();
  cursed.gold = 100;
  check(
    applyOffer(cursed, offerFor("crunch_time", cursed)),
    "Crunch Time should be purchasable",
  );
  check(
    trialRollTarget(cursed) === trialRollTarget(plain) - CRUNCH_TIME_ROLL_COST,
    "Crunch Time should shorten the trial",
  );

  const dice = Array.from({ length: 40 }, () => die(6, 1));
  check(
    scoreRoll(cursed, dice).points ===
      scoreRoll(plain, dice).points * CRUNCH_TIME_MULT,
    "and triple every roll's points",
  );

  // However short the trial and however many rolls a boss takes on top, a trial
  // always grants at least one roll.
  const squeezed = newRun();
  squeezed.gold = 100;
  applyOffer(squeezed, offerFor("crunch_time", squeezed));
  squeezed.bonusRollsPerRound = -100;
  check(trialRollTarget(squeezed) >= 1, "a trial should never lose every roll");
}

// The three tempo items apply their flag or counter on purchase.
{
  const tempoItems: [string, (s: ReturnType<typeof newRun>) => boolean][] = [
    ["rain_check", (s) => s.rainCheck === 1],
    ["downbeat", (s) => s.downbeat === 1],
    ["crunch_time", (s) => s.hasCrunchTime],
  ];
  for (const [id, applied] of tempoItems) {
    const state = newRun();
    state.gold = 100;
    const offer = offerFor(id as never, state);
    check(applyOffer(state, offer), `${id} should be purchasable`);
    check(applied(state), `${id} should apply its effect`);
    check(state.purchases[id as never] === 1, `${id} should be recorded`);
  }
}

// --- Afflictions ------------------------------------------------------------
//
// The debuff layer itself: how sources fold, and that a boss and a cursed card
// reach the same rules through it.

// Folding combines by each field's own declared rule.
{
  const none = fold([]);
  check(
    none === NO_AFFLICTIONS,
    "folding nothing should return the shared identity",
  );

  // Two breakage sources add into one likelier break.
  const breakage = fold(["bloodPrice", "ouroboros"]);
  check(
    Math.abs(
      breakage.dieBreakChance -
        (AFFLICTIONS.bloodPrice.dieBreakChance! +
          AFFLICTIONS.ouroboros.dieBreakChance!),
    ) < 1e-9,
    "breakage chances should sum",
  );

  // Two goal multipliers compound rather than replacing one another.
  const goals = fold(["reckoning", "devilsBargain"]);
  check(
    goals.goalMultMilli ===
      Math.floor(
        (AFFLICTIONS.reckoning.goalMultMilli! *
          AFFLICTIONS.devilsBargain.goalMultMilli!) /
          1_000,
      ),
    "goal multipliers should compound",
  );

  // Caps take the tighter of the pair, whichever order they arrive in.
  const caps = fold(["famishedIdol", "sealedDoors"]);
  check(
    caps.gridCap === AFFLICTIONS.famishedIdol.gridCap &&
      caps.purchaseLimit === AFFLICTIONS.sealedDoors.purchaseLimit,
    "caps should carry through the fold",
  );

  // Suppressions union, and booleans latch on any source.
  const sealed = fold(["famine", "warden", "locustIdol"]);
  check(
    sealed.suppress.includes("extraPoint") &&
      sealed.suppress.includes("patterns") &&
      sealed.blocksGrowth,
    "suppressions should union and booleans should latch",
  );
}

// A boss's drawback and a cursed card's are the same field from two sources: a
// boss reaches the run only on its own trial, a curse on every trial.
{
  const state = newRun();
  state.bossModifiers = ["hunger"];
  state.trial = 1; // not a Boss Trial
  check(
    afflictionsFor(state).rollDelta === 0,
    "a boss modifier should not bite before its Boss Trial",
  );
  state.trial = 3;
  check(
    isBossTrial(3) &&
      afflictionsFor(state).rollDelta === AFFLICTIONS.hunger.rollDelta,
    "and should bite on it",
  );

  // The same run, cursed: Crunch Time is felt on every trial, and the two
  // sources stack on the Boss Trial where they meet.
  state.afflictions = ["crunchTime"];
  state.trial = 1;
  check(
    afflictionsFor(state).rollDelta === -CRUNCH_TIME_ROLL_COST,
    "a curse should be felt on an ordinary trial",
  );
  state.trial = 3;
  check(
    afflictionsFor(state).rollDelta ===
      AFFLICTIONS.hunger.rollDelta! - CRUNCH_TIME_ROLL_COST,
    "and should stack with the boss on a Boss Trial",
  );
}

// --- Cursed cards -----------------------------------------------------------
//
// Every cursed card is bought rather than hand-set, because the whole point of
// the shape is that its two halves arrive together: the boon as a flag or a
// plain effect, the drawback as an affliction.

/** Buy a card outright, with the gold to afford it. */
function buy(
  id: Parameters<typeof offerFor>[0],
  setup: (s: RunState) => void = () => {},
) {
  const state = newRun();
  state.gold = 200;
  setup(state);
  check(applyOffer(state, offerFor(id, state)), `${id} should be purchasable`);
  return state;
}

// Each of the fifteen applies both halves, and the drawback lands on the run's
// affliction list where every rule can read it.
{
  const cursed: [Parameters<typeof offerFor>[0], AfflictionId][] = [
    ["crunch_time", "crunchTime"],
    ["blood_price", "bloodPrice"],
    ["ouroboros", "ouroboros"],
    ["famished_idol", "famishedIdol"],
    ["the_bloat", "bloat"],
    ["iron_debt", "ironDebt"],
    ["paupers_vow", "paupersVow"],
    ["sealed_doors", "sealedDoors"],
    ["devils_bargain", "devilsBargain"],
    ["leaden_dice", "leadenDice"],
    ["locust_idol", "locustIdol"],
    ["gamblers_curse", "gamblersCurse"],
    ["the_reckoning", "reckoning"],
    ["hair_trigger", "hairTrigger"],
    ["long_night", "longNight"],
    ["tollkeeper", "tollkeeper"],
  ];
  for (const [id, affliction] of cursed) {
    const priced = offerFor(id, newRun());
    check(priced.cost === 0, `${id} should cost no gold`);
    const state = buy(id);
    check(
      state.afflictions.includes(affliction),
      `${id} should inflict its own affliction`,
    );
    check(state.purchases[id] === 1, `${id} should be recorded as bought`);
  }
}

// The flat multipliers all reach the roll, and compound with one another.
{
  const dice = Array.from({ length: 40 }, () => die(6, 1));
  const plain = scoreRoll(newRun(), dice).points;
  for (const def of FLAT_MULTIPLIERS) {
    const state = newRun();
    state[def.flag] = true;
    check(
      scoreRoll(state, dice).points === plain * def.mult,
      `${def.name} should multiply the roll by ${def.mult}`,
    );
    check(
      scoreRoll(state, dice).modifiers.some(
        (m) => m.id === def.id && m.mult === def.mult,
      ),
      `${def.name} should appear in the breakdown`,
    );
  }
  const both = newRun();
  both.hasBloodPrice = true;
  both.hasReckoning = true;
  check(
    scoreRoll(both, dice).points === plain * 4n * 3n,
    "two flat multipliers should compound",
  );
}

// Ouroboros pays ten a die where the grid pays one, and stacks with Extra Point
// rather than replacing it.
{
  const dice = Array.from({ length: 10 }, () => die(6, 1));
  const state = newRun();
  state.hasOuroboros = true;
  check(
    scoreRoll(state, dice).points === 100n,
    "Ouroboros should pay ten for every scoring die",
  );
  state.extraPoints = 1;
  check(
    scoreRoll(state, dice).points === 110n,
    "and Extra Point should pay on top of it",
  );
}

// Breakage bills the dice that scored — after the growth passives, so a die
// still spawns its copy before it shatters.
{
  const state = newRun();
  state.hasOuroboros = true;
  state.afflictions = ["ouroboros"]; // every scoring die shatters
  state.dice.addDice(1, 100); // d1s always score
  const before = state.dice.length;
  state.dice.roll(() => 0.5, state.scoringNumbers);
  const { broken } = resolveRoll(state, () => 0);
  check(broken > 0, "a breakage affliction should shatter scoring dice");
  check(
    state.dice.length === before - broken,
    "and the shattered dice should leave the grid",
  );
}

// Betrayal bills the other half of the roll: the dice that came up with
// nothing. Breakage and defection are billed against the SAME roll, so a run
// carrying both must not have one of them counting the other's leftovers.
{
  const state = newRun();
  state.afflictions = ["betrayal"];
  // d1s always score, so a grid of d6s asked for 1s is mostly failure: the
  // faces below are forced to 6, which never scores.
  state.dice.addDice(6, 200);
  const before = state.dice.length;
  state.dice.roll(() => 0.99, state.scoringNumbers);
  const nonScoring = state.dice.agg().total - state.dice.agg().scoringCount;
  check(nonScoring > 0, "a roll of 6s against 1s should score nothing");
  const { defected } = resolveRoll(state, () => 0);
  check(defected > 0, "Betrayal should take dice that failed to score");
  check(
    state.dice.length === before - defected,
    "and the defectors should leave the grid",
  );
  check(
    state.defectors === defected,
    "and the run should tally every one of them",
  );
}

// Breakage and defection bill one roll between them, each taking only from its
// own half of it. Run with both afflictions at full tilt and an rng that always
// fires, so each pass takes everything it is entitled to and no more — the way
// the two would collide if one were reading the other's leftovers.
{
  const state = newRun();
  state.hasOuroboros = true;
  state.afflictions = ["ouroboros", "betrayal"];
  state.dice.addDice(1, 100); // d1s always score
  state.dice.addDice(6, 100); // rolled to 6s below, so none of these score
  state.dice.roll(() => 0.99, state.scoringNumbers);
  const agg = state.dice.agg();
  const scoring = agg.scoringCount;
  const nonScoring = agg.total - agg.scoringCount;
  const before = state.dice.length;
  check(scoring > 0 && nonScoring > 0, "the roll should have both halves");
  const { broken, defected } = resolveRoll(state, () => 0);
  check(broken > 0 && broken <= scoring, "breakage takes only scoring dice");
  check(
    defected > 0 && defected <= nonScoring,
    "and defection only dice that failed",
  );
  check(
    state.dice.length === before - broken - defected,
    "and between them they take each die at most once",
  );
}

// A grid cap culls the excess and holds the grid at its ceiling.
{
  const state = buy("famished_idol");
  state.dice.addDice(6, 500);
  const culled = enforceGridCap(state);
  check(culled > 0, "a grid cap should cull the excess");
  check(
    state.dice.length === AFFLICTIONS.famishedIdol.gridCap,
    "and hold the grid at its ceiling",
  );
}

// Iron Debt: a cleared trial pays 40% of its ordinary proceeds, plus interest.
{
  const state = buy("iron_debt", (s) => {
    s.trial = 1;
  });
  check(
    state.scoringNumbers.includes(2) && state.scoringNumbers.includes(3),
    "Iron Debt should decree two more scoring numbers",
  );
  state.gold = 20; // enough to earn interest
  const payout = trialPayout(state);
  const plain = newRun();
  plain.trial = state.trial;
  plain.gold = state.gold;
  const ordinary = trialPayout(plain);
  check(
    payout.base > 0 && payout.base < ordinary.base,
    "Iron Debt should reduce rather than erase the trial payout",
  );
  check(
    payout.interest === ordinary.interest && payout.total < ordinary.total,
    "and leave interest untouched",
  );
}

// Pauper's Vow skims the purse as a trial ends, and reports what it took.
{
  const state = buy("paupers_vow");
  state.gold = 50;
  const forfeited = applyGoldCeiling(state);
  const ceiling = AFFLICTIONS.paupersVow.goldCeiling!;
  check(
    state.gold === ceiling && forfeited === 50 - ceiling,
    "Pauper's Vow should skim the purse to its ceiling",
  );
  check(
    applyGoldCeiling(state) === 0,
    "and take nothing when the purse is already under it",
  );
}

// Sealed Doors: one purchase a shop, applied twice.
{
  const state = buy("sealed_doors");
  check(
    shopClosed(state, 1) && !shopClosed(state, 0),
    "Sealed Doors should close the counter after one purchase",
  );
  // A stacking card bought under it lands twice, and is priced as two copies.
  applyOffer(state, offerFor("brick_mold", state));
  check(
    state.brickMold === 2 && state.purchases.brick_mold === 2,
    "a stacking card should take effect twice under Sealed Doors",
  );
  // A one-time card is still one card on the shelf, however many passes ran.
  applyOffer(state, offerFor("vault", state));
  check(
    state.hasVault && state.purchases.vault === 1,
    "a unique card should still be recorded once",
  );
}

// Devil's Bargain lends gold against every goal for the rest of the run. Read on
// a mid-ladder trial: rank 1's goals are single digits, where a 15% rise floors
// away to nothing.
{
  const before = newRun();
  before.trial = 10;
  const state = buy("devils_bargain", (s) => {
    s.trial = 10;
  });
  check(state.gold > before.gold, "Devil's Bargain should pay out at once");
  check(
    goalFor(state) > goalFor(before),
    "and raise the trial goal permanently",
  );
}

// The Reckoning triples points against a doubled goal.
{
  const plain = newRun();
  plain.trial = 10;
  const state = buy("the_reckoning", (s) => {
    s.trial = 10;
  });
  check(
    goalFor(state) === goalFor(plain) * 2n,
    "The Reckoning should double the goal",
  );
}

// The Bloat walks the whole grid up the ladder as each trial opens.
{
  const state = buy("the_bloat");
  state.dice.addDice(2, 10);
  const before = state.dice.sizeCounts();
  applyTrialStart(state);
  const after = state.dice.sizeCounts();
  check(
    (before[2] ?? 0) > 0 && (after[2] ?? 0) === 0 && (after[4] ?? 0) > 0,
    "The Bloat should grow every die one rung at trial start",
  );
}

// Locust Idol freezes the grid: the passives stop, and the shop stops offering
// the cards that could only have grown it.
{
  const state = buy("locust_idol", (s) => s.dice.addDice(6, 9));
  check(state.dice.length === 50, "Locust Idol should pour one last time");
  state.genesis = 2;
  state.brickMold = 3;
  state.foundry = 1;
  const frozen = state.dice.length;
  applyTrialStart(state);
  check(state.dice.length === frozen, "then Foundry should add nothing");
  state.dice.roll(() => 0.5, state.scoringNumbers);
  resolveRoll(state, () => 0.5);
  check(
    state.dice.length === frozen,
    "and neither should Genesis or the molds",
  );
  const offered = availableIds(state);
  check(
    !offered.includes("twin") && !offered.includes("brick_mold"),
    "the shop should stop offering cards that only add dice",
  );
  check(
    offered.includes("extra_point"),
    "but should still offer the cards that do something else",
  );
}

// Hair Trigger multiplies a trial's opening roll and thins every roll after it.
{
  const dice = Array.from({ length: 40 }, () => die(6, 1));
  const plain = newRun();
  const state = buy("hair_trigger");
  check(
    scoreRoll(state, dice).points ===
      scoreRoll(plain, dice).points * HAIR_TRIGGER_MULT,
    "Hair Trigger should multiply the trial's first roll",
  );

  // On every roll after the first, its curse makes half the grid inert — the
  // same lever The Toll pulls, so it reduces the points themselves rather than
  // the multiplier, and per-item attribution stays exact.
  state.roll = 1;
  plain.roll = 1;
  const later = scoreRoll(state, dice).points;
  check(
    later < scoreRoll(plain, dice).points && later > 0n,
    "and thin every roll after it",
  );
  check(
    !scoreRoll(state, dice).modifiers.some((m) => m.id === "hairTrigger"),
    "without paying its multiplier on those rolls",
  );
}

// The Long Night buys rolls with boss pain.
{
  const plain = newRun();
  const state = buy("long_night");
  check(
    trialRollTarget(state) === trialRollTarget(plain) + 5,
    "The Long Night should lengthen every trial",
  );
  // Its Boss Trials roll the full count of modifiers, all of which bite.
  state.trial = 3;
  state.bossModifiers = bossesForRank(state, 3, mulberry32(7));
  check(
    state.bossModifiers.length === AFFLICTIONS.longNight.bossModifierCount,
    "and arm a Boss Trial with two modifiers",
  );
  check(
    new Set(state.bossModifiers).size === state.bossModifiers.length,
    "which are never the same modifier twice",
  );
}

// Tollkeeper charges every roll, and takes the roll when the purse is empty.
{
  const state = buy("tollkeeper");
  state.dice.addDice(1, 20);
  state.gold = 2;
  state.dice.roll(() => 0.5, state.scoringNumbers);
  const paid = resolveRoll(state, () => 0.5);
  check(
    state.gold === 1 && paid.denied === null && paid.result.points > 0n,
    "a paid toll should leave the roll alone",
  );
  state.gold = 0;
  state.dice.roll(() => 0.5, state.scoringNumbers);
  const unpaid = resolveRoll(state, () => 0.5);
  check(
    unpaid.denied === "tollkeeper" && unpaid.result.points === 0n,
    "an unpaid toll should take the roll",
  );
  check(
    state.scoreStreak === 0,
    "and a taken roll should break the scoring streak",
  );
}

// Gambler's Curse takes a roll outright when the gamble comes in.
{
  const state = buy("gamblers_curse");
  state.dice.addDice(1, 20);
  state.dice.roll(() => 0.5, state.scoringNumbers);
  const lost = resolveRoll(state, () => 0);
  check(
    lost.denied === "gamblersCurse" && lost.result.points === 0n,
    "Gambler's Curse should be able to take a roll",
  );
  state.dice.roll(() => 0.5, state.scoringNumbers);
  const kept = resolveRoll(state, () => 0.99);
  check(
    kept.denied === null && kept.result.points > 0n,
    "and leave the rest of them alone",
  );
}

// The Catechism: the Lessons' engine, sold once Group Study is owned, which grows
// every later roll by 10% for each roll the whole live grid scored on.
{
  const shopper = newRun();
  check(
    !availableIds(shopper).includes("the_catechism"),
    "The Catechism should wait for Group Study",
  );
  shopper.purchases.grindstone = 1;
  check(
    availableIds(shopper).includes("the_catechism"),
    "and be offered once Group Study is owned",
  );

  const state = newRun();
  state.hasCatechism = true;
  state.dice.shrinkAll(5); // the starter d6, down to a d1
  state.dice.addDice(1, 9);
  state.dice.roll(() => 0.5, state.scoringNumbers);
  const first = resolveRoll(state, () => 0.5);
  check(
    first.result.points === 10n && state.growthRollsAt.catechism?.[10] === 1,
    "a roll the whole grid scored should pay ungrown, then count",
  );
  state.dice.roll(() => 0.5, state.scoringNumbers);
  const second = resolveRoll(state, () => 0.5);
  check(
    second.result.points === 11n && second.result.growth === 1n,
    "the roll after it should grow by 10%",
  );
  check(
    second.result.modifiers.some(
      (mod) => mod.id === "catechism" && mod.displayPoints === 1n,
    ),
    "and the breakdown should show what the growth added",
  );

  state.dice.addDice(6, 1);
  state.dice.roll(() => 0.99, state.scoringNumbers); // the d6 shows a 6
  const missed = resolveRoll(state, () => 0.99);
  check(
    missed.result.points === 12n && state.growthRollsAt.catechism?.[10] === 2,
    "a roll one die missed should still grow, but not count",
  );

  const credited = [
    ...Object.values(state.dicePoints),
    ...Object.values(state.itemPoints),
  ].reduce((sum, points) => sum + points, 0n);
  check(
    credited === state.totalScore &&
      (state.itemPoints.the_catechism ?? 0n) === 3n,
    "growth should be credited to The Catechism, keeping attribution whole",
  );
}

// Both sides of the duel score a roll at the same growth: the count the player's
// roll earns moves only after the mirror has rolled.
{
  const state = newRun();
  state.hasCatechism = true;
  state.growthRollsAt = { catechism: atPercents({ 10: 3 }) };
  state.dice.shrinkAll(5);
  state.dice.addDice(1, 9);
  state.trial = WIN_TRIAL;
  prepareDuel(state);
  rollPool(state, state.dice, () => 0.5);
  const duelRoll = resolveRoll(state, () => 0.5);
  check(
    duelRoll.rivalPoints === duelRoll.result.points &&
      state.growthRollsAt.catechism?.[10] === 4,
    "the mirror should score a duel roll at the player's growth, not the next roll's",
  );
}

// Litany: offered only beside The Catechism, two copies at most, raising the
// growth of rolls counted after it and credited with the share it added.
{
  const state = newRun();
  check(
    !availableIds(state).includes("litany"),
    "Litany should wait for The Catechism",
  );
  state.hasCatechism = true;
  state.purchases.the_catechism = 1;
  check(
    availableIds(state).includes("litany"),
    "and be offered once The Catechism is owned",
  );
  const free = () => ({ ...offerFor("litany", state), cost: 0 });
  check(
    applyOffer(state, free()) &&
      applyOffer(state, free()) &&
      applyOffer(state, free()) &&
      state.litany === 3 &&
      !availableIds(state).includes("litany"),
    "and stop at three copies",
  );

  // Ten rolls counted at 10%, ten at 12%: 10 × 1.1¹⁰ × 1.12¹⁰ = 80.56, where the
  // card's own rate alone would have grown to 10 × 1.1²⁰ = 67.27.
  const grown = newRun();
  grown.hasCatechism = true;
  grown.litany = 1;
  grown.growthRollsAt = { catechism: atPercents({ 10: 10, 12: 10 }) };
  grown.dice.shrinkAll(5);
  grown.dice.addDice(1, 9);
  grown.dice.roll(() => 0.5, grown.scoringNumbers);
  const roll = resolveRoll(grown, () => 0.5);
  check(
    roll.result.points === 80n && grown.growthRollsAt.catechism?.[12] === 11,
    "a roll should grow at each count's own rate, and count at the run's current one",
  );
  check(
    grown.itemPoints.the_catechism === 57n && grown.itemPoints.litany === 13n,
    "the growth the card's own rate earns should go to The Catechism, the rest to Litany",
  );
}

// The pruning cards shed the dice that can miss, and never empty the grid.
{
  const free = (id: ShopItemId, state: RunState) => ({
    ...offerFor(id, state),
    cost: 0,
  });

  const lone = newRun(); // the starter d6 and nothing else
  check(
    !applyOffer(lone, free("dismissal", lone), 0) && lone.dice.length === 1,
    "A Dismissal should refuse to remove the last die",
  );

  const state = newRun();
  state.dice.addDice(1, 3);
  state.dice.addDice(20, 2);
  check(
    applyOffer(state, free("dismissal", state), 0) &&
      state.dice.length === 5 &&
      state.dice.countOfSize(6) === 0,
    "A Dismissal should remove the die it names",
  );
  const d20 = state.dice.findIndex((die) => die.sides === 20);
  check(
    applyOffer(state, free("winnowing", state), d20) &&
      state.dice.countOfSize(20) === 0 &&
      state.dice.length === 3,
    "The Winnowing should remove every die of the size it names",
  );
  check(
    !applyOffer(state, free("winnowing", state), 0) && state.dice.length === 3,
    "and refuse to remove the grid's only size",
  );

  const mixed = newRun(); // the starter d6, which can miss
  mixed.dice.addDice(1, 4);
  mixed.dice.addDice(2, 2);
  mixed.scoringNumbers.push(2); // a d2 now scores on both faces
  mixed.extraNumberCount = 1;
  check(
    applyOffer(mixed, free("excommunication", mixed)) &&
      mixed.dice.length === 6 &&
      mixed.dice.countOfSize(6) === 0,
    "Excommunication should remove exactly the dice that can miss",
  );
  check(
    !applyOffer(mixed, free("excommunication", mixed)),
    "and do nothing on a grid where every die always scores",
  );

  const doomed = newRun(); // only dice that can miss
  doomed.dice.addDice(6, 3);
  check(
    !applyOffer(doomed, free("excommunication", doomed)) &&
      doomed.dice.length === 4,
    "and refuse to empty a grid that has no die worth keeping",
  );
}

// The d1 cards grow a grid without putting a die that can miss on it.
{
  const state = newRun(); // the starter d6
  check(
    applyOffer(state, { ...offerFor("two_novices", state), cost: 0 }) &&
      state.dice.countOfSize(1) === 2,
    "Two Novices should add two d1",
  );
  state.dice.addDice(1, 10); // thirteen dice, twelve of them d1
  check(
    applyOffer(state, { ...offerFor("the_calling", state), cost: 0 }) &&
      state.dice.countOfSize(1) === 15,
    "The Calling should add a quarter of the grid, at least three, as d1",
  );
}

// The reworked grid multipliers are cursed: free, and every goal from then on
// grows by the share the grid just grew — at parity, or more gently when swept.
{
  setGridCurseGoalPerDoublingForSimulation(2); // parity
  const state = newRun(); // the starter d6
  state.dice.addDice(6, 9, {}, "test"); // ten d6
  const offer = offerFor("mult2", state);
  check(
    offer.cursed && offer.cost === 0,
    "a reworked Gathering should be cursed, and so free",
  );
  const goal = goalFor(state);
  check(
    applyOffer(state, offer) &&
      state.dice.length === 20 &&
      goalFor(state) === goal * 2n,
    "and double every goal as it doubles the grid",
  );

  setGridCurseGoalPerDoublingForSimulation(1.6);
  const mixed = newRun(); // the starter d6
  mixed.dice.addDice(4, 1, {}, "test"); // and a d4: twinning the d6 grows it by half
  check(
    applyOffer(mixed, offerFor("twin", mixed), 0) &&
      mixed.dice.length === 3 &&
      Math.abs(mixed.goalScale - 1.5 ** Math.log2(1.6)) < 1e-9,
    "Like Minds should charge only the share of the grid it grew, at the swept rate",
  );
  setGridCurseGoalPerDoublingForSimulation(null);
  setCardReworksForSimulation(false);
  check(
    !offerFor("mult2", newRun()).cursed,
    "and a baseline without the reworks should sell them uncursed",
  );
  setCardReworksForSimulation(true);
}

// The trees: a card waits for the card above it and then draws at better odds;
// cards outside the trees, and a baseline without them, are untouched.
{
  const state = newRun(); // the starter d6, so both shrink cards can act
  const pool = () => availableIds(state);
  check(
    pool().includes("shrink") && !pool().includes("grindstone"),
    "a tree card should wait for the card above it",
  );
  check(
    offerDrawWeight(state, "shrink") === 1,
    "a tree's root should draw like any other card",
  );
  check(
    pool().includes("refinement") && offerDrawWeight(state, "refinement") === 1,
    "a tree's supports should sit in the base set, ungated",
  );
  state.purchases.shrink = 1;
  check(
    pool().includes("grindstone") && offerDrawWeight(state, "grindstone") === 3,
    "and open, at better odds, once that card is owned",
  );
  check(
    !pool().includes("uniform"),
    "a branch should wait for its chain's tier-2 card",
  );
  state.purchases.grindstone = 1;
  check(
    pool().includes("uniform") && offerDrawWeight(state, "uniform") === 3,
    "and open with it, at better odds",
  );
  check(
    !pool().includes("lucky_seven"),
    "a branch should wait for its own chain's tier-2 card",
  );
  state.purchases.the_scales = 1;
  check(pool().includes("lucky_seven"), "and open once that card is owned");
  delete state.purchases.the_scales;
  delete state.purchases.grindstone;
  check(
    pool().includes("extra_die") && offerDrawWeight(state, "extra_die") === 1,
    "cards outside every tree should be untouched",
  );
  setItemTreesForSimulation(false);
  delete state.purchases.shrink;
  check(
    pool().includes("grindstone") && offerDrawWeight(state, "grindstone") === 1,
    "and a baseline without the trees should ignore them",
  );
  setItemTreesForSimulation(null);

  check(
    !isTreeUpgrade(state, "grindstone") && !isTreeUpgrade(state, "shrink"),
    "a tree card should not be marked an upgrade before its parent is owned, nor a root ever",
  );
  state.purchases.shrink = 1;
  check(
    isTreeUpgrade(state, "grindstone") && !isTreeUpgrade(state, "extra_die"),
    "and be marked once it is, where a card outside the trees never is",
  );
  check(
    metaUnlockOwner("prism").id === "momentum" &&
      metaUnlockOwner("double_the_fun").id === "extra_dice" &&
      metaUnlockOwner("extra_die").id === "extra_die",
    "a tree card should unlock with its root, and any other card by itself",
  );
  check(
    offerFor("prism", state).desc.endsWith("Up to 2 copies.") &&
      !offerFor("hourglass", state).desc.includes("Up to"),
    "a capped multiplier should print its cap, and an uncapped one nothing",
  );
}

// --- The other strategy trees' engines ----------------------------------------

/** A fresh run whose grid is exactly these dice. */
function gridOf(...stacks: [DieSides, number, DieOpts?][]): RunState {
  const state = newRun();
  state.dice = DicePool.fromDice(
    stacks.flatMap(([sides, count, opts]) =>
      Array.from({ length: count }, () => makeDie(sides, opts)),
    ),
  );
  return state;
}

/** The card as a free offer. */
const freeOffer = (id: ShopItemId, state: RunState) => ({
  ...offerFor(id, state),
  cost: 0,
});

/** An rng that plays these values in turn, over and over. */
function sequence(values: number[]): () => number {
  let next = 0;
  return () => values[next++ % values.length];
}

/** The rng value that rolls `face` on a die of `sides`. */
const faceOf = (face: number, sides: number) => (face - 0.5) / sides;

/** Whether a run's attribution still sums to its score. */
function attributionWhole(state: RunState): boolean {
  const credited = [
    ...Object.values(state.dicePoints),
    ...Object.values(state.itemPoints),
  ].reduce((sum, points) => sum + points, 0n);
  return credited === state.totalScore;
}

/** Roll the run's grid with `rng` and resolve the roll. */
function rollWith(state: RunState, rng: () => number, resolveRng = rng) {
  rollPool(state, state.dice, rng);
  return resolveRoll(state, resolveRng);
}

// Resonance: The Resonant Hall counts a roll three cards multiplied, and
// Harmonics raises the rate of the rolls it counts after.
{
  const state = gridOf([1, 15]);
  state.hasResonantHall = true;
  state.hasAmplifier = true;
  state.hasCrunchTime = true;
  const pair = rollWith(state, () => 0.5);
  check(
    pair.result.points === 90n && !state.growthRollsAt.resonance,
    "The Resonant Hall should not count a roll only two cards multiplied",
  );
  state.prism = 1;
  const trio = rollWith(state, () => 0.5);
  check(
    trio.result.points === 270n && state.growthRollsAt.resonance?.[10] === 1,
    "and count a roll three cards multiplied, at 10%",
  );
  const grown = rollWith(state, () => 0.5);
  check(grown.result.points === 297n, "growing the rolls after it");
  state.shopUnlocks.push("momentum"); // Resonance's root, which unlocks its tree
  state.purchases.the_resonant_hall = 1;
  check(
    availableIds(state).includes("harmonics"),
    "Harmonics should be offered beside The Resonant Hall",
  );
  state.harmonics = 1;
  rollWith(state, () => 0.5);
  check(
    state.growthRollsAt.resonance?.[12] === 1 &&
      (state.itemPoints.harmonics ?? 0n) === 0n,
    "and count later rolls at 12%, earning nothing on rolls counted before it",
  );
  rollWith(state, () => 0.5);
  check(
    (state.itemPoints.harmonics ?? 0n) > 0n && attributionWhole(state),
    "then take its share of the growth, keeping attribution whole",
  );
}

// The Multitude pairs the copies The Curious makes.
{
  const state = gridOf([8, 4]);
  state.hasDoubleTheFun = true;
  state.multitude = 3; // a 60% chance a copy arrives as a pair
  rollWith(
    state,
    () => 0.999,
    () => 0.1,
  ); // every d8 at its top face
  check(
    state.dice.length === 12 &&
      state.itemValues.double_the_fun === 4 &&
      state.itemValues.the_multitude === 4,
    "The Multitude should pair The Curious' copies, credited to itself",
  );
}

// The Treasury: The Gilded Altar and The Endowment read the purse; Abstinence
// pays for an empty-handed visit.
{
  const state = gridOf([1, 4]);
  state.hasGildedAltar = true;
  state.gold = 25;
  const altar = rollWith(state, () => 0.5);
  check(
    altar.result.points === 16n &&
      altar.result.modifiers.some(
        (mod) => mod.id === "gildedAltar" && mod.mult === 4n,
      ) &&
      state.itemPoints.gilded_altar === 12n,
    "The Gilded Altar should double a roll for every 10 gold held, credited to itself",
  );
  state.hasEndowment = true;
  state.gold = 23;
  rollWith(state, () => 0.5);
  check(
    state.growthRollsAt.endowment?.[2] === 1,
    "The Endowment should count a roll at 1% for every 10 gold held",
  );
  state.gold = 200;
  const rich = rollWith(state, () => 0.5);
  check(state.growthRollsAt.endowment?.[10] === 1, "up to its 10% cap");
  check(
    rich.result.modifiers.some(
      (mod) => mod.id === "gildedAltar" && mod.mult === 16n,
    ),
    "while The Gilded Altar stops at ×16",
  );
  state.compoundInterest = 2;
  rollWith(state, () => 0.5);
  check(
    state.growthRollsAt.endowment?.[14] === 1 && attributionWhole(state),
    "which Compound Interest raises, keeping attribution whole",
  );

  const shopper = newRun();
  shopper.abstinence = 2;
  const gold = shopper.gold;
  check(
    leaveShop(shopper, true) === 0 && shopper.gold === gold,
    "Abstinence should pay nothing for a visit that bought something",
  );
  check(
    leaveShop(shopper, false) === 6 && shopper.gold === gold + 6,
    "and 3 gold a copy for one that bought nothing",
  );
}

// The Canticle: lone faces score under Counterpoint, double the roll under The
// Canticle and grow it under Plainsong; The Choirmaster removes the dice that
// repeated a face.
{
  const voice = newRun();
  check(
    applyOffer(voice, freeOffer("a_new_voice", voice)) &&
      voice.dice.countOfSize(8) === 1 &&
      voice.dice.countOfSize(10) === 1 &&
      voice.dice.countOfSize(20) === 1,
    "A New Voice should add a d8, a d10 and a d20",
  );

  const state = gridOf([100, 8]);
  state.hasCounterpoint = true;
  state.hasCanticle = true;
  state.hasPlainsong = true;
  // Six faces shown once, and an 11 shown twice.
  const roll = rollWith(
    state,
    sequence([11, 22, 33, 44, 55, 66, 77, 11].map((face) => faceOf(face, 100))),
    () => 0.5,
  );
  check(
    roll.result.points === 24n,
    "Counterpoint should score the six lone faces, and The Canticle double them for each beyond the fourth",
  );
  check(
    state.growthRollsAt.plainsong?.[6] === 1,
    "Plainsong should count 1% for each of the six unrepeated faces",
  );
  check(
    state.dice.removeRepeatedFaces() === 2 && state.dice.length === 6,
    "The Choirmaster should remove the dice that repeated a face",
  );
  const chorus = gridOf([1, 4]);
  rollPool(chorus, chorus.dice, () => 0.5);
  check(
    chorus.dice.removeRepeatedFaces() === 0 && chorus.dice.length === 4,
    "and never empty a grid on which every die repeated one",
  );

  // Plainsong's fuel.
  const unsung = newRun();
  check(
    !availableIds(unsung).includes("a_full_choir") &&
      !availableIds(unsung).includes("antiphon"),
    "Plainsong's fuel should wait for Plainsong",
  );
  const antiphon = gridOf([100, 8]);
  antiphon.hasPlainsong = true;
  antiphon.hasAntiphon = true;
  rollWith(
    antiphon,
    sequence([11, 22, 33, 44, 55, 66, 77, 11].map((face) => faceOf(face, 100))),
    () => 0.5,
  );
  check(
    antiphon.growthRollsAt.plainsong?.[10] === 1,
    "Antiphon should count the six lone faces twice, up to Plainsong's cap",
  );
  const loft = gridOf([6, 2]);
  loft.hasPlainsong = true;
  check(
    applyOffer(loft, freeOffer("a_full_choir", loft)) && loft.fullChoir === 1,
    "A Full Choir should be bought beside Plainsong",
  );
  applyTrialStart(loft);
  check(
    loft.dice.countOfSize(100) === 1 && loft.itemValues.a_full_choir === 1,
    "and add a d100 as each trial starts",
  );
}

// The Weighing: dice grow, a size is ballasted, The Scales pay faces, Gravitas
// reads the grid's mean size and The Weight of Ages its high faces.
{
  const state = gridOf([6, 1], [20, 2]);
  check(
    applyOffer(state, freeOffer("ascension", state), 0) &&
      state.dice.dieAt(0)?.sides === 10,
    "Ascension should grow a die two sizes",
  );
  const d20 = state.dice.findIndex((die) => die.sides === 20);
  check(
    applyOffer(state, freeOffer("exaltation", state), d20) &&
      state.dice.countOfSize(100) === 2,
    "Exaltation should grow every die of a size one size",
  );
  const d100 = state.dice.findIndex((die) => die.sides === 100);
  check(
    applyOffer(state, freeOffer("ballast", state), d100) &&
      state.ballastSizes.includes(100),
    "Ballast should mark the size it names",
  );
  rollPool(state, state.dice, () => 0);
  check(
    state.dice.dieAt(d100)?.value === 3 && state.dice.dieAt(0)?.value === 1,
    "whose dice then never roll their lowest two faces, while other sizes do",
  );
  check(
    applyOffer(state, freeOffer("two_elders", state)) &&
      state.dice.countOfSize(100) === 4,
    "Two Elders should add two d100",
  );

  const scales = gridOf([20, 3], [1, 1]);
  scales.hasScales = true;
  scales.scoringNumbers.push(2, 3);
  scales.extraNumberCount = 2;
  const weighed = rollWith(
    scales,
    sequence([faceOf(15, 20), faceOf(5, 20), faceOf(11, 20), 0.5]),
    () => 0.5,
  );
  check(
    weighed.result.points === 27n,
    "The Scales should pay the faces of the upper half — a 15, an 11 and a d1's 1 — and nothing for a 5 or the scoring numbers",
  );

  const heavy = gridOf([100, 20]);
  heavy.gravitas = 1;
  heavy.hasWeightOfAges = true;
  const high = rollWith(
    heavy,
    () => 0.995,
    () => 0.5,
  ); // every d100 shows 100
  check(
    high.result.modifiers.some(
      (mod) => mod.id === "gravitas" && mod.mult === 10n,
    ),
    "Gravitas should multiply by the grid's average die size over ten",
  );
  check(
    heavy.growthRollsAt.weight?.[6] === 1,
    "The Weight of Ages should count 1% for every three dice showing 50 or higher",
  );

  // The Weight of Ages' fuel.
  const anvil = gridOf([100, 3], [20, 1]);
  anvil.hasWeightOfAges = true;
  anvil.hasAnvil = true;
  rollPool(anvil, anvil.dice, () => 0);
  const anvilD100 = anvil.dice.findIndex((die) => die.sides === 100);
  const anvilD20 = anvil.dice.findIndex((die) => die.sides === 20);
  check(
    anvil.dice.dieAt(anvilD100)?.value === 50 &&
      anvil.dice.dieAt(anvilD20)?.value === 1,
    "The Anvil should hold a d100 at 50 or higher, and leave other sizes alone",
  );
  anvil.ancestors = 2;
  rollWith(anvil, () => 0.5);
  check(
    anvil.dice.countOfSize(100) === 5 && anvil.itemValues.the_ancestors === 2,
    "The Ancestors should add a d100 a copy after every roll",
  );
}

// The Pyre: burned and shattered faces feed it, Kindling doubles them, and From
// the Ashes returns a share of the burned dice.
{
  const state = gridOf([4, 10], [6, 5]);
  state.hasPyre = true;
  state.kindling = 1;
  state.fromTheAshes = 1;
  const d4 = state.dice.findIndex((die) => die.sides === 4);
  const goldBefore = state.gold;
  check(
    applyOffer(state, freeOffer("an_offering", state), d4) &&
      state.dice.countOfSize(4) === 0 &&
      state.pyreFaces === 80 &&
      state.dice.countOfSize(100) === 1 &&
      state.gold === goldBefore + 4,
    "An Offering should burn a size, its faces doubled by Kindling, a tenth return as d100s, and pay a gold per ten faces",
  );
  rollWith(state, () => 0.5);
  check(
    state.growthRollsAt.pyre?.[4] === 1 && state.pyreFaces === 0,
    "The Pyre should count 1% per twenty faces, and the roll spend them",
  );
  const lastSize = gridOf([6, 3]);
  lastSize.hasPyre = true;
  check(
    !applyOffer(lastSize, freeOffer("an_offering", lastSize), 0),
    "An Offering should refuse to burn the grid's only size",
  );

  const shatter = gridOf([6, 10, { wildFace: true }], [20, 1]);
  shatter.hasPyre = true;
  shatter.afflictions.push("bloodPrice");
  rollWith(
    shatter,
    () => 0.5,
    () => 0,
  ); // every scoring die shatters
  check(
    shatter.dice.length === 1 && shatter.growthRollsAt.pyre?.[3] === 1,
    "and a shattered die should feed The Pyre its faces on the roll it breaks",
  );

  // The Pyre's fuel.
  const brazier = gridOf([6, 4], [20, 2], [1, 1]);
  brazier.hasPyre = true;
  brazier.hasBrazier = true;
  brazier.hasEmbers = true;
  rollWith(
    brazier,
    () => 0,
    () => 0.5,
  ); // every die shows a 1
  check(
    brazier.dice.length === 1 &&
      brazier.growthRollsAt.pyre?.[3] === 1 &&
      brazier.itemValues.the_brazier === 6,
    "The Brazier should burn every die but a d1 that rolled a 1, feeding The Pyre its faces",
  );
  check(
    brazier.pyreFaces === 32,
    "and Embers keep half the faces the roll spent",
  );
  rollWith(brazier, () => 0.5);
  check(
    brazier.growthRollsAt.pyre?.[1] === 1 && brazier.pyreFaces === 16,
    "for the next roll to count",
  );
  const crown = gridOf([20, 5], [1, 1]);
  crown.hasAshenCrown = true;
  const crownD20 = crown.dice.findIndex((die) => die.sides === 20);
  check(
    applyOffer(crown, freeOffer("an_offering", crown), crownD20) &&
      crown.facesBurned === 100 &&
      crown.pyreFaces === 0,
    "Burned faces should count toward The Ashen Crown without The Pyre",
  );
  const crowned = rollWith(crown, () => 0.5);
  check(
    crowned.result.points === 2n && crown.itemPoints.the_ashen_crown === 1n,
    "which doubles a roll for every hundred of them, credited to itself",
  );
  const kindled = gridOf([20, 5], [1, 1]);
  kindled.hasAshenCrown = true;
  kindled.kindling = 1;
  check(
    applyOffer(
      kindled,
      freeOffer("an_offering", kindled),
      kindled.dice.findIndex((die) => die.sides === 20),
    ) && kindled.facesBurned === 200,
    "and Kindling double the faces it reads, with or without The Pyre",
  );
  crown.facesBurned = 10_000;
  check(
    rollWith(crown, () => 0.5).result.modifiers.some(
      (mod) => mod.id === "ashenCrown" && mod.mult === 16n,
    ),
    "up to ×16",
  );
  const lastDice = gridOf([6, 2]);
  lastDice.hasBrazier = true;
  rollWith(lastDice, () => 0);
  check(
    lastDice.dice.length === 2,
    "The Brazier should never burn the whole grid",
  );
  const bucketed = gridOf([20, 5000]);
  bucketed.hasBrazier = true;
  rollWith(bucketed, mulberry32(7));
  const left = bucketed.dice.length;
  check(
    bucketed.dice.bucketed && left < 5000 && left > 4600,
    `and burn about one die in twenty from a bucketed grid of d20s (${left} left)`,
  );
}

// The Hermitage: The Cell pays for empty seats, and The Vigil grows each die as
// it scores — a tally Anointing adds to, saves carry and the duel's mirror copies.
{
  const cell = gridOf([1, 3]);
  cell.hasCell = true;
  check(
    rollWith(cell, () => 0.5).result.points === 96n,
    "The Cell should double a roll for every empty seat below eight dice",
  );

  const parted = gridOf([6, 2]);
  const gold = parted.gold;
  check(
    applyOffer(parted, freeOffer("a_parting", parted), 0) &&
      parted.dice.length === 1 &&
      parted.gold === gold + 1,
    "A Parting should remove a die and pay 1 gold",
  );

  const state = gridOf([1, 4]);
  state.hasVigil = true;
  state.extraPoints = 9; // each die pays 10
  const first = rollWith(state, () => 0.5);
  check(
    first.result.points === 40n && state.dice.dieAt(0)?.scores?.[10] === 1,
    "The Vigil should tally each die that scored, and grow nothing on that roll",
  );
  check(
    rollWith(state, () => 0.5).result.points === 44n,
    "then grow each die's points 10% for every score it has tallied",
  );
  state.discipline = 1;
  rollWith(state, () => 0.5);
  check(
    state.dice.dieAt(0)?.scores?.[12] === 1 &&
      state.dice.dieAt(0)?.scores?.[10] === 2,
    "and tally at 12% once Discipline is owned, keeping the tallies before it",
  );
  check(
    applyOffer(state, freeOffer("anointing", state), 0) &&
      state.dice.dieAt(0)?.scores?.[12] === 6,
    "Anointing should tally five more scores on the die it names",
  );
  check(
    hydrateRunState(serializeRunState(state))?.dice.dieAt(0)?.scores?.[12] ===
      6,
    "and a saved run should keep each die's tally",
  );
  check(attributionWhole(state), "keeping attribution whole");
  const before = state.dice.dieAt(1)?.scores;
  state.dice.addDice(1, 9); // thirteen dice
  const crowded = rollWith(state, () => 0.5);
  check(
    crowded.result.points === 130n &&
      state.dice.dieAt(1)?.scores?.[12] === before?.[12],
    "and past twelve dice it should neither grow nor tally",
  );

  const duel = gridOf([1, 4]);
  duel.hasVigil = true;
  duel.extraPoints = 9;
  duel.dice.anointAt(0, 5, 10);
  duel.trial = WIN_TRIAL;
  prepareDuel(duel);
  const duelRoll = rollWith(duel, () => 0.5);
  check(
    duelRoll.rivalPoints === duelRoll.result.points &&
      duelRoll.result.points === 46n &&
      duel.rival?.dice.dieAt(0)?.scores?.[10] === 6,
    "the duel's mirror should copy each die's tally, and grow and tally its own the same",
  );
}

// The roll callout regroups a scored roll as (dice + bonuses) × multiplier. Its
// numbers are read off the scorer, never re-scored: the multiplier's last step
// must land on the roll's own points, growth and the Eclipse included.
{
  const state = gridOf([1, 4]);
  state.extraPoints = 2;
  state.prism = 1;
  state.hasAmplifier = true;
  state.hasCatechism = true;
  state.growthRollsAt = { catechism: atPercents({ 10: 2 }) };
  const roll = rollWith(state, () => 0.5);
  const breakdown = rollBreakdown(roll.result);
  check(
    breakdown !== null &&
      breakdown.dice === 4n &&
      breakdown.bonuses.some((b) => b.id === "extraPoint" && b.points === 8n) &&
      breakdown.subtotal === 12n,
    "the callout should split four scoring dice from Deeper Stillness' eight points",
  );
  const steps = breakdown?.steps ?? [];
  check(
    steps.map((step) => step.factor).join(" ") === "×1.2 ×2 ×3" &&
      formatMultiplier(steps[1].after) === "2.41",
    "and count the multiplier up smallest factor first: the growth the roll really got (72 → 87 is ×1.2), then the cards",
  );
  const final = breakdown!.multiplier;
  check(
    breakdown!.points === roll.result.points &&
      (breakdown!.subtotal * final.num) / final.den === roll.result.points &&
      formatMultiplier(final) === "7.25",
    "landing exactly on the roll's points (12 × 6 grown twice is 87, ×7.25)",
  );
  check(
    formatMultiplier({ num: 121n, den: 100n }) === "1.21" &&
      formatMultiplier({ num: 15n, den: 2n }) === "7.5" &&
      formatMultiplier({ num: 12n, den: 1n }) === "12",
    "multipliers print whole when whole and to two places otherwise",
  );

  const eclipsed = gridOf([1, 2]);
  eclipsed.prism = 1;
  eclipsed.afflictions = ["eclipse"];
  const dark = rollBreakdown(rollWith(eclipsed, () => 0.5).result);
  check(
    dark?.steps.map((step) => step.factor).join(" ") === "×3 ÷2" &&
      formatMultiplier(dark.multiplier) === "1",
    "the Eclipse should show as the one step that lowers the multiplier",
  );
  check(
    rollBreakdown({ points: 0n, multiplier: 1n, modifiers: [] }) === null,
    "a roll that scored nothing has no callout",
  );
}
console.log("Item mechanics check: ALL PASS");
