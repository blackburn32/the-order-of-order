// The expert shopper: the strategy that actually plays the game well.
//
// Every other bot in the field decides what to buy from a card's PRICE (greedy,
// thrifty) or its THEME (the five archetypes), and none of them decides where to
// point a card that needs a die — `chooseTargets` picks at random. A human
// playing well does neither: they ask what a card is worth to the build in front
// of them, they put Twin on their biggest die, and they leave gold on the table
// when the table is not worth it.
//
// This bot asks that question literally, through `appraise.ts`: it buys each
// candidate on a copy of the run, plays the next trial's whole roll budget out,
// and keeps the card that moved the score most per gold. Nothing here encodes an
// opinion about which items are good — that is the point. An item rebalanced in
// `Items.ts` changes this bot's behaviour on the next run with no edit here, and
// a synergy nobody wrote down is found because it shows up in the score.
//
// It exists to set goal targets. A curve designed against a field that cannot
// target its own dice is a curve a competent player one-rolls, which is exactly
// the complaint this module was written to answer.

import { PRICE_BANDS } from "../systems/Shop";
import {
  applyBoosterChoice,
  applyOffer,
  boosterPrice,
  canAfford,
  discountsShopPrices,
  openBooster,
  purchasesRemaining,
  repriceOffers,
  shopClosed,
  type BoosterOffer,
  type ShopOffer,
} from "../systems/Shop";
import type { RarityWeights } from "../config";
import type { ShopItemId } from "../systems/Items";
import type { RunState } from "../state/RunState";
import { trialRollTarget } from "./engine";
import {
  appraiseOffer,
  efficiency,
  goldExchangeRate,
  measureCapacity,
  resolveGroupIndex,
  type Appraisal,
  type Capacity,
  type CapacityOptions,
} from "./appraise";
import { cloneRunState } from "./cloneRun";
import { acceptsCurse } from "./curseValue";

export interface ExpertOptions {
  /** Roll-outs per hypothesis. See `CapacityOptions.samples`. */
  samples: number;
  /** Seed for this visit's roll-outs. Every hypothesis in the visit shares it,
   *  which is what makes three samples enough to rank a table. */
  seed: number;
  /**
   * How many trials' worth of rolls a card is judged over. Defaults to
   * `LOOKAHEAD_TRIALS`.
   *
   * One trial is the wrong window and measurably so: the grid never resets
   * between trials, so a mold that adds a die a roll, or a Genesis that breeds
   * off every scoring die, is worth far more over the ladder than over the
   * seven rolls in front of it. Judged on one trial this bot buys the
   * immediate card every time and arrives at rank 5 with a tenth of the grid a
   * spend-everything shopper has.
   */
  horizonScale?: number;
  /** Overrides for the three spending knobs below, so a tuning pass can sweep
   *  them without editing this file. Each defaults to the constant it names. */
  relativeFloor?: number;
  passes?: number;
  /** Multiplier on the self-calibrated exchange rate a gold is valued at (see
   *  `appraise.goldExchangeRate`). One leaves the measured rate alone; above one
   *  says a gold is worth more than this table's best card makes it look, which
   *  is the case a roll-out cannot see — income items are paid once inside the
   *  horizon and every trial after it. */
  goldWeight?: number;
  /** Let each hypothesis be rolled out across trial boundaries. Defaults to
   *  `CROSS_TRIAL_ROLLOUTS`. */
  crossTrials?: boolean;
  /** Cards weighed together as one purchase. Defaults to `BUNDLE_SIZE`; one
   *  turns bundling off. */
  bundleSize?: number;
  /** What a hypothesis is scored by — see `CapacityOptions.objective`.
   *  Defaults to `LADDER_OBJECTIVE`. */
  objective?: "score" | "ladder";
}

/**
 * Trials each hypothesis is played over.
 *
 * Two, for want of evidence for anything else. A four-trial window looked worth
 * about two trials of reach on a 48-run sweep and was shipped on it; over 192
 * PAIRED runs — the same seeds under both settings, differenced run by run — the
 * gap is +0.74 with a 95% interval of [-0.23, +1.79]. That straddles zero, and
 * four costs 60% more time per run (2.08s against 1.29s), so it is not a default
 * this file can justify. It is not disproven either: every point estimate has
 * been positive. Raise it with `SimConfig.expertHorizonScale` for a curve-design
 * pass, where an hour of clock is cheaper than a bot that stops short.
 *
 * The reason a 48-run mean could not tell: reach swings whole ranks on the seed.
 * Handing the appraiser strictly MORE samples — more information, same objective
 * — once read three trials worse on such a sweep, which is the measurement
 * calling itself a liar. `expertTune.ts` reports paired intervals now.
 */
export const LOOKAHEAD_TRIALS = 2;

/**
 * Whether a hypothesis is rolled out across trial boundaries: the goal is met,
 * the trial is resolved the way the game resolves it, and the rest of the
 * horizon is played in the trial after it.
 *
 * On, because income is paid WHEN A TRIAL ENDS. Interest, a Boss Trial's bonus,
 * Counting House, Deep Pockets and Reserve all arrive at a clear, so a roll-out
 * that never reaches one prices the whole economy at zero however long it runs —
 * and a bot that cannot see income does not buy it, which is a fair description
 * of what this one used to do. It also gives `LOOKAHEAD_TRIALS` something to
 * mean: two trials of rolls is now two trials rather than one trial played twice
 * as long.
 *
 * Measured over 192 paired runs: reach 15.0 → 16.2 (+1.16, 95% interval
 * [-0.10, +2.34]) and wins 9 → 28 of 192, which is a fifteenth of the runs
 * against a seventh of them and the readout that carries this decision. The
 * capacity it arrives at a trial with is up at every fixture, its reach at trial
 * 28 goes 7% → 26%, and it is CHEAPER than not crossing (2.14s a run against
 * 2.58s), because a roll-out that ends a trial when the goal is met stops
 * playing one enormous trial forever. Several independent readouts, one
 * direction — which is what the horizon knob could never manage.
 */
export const CROSS_TRIAL_ROLLOUTS = true;

/**
 * What a hypothesis is scored by: how far up the ladder it gets, or how much it
 * multiplies.
 *
 * The ladder, because the other one goes dead exactly where runs are decided. A
 * build that compounds one-rolls its goals, so the score it posts is one roll of
 * its grid — and against a 1e14 score a card that adds a die or a mold or a flat
 * bonus moves log10 by nothing measurable. A trace of the mid ladder showed
 * every hypothesis on the shelf measuring 0.0000, singles and pairs alike, from
 * about trial 15 on: the appraiser had no gradient left and those shops were
 * coin flips. Depth up the goal ladder keeps its gradient exactly there, because
 * the ladder is what eventually outruns a build — which is what ends runs.
 */
export const LADDER_OBJECTIVE: "score" | "ladder" = "score";

/**
 * The least a card may be worth and still be bought: log10 points per gold.
 *
 * Deliberately low. It is not a taste — it is the opportunity cost of the gold,
 * and gold left in the bank earns a fifth of itself per trial in interest, which
 * is very little compared to almost any card that does anything at all. A floor
 * set where it "feels right" starves the bot instead: at 0.004 it stopped buying
 * through the mid ladder and arrived at rank 4 with nine cards.
 */
const MIN_EFFICIENCY = 0.0008;

/**
 * How far below the best card on the table a card may be and still be worth the
 * gold. This is the real spending discipline, and it is relative because the
 * question a player actually asks is "is this the best use of my gold *here*",
 * not "is this good in the abstract". At 0.25 the bot takes anything within a
 * factor of four of the visit's best card and leaves the rest of its gold for a
 * shop that offers better.
 */
export const RELATIVE_FLOOR = 0.25;

/**
 * Appraisal passes per visit.
 *
 * Every purchase changes what the next card is worth (that is what a synergy
 * is), so the ideal shopper re-appraises after each one. The ideal shopper is
 * also quadratic in shelf size, and this bot has to run thousands of times. Two
 * passes buys almost all of it: the first pass picks the card the visit is
 * really about, the second re-ranks what is left against the build that card
 * just created, and the tail of a five-card shelf is rarely where a run is won.
 */
export const MAX_APPRAISAL_PASSES = 2;

/**
 * How many cards may be weighed together as one purchase. One is a card at a
 * time; two also measures the top few cards in pairs, as a single hypothesis
 * bought together, and takes the pair when it beats every single card per gold.
 *
 * **One, measured — the pairs did not pay.** The idea was the combination lock,
 * which is the shape a real build is usually made of: a Genesis breeds off dice
 * that SCORE, so on a grid that rarely scores it measures at nothing, and the
 * scoring numbers that would make it enormous measure at nothing without it.
 * Each is correctly priced at zero alone and the pair is worth the run.
 *
 * Over 48 matched runs on three seed streams, pairs against singles: reach
 * 15.6/17.3/12.8 against 15.8/18.6/12.8, wins 23 of 144 against 21 — a wash on
 * wins, never ahead on reach, and 25-35% slower. Kept, off, because the reason
 * it failed is worth being able to re-test: a trace of what it found showed the
 * pairs firing about five times a run and almost all of them before trial 10,
 * because from the mid ladder on EVERY hypothesis measures zero. Once a build
 * compounds, one more die or one more flat bonus does not change the growth
 * rate, so it does not move log10 of a 1e14 score at all — and a pair of cards
 * that each measure nothing measures nothing. The lock was not what was holding
 * the late game shut; the dead gradient is.
 */
export const BUNDLE_SIZE = 1;

/** How many of the ranked singles are eligible to appear in a bundle. The
 *  ranking is by measured worth, so the card that makes a pair worth having is
 *  nearly always near the top of it — and the subset count is what this bounds. */
const BUNDLE_CANDIDATES = 4;

export interface ExpertPurchase {
  id: ShopItemId;
  cursed: boolean;
}

export interface ExpertVisitResult {
  purchasesMade: number;
  taken: ExpertPurchase[];
  /** Cards a booster revealed, so the caller can tally curse exposure. */
  revealed: ShopOffer[];
}

/**
 * Rank a shelf, most worth-per-gold first.
 *
 * Returns the ranking and the exchange rate it was ranked under, because the
 * caller needs the rate to decide whether the BEST card is worth buying at all —
 * a ranking alone cannot answer that.
 */
function rankShelf(
  state: RunState,
  offers: readonly ShopOffer[],
  opts: ExpertOptions,
  passSeed: number,
): {
  ranked: Appraisal[];
  goldRate: number;
  baseline: Capacity;
  capacityOpts: CapacityOptions;
} {
  const capacityOpts: CapacityOptions = {
    samples: opts.samples,
    seed: passSeed,
    horizon: Math.ceil(
      (trialRollTarget(state) - state.roll) *
        (opts.horizonScale ?? LOOKAHEAD_TRIALS),
    ),
    crossTrials: opts.crossTrials ?? CROSS_TRIAL_ROLLOUTS,
    objective: opts.objective ?? LADDER_OBJECTIVE,
  };
  const baseline = measureCapacity(state, capacityOpts);
  const appraisals: Appraisal[] = [];
  for (const offer of offers) {
    const appraisal = appraiseOffer(state, offer, baseline, capacityOpts);
    if (appraisal) appraisals.push(appraisal);
  }
  const goldRate = goldExchangeRate(appraisals) * (opts.goldWeight ?? 1);
  const ranked = [...appraisals].sort(
    (a, b) => efficiency(b, goldRate) - efficiency(a, goldRate),
  );
  return { ranked, goldRate, baseline, capacityOpts };
}

/** A set of cards weighed as one purchase, with what the set is worth. */
interface Bundle {
  members: Appraisal[];
  cost: number;
  /** Worth per gold of the whole set, on the same scale `efficiency` returns. */
  worth: number;
}

/**
 * Weigh several cards as ONE hypothesis: buy them all on a copy of the run, in
 * the order given, and measure what the build does afterwards.
 *
 * Each card is pointed at the die its own appraisal chose. That key is resolved
 * against the hypothesis as it stands when the card is applied, so a card bought
 * after a Shrink lands on the grid the Shrink left behind — and a bundle whose
 * later card can no longer find its die is dropped rather than guessed at, since
 * a guess here would be exactly the un-measured opinion this module exists
 * without.
 */
function appraiseBundle(
  state: RunState,
  members: readonly Appraisal[],
  baseline: Capacity,
  goldRate: number,
  opts: CapacityOptions,
): Bundle | null {
  const hypothetical = cloneRunState(state);
  let cost = 0;
  for (const member of members) {
    const index =
      member.targetKey === null
        ? undefined
        : (resolveGroupIndex(hypothetical.dice, member.targetKey) ?? undefined);
    if (member.targetKey !== null && index === undefined) return null;
    if (!applyOffer(hypothetical, { ...member.offer, cost: 0 }, index))
      return null;
    cost += member.offer.cost;
  }

  const after = measureCapacity(hypothetical, opts);
  const value =
    after.logPoints -
    baseline.logPoints +
    goldRate * (after.gold - baseline.gold);
  return {
    members: [...members],
    cost,
    worth: cost <= 0 ? (value > 0 ? Infinity : value) : value / cost,
  };
}

/**
 * The best set of cards this visit could buy together, or null when no set beats
 * its own members.
 *
 * Only the top `BUNDLE_CANDIDATES` singles are combined, and only sets the purse
 * and the visit's remaining purchases can actually take — the cost of this is
 * the number of subsets, and a shelf's tail is not where a run is won.
 */
function bestBundle(
  state: RunState,
  ranked: readonly Appraisal[],
  baseline: Capacity,
  goldRate: number,
  opts: CapacityOptions,
  size: number,
  purchasesLeft: number,
): Bundle | null {
  const width = Math.min(size, purchasesLeft);
  if (width < 2) return null;
  const pool = ranked.slice(0, BUNDLE_CANDIDATES);
  if (pool.length < 2) return null;

  let best: Bundle | null = null;
  const walk = (start: number, chosen: Appraisal[], spent: number) => {
    if (chosen.length >= 2) {
      const bundle = appraiseBundle(state, chosen, baseline, goldRate, opts);
      if (bundle && (!best || bundle.worth > best.worth)) best = bundle;
    }
    if (chosen.length === width) return;
    for (let i = start; i < pool.length; i++) {
      const next = pool[i];
      // Prices move as a discount card is bought, so this is the shelf's price
      // before the bundle rather than after it. It only ever over-states the
      // cost, and every purchase is re-checked against the purse as it is made.
      if (spent + next.offer.cost > state.gold) continue;
      chosen.push(next);
      walk(i + 1, chosen, spent + next.offer.cost);
      chosen.pop();
    }
  };
  walk(0, [], 0);
  return best;
}

/** Cards this bot will consider: affordable, not already taken, and not a curse
 *  its appetite refuses. */
function shortlist(
  state: RunState,
  offers: readonly ShopOffer[],
  bought: ReadonlySet<ShopOffer>,
  curseAppetite: number,
): ShopOffer[] {
  return offers.filter(
    (offer) =>
      !bought.has(offer) &&
      canAfford(state, offer) &&
      acceptsCurse(state, offer, curseAppetite),
  );
}

/**
 * Buy from the open shelf.
 *
 * A card is taken when its worth per gold clears the floor AND the run can still
 * afford to keep its bank up — unless the table is strong, in which case the
 * bank is what the table is for.
 */
function buyFromShelf(
  state: RunState,
  offers: ShopOffer[],
  opts: ExpertOptions,
  curseAppetite: number,
  purchasesMade: number,
  taken: ExpertPurchase[],
): number {
  const bought = new Set<ShopOffer>();

  const passes = Math.max(1, opts.passes ?? MAX_APPRAISAL_PASSES);
  for (let pass = 0; pass < passes; pass++) {
    if (shopClosed(state, purchasesMade)) break;
    const candidates = shortlist(state, offers, bought, curseAppetite);
    if (candidates.length === 0) break;

    const { ranked, goldRate, baseline, capacityOpts } = rankShelf(
      state,
      candidates,
      opts,
      opts.seed + pass * 104_729,
    );

    // The last pass spends down the whole ranking; earlier passes take one card
    // and re-appraise, so the next choice is made against the build the last one
    // produced rather than against the build the visit opened with.
    const lastPass = pass === passes - 1;
    // The floor is set by the best card the visit could BUY, which is not
    // necessarily the best card on the shelf: a free card converts no gold at
    // all, so it measures as infinitely efficient. Taking the shelf's best
    // outright would then set an infinite floor on a table with a curse on it —
    // every curse is free — and the visit would end the moment the free cards
    // ran out, with the run's whole purse still in the bank.
    const bestPaid = ranked.reduce(
      (best, appraisal) =>
        appraisal.offer.cost > 0
          ? Math.max(best, efficiency(appraisal, goldRate))
          : best,
      0,
    );
    const floor = Math.max(
      MIN_EFFICIENCY,
      (opts.relativeFloor ?? RELATIVE_FLOOR) * bestPaid,
    );

    // A bundle is taken whole when the set beats every card in it per gold —
    // the combination lock, which no ranking of single cards can see. The
    // members are bought below by the ordinary loop, which re-checks the purse
    // and re-resolves each target against the live grid; what the bundle did was
    // put them at the front of the queue and lift the floor off them.
    const bundle = bestBundle(
      state,
      ranked,
      baseline,
      goldRate,
      capacityOpts,
      opts.bundleSize ?? BUNDLE_SIZE,
      purchasesRemaining(state, purchasesMade),
    );
    const taking =
      bundle && bundle.worth > Math.max(bestPaid, MIN_EFFICIENCY)
        ? new Set(bundle.members.map((member) => member.offer))
        : new Set<ShopOffer>();
    const queue =
      taking.size > 0
        ? [
            ...ranked.filter((appraisal) => taking.has(appraisal.offer)),
            ...ranked.filter((appraisal) => !taking.has(appraisal.offer)),
          ]
        : ranked;

    for (const appraisal of queue) {
      if (shopClosed(state, purchasesMade)) break;
      const { offer } = appraisal;
      // Struck off the set as it is reached, however it goes: a member the
      // purse or the grid has since ruled out is no longer pending either.
      const inBundle = taking.delete(offer);
      if (bought.has(offer) || !canAfford(state, offer)) continue;
      const worth = efficiency(appraisal, goldRate);
      // A free card is judged on its own: it is worth taking whenever it
      // measures as an improvement, and there is no gold for a floor to
      // ration. A paid card is judged against the floor, and because the
      // ranking descends the first one under it ends the visit — everything
      // behind it is worth less.
      if (inBundle) {
        // Measured as part of a set that beat the shelf. Its own worth is
        // beside the point — that is what a combination lock means.
      } else if (offer.cost <= 0) {
        if (worth <= 0) continue;
      } else if (worth < floor) break;

      const index =
        appraisal.targetKey === null
          ? undefined
          : (resolveGroupIndex(state.dice, appraisal.targetKey) ?? undefined);
      if (appraisal.targetKey !== null && index === undefined) continue;
      if (!applyOffer(state, offer, index)) continue;

      bought.add(offer);
      purchasesMade += 1;
      taken.push({ id: offer.id, cursed: offer.cursed });
      if (discountsShopPrices(offer.id)) repriceOffers(state, offers);
      // An early pass takes one card and re-appraises — unless it is partway
      // through a bundle, which is one purchase made of several cards and is
      // worth nothing taken half.
      if (!lastPass && taking.size === 0) break;
    }
  }
  return purchasesMade;
}

/**
 * Buy at most one booster pack, taking the reveal that measures best.
 *
 * The reveals are appraised the same way the shelf is, against a baseline taken
 * after the shelf has been shopped — a pack is opened last, so what it is worth
 * depends on what the visit already bought.
 *
 * The pack is opened before it is paid for, which is not what a player can do.
 * That is deliberate parity: `bot.ts` has always opened first and charged only
 * on a take, and giving this bot a different rule would make its results
 * incomparable with the field it exists to be measured against.
 */
function buyBooster(
  state: RunState,
  packs: readonly BoosterOffer[],
  visitWeights: RarityWeights,
  rng: () => number,
  opts: ExpertOptions,
  curseAppetite: number,
  purchasesMade: number,
  taken: ExpertPurchase[],
  revealed: ShopOffer[],
): number {
  const affordable = [...packs]
    .filter((pack) => boosterPrice(state, pack) <= state.gold)
    .sort((a, b) => boosterPrice(state, a) - boosterPrice(state, b));

  for (const pack of affordable) {
    if (shopClosed(state, purchasesMade)) break;
    const price = boosterPrice(state, pack);
    const choices = openBooster(
      state,
      pack,
      state.ownedLedger ? 5 : 3,
      rng,
      visitWeights,
    );
    revealed.push(...choices);
    const acceptable = choices.filter((offer) =>
      acceptsCurse(state, offer, curseAppetite),
    );
    if (acceptable.length === 0) continue;

    // Reveals cost nothing individually — the pack was the price — so they are
    // ranked on worth alone, and the pack's own price decides whether the best
    // of them is worth opening at all.
    const { ranked, goldRate } = rankShelf(
      state,
      acceptable,
      opts,
      opts.seed + 224_737,
    );
    const best = ranked[0];
    if (!best) continue;
    const packValue = efficiency(
      { ...best, offer: { ...best.offer, cost: price } },
      goldRate,
    );
    if (packValue < MIN_EFFICIENCY) continue;

    const index =
      best.targetKey === null
        ? undefined
        : (resolveGroupIndex(state.dice, best.targetKey) ?? undefined);
    if (best.targetKey !== null && index === undefined) continue;

    state.gold -= price;
    if (applyBoosterChoice(state, best.offer, index)) {
      purchasesMade += 1;
      taken.push({ id: best.offer.id, cursed: best.offer.cursed });
      break;
    }
  }
  return purchasesMade;
}

/** Shop the whole visit: the shelf first, then at most one pack. */
export function expertShopVisit(
  state: RunState,
  offers: ShopOffer[],
  packs: readonly BoosterOffer[],
  visitWeights: RarityWeights,
  rng: () => number,
  curseAppetite: number,
  opts: ExpertOptions,
): ExpertVisitResult {
  const taken: ExpertPurchase[] = [];
  const revealed: ShopOffer[] = [];
  let purchasesMade = buyFromShelf(
    state,
    offers,
    opts,
    curseAppetite,
    0,
    taken,
  );
  purchasesMade = buyBooster(
    state,
    packs,
    visitWeights,
    rng,
    opts,
    curseAppetite,
    purchasesMade,
    taken,
    revealed,
  );
  return { purchasesMade, taken, revealed };
}

/**
 * Whether to reroll this shelf.
 *
 * The one decision in this module that is a heuristic rather than a measurement,
 * and unavoidably so: a reroll's value lives entirely in the table you have not
 * seen, which no amount of rolling the table you HAVE seen can tell you. So it
 * rerolls on the two occasions a player does — the reroll is free, or the purse
 * can reach a build card and the shelf is selling nothing but chaff.
 */
export function expertWantsReroll(
  state: RunState,
  offers: readonly ShopOffer[],
  free: boolean,
  price: number,
  curseAppetite: number,
): boolean {
  if (free) return true;
  if (state.gold <= price) return false;

  const live = offers.filter(
    (offer) =>
      canAfford(state, offer) && acceptsCurse(state, offer, curseAppetite),
  );
  if (live.length === 0) return true;

  const bestBand = Math.max(
    ...live.map((offer) => PRICE_BANDS[offer.priceBand]),
  );
  return bestBand <= PRICE_BANDS.low && state.gold - price >= PRICE_BANDS.build;
}
