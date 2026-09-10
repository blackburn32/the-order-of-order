import type Phaser from "phaser";
import { rollPool } from "../sim/engine";
import { newRun, setRun, type RunState } from "../state/RunState";
import { DicePool, type DiceStack } from "../systems/DicePool";
import { DIE_LADDER, makeDie, type Die, type DieSides } from "../systems/Dice";
import { ITEMS, type ShopItemId } from "../systems/Items";
import { afflictionOf } from "../systems/Items";
import { createFreshShopCheckpoint } from "../systems/ActiveRunPersistence";
import { streamFor } from "../systems/Rng";
import type { ShopOffer } from "../systems/Shop";
import { LATE_GRID_REEL } from "./rollReel";

export type CaptureBackdrop = "felt" | "parchment" | "transparent";
export type CaptureFormat = "wide" | "square" | "portrait" | "card";

export interface CapturePreset {
  id: string;
  label: string;
  kind: "stage" | "gameplay" | "shop";
  defaultBackdrop: CaptureBackdrop;
  defaultFormat: CaptureFormat;
  readyDelayMs?: number;
  /** The performance `play()` runs, for a preset that does more than trigger a
   *  single interaction. A scripted preset publishes its own length and its
   *  outcome to the recorder; see `shopLoop.ts` and `rollReel.ts`. */
  script?: "shop-loop" | "grid-growth" | "late-grid" | "dice-zoom";
}

export const CAPTURE_PRESETS = [
  {
    id: "card-two-newcomers",
    label: "Card cutout — Two Newcomers",
    kind: "stage",
    defaultBackdrop: "transparent",
    defaultFormat: "card",
  },
  {
    id: "card-like-minds",
    label: "Card cutout — Like Minds",
    kind: "stage",
    defaultBackdrop: "transparent",
    defaultFormat: "card",
  },
  {
    id: "card-resonance",
    label: "Card cutout — Resonance",
    kind: "stage",
    defaultBackdrop: "transparent",
    defaultFormat: "card",
  },
  {
    id: "cards-core",
    label: "Cards — core trio",
    kind: "stage",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
  },
  {
    id: "cards-cursed",
    label: "Cards — cursed trio",
    kind: "stage",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
  },
  {
    id: "dice-order",
    label: "Dice — Order lineup",
    kind: "stage",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
  },
  {
    id: "settling",
    label: "Motion — learning to settle",
    kind: "stage",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
  },
  {
    id: "shop-loop",
    label: "Motion — a shop visit",
    kind: "shop",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
    readyDelayMs: 1050,
    script: "shop-loop",
  },
  {
    id: "gameplay-grid-growth",
    label: "Motion — grid growth",
    kind: "gameplay",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
    readyDelayMs: 700,
    script: "grid-growth",
  },
  {
    id: "gameplay-late-grid",
    label: "Motion — late grid",
    kind: "gameplay",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
    readyDelayMs: 700,
    script: "late-grid",
  },
  {
    id: "gameplay-multitude-zoom",
    label: "Motion — 100,489-die zoom",
    kind: "gameplay",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
    readyDelayMs: 900,
    script: "dice-zoom",
  },
  {
    id: "gameplay-eclipse",
    label: "Gameplay — Eclipse arrival",
    kind: "gameplay",
    defaultBackdrop: "felt",
    defaultFormat: "wide",
    // Hold until the entrance and announcement have reached full opacity.
    readyDelayMs: 900,
  },
] as const satisfies readonly CapturePreset[];

export type CapturePresetId = (typeof CAPTURE_PRESETS)[number]["id"];
export type CapturePresetDefinition = (typeof CAPTURE_PRESETS)[number];

export const DEFAULT_CAPTURE_PRESET: CapturePresetId = "cards-core";

export function capturePreset(
  id: string | null | undefined,
): CapturePresetDefinition {
  return (
    CAPTURE_PRESETS.find((preset) => preset.id === id) ??
    CAPTURE_PRESETS.find((preset) => preset.id === DEFAULT_CAPTURE_PRESET)!
  );
}

/** Roll the fixture's pool forward as the reel will, without scoring it, so the
 *  grid the studio opens on is the grid the reel's last roll lands on.
 *
 *  A roll's faces come from `streamFor(seed, "roll", "<trial>:<roll>")` and from
 *  the pool's own shape — never from the faces already showing — so replaying
 *  those same keys here and again during the reel deals the same dice twice.
 *  This fixture's pool neither grows nor shrinks across the reel (no Genesis, no
 *  breakage, no cull), which is what lets the scoring pass be skipped: the score
 *  and the roll counter stay at their opening values, and the clip loops on an
 *  identical 168 dice. */
function alignToReelClose(run: RunState, rolls: number): void {
  for (let index = 0; index < rolls; index++)
    rollPool(
      run,
      run.dice,
      streamFor(run.seed, "roll", `${run.trial}:${run.roll + index}`),
    );
}

/** The scripted performance a preset's `play()` runs, if any.
 *
 *  `CAPTURE_PRESETS` is read `as const`, so the presets that name no script have
 *  no such property to read: this asks the one question a caller has, without
 *  first having to narrow the union down to the presets that carry it. */
export function captureScript(
  preset: CapturePresetDefinition,
): CapturePreset["script"] {
  return "script" in preset ? preset.script : undefined;
}

export const CORE_CARD_IDS: readonly ShopItemId[] = [
  "extra_die",
  "twin",
  "amplifier",
];

export const CURSED_CARD_IDS: readonly ShopItemId[] = [
  "crunch_time",
  "blood_price",
  "ouroboros",
];

export function itemById(id: ShopItemId) {
  const item = ITEMS.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown capture item: ${id}`);
  return item;
}

/** A fixed die roster that shows the game's complete shape and colour ladder. */
export function captureDice(): Die[] {
  return DIE_LADDER.map((sides, index) => {
    const die = makeDie(sides, { maxFaceBonus: sides === 20 });
    die.value = Math.min(sides, Math.max(1, index + 1));
    return die;
  });
}

function gridDice(count: number, seed = 0x0d3a11ce): Die[] {
  let state = seed >>> 0;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };

  return Array.from({ length: count }, (_, index) => {
    // Weight the fixture toward familiar d6s without losing the late-game
    // variety that makes a large Order interesting at a glance.
    const roll = random();
    const sides: DieSides =
      roll < 0.46
        ? 6
        : roll < 0.61
          ? 4
          : roll < 0.73
            ? 8
            : roll < 0.82
              ? 10
              : roll < 0.9
                ? 2
                : roll < 0.96
                  ? 20
                  : 100;
    const die = makeDie(
      sides,
      { maxFaceBonus: index % 17 === 0, wildFace: index % 29 === 0 },
      index < 6 ? "starter" : "extra_die",
    );
    die.value = 1 + Math.floor(random() * sides);
    return die;
  });
}

function baseGameplayRun(): RunState {
  const run = newRun(
    ITEMS.map((item) => item.id),
    0x0d3a11ce,
  );
  run.tutorialArmed = false;
  run.forcedRolls = [];
  run.scoringNumbers = [1, 2, 3];
  run.extraNumberCount = 2;
  run.extraPoints = 3;
  run.hasAmplifier = true;
  run.ownedUnique = ["amplifier"];
  run.purchases = { extra_die: 8, twin: 4, amplifier: 1 };
  run.gold = 31;
  run.peakGold = 31;
  return run;
}

export function gameplayRun(presetId: CapturePresetId): RunState {
  const run = baseGameplayRun();
  if (presetId === "gameplay-multitude-zoom") {
    run.trial = 29;
    run.roll = 2;
    run.dice = DicePool.fromStacks(multitudeStacks());
    run.scoringNumbers = [1, 2, 3, 4, 5, 6];
    run.extraNumberCount = 5;
    run.score = 8_482_116n;
    run.trialScore = run.score;
    run.totalScore = 91_704_228n;
    rollPool(run, run.dice, streamFor(run.seed, "roll", "multitude"));
    return run;
  }
  if (presetId === "gameplay-grid-growth") {
    run.trial = 14;
    run.roll = 1;
    run.dice = DicePool.fromDice(gridDice(24, 0x6a70f17));
    run.scoringNumbers = [1, 2, 3, 4, 5, 6];
    run.extraNumberCount = 5;
    run.extraPoints = 2;
    run.genesis = 1;
    run.ownedUnique = [];
    run.purchases = { extra_die: 5, genesis: 1 };
    run.score = 76n;
    run.trialScore = run.score;
    run.totalScore = 4_218n;
    return run;
  }
  if (presetId === "gameplay-eclipse") {
    run.trial = 18;
    run.roll = 2;
    run.bossModifiers = ["eclipse"];
    run.bossesCleared = 5;
    run.dice = DicePool.fromDice(gridDice(72, 0xec11a5e));
    run.score = 184n;
    run.trialScore = run.score;
    run.totalScore = 12_804n;
    return run;
  }

  run.trial = 23;
  run.roll = 4;
  run.bossModifiers = ["toll"];
  run.bossesCleared = 7;
  run.dice = DicePool.fromDice(gridDice(168));
  run.score = 1_284n;
  run.trialScore = run.score;
  run.totalScore = 89_471n;
  alignToReelClose(run, LATE_GRID_REEL.rolls);
  return run;
}

/** A compact, bucket-backed fixture for the zoom reel. Deterministic short
 * stacks mix die types throughout the grid instead of laying each type down as
 * one enormous band. Their counts total 100,489 exactly; GameScene still
 * expands only the on-screen window and summarizes the rest through the same
 * DiceSummaryCard path used in a live run. */
function multitudeStacks(): DiceStack[] {
  const total = 100_489;
  // Keep several complete rows around the exact geometric midpoint at
  // one-die granularity. That is the opening camera's window, so neighbours
  // there genuinely vary die-by-die instead of exposing the storage chunks
  // used to keep the other hundred thousand cheap to summarize.
  const detailedStart = 49_000;
  const detailedEnd = 51_500;
  const stacks: DiceStack[] = [];
  let remaining = total;
  let state = 0x100489;
  let previous: DieSides | undefined;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };

  while (remaining > 0) {
    const position = total - remaining;
    const detailed = position >= detailedStart && position < detailedEnd;
    const randomCount = 32 + Math.floor(random() * 65);
    const count = detailed
      ? 1
      : Math.min(
          remaining,
          position < detailedStart
            ? Math.min(randomCount, detailedStart - position)
            : randomCount,
        );
    const roll = random();
    let sides: DieSides =
      roll < 0.38
        ? 6
        : roll < 0.54
          ? 4
          : roll < 0.67
            ? 8
            : roll < 0.77
              ? 10
              : roll < 0.85
                ? 2
                : roll < 0.92
                  ? 20
                  : roll < 0.97
                    ? 100
                    : 1;
    if (sides === previous) {
      const index = DIE_LADDER.indexOf(sides);
      sides =
        DIE_LADDER[(index + 1 + Math.floor(random() * 3)) % DIE_LADDER.length];
    }
    const index = stacks.length;
    stacks.push({
      sides,
      count,
      maxFaceBonus: index % 17 === 0 ? 1 : 0,
      loaded: sides > 1 && index % 29 === 0,
      wildFace: index % 43 === 0,
      source: "extra_die",
    });
    previous = sides;
    remaining -= count;
  }
  return stacks;
}

export function installGameplayFixture(
  game: Phaser.Game,
  presetId: CapturePresetId,
): void {
  setRun(game.registry, gameplayRun(presetId));
}

function captureOffer(id: ShopItemId, state: RunState): ShopOffer {
  const item = itemById(id);
  return {
    id: item.id,
    name: item.name,
    cost: item.priceBand === "free" ? 0 : item.priceBand === "low" ? 3 : 5,
    listPrice: item.priceBand === "free" ? 0 : item.priceBand === "low" ? 3 : 5,
    priceBand: item.priceBand,
    desc: typeof item.desc === "function" ? item.desc(state) : item.desc,
    rarity: item.rarity,
    needsTarget: item.needsTarget ?? false,
    targetsSize: item.targetsSize ?? false,
    targetCount: item.targetCount,
    cursed: item.cursed ?? false,
    affliction: afflictionOf(item),
  };
}

/** A real ShopScene checkpoint with a stable, camera-friendly card in the centre
 * slot. The scene still owns the card interaction and the purchase effect.
 *
 * Deterministic in every detail: the shop reel re-installs this to re-stage the
 * visit's opening shelf at the end of its loop, and gets the identical deal back
 * (see `shopLoop.ts`). The purse is deep enough to pay for that whole visit —
 * three cards, a booster, and two rerolls — since a beat the shop refuses is a
 * beat the clip cannot show. */
export function installShopFixture(game: Phaser.Game) {
  const run = baseGameplayRun();
  run.trial = 9;
  run.roll = 0;
  run.gold = 42;
  run.peakGold = 42;
  run.dice = DicePool.fromDice(gridDice(10, 0x5a0b5eed));
  setRun(game.registry, run);

  const checkpoint = createFreshShopCheckpoint(run);
  const neighbours = checkpoint.offers.filter(
    (offer) => offer.id !== "extra_die",
  );
  checkpoint.offers = [
    neighbours[0] ?? captureOffer("pocket_change", run),
    captureOffer("extra_die", run),
    neighbours[1] ?? captureOffer("amplifier", run),
  ];
  return checkpoint;
}
