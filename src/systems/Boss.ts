// Boss Trial modifiers.
//
// The third trial of every rank is a Boss Trial: it rolls one hostile modifier
// (more, under an affliction that says so) that makes its goal harder to reach,
// and rewards the player with a better shop if they clear it anyway.
//
// A boss no longer describes its own mechanics. What it DOES is an affliction —
// the same vocabulary a cursed card writes its drawback in (see
// systems/Afflictions) — looked up by the boss's own id, so the table below is
// only naming, copy, and whatever REWARD the boss carries. That split is what
// lets a future boss inflict a cursed card's drawback, or a card a boss's,
// without either side gaining a special case.
//
// IMPORTANT: afflictions that touch scoring must behave identically in both
// scorers — `ScoringHistogram.scoreRollHistogram` (the live path) and
// `Scoring.scoreRoll` (the reference implementation). `npx tsx
// src/sim/compareScoring.ts` fails loudly if they drift.

import {
  TRIALS_PER_RANK,
  isBossTrial,
  isMirrorTrial,
  trialGoal,
  trialInRank,
} from "../config";
import type { RunState } from "../state/RunState";
import {
  afflictionsFor,
  fold,
  permanentAfflictions,
  type AfflictionId,
} from "./Afflictions";

/** Boss ids are affliction ids: `AFFLICTIONS[id]` is what the boss does. */
export type BossModifierId = Extract<
  AfflictionId,
  | "famine"
  | "drought"
  | "eclipse"
  | "silence"
  | "hunger"
  | "warden"
  | "toll"
  | "hoard"
>;

export interface BossModifier {
  id: BossModifierId;
  name: string;
  /** One line, shown on the announcement banner and the GOAL badge tooltip. */
  desc: string;
  /** Compact all-caps rule used by the in-trial ribbon. */
  shortDesc: string;
  /** Per-mille multiplier on the gold paid for clearing (2_000 = double). The
   *  one field that is a boon rather than a penalty, which is why it stays here
   *  rather than moving to the affliction table. */
  goldMultMilli?: number;
}

export const BOSS_MODIFIERS: BossModifier[] = [
  {
    id: "famine",
    name: "The Famine",
    desc: "Deeper Stillness and Enlightenment grant nothing.",
    shortDesc: "BONUSES SEALED",
  },
  {
    id: "drought",
    name: "The Drought",
    desc: "No dice are added this trial.",
    shortDesc: "NO DICE ADDED",
  },
  {
    id: "eclipse",
    name: "The Eclipse",
    desc: "Your roll multiplier is halved.",
    shortDesc: "MULTIPLIER HALVED",
  },
  {
    id: "silence",
    name: "The Silence",
    desc: "Only 1s score — the numbers you unlocked are silenced.",
    shortDesc: "UNLOCKED NUMBERS SILENCED",
  },
  {
    id: "hunger",
    name: "The Hunger",
    desc: "Five fewer rolls.",
    shortDesc: "5 FEWER ROLLS",
  },
  {
    id: "warden",
    name: "The Warden",
    desc: "Consensus, The Congregation and Lucky Seven grant nothing.",
    shortDesc: "PATTERNS SEALED",
  },
  {
    id: "toll",
    name: "The Toll",
    desc: "A tenth of your dice score nothing.",
    shortDesc: "10% OF DICE INERT",
  },
  {
    id: "hoard",
    name: "The Hoard",
    desc: "The goal is 40% higher, but clearing it pays double gold.",
    shortDesc: "+40% GOAL · ×2 GOLD",
    goldMultMilli: 2_000,
  },
];

const BY_ID = new Map<BossModifierId, BossModifier>(
  BOSS_MODIFIERS.map((b) => [b.id, b]),
);

export function bossById(id: BossModifierId | null): BossModifier | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** True for every trial of the rank whose Boss Trial is the duel, so the rank
 *  previews no curse it is never going to bring. */
function rankHoldsDuel(trial: number): boolean {
  const bossTrial = trial + (TRIALS_PER_RANK - trialInRank(trial));
  return isMirrorTrial(bossTrial);
}

/** The modifiers in force right now — empty outside a Boss Trial. */
export function activeBosses(state: RunState): BossModifier[] {
  if (!isBossTrial(state.trial)) return [];
  return rankBosses(state);
}

/** The first modifier in force, for the surfaces that show one thing — the
 *  ambient sigil, the layout's "is there a boss" question. Anything that lists
 *  what the player is up against should use `activeBosses`. */
export function activeBoss(state: RunState): BossModifier | null {
  return activeBosses(state)[0] ?? null;
}

/** The modifiers assigned to the current rank, including while the player is
 *  still approaching its Boss Trial. Overview/shop screens use this preview;
 *  gameplay must use `activeBosses`, which guards against applying it early. */
export function rankBosses(state: RunState): BossModifier[] {
  return state.bossModifiers
    .map((id) => bossById(id))
    .filter((b): b is BossModifier => b !== null);
}

/** How many modifiers a Boss Trial rolls. One, unless a standing affliction (The
 *  Long Night) says otherwise — read off the run's permanent afflictions, since
 *  the count has to be known while assigning a rank's boss, before its Boss
 *  Trial is the live one. */
export function bossModifierCount(state: RunState): number {
  return permanentAfflictions(state).bossModifierCount;
}

/** Pick `count` distinct modifiers for a Boss Trial, never repeating one just
 *  faced so back-to-back ranks feel different. */
export function rollBossModifiers(
  count = 1,
  rng: () => number = Math.random,
  exclude: readonly BossModifierId[] = [],
): BossModifierId[] {
  const pool = BOSS_MODIFIERS.filter((b) => !exclude.includes(b.id)).map(
    (b) => b.id,
  );
  const chosen: BossModifierId[] = [];
  while (chosen.length < count && pool.length > 0) {
    chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return chosen;
}

/** Keep one previewable assignment for all three trials in a rank. A fresh set
 *  is rolled on the Lesser Trial that opens a rank; advancing within the rank
 *  keeps it. The defensive empty branch also repairs older/dev-created states
 *  that entered the middle of a rank without an assignment, and re-rolls when an
 *  affliction has since raised the count a Boss Trial should carry. */
export function bossesForRank(
  state: RunState,
  trial: number,
  rng: () => number = Math.random,
  previous: readonly BossModifierId[] = [],
): BossModifierId[] {
  // The final rank rolls nothing. Its Boss Trial is a duel against a copy of the
  // player's own grid, and a modifier would fall on one side of that mirror
  // only — which is the one thing the duel cannot survive.
  if (rankHoldsDuel(trial)) return [];
  const count = bossModifierCount(state);
  if (trialInRank(trial) === 1 || previous.length === 0) {
    return rollBossModifiers(count, rng, previous);
  }
  if (previous.length >= count) return [...previous];
  // The Long Night was bought mid-rank: keep what was previewed and roll the
  // rest, so the shortfall is filled without moving the modifier already shown.
  return [
    ...previous,
    ...rollBossModifiers(count - previous.length, rng, previous),
  ];
}

/** Per-mille gold multiplier for clearing this trial (The Hoard pays double).
 *  Compounds if a trial ever carries two paying bosses. */
export function bossGoldMultMilli(state: RunState): number {
  let milli = 1_000;
  for (const boss of activeBosses(state)) {
    if (boss.goldMultMilli)
      milli = Math.floor((milli * boss.goldMultMilli) / 1_000);
  }
  return milli;
}

/** The score this trial must reach, including every affliction that raises it.
 *  Everything that gates on "did they clear it" must go through here, not
 *  `trialGoal`, or The Hoard and The Reckoning silently do nothing. */
export function goalFor(state: RunState): bigint {
  return scaleGoal(trialGoal(state.trial), afflictionsFor(state).goalMultMilli);
}

/** Preview a trial's goal without moving RunState. The rank's modifiers change
 *  only the Boss Trial, even though they are known from the Lesser Trial onward;
 *  the run's own afflictions apply to every trial. */
export function goalForTrial(state: RunState, trial: number): bigint {
  const ids = isBossTrial(trial)
    ? [...state.afflictions, ...state.bossModifiers]
    : state.afflictions;
  return scaleGoal(trialGoal(trial), fold(ids).goalMultMilli);
}

function scaleGoal(base: bigint, multMilli: number): bigint {
  if (multMilli === 1_000) return base;
  return (base * BigInt(multMilli)) / 1_000n;
}
