// The "lessons" series: a shopper that plays one strategy tree, The Lessons,
// toward its engine, The Catechism.
//
// The engine experiment needs runs that build the tree the way a player
// committed to it would, so that what it measures is the engine rather than a
// shopper's indifference to it. The plan, numbered so each rule below can cite
// the one it implements:
//
//   1  buy only The Lessons' cards (systems/ItemTrees: its chain and its
//      supports), plus the free dice while the grid is tiny and the engine is
//      not yet owned
//   2  take The Catechism on sight, and then each Litany
//   3  make every die score every roll: shrink or remove the dice that can
//      miss, aim the size-wide cards at the size that misses, widen the
//      scoring faces
//   4  once the engine is owned — or, when guarding perfection, from rank 2 —
//      add no die that would not score every roll: a single miss is a roll the
//      engine does not grow on. Grow the grid with dice that always score.
//   5  from rank 2, while the engine is still missing, keep a build card's price
//      banked through everything rule 3 does not name
//   6  from rank 2, reroll a shelf with nothing on the engine's path, as long as
//      that bank survives the reroll
//   7  when guarding perfection, refuse a King's demand that would break a
//      perfect grid: dice that grow, muted scoring numbers, or rolls taken away
//
// Two parts of the plan can be switched off for the engine experiment
// (`setLessonsPlan`), so each one's effect on the engine is measured apart:
//   buildsPerfectDice  take the cards that add dice that always score (Two
//                      Novices, The Calling); off, they are refused
//   guardsPerfection   rule 4 from rank 2 rather than from the engine, and rule 7
//   buysLitany         rule 2's Litany; off, it is refused
//
// Like the player's plan this is a ranking, and `lessonsRank` is the whole of it.

import { rankOf } from "../config";
import type { RunState } from "../state/RunState";
import type { DieSides } from "../systems/Dice";
import {
  sizeAlwaysScores,
  sizesThatCanMiss,
  type ShopItemId,
} from "../systems/Items";
import { ITEM_TREES } from "../systems/ItemTrees";
import { canAfford, PRICE_BANDS, type ShopOffer } from "../systems/Shop";
import {
  AFFLICTIONS,
  type Affliction,
  type AfflictionId,
} from "../systems/Afflictions";
import type { DieTargets } from "./bot";
import { acceptsCurse, afflictionRisk } from "./curseValue";

// ---- the plan's vocabulary -------------------------------------------------

/** Rule 1: the tree, read from the tree file so the bot cannot drift from it. */
const LESSONS_TREE = ITEM_TREES.find((tree) => tree.id === "lessons")!;
const LESSONS: ReadonlySet<string> = new Set(
  [
    ...LESSONS_TREE.nodes,
    ...LESSONS_TREE.branches,
    ...LESSONS_TREE.supports,
  ].map((card) => card.id),
);

/** Rule 2. */
const ENGINE: ShopItemId = "the_catechism";
const BOOST: ShopItemId = "litany";

/** Rule 3: cards that turn a die that sometimes misses into one that never does. */
const PERFECTING: ReadonlySet<ShopItemId> = new Set([
  "refinement",
  "grindstone",
  "shrink",
  "wild_face",
  "extra_number",
  "loaded_die",
  "whetstone",
  "iron_debt",
  "leaden_dice",
  // ...and the cards that remove the dice that can miss instead.
  "dismissal",
  "winnowing",
  "excommunication",
]);

/** Rule 4: the cards that add dice, and the size each adds. */
const ADDS_DICE: Partial<Record<ShopItemId, DieSides>> = {
  extra_die: 6,
  spike: 4,
  chip: 2,
  rollplayer: 20,
  centurion: 100,
  two_novices: 1,
  the_calling: 1,
};

/** The cards that add only dice that always score. */
const PERFECT_DICE: ReadonlySet<ShopItemId> = new Set([
  "two_novices",
  "the_calling",
]);

/** The special dice, whose windfall fires on every roll once shrunk to a d1. */
const SPECIALS: ReadonlySet<ShopItemId> = new Set(["rollplayer", "centurion"]);

/** Rule 1's "tiny". */
const FREE_DICE_UNTIL = 8;

const TIER = {
  refuse: -1,
  filler: 1,
  dice: 4,
  power: 5,
  perfecting: 7,
  engine: 10,
} as const;

/** The tier from which a card is bought regardless of rule 5's bank. */
export const LESSONS_ON_PATH: number = TIER.perfecting;

/** The parts of the plan the engine experiment can switch off. */
export interface LessonsPlan {
  buildsPerfectDice: boolean;
  guardsPerfection: boolean;
  buysLitany: boolean;
}

const FULL_PLAN: LessonsPlan = {
  buildsPerfectDice: true,
  guardsPerfection: true,
  buysLitany: true,
};
let plan: LessonsPlan = { ...FULL_PLAN };

/** Sim-only. Switch parts of the plan off; any part not named returns to the
 *  full plan, so calling it bare restores everything. */
export function setLessonsPlan(next: Partial<LessonsPlan> = {}): void {
  plan = { ...FULL_PLAN, ...next };
}

/** Rule 4's reach: from the engine, or from rank 2 when guarding perfection. */
function guardsDice(state: RunState): boolean {
  return (
    state.hasCatechism || (plan.guardsPerfection && rankOf(state.trial) >= 2)
  );
}

// ---- reading the grid ------------------------------------------------------

// Whether a size always scores is a rule of the game rather than of this plan,
// so it lives beside the cards that read it (Items.sizeAlwaysScores).
const alwaysScores = sizeAlwaysScores;
const missingSizes = sizesThatCanMiss;

// ---- the decisions ---------------------------------------------------------

/** Rule 1, applied everywhere a card can be taken. Cursed cards in the tree are
 *  appraised against the appetite, as the rest of the field does. */
export function lessonsAccepts(
  state: RunState,
  offer: ShopOffer,
  curseAppetite: number,
): boolean {
  if (offer.id === "extra_die")
    return !state.hasCatechism && state.dice.length < FREE_DICE_UNTIL;
  if (!LESSONS.has(offer.id)) return false;
  if (PERFECT_DICE.has(offer.id) && !plan.buildsPerfectDice) return false;
  if (offer.id === BOOST && !plan.buysLitany) return false;
  return !offer.cursed || acceptsCurse(state, offer, curseAppetite);
}

/** What this card is worth to the plan right now, as a tier. */
export function lessonsRank(state: RunState, offer: ShopOffer): number {
  if (offer.id !== "extra_die" && !LESSONS.has(offer.id)) return TIER.refuse;
  if (offer.id === ENGINE) return TIER.engine;
  if (offer.id === BOOST) return plan.buysLitany ? TIER.engine : TIER.refuse;

  const sides = ADDS_DICE[offer.id];
  if (sides !== undefined) {
    // A die that always scores is growth the engine keeps.
    if (PERFECT_DICE.has(offer.id))
      return plan.buildsPerfectDice ? TIER.power : TIER.refuse;
    if (!guardsDice(state)) {
      if (offer.id === "extra_die" && state.dice.length >= FREE_DICE_UNTIL)
        return TIER.refuse;
      return SPECIALS.has(offer.id) ? TIER.power : TIER.dice;
    }
    // Rule 4: a die that can miss is a roll the engine loses.
    return alwaysScores(state, sides) ? TIER.dice : TIER.refuse;
  }

  // Rule 3 — while any die can still miss.
  if (PERFECTING.has(offer.id))
    return missingSizes(state).length > 0 ? TIER.perfecting : TIER.filler;

  if (offer.id === "uniform")
    return Object.keys(state.dice.sizeCounts()).length === 1
      ? TIER.power
      : TIER.filler;
  if (offer.id === "keen_edge")
    return state.dice.countOfSize(1) > 0 ? TIER.power : TIER.filler;
  return TIER.power;
}

/** The shelf as the plan walks it: refused cards dropped, then by tier, then
 *  cheapest. */
export function lessonsOrder(
  state: RunState,
  offers: readonly ShopOffer[],
): ShopOffer[] {
  return offers
    .map((offer) => ({ offer, rank: lessonsRank(state, offer) }))
    .filter((entry) => entry.rank > TIER.refuse)
    .sort((a, b) => b.rank - a.rank || a.offer.cost - b.offer.cost)
    .map((entry) => entry.offer);
}

/** Rule 5. */
export function lessonsGoldFloor(state: RunState): number {
  return !state.hasCatechism && rankOf(state.trial) >= 2
    ? PRICE_BANDS.build
    : 0;
}

/** Rule 6. `MAX_REROLLS_PER_VISIT` in bot.ts keeps it finite. */
export function lessonsWantsReroll(
  state: RunState,
  offers: readonly ShopOffer[],
  free: boolean,
  price: number,
): boolean {
  if (free) return true;
  if (state.hasCatechism || rankOf(state.trial) < 2) return false;
  if (state.gold - price < lessonsGoldFloor(state)) return false;
  return !offers.some(
    (offer) =>
      canAfford(state, offer) && lessonsRank(state, offer) >= LESSONS_ON_PATH,
  );
}

/** Rule 7's test: whether a drawback undoes a perfect grid — by growing its
 *  dice off the sizes that always score, muting the numbers that make a size
 *  always score, or taking rolls away before they can count. */
function breaksPerfection(id: AfflictionId): boolean {
  const affliction: Affliction = AFFLICTIONS[id];
  return (
    (affliction.dieGrowthPerTrial ?? 0) > 0 ||
    (affliction.dudRollChance ?? 0) > 0 ||
    (affliction.suppress ?? []).includes("extraNumber")
  );
}

/** Rule 7. The least risky demand that leaves a perfect grid intact, and the
 *  least risky of all when none does — which is the field's own choice, and so
 *  what this returns when perfection is not being guarded. */
export function lessonsChooseDemand(
  state: RunState,
  demands: readonly AfflictionId[],
): AfflictionId | undefined {
  const byRisk = [...demands].sort(
    (a, b) => afflictionRisk(state, a) - afflictionRisk(state, b),
  );
  if (!plan.guardsPerfection) return byRisk[0];
  return byRisk.find((id) => !breaksPerfection(id)) ?? byRisk[0];
}

// ---- targets ---------------------------------------------------------------

type DiceGroup = ReturnType<RunState["dice"]["groups"]>[number];

function mostNumerous(groups: DiceGroup[]): DiceGroup {
  return groups.reduce((best, group) =>
    group.count > best.count ||
    (group.count === best.count && group.die.sides > best.die.sides)
      ? group
      : best,
  );
}

/** Rule 3's aim for every card that names a die or a size. */
export function lessonsChooseTargets(
  state: RunState,
  offer: ShopOffer,
): DieTargets | null {
  if (!offer.needsTarget) return {};
  const groups = state.dice.groups();
  if (groups.length === 0) return null;

  switch (offer.id) {
    // The biggest die that can still miss — a special first, since a shrunk
    // special also fires its windfall on every roll.
    case "shrink":
    case "grindstone": {
      const shrinkable = groups.filter((group) => group.die.sides > 1);
      if (shrinkable.length === 0) return null;
      const missing = shrinkable.filter(
        (group) => !alwaysScores(state, group.die.sides),
      );
      const pool = missing.length > 0 ? missing : shrinkable;
      const specials = pool.filter((group) => group.die.maxFaceBonus > 0);
      const from = specials.length > 0 ? specials : pool;
      const target = from.reduce((best, group) =>
        group.die.sides > best.die.sides ||
        (group.die.sides === best.die.sides && group.count > best.count)
          ? group
          : best,
      );
      return { index: target.firstIndex };
    }
    // Size-wide perfecting: where the most dice still miss.
    case "wild_face": {
      const open = groups.filter((group) => !group.die.wildFace);
      if (open.length === 0) return null;
      const missing = open.filter(
        (group) => !alwaysScores(state, group.die.sides),
      );
      return {
        index: mostNumerous(missing.length > 0 ? missing : open).firstIndex,
      };
    }
    case "loaded_die": {
      const open = groups.filter(
        (group) => group.die.sides > 1 && !group.die.loaded,
      );
      if (open.length === 0) return null;
      const missing = open.filter(
        (group) => !alwaysScores(state, group.die.sides),
      );
      return {
        index: mostNumerous(missing.length > 0 ? missing : open).firstIndex,
      };
    }
    // Removal: the size that misses with the fewest dice, which gives up the
    // fewest points to become perfect — one die of it for A Dismissal, the whole
    // size for The Winnowing.
    case "dismissal":
    case "winnowing": {
      const missing = groups.filter(
        (group) => !alwaysScores(state, group.die.sides),
      );
      if (missing.length === 0) return null;
      const counts = state.dice.sizeCounts();
      const target = missing.reduce((best, group) =>
        counts[group.die.sides] < counts[best.die.sides] ||
        (counts[group.die.sides] === counts[best.die.sides] &&
          group.die.sides > best.die.sides)
          ? group
          : best,
      );
      return { index: target.firstIndex };
    }
    default:
      return {};
  }
}
