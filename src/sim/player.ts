// The "player" series: a shopper that follows one written plan rather than a
// price rule or a single theme.
//
// The plan is an engine build, and it is stated as a numbered list here so that
// every rule below can cite the number it implements — a rule that turns out to
// be wrong is then findable from the play it produced:
//
//   1  first shop: recurring dice creation, then new dice, then money
//   2  after that: economy and new dice; take the Ledger on sight
//   3  from the fifth shop, start banking for interest
//   4  duplicate the grid until it runs to 200+ dice
//   5  shrink the special dice (Rollplayer, Centurion) by naming their size
//   6  keep duplicating whichever size there is most of
//   7  reroll aggressively
//   8  keep 10 banked, unless one shelf holds several affordable duplications
//   9  take flat multipliers, extra scoring faces, and duplications
//  10  never take a card that changes how long a trial runs
//  11  never take a cursed card
//  12  when the King forces one, refuse the ones that stop the grid growing
//
// Unlike the themed bots this one is not a filter over `ITEM_THEMES`: the plan
// crosses three themes (swarm for the grid, economy for the purse, multiplier
// and precision for what the grid pays) and excludes cards inside each of them.
// It is a ranking instead, and `playerRank` is the whole of it.

import type { RunState } from "../state/RunState";
import {
  AFFLICTIONS,
  type Affliction,
  type AfflictionId,
} from "../systems/Afflictions";
import { GOLD_PER_INTEREST } from "../systems/Gold";
import { ITEM_THEMES, type ShopItemId } from "../systems/Items";
import { canAfford, PRICE_BANDS, type ShopOffer } from "../systems/Shop";
import type { DieTargets } from "./bot";
import { afflictionRisk } from "./curseValue";

// ---- the plan's vocabulary -------------------------------------------------

/** Rule 1: cards that keep making dice on their own, roll after roll or trial
 *  after trial. The opening shop hunts for these before anything else, because
 *  every later rule compounds whatever they have already poured out. */
const RECURRING_CREATION: ReadonlySet<ShopItemId> = new Set([
  "brick_mold", // The Open Gate — a d6 after every roll
  "spike_mold", // The Novitiate — a d4 after every roll
  "chip_mold", // The Sanctum — a d2 after every roll
  "genesis", // Testimony — copies every die that scores
  "foundry", // The Inner Circle — doubles the smallest size each trial
  "double_the_fun", // The Curious — copies every die that rolls a 5 or 6
]);

/** Rules 4, 6 and 9: cards that duplicate dice already on the grid. */
const DUPLICATION: ReadonlySet<ShopItemId> = new Set([
  "mult3",
  "mult2",
  "twin",
]);

/** Rules 1 and 2: cards that put dice on the grid once. */
const NEW_DICE: ReadonlySet<ShopItemId> = new Set([
  "extra_dice",
  "extra_die",
  "chip",
  "spike",
  "rollplayer",
  "centurion",
]);

/** The three of those whose worth survives rule 4's grid: Word of Mouth is
 *  quoted as a share of the grid rather than a flat two dice, and the two
 *  special dice are what rule 5 exists to sharpen. */
const NEW_DICE_THAT_SCALE: ReadonlySet<ShopItemId> = new Set([
  "extra_dice",
  "rollplayer",
  "centurion",
]);

/** Rule 9, both halves: flat point multipliers, and cards that make dice score
 *  more often or for more. */
const SCORING_POWER: ReadonlySet<ShopItemId> = new Set([
  // multipliers
  "amplifier",
  "prism",
  "last_call",
  "parade",
  "menagerie",
  "uniform",
  "lucky_seven",
  "hourglass",
  "downbeat",
  // scoring faces, and what a scoring face pays
  "extra_number",
  "extra_point",
  "wild_face",
  "royal_seal",
  "keen_edge",
  "snake_eyes",
  "jackpot",
  "dividend",
  "momentum",
]);

/** Rule 5's tools. Only the two that name a target sharpen a special die;
 *  Refinement and Daily Practice shrink whatever they reach, which is a mild
 *  good on a d6 grid and never the reason to visit a shop. */
const SHRINK_TOOLS: ReadonlySet<ShopItemId> = new Set([
  "grindstone",
  "shrink",
  "refinement",
  "whetstone",
]);
const AIMED_SHRINK: ReadonlySet<ShopItemId> = new Set(["grindstone", "shrink"]);

/** Rule 10. Every one of these moves the roll budget — up or down, for one
 *  trial or for all of them — and the plan is built on a trial being the length
 *  the ladder says it is. Haste is cursed as well, and rule 11 would refuse it
 *  anyway; it is named here so the set is the rule rather than a subset of it. */
const ALTERS_TRIAL_LENGTH: ReadonlySet<ShopItemId> = new Set([
  "overtime", // The Long Sitting — rolls added to the next trial
  "metronome", // The Bell — a permanent roll on every trial
  "rain_check", // Held Breath — unused rolls carried forward
  "crunch_time", // Haste — fewer rolls on every trial
]);

// ---- the plan's numbers ----------------------------------------------------

/** Rule 4's "much larger". Past it, two more d6 is not a purchase. */
const BIG_GRID = 200;

/** Rule 3: the shop at which the purse stops being spent to the last coin. */
const BANKING_SHOP = 5;

/** Rule 8: two interest ticks, kept banked through every visit after that. */
const BANK_FLOOR = 2 * GOLD_PER_INTEREST;

/**
 * Where each kind of card sits, highest first. The gaps are deliberate: a tier
 * is a decision ("a duplication beats an engine card"), and cards inside one
 * are separated by `playerOrder`'s tiebreaks rather than by inventing a tier.
 */
const TIER = {
  refuse: -1,
  filler: 0,
  /** Right card, wrong moment — still bought with what is left over. */
  spare: 2,
  economy: 5,
  economyEarly: 6,
  newDice: 6,
  scoring: 7,
  recurring: 8,
  duplication: 9,
  ledger: 10,
  // Rule 1 names three things and an order for them, and it outranks the rest
  // of the list for one shop only.
  firstShopEconomy: 10,
  firstShopNewDice: 11,
  firstShopRecurring: 12,
} as const;

/** The lowest tier worth ending a reroll for (rule 7). */
const KEEPER_TIER: number = TIER.scoring;

// ---- reading the run -------------------------------------------------------

/** Which shop this is, 1-based. A shop runs after its trial has been resolved,
 *  so `state.trial` already names the trial the shop is preparing for. */
export function shopNumber(state: RunState): number {
  return Math.max(1, state.trial - 1);
}

/** Rule 5's premise: a Rollplayer or Centurion that still has room to shrink.
 *  Their bonus fires on the die's *current* highest face, so walking a d100 down
 *  to a d4 turns a 1-in-100 quadrupling into a 1-in-4 one. */
function hasShrinkableSpecial(state: RunState): boolean {
  return state.dice
    .groups()
    .some((group) => group.die.maxFaceBonus > 0 && group.die.sides > 1);
}

/** Whether a rule 9 card would actually pay this grid. Two of them are written
 *  against a grid this plan does not build, and buying a dead multiplier is not
 *  what "grab any kind of flat point multiplier" means. */
function scoringPays(state: RunState, offer: ShopOffer): boolean {
  const sizes = Object.keys(state.dice.sizeCounts()).map(Number);
  // Lucky Seven needs a face that can show a 7; this grid is d6 and smaller.
  if (offer.id === "lucky_seven") return sizes.some((sides) => sides >= 7);
  // Of One Mind needs every die to match, and rules 1 and 5 guarantee a mix.
  if (offer.id === "uniform") return sizes.length === 1;
  return true;
}

// ---- the decisions ---------------------------------------------------------

/** Rules 10 and 11, applied everywhere a card can be taken — the shelf, a
 *  booster reveal, and the Benefactor's freebie. Both rules are about the card
 *  and not about the run, which is why the state goes unread: this is stricter
 *  than any curse appetite, because the plan does not appraise cursed cards at
 *  all, it declines them. */
export function playerAccepts(_state: RunState, offer: ShopOffer): boolean {
  if (offer.cursed) return false;
  return !ALTERS_TRIAL_LENGTH.has(offer.id);
}

/** What this card is worth to the plan right now, as a tier. */
export function playerRank(state: RunState, offer: ShopOffer): number {
  if (!playerAccepts(state, offer)) return TIER.refuse;
  const shop = shopNumber(state);
  const firstShop = shop === 1;

  // Rule 1, in the order it names them.
  if (RECURRING_CREATION.has(offer.id))
    return firstShop ? TIER.firstShopRecurring : TIER.recurring;

  if (NEW_DICE.has(offer.id)) {
    if (firstShop) return TIER.firstShopNewDice;
    const fades =
      !NEW_DICE_THAT_SCALE.has(offer.id) && state.dice.length >= BIG_GRID;
    return fades ? TIER.spare : TIER.newDice;
  }

  // Rule 2 puts the Ledger above the rest of its own theme: five loose cards
  // and five reveals is a wider shop for every visit that follows, which is
  // worth more to a plan this specific than any one card on this shelf.
  if (offer.id === "ledger")
    return firstShop ? TIER.firstShopEconomy : TIER.ledger;
  if (ITEM_THEMES[offer.id].includes("economy")) {
    if (firstShop) return TIER.firstShopEconomy;
    return shop < BANKING_SHOP ? TIER.economyEarly : TIER.economy;
  }

  // Rules 4, 6 and 9. Which duplication is settled by `playerOrder`.
  if (DUPLICATION.has(offer.id)) return TIER.duplication;

  // Rule 5: worth a strong card's slot while there is a special to sharpen,
  // and worth loose change otherwise.
  if (SHRINK_TOOLS.has(offer.id)) {
    const aimed = AIMED_SHRINK.has(offer.id) && hasShrinkableSpecial(state);
    return aimed ? TIER.scoring : TIER.spare;
  }

  // Rule 9.
  if (SCORING_POWER.has(offer.id))
    return scoringPays(state, offer) ? TIER.scoring : TIER.spare;

  return TIER.filler;
}

/** How much of the grid a card duplicates: 3 for The Great Gathering, 2 for The
 *  Gathering, and for Like Minds whatever share of the grid its largest size
 *  holds (rule 6). 1 for everything else, so this only sorts within a tier. */
function gridFactor(state: RunState, offer: ShopOffer): number {
  if (offer.id === "mult3") return 3;
  if (offer.id === "mult2") return 2;
  if (offer.id !== "twin") return 1;
  const counts = Object.values(state.dice.sizeCounts());
  const largest = counts.length > 0 ? Math.max(...counts) : 0;
  return 1 + largest / Math.max(1, state.dice.length);
}

/** The shelf as the plan would walk it: refused cards dropped, then by tier,
 *  then by how much grid the card makes, then cheapest — so a visit that cannot
 *  reach the top of its list still buys as much of the rest as it can. */
export function playerOrder(
  state: RunState,
  offers: readonly ShopOffer[],
): ShopOffer[] {
  return offers
    .filter((offer) => playerAccepts(state, offer))
    .map((offer) => ({
      offer,
      rank: playerRank(state, offer),
      gain: gridFactor(state, offer),
    }))
    .sort(
      (a, b) =>
        b.rank - a.rank || b.gain - a.gain || a.offer.cost - b.offer.cost,
    )
    .map((entry) => entry.offer);
}

/** Rules 3 and 8: nothing is banked until the build exists, and after that two
 *  interest ticks are — unless this one shelf is holding more duplication than
 *  the plan expects to see again, and the purse covers all of it. */
export function playerGoldFloor(
  state: RunState,
  offers: readonly ShopOffer[],
): number {
  if (shopNumber(state) < BANKING_SHOP) return 0;
  const duplications = offers.filter(
    (offer) => DUPLICATION.has(offer.id) && playerAccepts(state, offer),
  );
  const total = duplications.reduce((sum, offer) => sum + offer.cost, 0);
  if (duplications.length >= 2 && total <= state.gold) return 0;
  return BANK_FLOOR;
}

/**
 * Rule 7. Rerolls cost 1, 2 and 3 gold, so the question is not whether one is
 * affordable but whether this shelf is worth keeping: stop for a duplication,
 * an engine card, a multiplier or the Ledger, and otherwise buy a new shelf.
 * `MAX_REROLLS_PER_VISIT` in bot.ts is what keeps "aggressively" finite.
 */
export function playerWantsReroll(
  state: RunState,
  offers: readonly ShopOffer[],
  free: boolean,
  price: number,
): boolean {
  if (free) return true;
  const floor = playerGoldFloor(state, offers);
  // A reroll that leaves nothing to shop the new shelf with is a card burned,
  // not a card sought.
  if (state.gold - price < floor + PRICE_BANDS.low) return false;
  const keeper = offers.some(
    (offer) =>
      canAfford(state, offer) &&
      state.gold - offer.cost >= floor &&
      playerRank(state, offer) >= KEEPER_TIER,
  );
  return !keeper;
}

// ---- targets ---------------------------------------------------------------

type DiceGroup = ReturnType<RunState["dice"]["groups"]>[number];

/** The group holding the most dice, largest die breaking a tie — more points
 *  per die, for the same card. */
function mostNumerous(groups: DiceGroup[]): DiceGroup {
  return groups.reduce((best, group) =>
    group.count > best.count ||
    (group.count === best.count && group.die.sides > best.die.sides)
      ? group
      : best,
  );
}

/** A die of the size there is most of, for the cards that name a size rather
 *  than a die (rule 6). Sizes are counted across groups, because Like Minds
 *  duplicates every die of the size regardless of what else marks it. */
function largestSizeIndex(state: RunState, groups: DiceGroup[]): number {
  const counts = state.dice.sizeCounts();
  let bestSides = -1;
  let bestCount = -1;
  for (const [sides, count] of Object.entries(counts)) {
    const n = Number(sides);
    if (count > bestCount || (count === bestCount && n > bestSides)) {
      bestCount = count;
      bestSides = n;
    }
  }
  const group = groups.find((entry) => entry.die.sides === bestSides);
  return (group ?? groups[0]).firstIndex;
}

/**
 * Where the plan points a card that needs a die. This replaces the bot's random
 * valid pick for every targeting card, because two of the twelve rules are
 * entirely about which die gets named.
 */
export function playerChooseTargets(
  state: RunState,
  offer: ShopOffer,
): DieTargets | null {
  if (!offer.needsTarget) return {};
  const groups = state.dice.groups();
  if (groups.length === 0) return null;

  switch (offer.id) {
    // Rule 5. Group Study names a size and A Lesson names one die, but both
    // want the same die: the biggest special still able to shrink. With no
    // special on the grid they fall back to shrinking the bulk of it, which is
    // what makes them worth their `spare` tier rather than nothing.
    case "grindstone":
    case "shrink": {
      const shrinkable = groups.filter((group) => group.die.sides > 1);
      if (shrinkable.length === 0) return null;
      const specials = shrinkable.filter((group) => group.die.maxFaceBonus > 0);
      if (specials.length > 0) {
        const biggest = specials.reduce((best, group) =>
          group.die.sides > best.die.sides ? group : best,
        );
        return { index: biggest.firstIndex };
      }
      return { index: largestSizeIndex(state, shrinkable) };
    }

    // Rule 6.
    case "twin":
      return { index: largestSizeIndex(state, groups) };

    // Rule 9. Both name a size and both pay per die of it, so both go where the
    // dice are — skipping sizes that already carry the effect.
    case "wild_face": {
      const open = groups.filter((group) => !group.die.wildFace);
      return open.length > 0 ? { index: mostNumerous(open).firstIndex } : null;
    }
    case "royal_seal": {
      const open = groups.filter(
        (group) => !state.royalSealSizes.includes(group.die.sides),
      );
      return open.length > 0 ? { index: mostNumerous(open).firstIndex } : null;
    }

    // Not a card the plan buys on purpose, but one a booster can leave it
    // holding: The Vow drops a size's top two faces, which raises how often it
    // shows a scoring number. Same reasoning, same target.
    case "loaded_die": {
      const open = groups.filter(
        (group) => group.die.sides > 1 && !group.die.loaded,
      );
      return open.length > 0 ? { index: mostNumerous(open).firstIndex } : null;
    }

    default:
      return {};
  }
}

// ---- the King's demand -----------------------------------------------------

function limitsGridGrowth(id: AfflictionId): boolean {
  const affliction: Affliction = AFFLICTIONS[id];
  if (affliction.blocksGrowth) return true;
  return (
    affliction.gridCap !== undefined && Number.isFinite(affliction.gridCap)
  );
}

/**
 * Rule 12. The King's writ cannot be declined, only chosen from, and every
 * other rule in this file is downstream of the grid still growing — so a
 * drought is refused ahead of a drawback that merely costs points. Among what
 * is left, the least risky, which is the same call the rest of the field makes.
 */
export function playerChooseDemand(
  state: RunState,
  demands: readonly AfflictionId[],
): AfflictionId | undefined {
  const byRisk = [...demands].sort(
    (a, b) => afflictionRisk(state, a) - afflictionRisk(state, b),
  );
  const growable = byRisk.filter((id) => !limitsGridGrowth(id));
  return growable[0] ?? byRisk[0];
}
