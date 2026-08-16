// Round-loop rules check: a round ends the moment its survival target is met,
// the early clear is latched against later shop spending, and the shop visit it
// earns never doubles up with a checkpoint visit. Run with `npm run rounds:check`.

import {
  ROLLS_PER_ROUND,
  SHOP_ROLLS,
  survivalTarget,
  WIN_ROUND,
} from "../config";
import { newRun, RunState } from "../state/RunState";
import { offerFor, applyOffer } from "../systems/Shop";
import {
  clearedEarly,
  resolveRoll,
  resolveRoundEnd,
  roundComplete,
  roundRollTarget,
  shouldOpenShop,
} from "./engine";

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/** Roll the pool and resolve the roll, exactly as GameScene and the bot do.
 *  `rng` at 0 makes every die show its lowest face (a 1 — a scoring number). */
function takeRoll(state: RunState, rng: () => number = () => 0): void {
  state.dice.roll(rng, state.scoringNumbers, state.royalSealSizes);
  resolveRoll(state, rng);
}

// A fresh round is not complete, and a target met mid-round ends it early.
{
  const state = newRun();
  check(!roundComplete(state), "A round with no rolls taken is not complete");

  // Round 1's target is 3 points and one d6 showing a 1 scores 1 point a roll.
  const target = survivalTarget(1, false);
  check(target === 3n, "This check assumes a round-1 target of 3");

  takeRoll(state);
  check(state.score === 1n, "One scoring d6 should bank one point");
  check(!state.roundCleared, "One point should not clear a three-point round");
  check(!roundComplete(state), "The round continues below its target");

  takeRoll(state);
  takeRoll(state);
  check(state.score === 3n, "Three rolls should reach the target exactly");
  check(state.roundCleared, "Meeting the target should clear the round");
  check(roundComplete(state), "A cleared round is complete");
  check(clearedEarly(state), "Clearing on roll 3 of 20 is an early clear");
  check(
    state.roll === 3 && state.roll < roundRollTarget(state),
    "The early clear should leave the unused rolls on the counter",
  );
}

// The early clear advances the run, and the next round starts uncleared even
// when the carried-over score already exceeds its target.
{
  const state = newRun();
  state.hasVault = true; // carries 33% of the cleared score into the next round
  state.score = 300n;
  takeRoll(state); // latches the clear (300 >> the round-1 target of 3)
  check(clearedEarly(state), "A big score should clear round 1 early");

  const outcome = resolveRoundEnd(state);
  check(outcome.phase === "advanced", "An early clear should advance the run");
  check(state.round === 2, "The round counter should advance");
  check(state.roll === 0, "The roll counter should reset");
  check(!state.roundCleared, "The new round should start uncleared");
  check(
    state.score > survivalTarget(2, false),
    "This check needs a carryover above the round-2 target",
  );
  check(
    !roundComplete(state),
    "A carryover above the target must not clear a round before a roll is taken",
  );
  takeRoll(state);
  check(
    roundComplete(state) && clearedEarly(state),
    "The first roll of the new round should then clear it immediately",
  );
}

// Spending the bonus shop visit back below the target does not undo the clear.
{
  const state = newRun();
  state.score = 500n;
  takeRoll(state);
  check(clearedEarly(state), "The round should be cleared before shopping");

  const offer = { ...offerFor("extra_die", state), cost: state.score };
  check(applyOffer(state, offer), "The bonus-shop purchase should succeed");
  check(state.score === 0n, "The purchase should spend the whole score");
  check(
    state.score < survivalTarget(state.round, state.hardMode),
    "This check needs a post-purchase score below the target",
  );
  check(roundComplete(state), "The round stays complete after spending");

  const outcome = resolveRoundEnd(state);
  check(
    outcome.phase === "advanced",
    "Spending an early clear's score must not turn the round into a game over",
  );
  check(!outcome.insuranceUsed, "A banked clear should not consume Insurance");
}

// Falling short across all 20 rolls still ends the run, and still gets no shop.
{
  const state = newRun();
  state.round = 5; // target 200, far out of reach for a lone d6
  state.score = 0n;
  let shopVisits = 0;
  for (let i = 0; i < ROLLS_PER_ROUND; i++) {
    takeRoll(state, () => 0.99); // every die shows its top face: no points
    if (shouldOpenShop(state) || clearedEarly(state)) shopVisits += 1;
    if (roundComplete(state)) break;
  }
  check(state.score === 0n, "Non-scoring faces should bank nothing");
  check(state.roll === ROLLS_PER_ROUND, "A failing round runs its full length");
  check(roundComplete(state), "Exhausted rolls complete the round");
  check(!clearedEarly(state), "Running out of rolls is not an early clear");
  check(shopVisits === 2, "A full round should still hit both checkpoints");
  check(
    resolveRoundEnd(state).phase === "gameOver",
    "Missing the target across every roll should end the run",
  );
}

// A clear landing exactly on a checkpoint roll takes one shop visit, not two.
{
  const state = newRun();
  const checkpoint = SHOP_ROLLS[0];
  let shopVisits = 0;
  for (let i = 0; i < ROLLS_PER_ROUND; i++) {
    // Score nothing until the checkpoint roll, which then clears the round.
    if (state.roll + 1 === checkpoint) state.score = 10_000n;
    takeRoll(state, () => 0.99);
    if (shouldOpenShop(state) || clearedEarly(state)) shopVisits += 1;
    if (roundComplete(state)) break;
  }
  check(state.roll === checkpoint, "The round should end on the checkpoint");
  check(shouldOpenShop(state), "Roll 5 is a checkpoint");
  check(clearedEarly(state), "The same roll cleared the round early");
  check(shopVisits === 1, "A checkpoint clear should open the shop once");
}

// Clearing the final round early wins outright — and takes no bonus shop visit,
// since the score is never reset and the run ends there.
{
  const state = newRun();
  state.round = WIN_ROUND;
  state.score = survivalTarget(WIN_ROUND, false);
  takeRoll(state);
  check(clearedEarly(state), "The final round should clear early too");
  check(
    !(clearedEarly(state) && state.round < WIN_ROUND),
    "A winning clear should not earn the bonus shop visit",
  );
  check(
    resolveRoundEnd(state).phase === "victory",
    "Clearing the final round early should win the run",
  );
}

console.log("Round-end rules check: ALL PASS");
