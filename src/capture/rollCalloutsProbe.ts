// Print what each roll-callout clip will show, without a browser: the rolls use
// the same seeded streams GameScene does, so these are the clips' numbers — and
// which of them cross the trial's goal, which is what the callout's acclaim is
// staged off (see ui/rollBreakdown).
//
//   node node_modules/tsx/dist/cli.mjs src/capture/rollCalloutsProbe.ts

import "../sim/localStorageShim";
import { resolveRoll, rollPool, trialComplete } from "../sim/engine";
import { goalFor } from "../systems/Boss";
import { formatMultiplier, rollBreakdown } from "../systems/RollBreakdown";
import { streamFor } from "../systems/Rng";
import { formatScore } from "../ui/formatScore";
import {
  ROLL_CALLOUT_PRESET_IDS,
  rollCalloutReel,
  rollCalloutRun,
} from "./rollCallouts";

let failed = false;
for (const id of ROLL_CALLOUT_PRESET_IDS) {
  const run = rollCalloutRun(id);
  console.log(
    `\n${id}: ${run.dice.length.toLocaleString()} dice, goal ${formatScore(goalFor(run))}`,
  );
  const reel = rollCalloutReel(id);
  for (let index = 0; index < reel.rolls; index++) {
    if (trialComplete(run)) {
      console.log(`  roll ${index + 1}: the trial is already over`);
      failed = true;
      break;
    }
    const scoreBefore = run.score;
    rollPool(
      run,
      run.dice,
      streamFor(run.seed, "roll", `${run.trial}:${run.roll}`),
    );
    const { result } = resolveRoll(
      run,
      streamFor(run.seed, "roll", `${run.trial}:${run.roll}:resolve`),
    );
    const breakdown = rollBreakdown(result);
    if (!breakdown) {
      console.log(`  roll ${index + 1}: scored nothing`);
      continue;
    }
    console.log(
      `  roll ${index + 1}: ${breakdown.dice} dice` +
        breakdown.bonuses.map((b) => ` + ${b.name} ${b.points}`).join("") +
        ` = ${breakdown.subtotal}`,
    );
    console.log(
      `    ×1 → ` +
        breakdown.steps
          .map((s) => `${s.name} ${s.factor} (×${formatMultiplier(s.after)})`)
          .join(" → "),
    );
    const goal = goalFor(run);
    const acclaim =
      scoreBefore < goal && run.score >= goal
        ? run.roll === 1
          ? " — ACCLAIM: first roll clear"
          : " — ACCLAIM: goal met"
        : "";
    console.log(
      `    = ×${formatMultiplier(breakdown.multiplier)} → +${formatScore(breakdown.points)}` +
        ` (score ${formatScore(run.score)} of ${formatScore(goal)})${acclaim}`,
    );
  }
}
if (failed) process.exitCode = 1;
