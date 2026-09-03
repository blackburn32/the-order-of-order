// The mirror duel is a fair coin — this proves it, and is the only thing that
// can.
//
// The final Boss Trial is played against an exact copy of the player's grid,
// scored by the player's own build under the player's own afflictions. Nothing
// in the duel is tuned, so there is no number here to adjust: the win rate is
// 50% or the mirror is broken. A result meaningfully off 50% means some rule is
// reaching one side and not the other — a growth passive applied to the run's
// pool by name, an affliction read off `state.dice`, a roll budget counted for
// one side only.
//
// Run: node node_modules/tsx/dist/cli.mjs src/sim/duelCheck.ts

import { WIN_TRIAL } from "../config";
import { newRun, type RunState } from "../state/RunState";
import { type AfflictionId } from "../systems/Afflictions";
import { playerLeadsDuel } from "../systems/Rival";
import { trialRollTarget } from "../systems/Trial";
import { prepareDuel, resolveRoll, rollPool } from "./engine";

const DUELS = 4000;

/** A seeded, cheap generator, so a failure can be reproduced exactly. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One duellist's build. Deliberately varied across the sample: the mirror has
 *  to hold for a swarm of d1s and for a compounding multiplier stack alike, and
 *  a bug that only shows under Genesis would hide behind a plain grid. */
interface Build {
  name: string;
  apply: (state: RunState) => void;
}

const BUILDS: Build[] = [
  {
    name: "plain grid",
    apply: (state) => {
      state.dice.addDice(6, 120);
    },
  },
  {
    name: "swarm + molds",
    apply: (state) => {
      state.dice.addDice(2, 300);
      state.brickMold = 2;
      state.chipMold = 1;
    },
  },
  {
    name: "genesis engine",
    apply: (state) => {
      state.dice.addDice(1, 40);
      state.genesis = 2;
      state.hasDoubleTheFun = true;
    },
  },
  {
    name: "multiplier stack",
    apply: (state) => {
      state.dice.addDice(6, 80);
      state.prism = 2;
      state.lastCall = 1;
      state.extraPoints = 3;
      state.scoringNumbers = [1, 2];
    },
  },
  {
    name: "under affliction",
    apply: (state) => {
      state.dice.addDice(6, 200);
      // Both destruction afflictions at once, which is the pairing most likely
      // to bill one side's grid and not the other's.
      state.afflictions = ["betrayal", "bloodPrice"] as AfflictionId[];
      state.hasBloodPrice = true;
    },
  },
];

/** Play the duel out and report how it ended. A tie is called out separately
 *  because it is the one outcome the rules break symmetry on: clearing the
 *  trial takes a higher score, so a dead heat goes to the Order of Disorder. */
function duel(build: Build, seed: number): "win" | "loss" | "tie" {
  const state = newRun([]);
  state.trial = WIN_TRIAL;
  state.roll = 0;
  state.score = 0n;
  state.trialCleared = false;
  build.apply(state);
  prepareDuel(state);

  const rng = makeRng(seed);
  const rolls = trialRollTarget(state);
  for (let r = 0; r < rolls; r++) {
    rollPool(state, state.dice, rng);
    resolveRoll(state, rng);
  }
  if (playerLeadsDuel(state)) return "win";
  return state.score === (state.rival?.score ?? 0n) ? "tie" : "loss";
}

let failures = 0;
console.log(`\nMirror duel — ${DUELS} duels per build\n`);

for (const build of BUILDS) {
  let wins = 0;
  let ties = 0;
  for (let i = 0; i < DUELS; i++) {
    const outcome = duel(build, i * 7919 + 1);
    if (outcome === "win") wins += 1;
    else if (outcome === "tie") ties += 1;
  }
  const rate = wins / DUELS;
  // Three standard errors on a fair coin at this sample size. Wide enough that
  // a passing build is genuinely fair rather than merely close, and tight
  // enough to catch a rule reaching one side of the mirror only.
  const tolerance = 3 * Math.sqrt(0.25 / DUELS);
  const fair = Math.abs(rate - 0.5) <= tolerance;
  if (!fair) failures += 1;
  console.log(
    `  ${fair ? "ok  " : "FAIL"} ${build.name.padEnd(18)} ` +
      `player wins ${(rate * 100).toFixed(1)}% ` +
      `(fair within ±${(tolerance * 100).toFixed(1)}%)` +
      (ties ? ` · ${ties} ties, lost by rule` : ""),
  );
}

console.log(
  failures === 0
    ? "\nMirror duel check: the duel is fair.\n"
    : `\nMirror duel check: ${failures} BUILD(S) OFF A FAIR COIN.\n`,
);
if (failures > 0) process.exitCode = 1;
