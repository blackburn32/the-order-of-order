// The three novices a run can be played as.
//
// A character is not a bundle of items and not a difficulty setting: it is a
// small set of RULES the run carries from its first roll to its last, chosen
// once, before the first trial. Every one of them changes a mechanic and none
// of them changes a goal — the ladder in `config.ts` is the same ladder for all
// three, which is the whole point. A character makes some approaches
// impractical rather than making the game longer or shorter.
//
// Each character's rules live here as data, and each is read at exactly one
// seam elsewhere:
//
//   startingGold   -> state/RunState.newRun
//   shopDiscount   -> systems/Shop.discountedPrice (cards AND booster packs,
//                     deliberately not rerolls)
//   gridCeiling    -> systems/DicePool's own ceiling, enforced by the pool
//   sizeChaos      -> systems/DicePool.randomizeSizes, driven from
//                     sim/engine.applyGridPassives
//
// The ceiling is deliberately NOT an affliction, though `gridCap` — Famished
// Idol's — is. The two are different mechanisms: a cap CULLS a grid that has
// already grown, which is a penalty a rule has to read and apply, while a
// ceiling stops the growth ever happening, which is a property of the container.
// Folding it in with the afflictions would put a field in `ActiveAfflictions`
// that no rule ever reads.
//
// Nothing branches on a CharacterId outside this file. A fourth character is a
// fourth entry in CHARACTERS plus its art, and no new rule anywhere.

import { DIE_LADDER } from "./Dice";
import { STARTING_GOLD } from "./Gold";

export type CharacterId = "diebert" | "melodie" | "roland";

/** The character a run is played as when nothing says otherwise: the novice
 *  whose rules are the game's own. Runs saved before characters existed resume
 *  as him (see ActiveRunPersistence.hydrateRunState), which is why he is the one
 *  character with no drawback — an in-progress run must not have a rule added
 *  to it underneath the player. */
export const DEFAULT_CHARACTER: CharacterId = "diebert";

/**
 * Roland's size storm: the shape of the bell his dice are redrawn from after
 * every roll.
 *
 * `centre` is the ladder rung the curve peaks on and `sigma` its width in
 * rungs — weight ∝ exp(-(i - centre)² / 2σ²) over DIE_LADDER's eight sizes, so
 * the tails still reach d1 and d100 rather than being clipped off. Written as a
 * curve over the LADDER rather than over face counts because the ladder is the
 * scale every other size effect in the game works on (Refinement steps a rung,
 * Foundry doubles a rung); a curve over face counts would put almost everything
 * on d1 and d2.
 *
 * σ = 2 is chosen so the grid's mean chance of showing a scoring 1 (~17.6%)
 * lands just above a pure d6 grid's 16.7%. Roland therefore scores at about the
 * rate the game opens at — what he gives up is ever choosing a size, not the
 * ability to score.
 */
export interface SizeChaos {
  /** Index into DIE_LADDER the bell is centred on. */
  centre: number;
  /** Width of the bell, in ladder rungs. */
  sigma: number;
}

export const ROLAND_SIZE_CHAOS: SizeChaos = {
  centre: DIE_LADDER.indexOf(8),
  sigma: 2,
};

export interface Character {
  id: CharacterId;
  name: string;
  /** Texture key loaded by BootScene (see scripts/build-game-character-art.mjs). */
  art: string;
  /** One line, in the voice of the run: what this character does differently.
   *  Printed on the selection card and nowhere else. */
  ability: string;
  /** Gold the run opens with. */
  startingGold: number;
  /** Percent off every card and booster pack, all run. 0 for full price. */
  shopDiscountPercent: number;
  /** Dice this run's grid can never exceed. Infinity for no ceiling. Unlike
   *  Famished Idol's `gridCap`, which culls dice the grid has already grown,
   *  this stops the growth happening at all — see DicePool's ceiling. */
  gridCeiling: number;
  /** Set when every die is redrawn to a new size after each roll. */
  sizeChaos: SizeChaos | null;
  /** Characters that must have won a run before this one can be picked. Empty
   *  for a character available from the start. */
  unlockedBy: CharacterId[];
}

/** Melodie's ceiling, named because her card quotes it. */
export const MELODIE_GRID_CEILING = 20;
/**
 * Melodie's discount, named for the same reason — the share TAKEN OFF a price,
 * not the share she pays.
 *
 * The distinction is easy to lose and was: at the 50 this shipped as, "pays 50%"
 * and "50% off" are the same sentence, so her card could be read either way and
 * be right. They part company at any other value, and her card says "less" for
 * exactly that reason.
 *
 * Tuned down from 50 after measuring: at 50 she won 13% of runs against Diebert
 * and Roland's 9%, and her ceiling could not claw it back — the field's median
 * grid is 9 dice, so 20 is never reached and the cap is inert for most builds.
 * The discount is the whole lever (ceiling 20 -> 12 moved the win rate one
 * point; 50 -> 35 moved it three, to level). See src/sim/README.md.
 */
export const MELODIE_DISCOUNT_PERCENT = 35;
/** What Diebert's purse opens with, in place of STARTING_GOLD. */
export const DIEBERT_STARTING_GOLD = 10;

export const CHARACTERS: Record<CharacterId, Character> = {
  diebert: {
    id: "diebert",
    name: "Diebert",
    art: "character-diebert",
    ability: `Begins every run with ${DIEBERT_STARTING_GOLD} gold.`,
    startingGold: DIEBERT_STARTING_GOLD,
    shopDiscountPercent: 0,
    gridCeiling: Infinity,
    sizeChaos: null,
    unlockedBy: [],
  },
  melodie: {
    id: "melodie",
    name: "Melodie",
    art: "character-melodie",
    ability: `Pays ${MELODIE_DISCOUNT_PERCENT}% less for everything in the shop, but her grid never holds more than ${MELODIE_GRID_CEILING} dice.`,
    startingGold: STARTING_GOLD,
    shopDiscountPercent: MELODIE_DISCOUNT_PERCENT,
    gridCeiling: MELODIE_GRID_CEILING,
    sizeChaos: null,
    unlockedBy: [],
  },
  roland: {
    id: "roland",
    name: "Roland",
    art: "character-roland",
    ability:
      "Every die in his grid is remade at a new size after each roll. Nothing stays what it was.",
    startingGold: STARTING_GOLD,
    shopDiscountPercent: 0,
    gridCeiling: Infinity,
    sizeChaos: ROLAND_SIZE_CHAOS,
    unlockedBy: ["diebert", "melodie"],
  },
};

/** The roster, in the order the selection screen deals it. */
export const CHARACTER_ORDER: CharacterId[] = ["diebert", "melodie", "roland"];

const CHARACTER_IDS: ReadonlySet<string> = new Set(CHARACTER_ORDER);

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && CHARACTER_IDS.has(value);
}

export function characterOf(id: CharacterId): Character {
  return CHARACTERS[id];
}

/** Whether `id` can be picked, given the characters already beaten. */
export function characterUnlocked(
  id: CharacterId,
  beaten: readonly CharacterId[],
): boolean {
  return CHARACTERS[id].unlockedBy.every((required) =>
    beaten.includes(required),
  );
}

/** What the selection screen prints under a locked card. Written from the
 *  character's own `unlockedBy` rather than authored per character, so a new
 *  character's lock explains itself. */
export function describeCharacterUnlock(id: CharacterId): string {
  const names = CHARACTERS[id].unlockedBy.map((who) => CHARACTERS[who].name);
  if (names.length === 0) return "";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Win a run as ${list}.`;
}

/**
 * The weight of each ladder size under a size storm, normalised to sum to 1 and
 * indexed like DIE_LADDER.
 *
 * Derived rather than authored so the curve stays one number to tune (`sigma`)
 * instead of eight that have to be kept summing to one. Memoized per chaos
 * object: Roland redraws his whole grid every roll, and in bucketed mode that is
 * a table lookup per bucket per roll.
 */
const weightCache = new WeakMap<SizeChaos, number[]>();

export function sizeWeights(chaos: SizeChaos): number[] {
  const cached = weightCache.get(chaos);
  if (cached) return cached;
  const raw = DIE_LADDER.map((_, i) =>
    Math.exp(-((i - chaos.centre) ** 2) / (2 * chaos.sigma ** 2)),
  );
  const total = raw.reduce((sum, w) => sum + w, 0);
  const weights = raw.map((w) => w / total);
  weightCache.set(chaos, weights);
  return weights;
}
