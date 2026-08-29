// The story acts, and where on the ladder each one falls.
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
import { AFFLICTIONS, type AfflictionId } from "./Afflictions";

export type EndingId = "tribute" | "betrayal" | "disorder" | "peace";

/** One screen of a sequence. `image` is a texture key loaded in BootScene; a
 *  page whose art has not been drawn yet falls back to a placeholder frame. */
export interface EndingPage {
  title: string;
  blurb: string;
  image?: string;
}

export interface EndingDef {
  id: EndingId;
  /** The trial this act is pinned to. */
  trial: number;
  /** "afterClear" fires from TrialResults once that trial is cleared;
   *  "beforeTrial" fires from TrialOverview as the player starts it. */
  when: "afterClear" | "beforeTrial";
  pages: EndingPage[];
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
    pages: [
      {
        title: "A Quieter Realm",
        blurb:
          "Five ranks of discipline, and the churn is bound. Numbers fall as they are asked to. The harvests come in, the roads are safe, and for the first time in living memory the realm knows what tomorrow will look like.",
        image: "ending-tribute-1",
      },
      {
        title: "The King's Messenger",
        blurb:
          "A rider in royal colours climbs to the monastery gate. The Crown, he explains, has been watching the Order's work with great interest — and has noticed how much power it took to do.",
        image: "ending-tribute-2",
      },
      {
        title: "The Demands",
        blurb:
          "Tribute, in perpetuity, sealed with the King's own hand. The Order may keep its dice. It may not keep all of them, nor all of what they were once able to do.",
        image: "ending-tribute-3",
      },
    ],
  },
  {
    id: "betrayal",
    trial: 24,
    when: "afterClear",
    button: "Hear the King's Answer",
    next: "Tribute",
    gift: "betrayal",
    pages: [
      {
        title: "In Spite of the Crown",
        blurb:
          "Three more ranks under tribute, and the Order did not merely survive it — it grew. Novices arrive faster than the vaults can be opened for them. The rite spreads to monasteries that had forgotten it.",
        image: "ending-betrayal-1",
      },
      {
        title: "The King's Answer",
        blurb:
          "The Crown has stopped sending messengers. If it cannot tax the Order's discipline, it has decided, it will fund the opposite — and pay well for anyone willing to practise it.",
        image: "ending-betrayal-2",
      },
      {
        title: "The Order of Disorder",
        blurb:
          "Its first recruits were yours. They are still yours, in a sense: every die you roll now knows there is somewhere else to go, and any die that fails you may yet be persuaded to walk.",
        image: "ending-betrayal-3",
      },
    ],
  },
  {
    id: "disorder",
    trial: 33,
    when: "beforeTrial",
    button: "Take Your Seat",
    next: "Game",
    pages: [
      {
        title: "Two Orders",
        blurb:
          "The count is in, and it is not close to comforting. The Order of Disorder now numbers what the Order of Order does. Every rite you know, they know. Every die you hold, they hold.",
        image: "ending-disorder-1",
      },
      {
        title: "Mirror",
        blurb:
          "Across the table sits your grid, die for die, in the hands of people who learned it from you. There is no goal in this trial and no mercy in it. Outroll yourself, or the realm belongs to chaos.",
        image: "ending-disorder-2",
      },
    ],
  },
  {
    id: "peace",
    trial: 33,
    when: "afterClear",
    button: "Witness the Ascension",
    next: "Victory",
    pages: [
      {
        title: "The Last Roll",
        blurb:
          "The traitors' dice come to rest and are not picked up again. Across the table, one by one, the Order of Disorder stops counting.",
        image: "ending-peace-1",
      },
      {
        title: "The Crown Yields",
        blurb:
          "The King's order dissolves before the week is out, and the tribute with it. The writ that bound your dice is returned to the monastery unread, its seal broken.",
        image: "ending-peace-2",
      },
      {
        title: "Order",
        blurb:
          "Peace, and prosperity, and dice that fall as they should. The rite is finished, the realm is whole, and there is nothing left to do with the sacred numbers except find out how far they will go.",
        image: "ending-peace-3",
      },
    ],
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
