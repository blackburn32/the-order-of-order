// Strategy trees — the shop reads the links below (systems/Shop), and the
// simulation's committed shoppers read the engines.
//
// Every strategy is a short chain of four cards, bought across at least four
// shop visits: buying a card opens the next one to the shop for the rest of the
// run (at better odds, never guaranteed), and a locked card is never shown. The
// chain's root is the only card the meta progression unlocks: unlock the root
// and the whole chain is available in play.
//
// Everything else a strategy wants is a SUPPORT: a card that sits in the base
// set, ungated, under its own unlock. The trees keep the base set broad and gate
// only the path to the engine, so a run shops freely and commits to a strategy
// by walking one chain.
//
// The exception is a strategy's multipliers. Each is a BRANCH off its chain's
// tier-2 card, opened with that card rather than sold in the base set:
// multipliers bought from every strategy at once multiply into a second engine,
// one that grows with every shop visit, and the goal curve cannot gate on the
// real engines while that one is in reach.
//
// An engine that starves on what the base set feeds it gets its FUEL as branches
// off the engine itself: cards no other strategy has a use for, opened only once
// the run owns the engine they feed, so they never dilute the base set.
//
// THE RULE — every card pays when it is bought. A card on the shelf must be
// worth buying to a run that owns nothing but what opened it: a support must pay
// in the base set, a chain root must pay on its own, and a gated card must pay
// once its parent is owned. A card whose only use is a card further down a tree
// hangs from that card as a branch instead. A player has never seen the rest of
// the chain, so a card that only makes sense beside it is a card no player buys
// — and a chain whose early cards are such cards is one no player starts, however
// well a shopper who already knows the chain builds it. The Weighing once opened
// on growing a die, which lowers its odds of scoring until The Scales arrive;
// Ballast then made a size never roll the 1 it scored on. Rule of thumb: the
// root teaches the tree's idea in miniature (Ascension's die always scores its
// highest face; A New Voice's dice score alone on their face; An Offering pays
// for what burns; Solitude pays for empty seats), and the cards that deepen the
// idea wait for the card that makes it the rule.
//
// Shelf copy follows from it: a gated card is only ever seen once its parent is
// owned, so its text may name that card ("Under The Scales, …"), and should when
// the parent is why the card is worth having.
//
// `npm run engines:experiment` measures the rule: its skeptic-* scenarios play
// every tree with a shopper that buys none of its tree's cards on faith (see
// sim/skeptic.ts). A tree the trusting shopper builds and the skeptic does not is
// a tree whose early cards break the rule.
//
// A chain holds one card of each tier, in order. Tiers describe how a card grows
// a run's score, which is what the goal curve is designed against:
//   1  additive      more dice, more points per die; culled in ranks 4-6
//   2  fixed factor  flat multipliers and one-off jumps (cursed cards fold in here)
//   3  the engine    compounds for the rest of the run; building one is the win
//   4  the boost     raises the engine's rate 2% a copy, three copies at most
// Supports are tier 1 or 2 and branches tier 2; the engine and its boost are
// always gated.
//
// Every tier-3 engine compounds PER ROLL TAKEN, at 10% a roll before its boost.
// An engine that compounds once per trial clears late trials in one or two rolls
// however the curve is shaped; one that grows only while rolling regulates
// itself — a lead clears the trial sooner, which grows the engine less — and
// holds roll use near 60% (see the engine-gate and roll-use models in the
// balance notes). The same reasoning retires the cards that pay for unused rolls.
//
// Cards are either LIVE (an id in systems/Items, optionally with a proposed
// `change` not yet made to it) or PLANNED (defined below, not yet implemented). Export all trees
// for a visualisation tool with `npm run trees:csv`; the export validates them
// first, so run it after any edit here or in systems/Items.

import {
  ITEMS,
  type PriceBand,
  type Rarity,
  type ShopItemId,
  type StackPricing,
  type UnlockCriterion,
} from "./Items";

export type TreeId =
  | "lessons"
  | "gathering"
  | "resonance"
  | "hermitage"
  | "weighing"
  | "treasury"
  | "canticle"
  | "pyre";

export type Tier = 1 | 2 | 3 | 4;

/** Cards in a chain, and so the tiers, in order. */
export const CHAIN_LENGTH = 4;

/** Cards a tree calls for that the roster does not have yet — none, now that
 *  every tree's cards are implemented. A new card is designed here first. */
export type PlannedCardId = never;

export type CardId = ShopItemId | PlannedCardId;

/** A card a tree calls for that the roster does not have yet. The card-facing
 *  fields of an ItemDef and no effects, since nothing implements it. */
export interface PlannedCard {
  name: string;
  desc: string;
  priceBand: PriceBand;
  stackPricing?: StackPricing;
  rarity: Rarity;
  unique?: boolean;
  cursed?: boolean;
  needsTarget?: boolean;
  targetsSize?: boolean;
  /** Only a chain's root is unlocked by meta progression. */
  unlock?: UnlockCriterion;
  /** The rule the card needs that the game does not have yet. */
  mechanic: string;
}

/** A proposed edit to a live card, laid over its current definition on export. */
export interface CardChange {
  name?: string;
  desc?: string;
  priceBand?: PriceBand;
  stackPricing?: StackPricing;
  rarity?: Rarity;
  unique?: boolean;
  cursed?: boolean;
  note: string;
}

/** One link of a tree's gated chain. */
export interface TreeNode {
  id: CardId;
  /** The card whose purchase opens this one; null only for the root. */
  parent: CardId | null;
  tier: Tier;
  change?: CardChange;
}

/** A card that serves a strategy from the base set: never gated, and unlocked
 *  by its own meta criterion rather than the chain root's. */
export interface SupportCard {
  id: CardId;
  tier: 1 | 2;
  change?: CardChange;
}

/** A gated card off the chain: a strategy's multiplier, opened with the chain's
 *  tier-2 card, or an engine's fuel, opened with the engine. */
export interface BranchCard {
  id: CardId;
  /** The chain card whose purchase opens it; the tier-2 card when absent. */
  parent?: CardId;
  change?: CardChange;
}

export interface ItemTree {
  id: TreeId;
  name: string;
  /** How the tier-3 engine compounds. */
  engine: string;
  /** The strategies this one works against. */
  excludes: string;
  /** The gated chain, root first: one card of each tier, each under the last. */
  nodes: TreeNode[];
  /** The base-set cards this strategy wants. */
  supports: SupportCard[];
  /** The gated cards off the chain: multipliers and fuel. */
  branches: BranchCard[];
}

export interface OutsidePlacement {
  /** `neutral` serves every tree alike; `retire` works against the design. */
  status: "neutral" | "retire";
  note: string;
}

/** The gated chain for four cards, root first. */
function chain(
  root: CardId,
  factor: CardId,
  engine: CardId,
  boost: CardId,
  changes: Partial<Record<CardId, CardChange>> = {},
): TreeNode[] {
  return [root, factor, engine, boost].map((id, index, ids) => ({
    id,
    parent: index === 0 ? null : ids[index - 1],
    tier: (index + 1) as Tier,
    ...(changes[id] ? { change: changes[id] } : {}),
  }));
}

export const PLANNED_CARDS: Readonly<Record<string, PlannedCard>> = {};

export const ITEM_TREES: ItemTree[] = [
  {
    id: "lessons",
    name: "The Lessons",
    engine:
      "Each roll where every die scores permanently multiplies your multiplier by 1.1; each Litany adds 0.02 to that, up to 1.16.",
    excludes:
      "The Weighing (big faces) and The Canticle (unrepeated faces); a shrunk grid shows the same face everywhere.",
    nodes: chain("shrink", "grindstone", "the_catechism", "litany"),
    supports: [
      { id: "spike", tier: 1 },
      { id: "chip", tier: 1 },
      { id: "whetstone", tier: 1 },
      { id: "loaded_die", tier: 1 },
      { id: "two_novices", tier: 1 },
      { id: "extra_number", tier: 1 },
      { id: "refinement", tier: 2 },
      { id: "wild_face", tier: 2 },
      { id: "iron_debt", tier: 2 },
      { id: "keen_edge", tier: 2 },
      { id: "leaden_dice", tier: 2 },
      { id: "the_calling", tier: 2 },
      { id: "rollplayer", tier: 2 },
      { id: "centurion", tier: 2 },
    ],
    branches: [
      { id: "uniform" },
      // Shedding dice only pays once a roll every die scores grows something.
      { id: "dismissal", parent: "the_catechism" },
      { id: "winnowing", parent: "the_catechism" },
      { id: "excommunication", parent: "the_catechism" },
    ],
  },
  {
    id: "gathering",
    name: "The Gathering",
    engine:
      "The Curious copies any d6-or-larger that rolls its highest face, so the grid grows on every roll.",
    excludes:
      "The Hermitage (a small grid) and The Canticle (copies repeat faces); The Curious ignores shrunk dice.",
    nodes: chain("extra_dice", "mult2", "double_the_fun", "the_multitude"),
    supports: [
      { id: "dividend", tier: 1 },
      { id: "jackpot", tier: 1 },
      { id: "brick_mold", tier: 1 },
      { id: "spike_mold", tier: 1 },
      { id: "chip_mold", tier: 1 },
      { id: "mult3", tier: 2 },
      { id: "twin", tier: 2 },
      {
        id: "foundry",
        tier: 2,
        change: {
          priceBand: "standard",
          stackPricing: "linear",
          note: "Its fixed pour (systems/CardReworks) no longer earns an explosive price. Not yet measured.",
        },
      },
      { id: "genesis", tier: 2 },
      { id: "locust_idol", tier: 2 },
    ],
    branches: [],
  },
  {
    id: "resonance",
    name: "Resonance",
    engine:
      "Each roll that three or more cards multiply permanently multiplies your multiplier by 1.1; each Harmonics adds 0.02 to that, up to 1.16.",
    excludes:
      "The Treasury (every multiplier is bought with the gold that engine banks).",
    nodes: chain("momentum", "downbeat", "the_resonant_hall", "harmonics"),
    supports: [],
    branches: [
      { id: "hourglass" },
      { id: "last_call" },
      { id: "amplifier" },
      { id: "prism" },
      { id: "the_reckoning" },
      { id: "gamblers_curse" },
      {
        id: "crunch_time",
        change: {
          note: "Kept, but watch it: fewer rolls per trial is fewer rolls for every per-roll engine.",
        },
      },
    ],
  },
  {
    id: "hermitage",
    name: "The Hermitage",
    engine:
      "While the grid stays at 12 dice or fewer, each time a die scores its points are permanently multiplied by 1.1; each Discipline adds 0.02 to that, up to 1.16.",
    excludes:
      "The Gathering (any growth past 12 dice switches the engine off) and The Pyre (nothing to burn).",
    nodes: chain("solitude", "the_cell", "the_vigil", "discipline"),
    supports: [
      { id: "extra_point", tier: 1 },
      { id: "paupers_vow", tier: 2 },
      { id: "tollkeeper", tier: 2 },
    ],
    branches: [
      // Removing a die pays once an empty seat does.
      { id: "a_parting", parent: "solitude" },
      // Counts only under The Vigil.
      { id: "anointing", parent: "the_vigil" },
      {
        id: "famished_idol",
        change: {
          desc: "Every point you earn is multiplied by ×4, but your grid can never hold more than 12 dice.",
          note: "Cap 100 → 12 and ×8 → ×4: at 100 dice it was a swarm card, and at 12 its drawback is nearly free for this tree.",
        },
      },
    ],
  },
  {
    id: "weighing",
    name: "The Weighing",
    engine:
      "Each roll permanently multiplies your multiplier by up to 1.1: 0.01 for every 3 dice showing 50 or higher; each Gravity Well adds 0.02 to the cap, up to 1.16.",
    excludes:
      "The Lessons (shrinking now loses points) and The Canticle (a wall of d100s repeats faces as it grows).",
    nodes: chain(
      "ascension",
      "the_scales",
      "the_weight_of_ages",
      "gravity_well",
    ),
    supports: [
      { id: "royal_seal", tier: 2 },
      { id: "snake_eyes", tier: 2 },
    ],
    branches: [
      { id: "gravitas" },
      { id: "lucky_seven" },
      { id: "the_bloat" },
      // Bigger dice score less often until The Scales pay their faces, and a
      // ballasted size never rolls the 1 it scored on.
      { id: "two_elders", parent: "the_scales" },
      { id: "exaltation", parent: "the_scales" },
      { id: "ballast", parent: "the_scales" },
      // Builders' grids held too few d100s to reach the cap, and rode the
      // tree's fixed factors instead.
      { id: "the_ancestors", parent: "the_weight_of_ages" },
      { id: "the_anvil", parent: "the_weight_of_ages" },
    ],
  },
  {
    id: "treasury",
    name: "The Treasury",
    engine:
      "Each roll permanently multiplies your multiplier by up to 1.1: 0.01 for every 10 gold held, so every purchase slows it; each Compound Interest adds 0.02 to the cap, up to 1.16.",
    excludes: "Every tree that shops broadly; Resonance most of all.",
    nodes: chain(
      "counting_house",
      "gilded_altar",
      "the_endowment",
      "compound_interest",
    ),
    supports: [
      { id: "tithe_bowl", tier: 1 },
      { id: "lucky_coin", tier: 1 },
      {
        id: "vault",
        tier: 1,
        change: {
          desc: "Interest pays up to 5 more gold per trial for each copy.",
          stackPricing: "linear",
          unique: false,
          note: "Unique → stacking: holding past 25 gold earned nothing, and this tree is built on holding.",
        },
      },
      { id: "devils_bargain", tier: 1 },
      { id: "abstinence", tier: 1 },
      { id: "prospector", tier: 2 },
      { id: "reliquary", tier: 2 },
      { id: "coupon_book", tier: 2 },
      { id: "shopping_cart", tier: 2 },
      { id: "pawnbroker", tier: 2 },
    ],
    branches: [],
  },
  {
    id: "canticle",
    name: "The Canticle",
    engine:
      "Each roll permanently multiplies your multiplier by up to 1.1: 0.01 for every face exactly one die shows; each Descant adds 0.02 to the cap, up to 1.16.",
    excludes:
      "The Gathering (copies repeat faces) and The Lessons (shrunk dice all show 1).",
    nodes: chain("a_new_voice", "counterpoint", "plainsong", "descant"),
    supports: [],
    branches: [
      // Before Counterpoint a repeated face is usually a scoring 1.
      { id: "the_choirmaster", parent: "counterpoint" },
      { id: "the_canticle" },
      { id: "parade" },
      { id: "menagerie" },
      // Builders' grids ended near eight dice, and so near eight lone faces.
      { id: "a_full_choir", parent: "plainsong" },
      { id: "antiphon", parent: "plainsong" },
    ],
  },
  {
    id: "pyre",
    name: "The Pyre",
    engine:
      "Each roll permanently multiplies your multiplier by up to 1.1: 0.01 for every 20 faces burned or shattered; each Everflame adds 0.02 to the cap, up to 1.16.",
    excludes:
      "The Lessons (a shrunk die is worthless fuel) and The Hermitage (nothing to burn).",
    nodes: chain("an_offering", "the_ashen_crown", "the_pyre", "everflame"),
    supports: [
      { id: "tinder", tier: 1 },
      { id: "ouroboros", tier: 2 },
    ],
    branches: [
      { id: "blood_price" },
      // Kindling was the chain's tier-2 card and paid nothing until The Ashen
      // Crown or The Pyre was owned: a shopper who buys only what pays bought
      // it in no run at all, so no run reached the engine. The Crown pays on the
      // first die An Offering burns, and Kindling doubles what it already reads.
      { id: "kindling" },
      // The fire burned only when a curse shattered dice or an Offering was
      // bought: it grew on a third of the rolls taken. Opened with The Ashen
      // Crown rather than the engine: burning every roll is what pays the Crown
      // before The Pyre arrives.
      { id: "the_brazier" },
      // Returns nothing until something burns.
      { id: "from_the_ashes", parent: "an_offering" },
      { id: "embers", parent: "the_pyre" },
    ],
  },
];

const TEMPO = "Adds rolls or a safety net, which serves every tree alike.";
const EARLY_CLEAR =
  "Pays for clearing a trial with rolls to spare, which works against spending most of a trial's rolls.";

/** Live cards no tree claims. Every live item is either in a tree or here. */
export const OUTSIDE_TREES: Partial<Record<ShopItemId, OutsidePlacement>> = {
  extra_die: {
    status: "neutral",
    note: "The free fallback when a shop row is out of reach.",
  },
  the_edge: {
    status: "neutral",
    note: "Its unmirrored duel point serves every strategy alike.",
  },
  pocket_change: {
    status: "neutral",
    note: "A starter card, sold only to small grids.",
  },
  overtime: { status: "neutral", note: TEMPO },
  metronome: { status: "neutral", note: TEMPO },
  insurance_policy: { status: "neutral", note: TEMPO },
  long_night: { status: "neutral", note: TEMPO },
  ledger: {
    status: "neutral",
    note: "A shop utility with no strategy of its own.",
  },
  dealers_bell: {
    status: "neutral",
    note: "A shop utility with no strategy of its own.",
  },
  sealed_doors: {
    status: "neutral",
    note: "Doubles whichever tree the run is in.",
  },
  rain_check: { status: "retire", note: EARLY_CLEAR },
  reserve: { status: "retire", note: EARLY_CLEAR },
  deep_pockets: { status: "retire", note: EARLY_CLEAR },
  hair_trigger: {
    status: "retire",
    note: "Makes a trial's first roll the one that matters, the opposite of playing a trial out. Retired (systems/CardReworks).",
  },
};

/** Every structural problem with the trees, empty when they are sound: each
 *  live item placed exactly once (in a chain, as a branch or support, or in
 *  OUTSIDE_TREES), each planned card placed exactly once, and every chain four
 *  cards long — tiers 1 to 4 in order, each card under the one before it. */
export function validateTrees(): string[] {
  const problems: string[] = [];
  const liveIds = new Set<CardId>(ITEMS.map((item) => item.id));
  const plannedIds = new Set<CardId>(
    Object.keys(PLANNED_CARDS) as PlannedCardId[],
  );
  const placed = new Map<CardId, string>();
  const place = (
    tree: string,
    card: { id: CardId; change?: CardChange },
    as: string,
  ) => {
    const where = `${tree} ${as}`;
    const previous = placed.get(card.id);
    if (previous)
      problems.push(`${card.id} is placed twice (${previous} and ${where})`);
    else placed.set(card.id, where);
    if (!liveIds.has(card.id) && !plannedIds.has(card.id))
      problems.push(
        `${tree}: ${card.id} is neither a live item nor a planned card`,
      );
    if (card.change && !liveIds.has(card.id))
      problems.push(
        `${tree}: ${card.id} is planned — edit its definition rather than a change`,
      );
  };

  for (const tree of ITEM_TREES) {
    if (tree.nodes.length !== CHAIN_LENGTH)
      problems.push(
        `${tree.id}: its chain has ${tree.nodes.length} cards, not ${CHAIN_LENGTH}`,
      );
    tree.nodes.forEach((node, index) => {
      place(tree.id, node, "chain");
      const parent = index === 0 ? null : tree.nodes[index - 1].id;
      if (node.tier !== index + 1)
        problems.push(
          `${tree.id}: ${node.id} is tier ${node.tier} at link ${index + 1}; a chain runs tiers 1-${CHAIN_LENGTH} in order`,
        );
      if (node.parent !== parent)
        problems.push(
          `${tree.id}: ${node.id} hangs from ${node.parent ?? "nothing"}, not the card before it (${parent ?? "nothing"})`,
        );
    });
    for (const support of tree.supports) place(tree.id, support, "support");
    for (const branch of tree.branches) {
      place(tree.id, branch, "branch");
      if (
        branch.parent &&
        !tree.nodes.some((node) => node.id === branch.parent)
      )
        problems.push(
          `${tree.id}: branch ${branch.id} hangs from ${branch.parent}, which is not on its chain`,
        );
    }
  }

  for (const id of Object.keys(OUTSIDE_TREES) as ShopItemId[]) {
    place("outside", { id }, "card");
    if (!liveIds.has(id)) problems.push(`outside: ${id} is not a live item`);
  }
  for (const id of liveIds)
    if (!placed.has(id))
      problems.push(`${id} is in no tree and not in OUTSIDE_TREES`);
  for (const id of plannedIds)
    if (!placed.has(id)) problems.push(`planned card ${id} is in no tree`);

  return problems;
}

/** Each tree's engine and boost (its chain's tiers 3 and 4), by card. A run
 *  committed to one tree has no use for another's: the simulation's committed
 *  shoppers read this to leave them on the shelf. */
export const ENGINE_CARD_TREE: ReadonlyMap<CardId, TreeId> = new Map(
  ITEM_TREES.flatMap((tree) =>
    tree.nodes
      .filter((node) => node.tier >= 3)
      .map((node): [CardId, TreeId] => [node.id, tree.id]),
  ),
);

/** Where a live gated card sits for a shop that honours the trees. */
export interface LiveTreeLink {
  /** The card whose purchase opens this one, or null when it opens with its tree. */
  parent: ShopItemId | null;
  /** The chain's root, whose meta unlock opens the whole chain. */
  root: CardId;
  /** False when nothing implemented can open it: a branch whose chain has no
   *  live card to hang from stays out of the shop until that chain exists. */
  reachable: boolean;
}

/**
 * Every live gated card's link — chain cards and branches — for the shop;
 * supports have none, being base-set cards. Planned cards are skipped over: a
 * live card whose parent is not implemented yet hangs from the nearest
 * implemented card above it. A chain card with none opens with its tree, so a
 * chain can be played before all of it exists; a branch with none cannot be
 * opened at all.
 */
export function liveTreeLinks(): Map<ShopItemId, LiveTreeLink> {
  const live = new Set<CardId>(ITEMS.map((item) => item.id));
  const links = new Map<ShopItemId, LiveTreeLink>();
  for (const tree of ITEM_TREES) {
    const inTree = new Map<CardId, TreeNode>(
      tree.nodes.map((node) => [node.id, node]),
    );
    const root = tree.nodes[0].id;
    const nearestLive = (from: CardId | null): ShopItemId | null => {
      let parent = from;
      while (parent !== null && !live.has(parent))
        parent = inTree.get(parent)?.parent ?? null;
      return parent as ShopItemId | null;
    };
    for (const node of tree.nodes) {
      if (!live.has(node.id)) continue;
      links.set(node.id as ShopItemId, {
        parent: nearestLive(node.parent),
        root,
        reachable: true,
      });
    }
    const factor = tree.nodes[1]?.id ?? null;
    for (const branch of tree.branches) {
      if (!live.has(branch.id)) continue;
      const parent = nearestLive(branch.parent ?? factor);
      links.set(branch.id as ShopItemId, {
        parent,
        root,
        reachable: parent !== null,
      });
    }
  }
  return links;
}
