// Executable spec for the appraising shopper: the clone it thinks on
// (sim/cloneRun.ts), the measurement it thinks with (sim/appraise.ts), and the
// strategy that acts on both (sim/expert.ts).
//
// Run: npm run expert:check
//
// Two of these assertions are the whole point of the module and are worth naming
// out loud. A hypothesis must not touch the run it was taken from — the bot buys
// cards on copies, and a leak there would let an appraisal quietly alter the run
// it was appraising for. And a card that needs a die must land on the RIGHT die:
// that single behaviour is most of the gap between this bot and the eight that
// target at random, and it is the reason a goal curve designed against them is
// one a competent player clears on their opening roll.

import { RARITY_WEIGHTS } from "../config";
import { DIE_LADDER, makeDie } from "../systems/Dice";
import { DicePool } from "../systems/DicePool";
import { offerFor } from "../systems/Shop";
import { newRun, type RunState } from "../state/RunState";
import {
  appraiseOffer,
  groupKeyOf,
  log10Big,
  measureCapacity,
  quantile,
  resolveGroupIndex,
  targetChoices,
} from "./appraise";
import { cloneRunState } from "./cloneRun";
import { DEFAULT_CONFIG, GATED_ITEM_IDS } from "./config";
import { simulateRun } from "./bot";
import { beginRun } from "./engine";
import { expertShopVisit } from "./expert";
import {
  installStorage,
  mulberry32,
  seedGlobalRandom,
} from "./localStorageShim";

installStorage(GATED_ITEM_IDS);
seedGlobalRandom(11);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}

/** A run at a named trial holding a named grid — the shape most of these
 *  assertions want, without playing a ladder to get there. */
function runWith(sides: number[], trial = 4, gold = 40): RunState {
  const state = newRun(GATED_ITEM_IDS);
  state.dice = DicePool.fromDice(
    sides.map((s) => makeDie(s as (typeof DIE_LADDER)[number])),
  );
  state.trial = trial;
  state.gold = gold;
  beginRun(state);
  return state;
}

// ---------------------------------------------------------------------------
console.log("\nlog10 of a score");

check(log10Big(0n) === 0, "zero reads as zero rather than -Infinity");
check(Math.abs(log10Big(1000n) - 3) < 1e-9, "1,000 is exactly 3");
check(
  Math.abs(log10Big(10n ** 400n) - 400) < 1e-6,
  "a score far past Number.MAX_VALUE still reads its exponent",
);
check(
  log10Big(10n ** 400n) < log10Big(10n ** 401n),
  "and two such scores still compare (Number(v) would tie them at Infinity)",
);

// ---------------------------------------------------------------------------
console.log("\nA hypothesis cannot touch the run it came from");

const original = runWith([20, 6, 6, 2]);
const originalDice = original.dice.length;
const originalGold = original.gold;
const clone = cloneRunState(original);
clone.gold = 0;
clone.dice = DicePool.fromDice([makeDie(4)]);
clone.afflictions.push("betrayal");
clone.purchases.prism = 9;
clone.scoringNumbers.push(5);

check(original.gold === originalGold, "the source keeps its gold");
check(original.dice.length === originalDice, "the source keeps its grid");
check(original.afflictions.length === 0, "the source takes no afflictions");
check(
  original.purchases.prism === undefined,
  "the source's purchases are its own",
);
check(
  original.scoringNumbers.length === 1,
  "the source's scoring numbers are its own",
);

const before = `${original.dice.summary()}|${original.score}|${original.roll}|${original.gold}`;
measureCapacity(original, { samples: 4, seed: 3 });
check(
  `${original.dice.summary()}|${original.score}|${original.roll}|${original.gold}` ===
    before,
  "measuring a state's capacity leaves the state exactly as it was",
);

// ---------------------------------------------------------------------------
console.log("\nCommon random numbers");

const a = measureCapacity(runWith([20, 6, 6, 2]), { samples: 5, seed: 99 });
const b = measureCapacity(runWith([20, 6, 6, 2]), { samples: 5, seed: 99 });
check(
  a.logSamples.join(",") === b.logSamples.join(","),
  "the same state and seed produce the same roll-outs",
);
const c = measureCapacity(runWith([20, 6, 6, 2]), { samples: 5, seed: 100 });
check(
  c.logSamples.join(",") !== a.logSamples.join(","),
  "a different seed produces different ones",
);

// ---------------------------------------------------------------------------
console.log("\nNaming a die across a clone");

const gridded = runWith([20, 20, 6, 2]);
const groups = gridded.dice.groups();
check(groups.length === 3, "three sizes read as three groups");
for (const group of groups) {
  const key = groupKeyOf(group.die);
  const index = resolveGroupIndex(cloneRunState(gridded).dice, key);
  check(
    index !== null,
    `d${group.die.sides} is findable by key on a clone (index ${index})`,
  );
}

// ---------------------------------------------------------------------------
console.log("\nWhich die a card is offered");

const sealState = runWith([20, 6]);
const seal = offerFor("royal_seal", sealState);
check(
  (targetChoices(sealState, seal) ?? []).length === 2,
  "Royal Seal is offered both unsealed sizes",
);
sealState.royalSealSizes = [20, 6];
check(
  targetChoices(sealState, seal) === null,
  "and none once every size it could name is already sealed — the card is unbuyable",
);

const shrinkState = runWith([1, 1]);
check(
  targetChoices(shrinkState, offerFor("shrink", shrinkState)) === null,
  "Shrink is unbuyable on a grid that is all d1 — nothing left to shrink",
);

const plain = runWith([6, 6]);
check(
  (targetChoices(plain, offerFor("prism", plain)) ?? []).length === 1,
  "a card that needs no die gets one keyless choice, not zero",
);

// ---------------------------------------------------------------------------
console.log("\nThe card lands on the right die");

// A die scores by landing on a scoring number, so a SMALL die is the good one:
// a d2 hits `1` half the time where a d20 hits it once in twenty. The big die is
// the trap, and it is the trap a bot that targets at random walks into three
// times in four on this grid.
//
// Twin copies the die it is pointed at, so the copy belongs on the d2.
const twinState = runWith([20, 2, 2, 2], 6, 40);
const twinBaseline = measureCapacity(twinState, { samples: 9, seed: 5 });
const twinPick = appraiseOffer(
  twinState,
  offerFor("twin", twinState),
  twinBaseline,
  { samples: 9, seed: 5 },
);
check(twinPick !== null, "Twin can be appraised on a mixed grid");
check(
  twinPick?.targetKey === groupKeyOf(makeDie(2)),
  `Twin copies the d2, not the d20 (chose ${twinPick?.targetKey})`,
);

// Loaded Die takes a size's top two faces away, which raises the odds of what is
// left. On a d20 that is 1/18 instead of 1/20; on a d2 it is everything, because
// `rollDie` floors a loaded die at one face — a loaded d2 rolls a 1 every time.
const loadState = runWith([20, 2, 2, 2], 6, 40);
const loadPick = appraiseOffer(
  loadState,
  offerFor("loaded_die", loadState),
  measureCapacity(loadState, { samples: 9, seed: 17 }),
  { samples: 9, seed: 17 },
);
check(
  loadPick?.targetKey === groupKeyOf(makeDie(2)),
  `Loaded Die loads the d2, which then always scores (chose ${loadPick?.targetKey})`,
);

// ---------------------------------------------------------------------------
console.log("\nA free card on the shelf does not end the visit");

// Every curse is free, and so is anything a Coupon Book has taken the price
// off, so free cards turn up on shelves in twos often enough to matter. A free
// card converts no gold into points, which makes it infinitely efficient — and a
// spending floor taken as a share of "the best card here" would then be infinite
// too, ending the visit at the first card that costs anything and leaving the
// run's whole purse in the bank for the rest of the ladder.
//
// Two free cards rather than one because the shelf is shopped in passes that
// take a card each: with one, the second pass sees a shelf that no longer has a
// free card on it and prices the rest normally, which hides the fault.
const freeShelf = runWith([6, 6, 2], 6, 60);
const freeOffers = [
  offerFor("gamblers_curse", freeShelf),
  offerFor("the_bloat", freeShelf),
];
const paidOffer = offerFor("mult2", freeShelf);
check(
  freeOffers.every((offer) => offer.cost === 0) && paidOffer.cost > 0,
  `the shelf holds two free cards and a paid one (${paidOffer.cost}g)`,
);

const purseBefore = freeShelf.gold;
const visit = expertShopVisit(
  freeShelf,
  [...freeOffers, paidOffer],
  [],
  RARITY_WEIGHTS,
  mulberry32(4),
  1,
  { samples: 4, seed: 61 },
);
check(
  visit.taken.some((purchase) => purchase.id === "mult2"),
  `the paid card is still bought (took ${visit.taken.map((p) => p.id).join(", ") || "nothing"})`,
);
check(
  freeShelf.gold < purseBefore,
  `and the purse is actually spent (${purseBefore}g → ${freeShelf.gold}g)`,
);

// ---------------------------------------------------------------------------
console.log("\nMore dice is more capacity");

const small = measureCapacity(runWith([6, 6]), { samples: 15, seed: 31 });
const large = measureCapacity(runWith([6, 6, 6, 6, 6, 6, 6, 6]), {
  samples: 15,
  seed: 31,
});
check(
  quantile(large.logSamples, 0.5) > quantile(small.logSamples, 0.5),
  "a grid four times the size measures higher on the same dice",
);

// ---------------------------------------------------------------------------
console.log("\nThe expert plays a whole run");

const cfg = { ...DEFAULT_CONFIG, runs: 1, expertSamples: 2 };
const record = simulateRun("expert", 2_024, cfg);
check(
  record.trialReached >= 1,
  `the run resolves (reached trial ${record.trialReached})`,
);
check(
  record.strategy === "expert",
  "and is recorded under its own strategy name",
);
check(
  Object.keys(record.purchases).length > 0,
  `the expert buys cards (${Object.keys(record.purchases).length} distinct)`,
);
check(
  record.goldSpent > 0,
  `and spends gold on them (${record.goldSpent} across the run)`,
);

// The end-to-end version of the targeting assertions above: over a matched seed
// stream, an appraising shopper should outlast one that buys by price. Averaged
// rather than taken from a single run, because one run of a game this swingy
// says nothing — a single seed had the expert on trial 9 and greedy on trial 27
// while the mean ran the other way by two and a half trials.
const MATCHED_RUNS = 12;
function meanTrialReached(strategy: "expert" | "greedy"): number {
  let total = 0;
  for (let i = 0; i < MATCHED_RUNS; i++) {
    total += simulateRun(strategy, 5_000 + i * 17, {
      ...DEFAULT_CONFIG,
      expertSamples: 3,
    }).trialReached;
  }
  return total / MATCHED_RUNS;
}
const expertReach = meanTrialReached("expert");
const greedyReach = meanTrialReached("greedy");
check(
  expertReach > greedyReach,
  `the expert outlasts the greedy shopper on a matched seed stream ` +
    `(trial ${expertReach.toFixed(1)} vs ${greedyReach.toFixed(1)})`,
);

console.log(
  failures === 0
    ? "\nExpert check: ALL PASS"
    : `\nExpert check: ${failures} FAILURE(S)`,
);
if (failures > 0) process.exit(1);
