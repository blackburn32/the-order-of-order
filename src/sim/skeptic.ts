// The skeptical shopper: a tree shopper that buys nothing on faith.
//
// Every tree shopper (sim/treeShoppers.ts, sim/lessons.ts, the committed swarm
// bot) takes its tree's gated cards on sight, because it already knows where the
// chain leads. A player does not. A player who has never seen The Scales has no
// reason to buy a card that grows a die, and a card that grows a die before The
// Scales costs points. A tree whose early cards only pay once a later card
// arrives is a tree the committed shoppers build and players never start.
//
// Under this switch a tree card is bought only if it proves itself: the card is
// bought on a throwaway copy of the run, the next trial is played out on it
// against the same dice as the run without it (sim/appraise.ts), and it must
// come out ahead — in points, or in gold without costing points. The engine and
// its boost are exempt: their text says what they grow, which is reason
// enough. Cards outside every tree are exempt too — the question is whether a
// tree's own cards sell themselves, not whether the shopper likes the Ledger.
//
// Nothing here changes what a shopper wants, only what it will pay for, so a
// skeptical run and a trusting one on the same seeds differ exactly by the
// cards bought on faith. `npm run engines:experiment` runs every tree both ways
// (the `skeptic-*` scenarios).

import type { RunState } from "../state/RunState";
import { ENGINE_CARD_TREE, ITEM_TREES } from "../systems/ItemTrees";
import type { ShopItemId } from "../systems/Items";
import type { ShopOffer } from "../systems/Shop";
import {
  appraiseOffer,
  measureCapacity,
  type CapacityOptions,
} from "./appraise";
import { trialRollTarget } from "./engine";

let skeptical = false;

/** Sim-only. Whether tree shoppers refuse tree cards that do not pay now. */
export function setSkepticalShoppersForSimulation(on: boolean): void {
  skeptical = on;
}

export function skepticalShoppers(): boolean {
  return skeptical;
}

/** Every card a tree claims, save its engine and boost. */
const TREE_CARDS: ReadonlySet<string> = new Set(
  ITEM_TREES.flatMap((tree) => [
    ...tree.nodes.map((node) => node.id),
    ...tree.supports.map((card) => card.id),
    ...tree.branches.map((card) => card.id),
  ]).filter((id) => !ENGINE_CARD_TREE.has(id)),
);

/** Roll-outs per appraisal; matched seeds keep three honest (sim/appraise.ts). */
const SAMPLES = 3;

/** The least a card must add to the next trial's score, in log10: about +5%.
 *  A die that scores once in a hundred rolls adds something, and nothing a
 *  player would notice or pay for. */
const MIN_LOG_GAIN = 0.02;

/** Gold kept even with: a card that pays gold passes if it costs no more than
 *  this in log10 points. */
const GOLD_POINT_TOLERANCE = 0.005;

/** Verdicts for the shop visit in hand, so a card judged on the shelf is not
 *  rolled out again when a later purchase re-walks it. Keyed by the run and
 *  cleared whenever the run's purchases move on. */
const verdicts = new WeakMap<
  RunState,
  { stamp: string; byCard: Map<ShopItemId, boolean> }
>();

function stampOf(state: RunState): string {
  const bought = Object.values(state.purchases).reduce(
    (sum, n) => sum + (n ?? 0),
    0,
  );
  return `${state.trial}:${bought}:${state.dice.length}`;
}

/** Whether the skeptic lets this shopper consider the card at all. */
export function skepticAllows(state: RunState, offer: ShopOffer): boolean {
  if (!skeptical || !TREE_CARDS.has(offer.id)) return true;
  const stamp = stampOf(state);
  let cache = verdicts.get(state);
  if (!cache || cache.stamp !== stamp) {
    cache = { stamp, byCard: new Map() };
    verdicts.set(state, cache);
  }
  const known = cache.byCard.get(offer.id);
  if (known !== undefined) return known;
  const verdict = paysNow(state, offer);
  cache.byCard.set(offer.id, verdict);
  return verdict;
}

function paysNow(state: RunState, offer: ShopOffer): boolean {
  const opts: CapacityOptions = {
    samples: SAMPLES,
    seed: state.trial * 104_729 + 17,
    horizon: Math.max(1, trialRollTarget(state) - state.roll),
  };
  const baseline = measureCapacity(state, opts);
  const appraisal = appraiseOffer(state, offer, baseline, opts);
  if (!appraisal) return false;
  if (appraisal.pointsGain >= MIN_LOG_GAIN) return true;
  return (
    appraisal.goldGain > 0 && appraisal.pointsGain >= -GOLD_POINT_TOLERANCE
  );
}
