// The story acts, and where on the ladder each one falls.
//
// The words themselves are not here — every page of prose in the game lives in
// `src/story.ts`, and this file only says when each act is told and what it
// leads to.
//
// The run used to have one ending, at rank 5. It now has three — rank 5, rank
// 8, rank 11 — and only the last of them is a finish line — the first two close an act, hand the player a
// standing drawback, and send them back up the ladder under it. That shape is
// the whole design: the reward for winning is a harder game, twice, and the
// player agrees to it because the story is the thing being unlocked.
//
// An act is pinned to a trial and to a side of it. Two screens do the asking —
// TrialResults for the acts that follow a clear, TrialOverview for the one that
// stands in front of the final Boss Trial — and both ask the same two functions
// below rather than testing rank numbers of their own.

import { RunState } from "../state/RunState";
import { ENDING_PAGES } from "../story";
import type { StoryPage } from "../ui/storyPage";
import { AFFLICTIONS, type AfflictionId } from "./Afflictions";

export type EndingId = "tribute" | "betrayal" | "disorder" | "peace";

export interface EndingDef {
  id: EndingId;
  /** The trial this act is pinned to. */
  trial: number;
  /** "afterClear" fires from TrialResults once that trial is cleared;
   *  "beforeTrial" fires from TrialOverview as the player starts it. */
  when: "afterClear" | "beforeTrial";
  /** The act's pages, written in `src/story.ts`. */
  pages: readonly StoryPage[];
  /** What the last page's button says. */
  button: string;
  /** The scene the last page hands off to. */
  next: "Tribute" | "Shop" | "Game" | "Victory";
  /** The drawback the Tribute scene grants, when `next` is "Tribute". */
  gift?: "kingsDemands" | "betrayal";
}

export const ENDINGS: readonly EndingDef[] = [
  {
    id: "tribute",
    trial: 15,
    when: "afterClear",
    button: "Read the Demands",
    next: "Tribute",
    gift: "kingsDemands",
    pages: ENDING_PAGES.tribute,
  },
  {
    id: "betrayal",
    trial: 24,
    when: "afterClear",
    button: "Hear the King's Answer",
    next: "Tribute",
    gift: "betrayal",
    pages: ENDING_PAGES.betrayal,
  },
  {
    id: "disorder",
    trial: 33,
    when: "beforeTrial",
    button: "Take Your Seat",
    next: "Game",
    pages: ENDING_PAGES.disorder,
  },
  {
    id: "peace",
    trial: 33,
    when: "afterClear",
    button: "Witness the Ascension",
    next: "Victory",
    pages: ENDING_PAGES.peace,
  },
];

const BY_ID = new Map<EndingId, EndingDef>(ENDINGS.map((e) => [e.id, e]));

export function endingById(id: EndingId): EndingDef | null {
  return BY_ID.get(id) ?? null;
}

/** The act that follows clearing `trial`, if one does and the run has not
 *  already played it. */
export function endingAfterTrial(
  trial: number,
  seen: readonly EndingId[],
): EndingDef | null {
  return find("afterClear", trial, seen);
}

/** The act that stands in front of `trial`, if one does and the run has not
 *  already played it. */
export function endingBeforeTrial(
  trial: number,
  seen: readonly EndingId[],
): EndingDef | null {
  return find("beforeTrial", trial, seen);
}

function find(
  when: EndingDef["when"],
  trial: number,
  seen: readonly EndingId[],
): EndingDef | null {
  return (
    ENDINGS.find(
      (e) => e.when === when && e.trial === trial && !seen.includes(e.id),
    ) ?? null
  );
}

/** Record that an act has been played, so nothing replays it — neither a
 *  resumed checkpoint nor the trial it sits in front of. */
export function markEndingSeen(state: RunState, id: EndingId): void {
  if (!state.endingsSeen.includes(id)) state.endingsSeen.push(id);
}

/**
 * Afflictions the Crown will never demand.
 *
 * Betrayal is the Order of Disorder's to give, not the King's, and it arrives on
 * its own card two acts later.
 */
const NEVER_DEMANDED: readonly AfflictionId[] = ["betrayal"];

/**
 * The drawbacks the King's writ offers, of which the player must accept one.
 *
 * Drawn from the live affliction table rather than from a hand-written list of
 * demands, so every penalty the game knows how to inflict is on the table and a
 * new affliction is a candidate the moment it exists. Anything already in force
 * is excluded: `afflict` is idempotent, so a demand the run already suffers
 * would be a demand for nothing.
 *
 * The Ledger widens the writ the same way it widens a booster pack (see
 * `Shop.openBooster`). Widening a choice where every option is bad is still a
 * boon — more demands is a better chance that one of them is survivable for the
 * build actually being played.
 */
export function rollKingsDemands(
  state: RunState,
  rng: () => number = Math.random,
  count = state.ownedLedger ? 5 : 3,
): AfflictionId[] {
  const pool = (Object.keys(AFFLICTIONS) as AfflictionId[]).filter(
    (id) => !NEVER_DEMANDED.includes(id) && !state.afflictions.includes(id),
  );
  const chosen: AfflictionId[] = [];
  while (chosen.length < count && pool.length > 0) {
    chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return chosen;
}
