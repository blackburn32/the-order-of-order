// Shoppers that each play one strategy tree toward its engine: Resonance, The
// Treasury, The Canticle, The Weighing, The Pyre and The Hermitage. (The Lessons
// has its own, sim/lessons.ts, and The Gathering is played by the swarm shopper
// committed to its tree; see sim/bot.ts.)
//
// The engine experiment needs runs that build a tree the way a player committed
// to it would, so what it measures is the engine rather than a shopper's
// indifference to it. Every plan follows the same rules, and differs only in
// what it wants from the base set:
//
//   0  play one tree: every other tree's engine and boost stays on the shelf, as
//      does every card the trees mark for retirement; and gold is never spent
//      on a card the plan ranks as filler
//   1  take the tree's gated cards — its chain and the multipliers its tier-2
//      card opens — on sight, at any price the purse covers; the engine and its
//      boost first. A repeatable chain card is on the path for its first copy
//      only, and after that is worth what the plan says it is. A card the plan
//      refuses outright (rule 2) stays refused even when gated: a branch can be
//      a tree's card and still be wrong for this grid
//   2  rank everything else by what the tree wants of the grid (`worth`)
//   3  from rank 2, while the engine is still missing, keep a build card's price
//      banked through everything that is not on the path
//   4  from rank 2, reroll a shelf with nothing on the path, as long as that bank
//      survives the reroll
//   5  once the engine is owned, keep what the plan keeps banked (`keep`) —
//      only The Treasury, whose engine is the purse, keeps anything
//
// A plan's `chooseTargets` aims the cards that name a die or a size; a card it
// has no opinion on falls back to the field's random valid pick.

import { rankOf } from "../config";
import type { RunState } from "../state/RunState";
import type { DieSides } from "../systems/Dice";
import { engineGrowthPercent, growthTuning } from "../systems/GrowthEngines";
import {
  ballastableSizes,
  ITEM_THEMES,
  sizeAlwaysScores,
  type ItemTheme,
  type ShopItemId,
} from "../systems/Items";
import {
  ENGINE_CARD_TREE,
  ITEM_TREES,
  OUTSIDE_TREES,
  type TreeId,
} from "../systems/ItemTrees";
import { canAfford, PRICE_BANDS, type ShopOffer } from "../systems/Shop";
import type { DieTargets } from "./bot";
import { acceptsCurse } from "./curseValue";

export const TIER = {
  refuse: -1,
  filler: 1,
  useful: 3,
  dice: 4,
  power: 5,
  path: 8,
  engine: 10,
} as const;

/** The tier from which a card is bought regardless of rule 3's bank. */
export const PLAN_ON_PATH: number = TIER.path;

export interface TreePlan {
  tree: TreeId;
  /** The booster packs this plan opens first. */
  theme: ItemTheme | null;
  engine: ShopItemId;
  boost: ShopItemId;
  /** Rule 2: what a card off the path is worth right now, as a tier. */
  worth(state: RunState, offer: ShopOffer): number;
  /** Where the plan aims a card that names a die or a size: undefined when it
   *  has no opinion, null when no die on the grid is worth naming. */
  chooseTargets?(
    state: RunState,
    offer: ShopOffer,
  ): DieTargets | null | undefined;
  /** Rule 5: gold kept banked once the engine is owned. */
  keep?(state: RunState): number;
}

// ---- the grid vocabulary the plans share -------------------------------------

/** Dice a card puts on the grid at once. */
const ADDS: Partial<Record<ShopItemId, number>> = {
  extra_die: 2,
  chip: 2,
  spike: 2,
  rollplayer: 1,
  centurion: 1,
  two_novices: 2,
  the_calling: 3,
  a_new_voice: 3,
  two_elders: 2,
  tinder: 3,
  extra_dice: 5,
};

/** Cards that grow the grid on their own, or multiply it. */
const GROWS: ReadonlySet<ShopItemId> = new Set<ShopItemId>([
  "mult2",
  "mult3",
  "twin",
  "brick_mold",
  "chip_mold",
  "spike_mold",
  "foundry",
  "genesis",
  "double_the_fun",
  "the_multitude",
  "from_the_ashes",
  "locust_idol",
]);

/** Cards that shrink dice. */
const SHRINKS: ReadonlySet<ShopItemId> = new Set<ShopItemId>([
  "shrink",
  "grindstone",
  "refinement",
  "whetstone",
]);

/** The best tier any of a card's themes earns, from `tiers`. */
function byTheme(
  offer: ShopOffer,
  tiers: Partial<Record<ItemTheme, number>>,
): number {
  const themes = ITEM_THEMES[offer.id];
  if (themes.length === 0) return TIER.filler;
  return Math.max(...themes.map((theme) => tiers[theme] ?? TIER.filler));
}

type DiceGroup = ReturnType<RunState["dice"]["groups"]>[number];

/** The group a comparison prefers, or undefined for no groups. */
function best(
  groups: DiceGroup[],
  better: (a: DiceGroup, b: DiceGroup) => boolean,
): DiceGroup | undefined {
  return groups.reduce<DiceGroup | undefined>(
    (found, group) => (!found || better(group, found) ? group : found),
    undefined,
  );
}

/** The size on the grid with the most dice below a d100, the larger on a tie. */
function mostNumerousGrowable(state: RunState): DiceGroup | undefined {
  const counts = state.dice.sizeCounts();
  return best(
    state.dice.groups().filter((group) => group.die.sides < 100),
    (a, b) =>
      counts[a.die.sides] > counts[b.die.sides] ||
      (counts[a.die.sides] === counts[b.die.sides] &&
        a.die.sides > b.die.sides),
  );
}

/** The largest die below a d100. */
function largestGrowable(state: RunState): DiceGroup | undefined {
  return best(
    state.dice.groups().filter((group) => group.die.sides < 100),
    (a, b) => a.die.sides > b.die.sides,
  );
}

const at = (group: DiceGroup | undefined): DieTargets | null =>
  group ? { index: group.firstIndex } : null;

// ---- the plans ---------------------------------------------------------------

/** Resonance: land two multipliers on every roll. */
const RESONANCE: TreePlan = {
  tree: "resonance",
  theme: "multiplier",
  engine: "the_resonant_hall",
  boost: "harmonics",
  worth: (_state, offer) =>
    byTheme(offer, {
      multiplier: TIER.power,
      precision: TIER.useful,
      swarm: TIER.dice,
      economy: TIER.useful,
    }),
};

/** The Treasury: hold gold, because the engine is the purse. */
const TREASURY: TreePlan = {
  tree: "treasury",
  theme: "economy",
  engine: "the_endowment",
  boost: "compound_interest",
  worth: (_state, offer) =>
    byTheme(offer, {
      economy: TIER.power,
      multiplier: TIER.useful,
      precision: TIER.useful,
      swarm: TIER.dice,
    }),
  // Enough gold to fill the engine's cap, and no more.
  keep: (state) =>
    growthTuning().endowmentGoldPerPercent *
    engineGrowthPercent("endowment", state.compoundInterest),
};

/** The grid The Canticle stops growing at: around a hundred d100s show as many
 *  faces once as any grid can. */
const CANTICLE_GRID = 80;

/** Cards that add or make big dice, which is where unrepeated faces come from. */
const BIG_DICE: ReadonlySet<ShopItemId> = new Set<ShopItemId>([
  "two_elders",
  "centurion",
  "rollplayer",
  "tinder",
  "a_new_voice",
  "exaltation",
  "ascension",
]);

/** The Canticle: a grid of big dice that rarely repeat a face. */
const CANTICLE: TreePlan = {
  tree: "canticle",
  theme: "precision",
  engine: "plainsong",
  boost: "descant",
  worth: (state, offer) => {
    const id = offer.id;
    // Copies and small dice repeat faces; The Choirmaster culls the big dice
    // that do too.
    if (GROWS.has(id) || SHRINKS.has(id) || id === "the_choirmaster")
      return TIER.refuse;
    if (BIG_DICE.has(id))
      return state.dice.length < CANTICLE_GRID ? TIER.power : TIER.refuse;
    if (ADDS[id] !== undefined)
      return state.dice.length < 6 ? TIER.dice : TIER.refuse;
    return byTheme(offer, {
      multiplier: TIER.power,
      precision: TIER.useful,
      economy: TIER.useful,
    });
  },
  chooseTargets: (state, offer) => {
    switch (offer.id) {
      case "exaltation": {
        // A d20 grows straight into a d100.
        const d20 = state.dice.groups().find((group) => group.die.sides === 20);
        return at(d20 ?? largestGrowable(state));
      }
      case "ascension":
        return at(largestGrowable(state));
      default:
        return undefined;
    }
  },
};

/** The Weighing: a wall of d100s, scoring its faces. */
const WEIGHING: TreePlan = {
  tree: "weighing",
  theme: "swarm",
  engine: "the_weight_of_ages",
  boost: "gravity_well",
  worth: (state, offer) => {
    const id = offer.id;
    // Shrinking now loses points, and loading a die takes its best faces.
    if (SHRINKS.has(id) || id === "loaded_die" || id === "leaden_dice")
      return TIER.refuse;
    if (state.hasScales && (id === "extra_number" || id === "iron_debt"))
      return TIER.refuse;
    if (id === "two_elders" || id === "centurion" || id === "exaltation")
      return TIER.power;
    if (id === "ascension" || id === "ballast") return TIER.useful;
    if (ADDS[id] !== undefined || GROWS.has(id)) return TIER.dice;
    return byTheme(offer, {
      multiplier: TIER.power,
      precision: TIER.useful,
      economy: TIER.useful,
    });
  },
  chooseTargets: (state, offer) => {
    const groups = state.dice.groups();
    switch (offer.id) {
      case "exaltation":
        return at(mostNumerousGrowable(state));
      case "ascension":
        return at(largestGrowable(state));
      case "ballast": {
        const sizes = ballastableSizes(state);
        const counts = state.dice.sizeCounts();
        const size = sizes.reduce<DieSides | undefined>(
          (found, sides) =>
            found === undefined ||
            sides === 100 ||
            (found !== 100 && counts[sides] > counts[found])
              ? sides
              : found,
          undefined,
        );
        return at(groups.find((group) => group.die.sides === size));
      }
      case "twin":
      case "royal_seal":
      case "wild_face":
        return at(best(groups, (a, b) => a.die.sides > b.die.sides));
      default:
        return undefined;
    }
  },
};

/** The Pyre: a grid that burns as fast as it regrows. */
const PYRE: TreePlan = {
  tree: "pyre",
  theme: "swarm",
  engine: "the_pyre",
  boost: "everflame",
  worth: (_state, offer) => {
    const id = offer.id;
    if (SHRINKS.has(id)) return TIER.refuse;
    if (id === "kindling" || id === "ouroboros" || id === "from_the_ashes")
      return TIER.power;
    // More dice that score is more dice that shatter.
    if (id === "extra_number" || id === "wild_face" || id === "extra_point")
      return TIER.power;
    if (GROWS.has(id)) return TIER.power;
    if (ADDS[id] !== undefined) return TIER.dice;
    return byTheme(offer, {
      multiplier: TIER.power,
      precision: TIER.useful,
      economy: TIER.useful,
    });
  },
};

/** The Hermitage keeps no more dice than this: The Cell pays for every seat
 *  below it, and The Vigil stops growing past its own limit well above. */
const HERMIT_GRID = 8;

/** Cards that make a die score more often, which is every roll The Vigil grows. */
const DEVOTIONS: ReadonlySet<ShopItemId> = new Set<ShopItemId>([
  "extra_number",
  "wild_face",
  "extra_point",
  "keen_edge",
  "shrink",
  "grindstone",
  "refinement",
  "royal_seal",
  "paupers_vow",
  "tollkeeper",
  "iron_debt",
  "anointing",
]);

/** The die least likely to score: not wild, not always scoring, largest. */
function leastDevout(state: RunState): DiceGroup | undefined {
  const groups = state.dice.groups();
  const missing = groups.filter(
    (group) => !group.die.wildFace && !sizeAlwaysScores(state, group.die.sides),
  );
  return best(
    missing.length > 0 ? missing : groups,
    (a, b) => a.die.sides > b.die.sides,
  );
}

/** The Hermitage: a handful of dice, each of which scores every roll. */
const HERMITAGE: TreePlan = {
  tree: "hermitage",
  theme: "precision",
  engine: "the_vigil",
  boost: "discipline",
  worth: (state, offer) => {
    const id = offer.id;
    const dice = state.dice.length;
    if (GROWS.has(id)) return TIER.refuse;
    const adds = ADDS[id];
    if (adds !== undefined)
      return dice + adds > HERMIT_GRID
        ? TIER.refuse
        : id === "rollplayer" || id === "centurion"
          ? TIER.power
          : TIER.dice;
    if (
      id === "a_parting" ||
      id === "dismissal" ||
      id === "winnowing" ||
      id === "excommunication"
    )
      return dice > HERMIT_GRID ? TIER.useful : TIER.refuse;
    if (DEVOTIONS.has(id)) return TIER.power;
    return byTheme(offer, {
      multiplier: TIER.power,
      precision: TIER.useful,
      economy: TIER.useful,
      swarm: TIER.refuse,
    });
  },
  chooseTargets: (state, offer) => {
    const groups = state.dice.groups();
    switch (offer.id) {
      case "a_parting":
      case "dismissal":
        return state.dice.length > 1 ? at(leastDevout(state)) : null;
      case "shrink":
      case "grindstone":
        return at(
          best(
            groups.filter((group) => group.die.sides > 1),
            (a, b) => a.die.sides > b.die.sides,
          ),
        );
      case "wild_face":
        return at(
          best(
            groups.filter((group) => !group.die.wildFace),
            (a, b) => a.count > b.count || a.die.sides > b.die.sides,
          ),
        );
      case "anointing": {
        // The die that has scored most is the likeliest to keep scoring.
        const tally = (group: DiceGroup) =>
          (group.die.scores ?? []).reduce((sum, count) => sum + count, 0);
        return at(best(groups, (a, b) => tally(a) > tally(b)));
      }
      default:
        return undefined;
    }
  },
};

export const TREE_PLANS = {
  resonance: RESONANCE,
  treasury: TREASURY,
  canticle: CANTICLE,
  weighing: WEIGHING,
  pyre: PYRE,
  hermitage: HERMITAGE,
} as const;

export type PlannedTree = keyof typeof TREE_PLANS;

// ---- the rules -----------------------------------------------------------------

const GATED = new Map<TreeId, ReadonlySet<string>>(
  ITEM_TREES.map((tree) => [
    tree.id,
    new Set([...tree.nodes, ...tree.branches].map((card) => card.id)),
  ]),
);

/** What a card is worth to the plan right now, as a tier. */
export function planRank(
  plan: TreePlan,
  state: RunState,
  offer: ShopOffer,
): number {
  if (offer.id === plan.engine || offer.id === plan.boost) return TIER.engine;
  // Rule 0.
  const owner = ENGINE_CARD_TREE.get(offer.id);
  if (owner && owner !== plan.tree) return TIER.refuse;
  if (OUTSIDE_TREES[offer.id]?.status === "retire") return TIER.refuse;
  const worth = plan.worth(state, offer);
  if (worth <= TIER.refuse) return TIER.refuse;
  // Rule 1: the gated cards, each on the path until the run owns one.
  if (GATED.get(plan.tree)!.has(offer.id) && !state.purchases[offer.id])
    return TIER.path;
  return worth;
}

/** Whether this plan takes the card at all. Cursed cards are appraised against
 *  the appetite, as the rest of the field does. */
export function planAccepts(
  plan: TreePlan,
  state: RunState,
  offer: ShopOffer,
  curseAppetite: number,
): boolean {
  if (planRank(plan, state, offer) <= TIER.refuse) return false;
  return !offer.cursed || acceptsCurse(state, offer, curseAppetite);
}

/** The shelf as the plan walks it: refused cards dropped, then by tier, then
 *  cheapest. */
export function planOrder(
  plan: TreePlan,
  state: RunState,
  offers: readonly ShopOffer[],
): ShopOffer[] {
  return offers
    .map((offer) => ({ offer, rank: planRank(plan, state, offer) }))
    .filter((entry) => entry.rank > TIER.filler)
    .sort((a, b) => b.rank - a.rank || a.offer.cost - b.offer.cost)
    .map((entry) => entry.offer);
}

/** Whether the run owns the plan's engine. */
function ownsEngine(plan: TreePlan, state: RunState): boolean {
  return (state.purchases[plan.engine] ?? 0) > 0;
}

/** Rules 3 and 5. */
export function planGoldFloor(plan: TreePlan, state: RunState): number {
  if (ownsEngine(plan, state)) return plan.keep?.(state) ?? 0;
  return rankOf(state.trial) >= 2 ? PRICE_BANDS.build : 0;
}

/** Rule 4. `MAX_REROLLS_PER_VISIT` in bot.ts keeps it finite. */
export function planWantsReroll(
  plan: TreePlan,
  state: RunState,
  offers: readonly ShopOffer[],
  free: boolean,
  price: number,
): boolean {
  if (free) return true;
  if (ownsEngine(plan, state) || rankOf(state.trial) < 2) return false;
  if (state.gold - price < planGoldFloor(plan, state)) return false;
  return !offers.some(
    (offer) =>
      canAfford(state, offer) && planRank(plan, state, offer) >= PLAN_ON_PATH,
  );
}
