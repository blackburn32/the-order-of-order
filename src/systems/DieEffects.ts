import { ANVIL_SIZE, isVoiceDie } from "./Dice";

/**
 * The per-die effects a die can carry, in the order they are drawn and listed.
 *
 * Some are carried by the die itself (a windfall multiplier, Contentment's wild
 * face, The Vow's load, A New Voice's source) and some by its size, as a rule
 * the run holds for every die of that size (Royal Seal, Ballast, The Anvil).
 * The player cannot tell the two apart at the table and has no reason to: both
 * change what this die does when it rolls, so both are worn by the die.
 *
 * The three highest-face effects lead, since they are the ones a player is
 * hunting for on the grid.
 */
export const DIE_EFFECTS = [
  "windfall4", // Centurion: highest face scores and quadruples the roll
  "windfall2", // Rollplayer: highest face scores and doubles the roll
  "ascension", // Ascension: highest face always scores
  "royalSeal", // Royal Seal: highest face scores its own value
  "voice", // A New Voice: scores when no other die shows its face
  "wild", // Contentment: scores on every face
  "loaded", // The Vow: never rolls its two highest faces
  "ballast", // Ballast: never rolls its two lowest faces
  "anvil", // The Anvil: a d100 never rolls below 50
] as const;

export type DieEffect = (typeof DIE_EFFECTS)[number];

/** The size-wide rules a run holds, which every die of a listed size wears. */
export interface DieAuras {
  royalSealSizes?: readonly number[];
  ballastSizes?: readonly number[];
  anvil?: boolean;
}

/** The shape of a die this reads — a live die, a pool bucket, or a saved stack
 *  all carry these. */
export interface DieEffectSource {
  sides: number;
  maxFaceBonus: number;
  loaded: boolean;
  wildFace: boolean;
  source: string;
}

/** Everything that changes how `die` rolls or scores, in `DIE_EFFECTS` order. */
export function dieEffects(
  die: DieEffectSource,
  auras: DieAuras = {},
): DieEffect[] {
  const has: Record<DieEffect, boolean> = {
    windfall4: die.maxFaceBonus >= 4,
    windfall2: die.maxFaceBonus > 1 && die.maxFaceBonus < 4,
    ascension: die.maxFaceBonus === 1,
    royalSeal: auras.royalSealSizes?.includes(die.sides) ?? false,
    voice: isVoiceDie(die),
    wild: die.wildFace,
    loaded: die.loaded,
    ballast: auras.ballastSizes?.includes(die.sides) ?? false,
    anvil: (auras.anvil ?? false) && die.sides === ANVIL_SIZE,
  };
  return DIE_EFFECTS.filter((effect) => has[effect]);
}

/** A stable key for a set of effects — `""` for a plain die. */
export function dieEffectsKey(effects: readonly DieEffect[]): string {
  return effects.join("+");
}

/** What each effect does to its die, in a few words — the line the player
 *  reads beside a shaded die to learn what the shade means. */
export const DIE_EFFECT_LABEL: Record<DieEffect, string> = {
  windfall4: "×4 on max",
  windfall2: "×2 on max",
  ascension: "Max always scores",
  royalSeal: "Max scores its face",
  voice: "Scores when alone",
  wild: "Scores on every face",
  loaded: "Never rolls top two",
  ballast: "Never rolls bottom two",
  anvil: "Never below 50",
};

/** The whole rule, for a tooltip — what the die does, spelled out. */
export const DIE_EFFECT_DETAIL: Record<DieEffect, string> = {
  windfall4:
    "Its highest face always scores, and quadruples every point that roll.",
  windfall2:
    "Its highest face always scores, and doubles every point that roll.",
  ascension: "Its highest face always scores.",
  royalSeal:
    "Its highest face scores its own value. Every die of this size has it.",
  voice: "Scores whenever no other die shows the same face.",
  wild: "Scores on every face it rolls.",
  loaded: "Never rolls its two highest faces.",
  ballast: "Never rolls its two lowest faces. Every die of this size has it.",
  anvil: "Never rolls below 50. Every d100 has it.",
};

/** The card that gives each effect, by item id, so a tooltip can name it. */
export const DIE_EFFECT_SOURCE: Record<DieEffect, string> = {
  windfall4: "centurion",
  windfall2: "rollplayer",
  ascension: "ascension",
  royalSeal: "royal_seal",
  voice: "a_new_voice",
  wild: "wild_face",
  loaded: "loaded_die",
  ballast: "ballast",
  anvil: "the_anvil",
};

/** The size-wide rules a run currently holds. */
export function runAuras(state: {
  royalSealSizes: readonly number[];
  ballastSizes: readonly number[];
  hasAnvil: boolean;
}): DieAuras {
  return {
    royalSealSizes: state.royalSealSizes,
    ballastSizes: state.ballastSizes,
    anvil: state.hasAnvil,
  };
}
