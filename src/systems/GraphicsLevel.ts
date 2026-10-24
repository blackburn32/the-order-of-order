import type { EffectsTier } from "../renderQuality";

/**
 * How far out per-die flourishes keep drawing: the border pulses, chain
 * lightning, spotlights and sigil bursts that each land on a single die.
 *
 * Those flourishes are switched off past a zoom-out cutoff measured in how
 * many dice the camera covers (see `gridDetailLevel`), and each roll pulses at
 * most a sampled budget of the dice on screen. Both scale with the level, so a
 * capable machine can keep the whole table crackling while a struggling one
 * pulls the effects in. The player picks the level in Settings; until they do,
 * it follows the device's effect tier.
 */
export type GraphicsLevel = "low" | "medium" | "high" | "ultra";

export const GRAPHICS_LEVELS: readonly GraphicsLevel[] = [
  "low",
  "medium",
  "high",
  "ultra",
];

interface GraphicsLevelSpec {
  label: string;
  /** Dice in view past which per-die flourishes stop drawing. */
  effectsLodDice: number;
  /** Most dice one roll pulses, sampled evenly across the viewport. Chain
   *  lightning and the other flourishes only land on pulsed dice, so this
   *  bounds them too. */
  pulseBudget: number;
}

// Low is the game's original budget. Every cutoff stays below the summary-card
// threshold (10,000), past which there are no dice sprites left to decorate.
const SPECS: Record<GraphicsLevel, GraphicsLevelSpec> = {
  low: { label: "Low", effectsLodDice: 300, pulseBudget: 64 },
  medium: { label: "Medium", effectsLodDice: 1_000, pulseBudget: 160 },
  high: { label: "High", effectsLodDice: 2_500, pulseBudget: 400 },
  ultra: { label: "Ultra", effectsLodDice: 6_000, pulseBudget: 1_000 },
};

export function graphicsLevelSpec(level: GraphicsLevel): GraphicsLevelSpec {
  return SPECS[level];
}

export function isGraphicsLevel(value: unknown): value is GraphicsLevel {
  return GRAPHICS_LEVELS.includes(value as GraphicsLevel);
}

/** The level a player who has never chosen one gets: farther than the old
 *  cutoff everywhere, but held back on a Canvas fallback or low-core device. */
export function defaultGraphicsLevel(tier: EffectsTier): GraphicsLevel {
  return tier === "full" ? "high" : "medium";
}
