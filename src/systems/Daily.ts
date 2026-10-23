// The Daily Rite: one seed, one set of rules, the same for everyone each day.
//
// A day is a UTC calendar date ("2026-10-23"). Everything about that day's run
// is derived from the date and nothing else — the seed that fixes its dice,
// shops and bosses (see systems/Rng), the NOVICE it is played as, and the
// BOONS and BANES laid on it —
// so two players who sit down on the same day sit down to the same game, with
// no server to ask. The only thing the server holds is the day's board.
//
// The banes are afflictions (see systems/Afflictions), milder cousins of the
// curses, pushed onto the run's standing drawbacks the moment it begins: every
// rule that can be penalised already reads them from there. The boons are their
// mirror, and most are simply a card the day hands over for free, so they sit
// on the Inventory shelf like anything bought. The few that are not a card are
// either done to the run as it begins (the purse, the steady hand) or read at
// their one seam (the market, in Shop.weightsFor).
//
// What makes a day fair rather than merely shared:
//   - The shop draws from every card in the game, not from the player's own
//     unlocks, which are the one thing that differs between two players.
//   - The day names the novice. A character changes the run's mechanics, so a
//     board where everyone chose their own would be three boards in one. The
//     day's novice is played whether or not the player has unlocked them.
//   - The tutorial never rigs a daily run's dice.
//   - One attempt a day. The seed fixes every roll, so a second attempt is a run
//     played with the answers; the first one started is the one that counts.
//
// The tables below are APPEND-ONLY. A day's boons and banes are picked by their
// position in DAILY_BOON_IDS and DAILY_BANE_IDS (and its novice by position in
// Characters.CHARACTER_ORDER), so reordering any of those lists, or
// removing an entry, would rewrite every day already played and put players on
// two builds into two different rites on the same date.

import type { RunState } from "../state/RunState";
import {
  afflict,
  AFFLICTION_COPY,
  DAILY_BANE_IDS,
  type AfflictionId,
} from "./Afflictions";
import { isRetired } from "./CardReworks";
import { CHARACTER_ORDER, type CharacterId } from "./Characters";
import { grantGold } from "./Gold";
import { ITEMS, type ItemDef, type ShopItemId } from "./Items";
import { streamFor } from "./Rng";
import { applyOffer, offerFor } from "./Shop";

export type DailyBoonId =
  | "purse"
  | "newcomers"
  | "bell"
  | "decree"
  | "benefactor"
  | "secondLook"
  | "blessedMarket"
  | "steadyHand"
  | "reliquary";

/** Append-only, for the reason given at the top of the file. */
export const DAILY_BOON_IDS: readonly DailyBoonId[] = [
  "purse",
  "newcomers",
  "bell",
  "decree",
  "benefactor",
  "secondLook",
  "blessedMarket",
  "steadyHand",
  "reliquary",
];

/** How many of each a day lays on its run. */
export const DAILY_BOON_COUNT = 2;
export const DAILY_BANE_COUNT = 2;

/** The purse boon's gold, named because its copy quotes it. */
export const DAILY_PURSE_GOLD = 10;

/** Mixed into every day's seed, so the daily seeds are not the seeds a player
 *  could type in for an ordinary run. Changing it re-rolls every day. */
const DAILY_SALT = 0x0da11e;

interface DailyBoon {
  /** A card the day hands over for free. Its name and copy are the card's. */
  grant?: ShopItemId;
  /** Otherwise, the boon's own face and what it does to the run. */
  name?: string;
  desc?: string;
  apply?: (state: RunState) => void;
}

const DAILY_BOONS: Record<DailyBoonId, DailyBoon> = {
  purse: {
    name: "The Crown's Purse",
    desc: `Begin the run with ${DAILY_PURSE_GOLD} more gold.`,
    apply: (state) => grantGold(state, DAILY_PURSE_GOLD),
  },
  newcomers: { grant: "extra_die" },
  bell: { grant: "metronome" },
  decree: { grant: "extra_number" },
  benefactor: { grant: "coupon_book" },
  secondLook: { grant: "dealers_bell" },
  // Read in Shop.weightsFor, which is the only place it needs to be.
  blessedMarket: {
    name: "The Blessed Market",
    desc: "Every shop draws its cards at the odds a cleared Boss Trial earns.",
  },
  steadyHand: {
    name: "The Steady Hand",
    desc: "Every d6, now and later, never rolls a 5 or a 6.",
    apply: (state) => {
      if (!state.loadedSizes.includes(6)) state.loadedSizes.push(6);
      state.dice.loadAllOfSize(6);
    },
  },
  reliquary: { grant: "reliquary" },
};

/** The rules one day lays on its run. Carried on the run itself
 *  (`RunState.dailyRite`), so a run begun just before midnight finishes under
 *  the day it was begun on. */
export interface DailyRite {
  day: string;
  seed: number;
  character: CharacterId;
  boons: DailyBoonId[];
  banes: AfflictionId[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDailyDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value);
}

export function isDailyBoonId(value: unknown): value is DailyBoonId {
  return (
    typeof value === "string" &&
    (DAILY_BOON_IDS as readonly string[]).includes(value)
  );
}

/** The UTC date `now` falls on, as the rite names its days. */
export function dailyDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Milliseconds from `now` until the next day's rite opens. */
export function msUntilNextDay(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

/** The seed every player's run on `day` shares. */
export function dailySeed(day: string): number {
  return (
    Math.floor(streamFor(DAILY_SALT, "daily", day)() * 0x1_0000_0000) >>> 0
  );
}

function pick<T>(pool: readonly T[], count: number, rng: () => number): T[] {
  const left = [...pool];
  const chosen: T[] = [];
  while (chosen.length < count && left.length > 0)
    chosen.push(left.splice(Math.floor(rng() * left.length), 1)[0]);
  return chosen;
}

/** Everything `day` lays on its run. Pure: the same day always answers the
 *  same, on every device. */
export function dailyRite(day = dailyDay()): DailyRite {
  const seed = dailySeed(day);
  // Separate streams for the two draws, so a boon added to the end of its table
  // can never shift which banes a day rolls.
  return {
    day,
    seed,
    character: pick(CHARACTER_ORDER, 1, streamFor(seed, "daily", "novice"))[0],
    boons: pick(
      DAILY_BOON_IDS,
      DAILY_BOON_COUNT,
      streamFor(seed, "daily", "boons"),
    ),
    banes: pick(
      DAILY_BANE_IDS,
      DAILY_BANE_COUNT,
      streamFor(seed, "daily", "banes"),
    ),
  };
}

/** Every card the game can offer: the daily shop's pool, and the unlock
 *  snapshot a daily run is begun with in place of the player's own. */
export function dailyShopUnlocks(): ShopItemId[] {
  return ITEMS.filter((item) => item.unlock && !isRetired(item.id)).map(
    (item) => item.id,
  );
}

/** Lay `rite` on a freshly begun run. Called once, before the first trial. */
export function applyDailyRite(state: RunState, rite: DailyRite): void {
  state.dailyRite = {
    day: rite.day,
    seed: rite.seed,
    character: rite.character,
    boons: [...rite.boons],
    banes: [...rite.banes],
  };
  for (const id of rite.banes) afflict(state, id);
  for (const id of rite.boons) {
    const boon = DAILY_BOONS[id];
    if (boon.grant) {
      // Through the shop's own purchase path at no cost, so the card is owned
      // exactly as a bought one is: on the shelf, priced for its next copy,
      // and kept off the shelf if it is unique.
      applyOffer(state, { ...offerFor(boon.grant, state), cost: 0 });
    }
    boon.apply?.(state);
  }
}

export function hasDailyBoon(state: RunState, id: DailyBoonId): boolean {
  return state.dailyRite?.boons.includes(id) ?? false;
}

/** A boon as a card can print it. A granted card is the card itself; the
 *  others are dressed the way `Items.afflictionCard` dresses a drawback. */
export function dailyBoonCard(id: DailyBoonId): ItemDef {
  const boon = DAILY_BOONS[id];
  if (boon.grant) {
    const def = ITEMS.find((item) => item.id === boon.grant);
    if (def) return def;
  }
  return {
    // Never read by the card builder; present because the shape requires it.
    id: "extra_die",
    name: boon.name ?? id,
    desc: boon.desc ?? "",
    priceBand: "free",
    rarity: "rare",
    effects: [],
  };
}

/** A boon's name, for a line of text rather than a card. */
export function dailyBoonName(id: DailyBoonId): string {
  return dailyBoonCard(id).name;
}

export function dailyBaneName(id: AfflictionId): string {
  return AFFLICTION_COPY[id].name;
}

/** The boons that live on the Inventory shelf only as the boon itself: a
 *  granted card is already there, as the card. */
export function shelfOnlyBoons(state: RunState): DailyBoonId[] {
  return (state.dailyRite?.boons ?? []).filter((id) => !DAILY_BOONS[id].grant);
}
