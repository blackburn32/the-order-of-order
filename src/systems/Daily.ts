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

import {
  beginRun as initializeRun,
  resolveRoll,
  rollPool,
  trialComplete,
} from "../sim/engine";
import { newRun, type RunState } from "../state/RunState";
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
import { SCREENED_DRAWS, SCREENED_FROM } from "./DailyDraws";
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

/** Banes still in DAILY_BANE_IDS, so the tables stay append-only and an old
 *  save that carries one still resumes, but that no day draws any more.
 *
 *  The Lean Purse compounds: every trial's clear pays less, so every shop after
 *  it buys less, and the shortfall grows trial on trial. Played on each day's
 *  own seed it sank the whole field on most days it turned up on, which made
 *  those days its days rather than the day's. */
const UNDRAWN_BANES: ReadonlySet<AfflictionId> = new Set(["dailyLeanPurse"]);

/** The banes a day draws from, in table order. */
export const DRAWN_BANE_IDS: readonly AfflictionId[] = DAILY_BANE_IDS.filter(
  (id) => !UNDRAWN_BANES.has(id),
);

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

/** How many seeds a day may draw before it settles for the last. Far more
 *  than an unscreened day needs: about one draw in four is turned away (see
 *  dailyRite), so running out would take odds of around one in 10^38. */
export const MAX_SEED_DRAWS = 64;

/** The seed every player's run on `day` shares. */
export function dailySeed(day: string): number {
  return dailyRite(day).seed;
}

/** The `draw`th seed `day` may try. The first is keyed by the day alone, so a
 *  day that opens cleanly on it keeps the seed it always had. */
export function seedDraw(day: string, draw: number): number {
  const key = draw === 0 ? day : `${day}#${draw}`;
  return (
    Math.floor(streamFor(DAILY_SALT, "daily", key)() * 0x1_0000_0000) >>> 0
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
 *  same, on every device running the same build.
 *
 *  A seed fixes everything a day deals — every roll, every shelf, every boss —
 *  so a bad seed is a bad day for everyone, and nothing a player does can mend
 *  it. A day therefore draws seeds in turn (seedDraw) and keeps the first that
 *  passes, at one of two bars:
 *
 *  - SCREENED. Days in DailyDraws.ts have been played out ahead of time by the
 *    balance bots on their own dice and shelves (`npm run daily:screen`), and
 *    the table names, for each, the first draw a bot carried to victory. Those
 *    days are known to be winnable.
 *  - OPENING. Past the table's end, a day settles at runtime for the first
 *    draw whose opening trial clears. That trial comes before the first shop,
 *    so nothing the player does can change a die of it, and on roughly one seed
 *    in four the starting grid misses every roll — a day that would end at the
 *    first trial with no score for anyone. Every later trial follows a shop,
 *    where the player's choices change the grid it rolls. */
export function dailyRite(day = dailyDay()): DailyRite {
  let rite = riteCache.get(day);
  if (!rite) {
    const screened = screenedDraw(day);
    if (screened !== null) {
      rite = riteForDraw(day, screened);
    } else {
      rite = riteForDraw(day, 0);
      for (let draw = 1; draw < MAX_SEED_DRAWS && !opensCleanly(rite); draw++)
        rite = riteForDraw(day, draw);
    }
    riteCache.set(day, rite);
  }
  return { ...rite, boons: [...rite.boons], banes: [...rite.banes] };
}

/** The draw DailyDraws.ts names for `day`, or null past either end of it. */
export function screenedDraw(day: string): number | null {
  const index = Math.round(
    (Date.parse(`${day}T00:00:00Z`) -
      Date.parse(`${SCREENED_FROM}T00:00:00Z`)) /
      86_400_000,
  );
  const draw = SCREENED_DRAWS[index];
  return Number.isInteger(draw) && draw >= 0 && draw < MAX_SEED_DRAWS
    ? draw
    : null;
}

/** The rite the `draw`th seed would lay on `day`. */
export function riteForDraw(day: string, draw: number): DailyRite {
  return riteFor(day, seedDraw(day, draw));
}

/** Settling a day plays out its opening trial, possibly several times over, so
 *  each day is settled once per session. */
const riteCache = new Map<string, DailyRite>();

/** The rite `seed` would lay on `day`. */
function riteFor(day: string, seed: number): DailyRite {
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
      DRAWN_BANE_IDS,
      DAILY_BANE_COUNT,
      streamFor(seed, "daily", "banes"),
    ),
  };
}

/** Whether `rite`'s opening trial clears. Plays it exactly as the table would:
 *  the same run a daily begins (Tutorial.beginRun), the same named streams the
 *  table rolls from (GameScene), and no shop, because there is none before it. */
export function opensCleanly(rite: DailyRite): boolean {
  const state = newRun(dailyShopUnlocks(), rite.seed, rite.character);
  applyDailyRite(state, rite);
  initializeRun(state, streamFor(state.seed, "boss", 1));
  while (!trialComplete(state)) {
    const key = `${state.trial}:${state.roll}`;
    const context = rollPool(
      state,
      state.dice,
      streamFor(state.seed, "roll", key),
    );
    resolveRoll(state, streamFor(state.seed, "roll", `${key}:resolve`), {
      context,
      recordHistory: false,
    });
  }
  return state.trialCleared;
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
