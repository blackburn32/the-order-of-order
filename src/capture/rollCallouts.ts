// Fixtures for the roll-callout clips: the same callout (ui/rollBreakdown) at
// four scales, from a handful of dice with nothing to multiply them to a 20,000-
// die grid whose multiplier climbs through a dozen cards and two growth engines,
// plus the two clips that are *about* a trial ending — the goal met, and the
// goal met on the trial's first roll.
//
// Each run is built straight from `newRun` rather than from the marketing
// fixtures, so a clip shows exactly the cards named here and nothing else. Every
// fixture but the clearing pair is meant to survive its whole reel, since a
// cleared trial hands the scene to the results screen mid-clip; the clearing
// pair says so with `clears` on its reel, and its single roll is the clip.
// `npm run capture:callouts` records them;
// `node node_modules/tsx/dist/cli.mjs src/capture/rollCalloutsProbe.ts` prints
// what each roll will show without opening a browser.

import { newRun, type RunState } from "../state/RunState";
import { DicePool, type DiceStack } from "../systems/DicePool";
import { makeDie, type DieSides } from "../systems/Dice";
import { ITEMS } from "../systems/Items";
import type { RollReelConfig } from "./rollReel";

export const ROLL_CALLOUT_PRESET_IDS = [
  "roll-callout-few",
  "roll-callout-twenty",
  "roll-callout-hundred",
  "roll-callout-multitude",
  "roll-callout-skip",
  "roll-callout-goal",
  "roll-callout-first-roll",
] as const;

export type RollCalloutPresetId = (typeof ROLL_CALLOUT_PRESET_IDS)[number];

export function isRollCalloutPreset(id: string): id is RollCalloutPresetId {
  return (ROLL_CALLOUT_PRESET_IDS as readonly string[]).includes(id);
}

/** Two rolls, each left to play its whole callout — the multiplier's count and
 *  the fade — before the next press hurries it away. */
export const ROLL_CALLOUT_REEL: RollReelConfig = {
  rolls: 2,
  openingMs: 300,
  betweenRollsMs: 2000,
  closingMs: 2300,
};

/** The hundred-dice run pressed again the moment the game will take it, while
 *  the first roll's callout is still counting: it should jump to its end, land
 *  the score, and clear away as the next roll tumbles. */
export const ROLL_CALLOUT_SKIP_REEL: RollReelConfig = {
  rolls: 3,
  openingMs: 300,
  betweenRollsMs: 0,
  closingMs: 2600,
  // The tumble takes ~530ms, so this lands ~0.6s into the callout, while the
  // multiplier is still counting.
  pressEveryMs: 950,
};

/** One roll, left alone: it carries the trial past its goal, so GameScene
 *  holds the acclaimed callout and then leaves for the results screen. The
 *  closing rest covers the whole callout — tumble, count, flare and fade — and
 *  stops before the table slides away. */
export const ROLL_CALLOUT_CLEAR_REEL: RollReelConfig = {
  rolls: 1,
  openingMs: 300,
  betweenRollsMs: 0,
  closingMs: 3300,
  clears: true,
};

/** The reel each fixture is performed with. The clearing pair are single-roll
 *  reels; everything else plays the standard two. */
export function rollCalloutReel(id: RollCalloutPresetId): RollReelConfig {
  if (id === "roll-callout-skip") return ROLL_CALLOUT_SKIP_REEL;
  if (id === "roll-callout-goal" || id === "roll-callout-first-roll")
    return ROLL_CALLOUT_CLEAR_REEL;
  return ROLL_CALLOUT_REEL;
}

/** A deterministic grid in the given die mix. */
function mixedDice(
  count: number,
  mix: readonly [DieSides, number][],
  seed: number,
) {
  let state = seed >>> 0;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
  const total = mix.reduce((sum, [, weight]) => sum + weight, 0);
  return Array.from({ length: count }, () => {
    let pick = random() * total;
    const sides = mix.find(([, weight]) => (pick -= weight) < 0)?.[0] ?? 6;
    const die = makeDie(sides, {}, "extra_die");
    die.value = 1 + Math.floor(random() * sides);
    return die;
  });
}

/** 20,000 dice as short mixed stacks, so the card view varies row to row. */
function multitudeStacks(total: number): DiceStack[] {
  const ladder: DieSides[] = [6, 4, 8, 10, 6, 20, 2, 8, 100, 6];
  const stacks: DiceStack[] = [];
  let remaining = total;
  let index = 0;
  while (remaining > 0) {
    const count = Math.min(remaining, 40 + ((index * 37) % 61));
    stacks.push({
      sides: ladder[index % ladder.length],
      count,
      maxFaceBonus: 0,
      loaded: false,
      wildFace: false,
      source: "extra_die",
    });
    remaining -= count;
    index += 1;
  }
  return stacks;
}

function baseRun(seed: number): RunState {
  const run = newRun(
    ITEMS.map((item) => item.id),
    seed,
  );
  run.tutorialArmed = false;
  run.forcedRolls = [];
  run.gold = 12;
  run.peakGold = 12;
  return run;
}

export function rollCalloutRun(id: RollCalloutPresetId): RunState {
  switch (id) {
    // A few dice and nothing else: the callout at its plainest, ×1.
    case "roll-callout-few": {
      const run = baseRun(0x5eed0001);
      run.trial = 6;
      run.roll = 0;
      run.dice = DicePool.fromDice(mixedDice(5, [[6, 1]], 0xf00d));
      run.scoringNumbers = [1, 2, 3];
      run.extraNumberCount = 2;
      return run;
    }
    // Twenty dice, one flat multiplier and one bonus.
    case "roll-callout-twenty": {
      const run = baseRun(0x5eed0002);
      run.trial = 9;
      run.roll = 0;
      run.dice = DicePool.fromDice(
        mixedDice(
          20,
          [
            [6, 6],
            [4, 2],
            [8, 2],
          ],
          0x20,
        ),
      );
      run.scoringNumbers = [1, 2, 3, 4];
      run.extraNumberCount = 1;
      run.hasAmplifier = true;
      run.extraPoints = 1;
      run.purchases = { amplifier: 1, extra_point: 1 };
      run.ownedUnique = ["amplifier"];
      return run;
    }
    // A hundred dice: a handful of multipliers, one growth engine, and several
    // bonuses.
    case "roll-callout-hundred":
    case "roll-callout-skip": {
      const run = baseRun(0x5eed0003);
      run.trial = 18;
      run.roll = 0;
      run.dice = DicePool.fromDice(
        mixedDice(
          100,
          [
            [6, 5],
            [4, 2],
            [8, 2],
            [10, 2],
            [20, 1],
          ],
          0x100,
        ),
      );
      run.scoringNumbers = [1, 2, 3, 4, 5, 6];
      run.extraNumberCount = 5;
      run.hasAmplifier = true;
      run.prism = 1;
      run.hasHourglass = true;
      run.hasLuckySeven = true;
      run.hasSnakeEyes = true;
      run.extraPoints = 2;
      run.pocketChange = 2;
      run.momentum = 1;
      run.hasCatechism = true;
      run.growthRollsAt = { catechism: counts({ 10: 6 }) };
      return run;
    }
    // The same hundred-die build twice over, for the two tiers of acclaim the
    // callout stages when a roll carries the trial past its goal (see
    // ui/rollBreakdown). `goal` opens part-way through the trial so the roll
    // that crosses is not its first; `first-roll` opens on a fresh trial and
    // crosses on the opening press, which is the louder of the two.
    case "roll-callout-goal":
    case "roll-callout-first-roll": {
      const run = rollCalloutRun("roll-callout-hundred");
      if (id === "roll-callout-goal") {
        run.roll = 1;
        run.score = 24_000n;
        run.trialScore = run.score;
        run.totalScore = run.score;
      }
      return run;
    }
    // Twenty thousand dice: a long climb through stacked cards and two engines.
    case "roll-callout-multitude": {
      const run = baseRun(0x5eed0004);
      run.trial = 29;
      run.roll = 2;
      run.dice = DicePool.fromStacks(multitudeStacks(20_000));
      run.scoringNumbers = [1, 2, 3, 4, 5, 6];
      run.extraNumberCount = 5;
      run.hasAmplifier = true;
      run.hasCrunchTime = true;
      run.prism = 2;
      run.downbeat = 2;
      run.hasLuckySeven = true;
      run.hasSnakeEyes = true;
      run.jackpot = 2;
      run.extraPoints = 3;
      run.dividend = 2;
      run.momentum = 2;
      run.pocketChange = 3;
      run.hasCatechism = true;
      run.litany = 1;
      run.hasResonantHall = true;
      run.growthRollsAt = {
        catechism: counts({ 10: 24, 12: 9 }),
        resonance: counts({ 10: 11 }),
      };
      return run;
    }
  }
}

function counts(byPercent: Record<number, number>): number[] {
  const table: number[] = [];
  for (const [percent, rolls] of Object.entries(byPercent)) {
    while (table.length <= Number(percent)) table.push(0);
    table[Number(percent)] = rolls;
  }
  return table;
}
