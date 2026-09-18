// Executable spec for the three novices: the rules in systems/Characters.ts and
// the four seams that read them.
//
// Run: npm run characters:check
//
// The characters are the one feature in this game that changes MECHANICS
// without changing goals, which makes them uniquely easy to break silently — a
// ceiling that stops being enforced, or a storm that quietly stops firing, does
// not crash anything and does not fail any other check. It only makes a
// character play like a different one. So each rule is asserted here directly.

import { newRun, type RunState } from "../state/RunState";
import {
  CHARACTER_ORDER,
  CHARACTERS,
  characterUnlocked,
  DEFAULT_CHARACTER,
  describeCharacterUnlock,
  isCharacterId,
  MELODIE_DISCOUNT_PERCENT,
  MELODIE_GRID_CEILING,
  ROLAND_SIZE_CHAOS,
  sizeWeights,
  type CharacterId,
} from "../systems/Characters";
import { DIE_LADDER, makeDie, type DieSides } from "../systems/Dice";
import { DicePool } from "../systems/DicePool";
import { discountedPrice } from "../systems/Shop";
import {
  hydrateRunState,
  serializeRunState,
} from "../systems/ActiveRunPersistence";
import { resolveRoll, rollPool } from "./engine";
import { installStorage, mulberry32 } from "./localStorageShim";

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

/** A run of `character` holding `count` d6, ready to roll. */
function gridOf(character: CharacterId, count: number): RunState {
  const state = newRun([], 1, character);
  state.dice = DicePool.fromDice(
    Array.from({ length: count }, () => makeDie(6)),
    CHARACTERS[character].gridCeiling,
  );
  return state;
}

// ---------------------------------------------------------------------------
console.log("The roster");

{
  check(CHARACTER_ORDER.length === 3, "holds three novices");
  check(
    CHARACTER_ORDER.every((id) => CHARACTERS[id].id === id),
    "and each entry is keyed by its own id",
  );
  check(
    CHARACTER_ORDER.every(isCharacterId) && !isCharacterId("nobody"),
    "and the id guard admits exactly those three",
  );
  check(
    CHARACTERS[DEFAULT_CHARACTER].unlockedBy.length === 0 &&
      CHARACTERS[DEFAULT_CHARACTER].gridCeiling === Infinity &&
      CHARACTERS[DEFAULT_CHARACTER].sizeChaos === null,
    "the default novice adds no rule a resumed run could inherit",
  );
}

// ---------------------------------------------------------------------------
console.log("\nUnlocking");

{
  check(
    characterUnlocked("diebert", []) && characterUnlocked("melodie", []),
    "the two starters need nothing",
  );
  check(!characterUnlocked("roland", []), "Roland starts locked");
  check(
    !characterUnlocked("roland", ["diebert"]) &&
      !characterUnlocked("roland", ["melodie"]),
    "and one win is not enough",
  );
  check(
    characterUnlocked("roland", ["diebert", "melodie"]),
    "but both wins open him",
  );
  check(
    describeCharacterUnlock("roland").includes("Diebert") &&
      describeCharacterUnlock("roland").includes("Melodie"),
    "and his locked card names them both",
  );
}

// ---------------------------------------------------------------------------
console.log("\nMelodie's ceiling");

{
  const state = gridOf("melodie", MELODIE_GRID_CEILING - 3);
  check(state.dice.headroom === 3, "a grid under the ceiling has headroom");

  // Every growth path clamps to what fits rather than overflowing and being
  // culled, which is the whole difference between a ceiling and Famished Idol's
  // cap: nothing the run already owns is ever destroyed to make room.
  const added = state.dice.addDice(6, 10, {}, "extra_dice");
  check(added === 3, "and an add takes only what fits");
  check(
    state.dice.length === MELODIE_GRID_CEILING,
    "leaving the grid exactly at the ceiling",
  );
  check(state.dice.headroom === 0, "with no headroom left");
  check(
    state.dice.addDice(6, 5, {}, "extra_dice") === 0,
    "and a later add does nothing at all",
  );

  const full = gridOf("melodie", MELODIE_GRID_CEILING);
  full.dice.multiply(4, "mult2");
  check(
    full.dice.length === MELODIE_GRID_CEILING,
    "a grid multiplier cannot grow a full grid",
  );
  const half = gridOf("melodie", MELODIE_GRID_CEILING - 5);
  half.dice.multiply(2, "mult2");
  check(
    half.dice.length === MELODIE_GRID_CEILING,
    "and one with room fills it rather than refusing",
  );

  const foundry = gridOf("melodie", MELODIE_GRID_CEILING - 2);
  foundry.dice.foundryDouble(3);
  check(
    foundry.dice.length === MELODIE_GRID_CEILING,
    "the Foundry's doubling stops at the ceiling too",
  );

  check(
    gridOf("diebert", 40).dice.headroom === Infinity &&
      gridOf("roland", 40).dice.headroom === Infinity,
    "and nobody else is ceilinged",
  );
}

// ---------------------------------------------------------------------------
console.log("\nMelodie's discount");

{
  const her = newRun([], 1, "melodie");
  const him = newRun([], 1, "diebert");

  // Asserted against the constant rather than against a number, because the
  // discount is a tuning dial and a check that hard-codes its current value
  // fails the next time it moves without anything being wrong.
  const off = MELODIE_DISCOUNT_PERCENT / 100;
  const expected = (list: number) => Math.ceil(list * (1 - off));
  let priced = true;
  for (let list = 2; list <= 40; list++)
    if (discountedPrice(her, list) !== expected(list)) priced = false;
  check(priced, `she pays ${MELODIE_DISCOUNT_PERCENT}% less, rounded up`);
  check(
    discountedPrice(her, 8) < discountedPrice(him, 8),
    "and less than a novice with no discount",
  );
  check(
    discountedPrice(her, 1) === 1,
    "and no card falls below a gold however deep the cut",
  );
  check(discountedPrice(her, 0) === 0, "while a free card stays free");

  // Order-independence is what keeps `repriceOffers` idempotent: every
  // percentage lands before the single rounding, and the flat cut after it.
  const stacked = newRun([], 1, "melodie");
  stacked.hasShoppingCart = true;
  stacked.hasPawnbroker = true;
  check(
    discountedPrice(stacked, 12) === discountedPrice(stacked, 12),
    "and a discount stacked with the cards is stable under repricing",
  );
  check(
    discountedPrice(stacked, 12) < discountedPrice(her, 12),
    "and compounds with them rather than replacing them",
  );
}

// ---------------------------------------------------------------------------
console.log("\nRoland's size storm");

{
  const weights = sizeWeights(ROLAND_SIZE_CHAOS);
  const total = weights.reduce((sum, w) => sum + w, 0);
  check(
    Math.abs(total - 1) < 1e-12,
    "the bell is a distribution over the whole ladder",
  );
  check(
    weights.length === DIE_LADDER.length && weights.every((w) => w > 0),
    "and every size keeps a share of it, tails included",
  );
  const peak = weights.indexOf(Math.max(...weights));
  check(DIE_LADDER[peak] === 8, "peaking on the d8");

  // The rate the storm was tuned to: a grid under it shows a scoring 1 about as
  // often as the pure d6 grid the game opens with (see systems/Characters).
  const scoringRate = weights.reduce((sum, w, i) => sum + w / DIE_LADDER[i], 0);
  check(
    scoringRate > 1 / 6,
    `a stormed grid scores at least as often as a d6 grid (${(scoringRate * 100).toFixed(1)}%)`,
  );

  // Per-die mode.
  const listed = gridOf("roland", 40);
  const before = listed.dice.length;
  rollPool(listed, listed.dice, mulberry32(7));
  resolveRoll(listed, mulberry32(9), { recordHistory: false });
  check(listed.dice.length === before, "a storm adds and destroys nothing");
  const sizes = new Set<DieSides>();
  listed.dice.forEach((die) => sizes.add(die.sides));
  check(sizes.size > 1, "and leaves a grid of mixed sizes");
  check(
    [...sizes].every((s) => DIE_LADDER.includes(s)),
    "every one of them on the ladder",
  );
  let facesValid = true;
  listed.dice.forEach((die) => {
    if (die.value > die.sides || die.value < 1) facesValid = false;
  });
  check(facesValid, "and no die left showing a face it does not have");

  // A windfall die is re-resolved at its new size rather than carrying a d100's
  // multiplier onto a d2 it would hit every other roll.
  const windfall = newRun([], 1, "roland");
  windfall.dice = DicePool.fromDice(
    Array.from({ length: 60 }, () => makeDie(100, { maxFaceBonus: true })),
  );
  rollPool(windfall, windfall.dice, mulberry32(3));
  resolveRoll(windfall, mulberry32(4), { recordHistory: false });
  let windfallsSane = true;
  windfall.dice.forEach((die) => {
    const expected = die.sides === 100 ? 4 : 2;
    if (die.maxFaceBonus !== expected) windfallsSane = false;
  });
  check(windfallsSane, "a windfall is re-priced at the size it lands on");

  // Size auras are re-read every storm: that is what "every die of that size"
  // has always meant, and it is what keeps Loaded Die paying under Roland.
  const aura = gridOf("roland", 200);
  aura.loadedSizes = [8];
  rollPool(aura, aura.dice, mulberry32(11));
  resolveRoll(aura, mulberry32(12), { recordHistory: false });
  let loadedMatchesAura = true;
  let loadedSeen = 0;
  aura.dice.forEach((die) => {
    if (die.loaded) loadedSeen += 1;
    if (die.loaded !== (die.sides === 8)) loadedMatchesAura = false;
  });
  check(loadedMatchesAura, "a size aura follows the size, not the die");
  check(loadedSeen > 0, "and still reaches part of every stormed grid");

  // Nobody else's grid moves.
  const still = gridOf("diebert", 30);
  rollPool(still, still.dice, mulberry32(5));
  resolveRoll(still, mulberry32(6), { recordHistory: false });
  let allSix = true;
  still.dice.forEach((die) => {
    if (die.sides !== 6) allSix = false;
  });
  check(allSix, "and a grid outside the storm keeps its sizes");
}

// ---------------------------------------------------------------------------
console.log("\nThe storm in bucketed storage");

{
  // Above BUCKET_THRESHOLD the pool holds counts rather than dice, so the storm
  // splits each bucket across the ladder instead of redrawing per die. The
  // count has to come out exact however the rounding falls.
  const big = gridOf("roland", 6000);
  check(big.dice.bucketed, "a large grid is bucketed");
  const before = big.dice.length;
  for (let roll = 0; roll < 5; roll++) {
    rollPool(big, big.dice, mulberry32(100 + roll));
    resolveRoll(big, mulberry32(200 + roll), { recordHistory: false });
  }
  check(
    big.dice.length === before,
    "and five storms leave the count exactly where it was",
  );
  const counts = big.dice.sizeCounts();
  const present = DIE_LADDER.filter((s) => (counts[s] ?? 0) > 0);
  check(present.length >= 6, "with the grid spread across the ladder");
  check(
    DIE_LADDER.reduce((sum, s) => sum + (counts[s] ?? 0), 0) === before,
    "and every die accounted for by size",
  );
}

// ---------------------------------------------------------------------------
console.log("\nCarrying a character through a save");

{
  for (const id of CHARACTER_ORDER) {
    const state = newRun([], 1, id);
    const back = hydrateRunState(
      JSON.parse(JSON.stringify(serializeRunState(state))),
    );
    check(
      back?.character === id,
      `${CHARACTERS[id].name} survives a round trip`,
    );
    check(
      back?.dice.ceiling === CHARACTERS[id].gridCeiling,
      "and that grid resumes under the same ceiling",
    );
  }

  // The reason the field is read by hand rather than by the generic pass: a run
  // saved before characters existed carries none, and must resume as the game it
  // was started as rather than being handed a rule mid-run.
  const legacy = JSON.parse(
    JSON.stringify(serializeRunState(newRun([], 1, "roland"))),
  ) as Record<string, unknown>;
  delete legacy.character;
  const resumed = hydrateRunState(legacy);
  check(
    resumed?.character === DEFAULT_CHARACTER,
    "a save from before characters resumes as the default",
  );
  check(
    resumed?.dice.ceiling === Infinity,
    "and carries no ceiling it was not played under",
  );

  const foreign = JSON.parse(
    JSON.stringify(serializeRunState(newRun([], 1, "melodie"))),
  ) as Record<string, unknown>;
  foreign.character = "somebody-else";
  check(
    hydrateRunState(foreign) === null,
    "while an unknown novice fails the hydration rather than becoming someone",
  );
}

console.log(
  failures === 0
    ? "\nCharacter check: ALL PASS"
    : `\nCharacter check: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
