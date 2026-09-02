// Executable spec for the trial loop: the rules in sim/engine.ts that decide
// when a trial is over, what a clear pays, and how the ladder advances.
//
// Run: npm run trials:check
//
// These assertions are the safety net for anything that touches the loop. They
// exercise the engine directly rather than through GameScene, so a failure here
// is a rules bug and not a presentation one.

import {
  isBossTrial,
  rankOf,
  rollsForTrial,
  setTrialGoals,
  STARTING_DICE,
  TRIALS_PER_RANK,
  trialGoal,
  trialInRank,
  WIN_TRIAL,
} from "../config";
import { newRun, RunState } from "../state/RunState";
import { activeBoss, goalFor } from "../systems/Boss";
import { STARTING_GOLD } from "../systems/Gold";
import {
  clearedEarly,
  beginRun,
  continueEndless,
  resolveTrialEnd,
  trialComplete,
  trialRollTarget,
} from "./engine";
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

/** A run parked on `trial` with a clean slate, for driving one rule at a time. */
function runAt(trial: number): RunState {
  const state = newRun([]);
  state.trial = trial;
  state.roll = 0;
  state.score = 0n;
  state.trialCleared = false;
  return state;
}

// ---------------------------------------------------------------------------
console.log("\nLadder shape");

check(WIN_TRIAL === 30, "the ladder is 30 trials long");
check(
  rankOf(1) === 1 && rankOf(3) === 1 && rankOf(4) === 2 && rankOf(30) === 10,
  "ranks group trials in threes",
);
check(
  trialInRank(1) === 1 && trialInRank(3) === 3 && trialInRank(4) === 1,
  "trial-within-rank cycles 1,2,3",
);
check(
  !isBossTrial(1) && !isBossTrial(2) && isBossTrial(3) && isBossTrial(30),
  "every third trial is a Boss Trial",
);
check(
  rollsForTrial(1) === 7 && rollsForTrial(2) === 15 && rollsForTrial(3) === 20,
  "trials grant 7 / 15 / 20 rolls",
);
{
  // The curve rises per SLOT, not across the whole ladder: a rank's 7-roll
  // Lesser Trial asks for less than the 20-roll Boss Trial before it, which is
  // the shape of a rank rather than a mistake. What must always rise is the same
  // slot from one rank to the next. Equal adjacent-rank goals are allowed at
  // the very start of the curve, where the smaller opening grid is the wall.
  let neverDropsPerSlot = true;
  for (let t = TRIALS_PER_RANK + 1; t <= WIN_TRIAL; t++) {
    if (trialGoal(t) < trialGoal(t - TRIALS_PER_RANK))
      neverDropsPerSlot = false;
  }
  check(
    neverDropsPerSlot,
    "each trial asks at least as much as the same slot a rank below",
  );

  let neverDropsInRank = true;
  for (let t = 1; t <= WIN_TRIAL; t++) {
    if (trialInRank(t) === 1) continue;
    if (trialGoal(t) < trialGoal(t - 1)) neverDropsInRank = false;
  }
  check(
    neverDropsInRank,
    "and at least as much as the trial before it within its own rank",
  );
}
check(
  trialGoal(WIN_TRIAL + 1) > trialGoal(WIN_TRIAL),
  "endless goals continue past the final rank",
);
{
  // Endless growth must ACCELERATE, or a compounding build outruns it forever.
  const step = (t: number) => Number(trialGoal(t + 1)) / Number(trialGoal(t));
  check(
    step(WIN_TRIAL + 5) > step(WIN_TRIAL + 1),
    "each endless step grows faster than the last",
  );
}

// ---------------------------------------------------------------------------
console.log("\nTrial completion");

{
  const state = runAt(1);
  check(!trialComplete(state), "a fresh trial is not complete");
  state.roll = trialRollTarget(state);
  check(trialComplete(state), "a trial ends when its rolls run out");
}

{
  const state = runAt(1);
  state.trialCleared = true;
  state.roll = 1;
  check(trialComplete(state), "meeting the goal ends the trial immediately");
  check(clearedEarly(state), "clearing with rolls in hand is an early clear");
}

{
  // The clear latch must survive anything that happens afterwards — it is what
  // stops a later mutation from silently un-clearing a trial the player won.
  const state = runAt(1);
  state.trialCleared = true;
  state.score = 0n;
  check(
    trialComplete(state),
    "the clear latch holds even if the score is emptied",
  );
}

// ---------------------------------------------------------------------------
console.log("\nAdvancing");

{
  const state = runAt(1);
  state.score = goalFor(state);
  state.trialCleared = true;
  state.roll = 3;
  state.trialRollGold = { titheBowl: 2, luckyCoin: 1 };
  const before = state.gold;
  const out = resolveTrialEnd(state);
  check(out.phase === "advanced", "a cleared trial advances the ladder");
  check(state.trial === 2, "the trial counter moves on");
  check(state.score === 0n, "score resets to zero for the new trial");
  check(state.roll === 0, "the roll counter resets");
  check(!state.trialCleared, "the clear latch resets");
  check(state.gold > before, "clearing a trial pays gold");
  check(
    out.goldEarned === state.gold - before,
    "the payout matches the report",
  );
  check(
    out.rollGold.total === 3,
    "the report includes gold earned during rolls",
  );
  check(
    out.totalGoldEarned === out.goldEarned + 3,
    "the result receipt totals clear and in-trial gold",
  );
  check(
    state.trialRollGold.titheBowl === 0 && state.trialRollGold.luckyCoin === 0,
    "the next trial starts a fresh gold receipt",
  );
}

{
  const state = runAt(2);
  const out = resolveTrialEnd(state); // score 0, rolls exhausted by definition
  check(out.phase === "gameOver", "failing the goal ends the run");
  check(out.goldEarned === 0, "a failed trial pays nothing");
}

{
  // A rank carries one previewable modifier throughout; entering a new rank
  // rolls a fresh assignment instead of clearing it.
  const state = runAt(2);
  state.trialCleared = true;
  resolveTrialEnd(state);
  check(state.trial === 3, "advanced into the Boss Trial");
  check(state.bossModifiers.length > 0, "a boss modifier is armed for trial 3");
  const firstBoss = state.bossModifiers[0];

  state.trialCleared = true;
  resolveTrialEnd(state);
  check(state.trial === 4, "advanced out of the Boss Trial");
  check(state.bossModifiers.length > 0, "the next rank has a previewable boss");
  check(
    state.bossModifiers[0] !== firstBoss,
    "consecutive ranks avoid repeats",
  );
}

{
  const state = runAt(3);
  state.trialCleared = true;
  const out = resolveTrialEnd(state);
  check(out.bossCleared, "clearing trial 3 counts as clearing a boss");
  check(state.bossesCleared === 1, "the boss tally increments");
  check(state.boonNextShop, "a boss clear earns the next shop's boon");
  check(rankOf(state.trial) === 2, "clearing the Boss Trial raises the rank");
}

// ---------------------------------------------------------------------------
console.log("\nEndings");

{
  const state = runAt(WIN_TRIAL);
  state.trialCleared = true;
  const out = resolveTrialEnd(state);
  check(out.phase === "victory", "clearing the final trial wins the run");
  check(state.trial === WIN_TRIAL, "victory leaves the ladder where it was");
  check(out.goldEarned > 0, "the winning clear still pays its gold");
}

{
  const state = runAt(WIN_TRIAL);
  state.endless = true;
  state.trialCleared = true;
  const out = resolveTrialEnd(state);
  check(out.phase === "advanced", "an endless run continues past the win");
  check(state.trial === WIN_TRIAL + 1, "and climbs into the endless ladder");
}

{
  const state = runAt(WIN_TRIAL);
  state.trialCleared = true;
  resolveTrialEnd(state); // victory
  continueEndless(state);
  check(state.endless, "continuing marks the run endless");
  check(state.trial === WIN_TRIAL + 1, "and moves past the final trial");
  check(state.score === 0n && state.roll === 0, "on a fresh trial");
}

// ---------------------------------------------------------------------------
console.log("\nInsurance Policy");

// A trial deep enough that 75% of its goal is an exact integer — the early
// goals are single digits, where integer division would land below the
// threshold and test nothing.
const INSURED_TRIAL = 12;

{
  const state = runAt(INSURED_TRIAL);
  state.hasInsurancePolicy = true;
  state.ownedUnique.push("insurance_policy");
  state.purchases.insurance_policy = 1;
  const goal = goalFor(state);
  check(
    (goal * 3n) % 4n === 0n,
    `trial ${INSURED_TRIAL}'s goal divides cleanly for the 75% test`,
  );
  state.score = (goal * 3n) / 4n; // exactly 75% of the goal
  const out = resolveTrialEnd(state);
  check(out.phase === "advanced", "insurance saves a trial at 75% of its goal");
  check(out.insuranceUsed, "the outcome reports the save");
  check(!state.hasInsurancePolicy, "the policy is destroyed");
  check(
    state.purchases.insurance_policy === undefined,
    "and removed from the inventory",
  );
  check(
    out.goldEarned === 0,
    "a trial survived on insurance was not cleared, so it pays nothing",
  );
}

{
  const state = runAt(INSURED_TRIAL);
  state.hasInsurancePolicy = true;
  state.score = (goalFor(state) * 7n) / 10n; // 70% — below the threshold
  check(
    resolveTrialEnd(state).phase === "gameOver",
    "insurance does not save a trial below 75%",
  );
}

// ---------------------------------------------------------------------------
console.log("\nStarting state");

{
  const state = newRun([]);
  check(state.trial === 1, "a run starts on trial 1");
  check(
    STARTING_DICE === 1 && state.dice.length === 1,
    "with one starting die",
  );
  check(trialGoal(1) === 1n, "with a starting goal of 1");
  check(trialGoal(2) === 3n, "with a second-trial goal of 3");
  check(state.gold === STARTING_GOLD, "with a starting purse");
  check(state.score === 0n, "and no score");
  check(!state.endless, "and is not endless");
  check(
    trialRollTarget(state) === rollsForTrial(1),
    "and the first trial's own roll budget",
  );
  beginRun(state, () => 0);
  check(
    state.bossModifiers.length > 0,
    "and previews the rank's boss immediately",
  );
  check(activeBoss(state) === null, "without applying the boss before trial 3");
}

// ---------------------------------------------------------------------------
console.log("\nGoal overrides (the sim's balancing hook)");

{
  setTrialGoals(new Array(WIN_TRIAL).fill(1));
  check(trialGoal(1) === 1n, "an override table replaces the authored goals");
  setTrialGoals(null);
  check(trialGoal(1) > 0n, "and clearing it restores them");
}

check(TRIALS_PER_RANK === 3, "a rank is three trials");

console.log(
  failures === 0
    ? "\nTrial-loop rules check: ALL PASS"
    : `\nTrial-loop rules check: ${failures} FAILURE(S)`,
);
if (failures > 0) process.exit(1);
