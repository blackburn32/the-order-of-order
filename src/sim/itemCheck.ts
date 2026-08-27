import { isBossTrial, STARTING_DICE } from "../config";
import { newRun, type RunState } from "../state/RunState";
import { bossesForRank, goalFor } from "../systems/Boss";
import { applyDeadDice } from "../systems/Afflictions";
import { applyTrialStart, enforceGridCap } from "../systems/Items";
import { makeDie } from "../systems/Dice";
import {
  applyOffer,
  availableIds,
  offerFor,
  shopClosed,
  rerollShopOffers,
  rollShopOffers,
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
import { applyGoldCeiling, trialPayout } from "../systems/Gold";
import {
  AFFLICTIONS,
  afflictionsFor,
  CRUNCH_TIME_ROLL_COST,
  fold,
  type AfflictionId,
  NO_AFFLICTIONS,
} from "../systems/Afflictions";
import { rollsForTrial } from "../config";
import { scoreRollHistogram } from "../systems/ScoringHistogram";
import { resolveRoll, resolveTrialEnd } from "./engine";
import { mulberry32 } from "./localStorageShim";

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function die(sides: 4 | 6 | 8 | 100, value: number) {
  const d = makeDie(sides);
  d.value = value;
  return d;
}

// Lucky Seven multiplies the whole roll, on any value with a 7 written in it.
{
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

// Foundry doubles the smallest size on the grid, once per copy owned.
{
  const state = newRun();
  state.dice.addDice(2, 5, {}, "test");
  state.dice.addDice(20, 3, {}, "test");
  state.foundry = 2; // x4
  const added = applyTrialStart(state);
  check(added === 15, "two Foundry copies should quadruple five d2");
  check(state.dice.countOfSize(2) === 20, "leaving twenty d2");
  check(state.dice.countOfSize(20) === 3, "and the larger dice untouched");
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
    const offers = rerollShopOffers(state, 5, rng);
    check(
      !offers.some((offer) => offer.id === "extra_die"),
      "Rerolls should never offer Two Bricks",
    );
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

// The Toll takes a tenth of the grid out of play. Defined on the aggregate, so
// a hundred dice under it must score exactly what ninety dice score without it —
// that equivalence is what lets it mean the same thing once the pool is
// bucketed and individual dice no longer exist.
{
  const tolled = newRun();
  tolled.trial = 3;
  tolled.bossModifiers = ["toll"];
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

// The Hoard raises the goal it has to be measured against.
{
  const plain = newRun();
  plain.trial = 3;
  const hoard = newRun();
  hoard.trial = 3;
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
    scoreRoll(both, dice).points === plain * 4n * 2n,
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

// Iron Debt: a cleared trial pays only the interest earned on the bank.
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
  check(
    payout.base === 0 && payout.rolls === 0 && payout.items === 0,
    "Iron Debt should pay nothing for the trial itself",
  );
  check(
    payout.interest > 0 && payout.total === payout.interest,
    "and leave only the interest on the bank",
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
// a mid-ladder trial: rank 1's goals are single digits, where a 25% rise floors
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

// The Reckoning doubles the goal as well as the points.
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

console.log("Item mechanics check: ALL PASS");
