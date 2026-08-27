// Executable spec for the gold economy: what a cleared trial pays, what the
// shop charges, and the items that bend either of those.
//
// Run: npm run gold:check

import { newRun, RunState } from "../state/RunState";
import { activeBoss } from "../systems/Boss";
import {
  BOSS_CLEAR_GOLD,
  GOLD_PER_INTEREST,
  INTEREST_CAP,
  interestOn,
  PROSPECTOR_CAP,
  STARTING_GOLD,
  TRIAL_GOLD_BASE,
  trialPayout,
  UNUSED_ROLL_GOLD_CAP,
  unusedRolls,
  VAULT_INTEREST_CAP,
  grantGold,
  rollGold,
} from "../systems/Gold";
import { ITEMS } from "../systems/Items";
import {
  offerFor,
  PRICE_BANDS,
  priceFor,
  rerollCost,
  rerollIsFree,
  applyOffer,
  applyBoosterChoice,
  boosterPrice,
  discountOffersForPawnbroker,
  openBooster,
  rollBoosterOffers,
} from "../systems/Shop";
import { installStorage } from "./localStorageShim";

installStorage([]);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

function runAt(trial: number, roll = 0): RunState {
  const state = newRun([]);
  state.trial = trial;
  state.roll = roll;
  state.gold = 0;
  return state;
}

const byId = (id: string) => ITEMS.find((it) => it.id === id)!;

// ---------------------------------------------------------------------------
console.log("\nTrial payout");

{
  // A trial cleared on its very last roll pays only its base.
  const state = runAt(1, 7);
  const gold = trialPayout(state);
  check(unusedRolls(state) === 0, "no rolls left in hand");
  check(gold.base === TRIAL_GOLD_BASE[0], "the Lesser Trial pays its base");
  check(gold.rolls === 0, "and nothing for rolls");
  check(gold.total === gold.base, "so the total is just the base");
}

{
  const lesser = trialPayout(runAt(1, 7)).base;
  const greater = trialPayout(runAt(2, 15)).base;
  const boss = trialPayout(runAt(3, 20)).base;
  check(
    lesser < greater && greater < boss,
    "a harder trial pays a bigger base (before the boss bonus)",
  );
}

{
  const state = runAt(2, 12); // 15-roll trial cleared with 3 to spare
  check(unusedRolls(state) === 3, "unused rolls counted from the trial budget");
  check(trialPayout(state).rolls === 3, "and paid at 1 gold each");
}

{
  const state = runAt(2, 0); // cleared on the first roll: 15 unused
  check(
    trialPayout(state).rolls === UNUSED_ROLL_GOLD_CAP,
    "the unused-roll payout is capped",
  );
}

{
  const state = runAt(2, 12);
  state.reserve = 2;
  check(
    trialPayout(state).rolls === 3 * (1 + 2),
    "Reserve adds a gold per unused roll, per copy",
  );
}

// ---------------------------------------------------------------------------
console.log("\nInterest");

{
  const state = runAt(1, 7);
  state.gold = 12;
  check(interestOn(state) === 2, "interest pays 1 per 5 banked");
  state.gold = GOLD_PER_INTEREST * INTEREST_CAP * 2;
  check(interestOn(state) === INTEREST_CAP, "and is capped");
  state.hasVault = true;
  check(interestOn(state) === VAULT_INTEREST_CAP, "Vault raises the cap");
}

{
  const state = runAt(1, 7);
  state.gold = 0;
  check(trialPayout(state).interest === 0, "an empty purse earns no interest");
}

// ---------------------------------------------------------------------------
console.log("\nBoss trials");

{
  const state = runAt(3, 20);
  state.bossModifier = "famine";
  check(
    trialPayout(state).items === BOSS_CLEAR_GOLD,
    "clearing a boss pays its bonus",
  );
  const plainTotal = trialPayout(state).total;
  state.hasReliquary = true;
  const relicTotal = trialPayout(state).total;
  check(
    relicTotal > plainTotal,
    "and Reliquary takes a share of every payout on top",
  );
}

{
  const plain = runAt(3, 20);
  plain.bossModifier = "famine";
  const hoard = runAt(3, 20);
  hoard.bossModifier = "hoard";
  check(
    activeBoss(hoard)!.goldMultMilli === 2_000,
    "The Hoard declares a double payout",
  );
  check(
    trialPayout(hoard).base === trialPayout(plain).base * 2,
    "and the base payout is doubled",
  );
}

// ---------------------------------------------------------------------------
console.log("\nGold items");

{
  const state = runAt(1, 7);
  state.countingHouse = 3;
  check(trialPayout(state).items === 3, "Counting House pays per copy");
}

{
  const state = runAt(1, 7);
  state.hasProspector = true;
  state.dice.addDice(6, 74, {}, "test"); // 75 dice total
  check(trialPayout(state).items === 3, "Prospector pays per 25 dice held");
  state.dice.addDice(6, 500, {}, "test");
  check(trialPayout(state).items === PROSPECTOR_CAP, "and is capped");
}

{
  const state = runAt(1);
  state.titheBowl = 2;
  check(
    rollGold(state, false) === 2,
    "Tithe Bowl pays per copy on a scoreless roll",
  );
  check(rollGold(state, true) === 0, "and nothing on a roll that scored");
}

{
  const state = runAt(1);
  state.luckyCoin = 1;
  check(rollGold(state, true, () => 0.05) === 1, "Lucky Coin can hit");
  check(rollGold(state, true, () => 0.5) === 0, "and can miss");
}

// ---------------------------------------------------------------------------
console.log("\nBanking");

{
  const state = newRun([]);
  check(state.gold === STARTING_GOLD, "a run starts with its purse");
  check(state.peakGold === STARTING_GOLD, "and its peak matches");
  grantGold(state, 10);
  check(state.gold === STARTING_GOLD + 10, "granting adds to the purse");
  check(state.peakGold === state.gold, "and tracks the peak");
  state.gold = 1;
  grantGold(state, 2);
  check(
    state.peakGold === STARTING_GOLD + 10,
    "spending down does not lower the peak",
  );
}

// ---------------------------------------------------------------------------
console.log("\nShop pricing");

{
  const state = runAt(1);
  check(
    priceFor(byId("extra_die"), state) === 0,
    "the free item costs nothing",
  );
  check(
    priceFor(byId("pocket_change"), state) === PRICE_BANDS.low,
    "a low-band item costs its band at neutral market",
  );
  check(
    priceFor(byId("prism"), state) > priceFor(byId("pocket_change"), state),
    "a build-defining item costs more than a low one",
  );
}

{
  const state = runAt(1);
  const first = priceFor(byId("pocket_change"), state);
  state.purchases.pocket_change = 2;
  check(
    priceFor(byId("pocket_change"), state) > first,
    "repeat copies cost more",
  );
}

{
  const plain = runAt(1);
  const cart = runAt(1);
  cart.hasShoppingCart = true;
  check(
    priceFor(byId("prism"), cart) < priceFor(byId("prism"), plain),
    "Shopping Cart discounts every card",
  );

  const pawn = runAt(1);
  pawn.hasPawnbroker = true;
  check(
    priceFor(byId("prism"), pawn) === priceFor(byId("prism"), plain) - 2,
    "Pawnbroker takes a flat 2 gold off",
  );
}

{
  const state = runAt(1);
  state.hasPawnbroker = true;
  state.hasShoppingCart = true;
  let floored = true;
  for (const item of ITEMS) {
    if (item.priceBand === "free") continue;
    if (priceFor(item, state) < 1) floored = false;
  }
  check(floored, "no paid card can be discounted below 1 gold");
}

{
  const offers = [
    offerFor("prism", runAt(1)),
    offerFor("pocket_change", runAt(1)),
    { ...offerFor("extra_die", runAt(1)), freeByCoupon: true },
  ];
  const originalCosts = offers.map((offer) => offer.cost);
  discountOffersForPawnbroker(offers);
  check(
    offers[0].cost === originalCosts[0] - 2 &&
      offers[1].cost === Math.max(1, originalCosts[1] - 2),
    "buying Pawnbroker immediately discounts the current card row",
  );
  check(offers[2].cost === 0, "Pawnbroker leaves an already-free card free");
}

{
  const state = runAt(1);
  const cheap = priceFor(byId("prism"), state, 0.75);
  const dear = priceFor(byId("prism"), state, 1.25);
  check(cheap < dear, "market variation moves the price both ways");
}

// ---------------------------------------------------------------------------
console.log("\nRerolls");

{
  check(rerollCost(0) === 1, "the first reroll is cheap");
  check(rerollCost(3) > rerollCost(0), "and each one costs more");

  const plain = runAt(1);
  check(!rerollIsFree(plain, 0), "rerolls cost gold by default");

  const bell = runAt(1);
  bell.hasDealersBell = true;
  check(rerollIsFree(bell, 0), "Dealer's Bell covers the first reroll");
  check(!rerollIsFree(bell, 1), "but only the first");
}

// ---------------------------------------------------------------------------
console.log("\nPurchases");

{
  const state = runAt(1);
  state.gold = 10;
  const offer = offerFor("pocket_change", state);
  check(applyOffer(state, offer), "an affordable card can be bought");
  check(state.gold === 10 - offer.cost, "and its price leaves the purse");
  check(state.pocketChange === 1, "and its effect lands");
}

console.log("\nBooster packs");

{
  const unlocked = ITEMS.filter((item) => item.unlock).map((item) => item.id);
  const state = newRun(unlocked);
  state.gold = 100;
  let seed = 0x9e3779b9;
  const rng = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const packs = rollBoosterOffers(state, 2, false, rng);
  check(packs.length === 2, "a shop starts with two booster packs");
  check(packs[0].id !== packs[1].id, "the two pack flavors are different");

  const regularPackPrice = boosterPrice(state, packs[0]);
  state.hasPawnbroker = true;
  check(
    boosterPrice(state, packs[0]) === Math.max(1, regularPackPrice - 2),
    "Pawnbroker immediately discounts booster packs",
  );

  const rare = rollBoosterOffers(state, 8, true, rng).find(
    (pack) => pack.rarity === "rare",
  );
  check(!!rare, "the rarity catalog includes a Rare pack");
  if (rare) {
    const choices = openBooster(state, rare, 3, rng);
    check(choices.length === 3, "a pack reveals three choices");
    check(
      choices.every((choice) => choice.rarity === "rare"),
      "a rarity pack keeps every choice in its tier",
    );
    const before = state.gold;
    check(
      applyBoosterChoice(state, choices[0]),
      "the selected booster card can be acquired",
    );
    check(state.gold === before, "the selected card has no second charge");
  }

  state.ownedLedger = true;
  const ledgerPack = rollBoosterOffers(state, 1, false, rng)[0];
  const ledgerChoices = ledgerPack
    ? openBooster(state, ledgerPack, 5, rng)
    : [];
  check(ledgerChoices.length === 5, "Ledger expands a pack to five choices");

  const priced = packs[0];
  const regularPrice = boosterPrice(state, priced);
  state.hasShoppingCart = true;
  check(
    boosterPrice(state, priced) < regularPrice,
    "Shopping Cart discounts booster packs",
  );
}

{
  const state = runAt(1);
  state.gold = 0;
  const offer = offerFor("prism", state);
  check(!applyOffer(state, offer), "an unaffordable card is refused");
  check(state.gold === 0, "without charging");
  check(state.prism === 0, "and without applying its effect");
}

console.log(
  failures === 0
    ? "\nGold economy check: ALL PASS"
    : `\nGold economy check: ${failures} FAILURE(S)`,
);
if (failures > 0) process.exit(1);
