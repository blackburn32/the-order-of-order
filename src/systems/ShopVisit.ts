// One visit to the shop, as rules alone: what is on the shelf and in the packs,
// what the visit has spent, and what each of the player's choices does to the
// run. No Phaser, no animation, no audio.
//
// ShopScene drives one of these from the player's taps and draws whatever it
// says happened; the audit replayer (sim/replay) drives one from a run's input
// log. Keeping the rules here rather than inline in the scene is what lets a
// replay buy the same cards at the same prices and get the same run — the same
// reason the trial loop lives in sim/engine rather than in GameScene.
//
// Every choice that changes the run is written to the run's input log here
// (see systems/InputLog), so a tap and a replayed entry go through one door.

import type { RarityWeights } from "../config";
import type { RunState } from "../state/RunState";
import {
  createFreshShopCheckpoint,
  type ShopCheckpointState,
} from "./ActiveRunPersistence";
import { spendGold } from "./Gold";
import { logInput } from "./InputLog";
import { addItemValue, recordRunItemPurchase } from "./ItemValue";
import { streamFor } from "./Rng";
import {
  applyBoosterChoice,
  applyCouponFreebie,
  applyOffer,
  boosterPrice,
  canAfford,
  discountsShopPrices,
  leaveShop,
  openBooster,
  refreshOffer,
  repriceOffers,
  rerollCost,
  rerollIsFree,
  rerollShopOffers,
  shopClosed,
  type BoosterOffer,
  type ShopOffer,
} from "./Shop";

export class ShopVisit {
  offers: ShopOffer[];
  packs: BoosterOffer[];
  /** The opened pack's cards, while it is open. */
  packChoices?: ShopOffer[];
  openingPack?: BoosterOffer;
  /** What the open pack cost, which its pick is recorded as having cost. */
  openingPackCost?: number;
  visitWeights: RarityWeights;
  /** Whether this is the boon shop a Boss Trial clear bought. */
  boonSpent: boolean;
  purchasesMade: number;
  rerollsThisVisit: number;
  packsOpenedThisVisit: number;
  couponFreebieClaimedThisVisit: boolean;
  /** The card waiting on the die picker, and the dice picked for it so far. */
  pickerOffer?: ShopOffer;
  pickedIndices: number[];

  constructor(
    readonly state: RunState,
    checkpoint: ShopCheckpointState,
  ) {
    this.purchasesMade = checkpoint.purchasesMade;
    this.rerollsThisVisit = checkpoint.rerollsThisVisit;
    this.packsOpenedThisVisit = checkpoint.packsOpenedThisVisit ?? 0;
    this.couponFreebieClaimedThisVisit =
      checkpoint.couponFreebieClaimedThisVisit;
    this.visitWeights = { ...checkpoint.visitWeights };
    this.boonSpent = checkpoint.boonSpent;
    this.offers = checkpoint.offers.map((offer) => refreshOffer(offer, state));
    this.packs = checkpoint.packs.map((pack) => ({ ...pack }));
    this.packChoices = checkpoint.packChoices?.map((offer) =>
      refreshOffer(offer, state),
    );
    this.openingPack = checkpoint.openingPackId
      ? this.packs.find((pack) => pack.id === checkpoint.openingPackId)
      : undefined;
    this.openingPackCost = checkpoint.openingPackCost;
    if (this.openingPack && this.openingPackCost === undefined)
      this.openingPackCost = boosterPrice(state, this.openingPack);
    const pickerWasFromPack =
      !!checkpoint.pickerOffer &&
      !!checkpoint.packChoices?.some(
        (offer) => offer.id === checkpoint.pickerOffer?.id,
      );
    this.pickerOffer = checkpoint.pickerOffer
      ? (pickerWasFromPack ? this.packChoices : this.offers)?.find(
          (offer) => offer.id === checkpoint.pickerOffer?.id,
        )
      : undefined;
    this.pickedIndices = [...checkpoint.pickedIndices];
  }

  /** Open a fresh visit: deal the shelf and the packs for the trial just
   *  cleared. */
  static open(state: RunState): ShopVisit {
    return new ShopVisit(state, createFreshShopCheckpoint(state));
  }

  /** The visit as the active-run save keeps it. */
  checkpoint(): ShopCheckpointState {
    return {
      offers: this.offers,
      packs: this.packs,
      packChoices: this.packChoices,
      openingPackId: this.openingPack?.id,
      openingPackCost: this.openingPackCost,
      visitWeights: this.visitWeights,
      boonSpent: this.boonSpent,
      purchasesMade: this.purchasesMade,
      rerollsThisVisit: this.rerollsThisVisit,
      packsOpenedThisVisit: this.packsOpenedThisVisit,
      couponFreebieClaimedThisVisit: this.couponFreebieClaimedThisVisit,
      pickerOffer: this.pickerOffer,
      pickedIndices: this.pickedIndices,
    };
  }

  /** Whether an affliction has closed the counter for the rest of the visit. */
  get closed(): boolean {
    return shopClosed(this.state, this.purchasesMade);
  }

  /** Whether this card can be taken right now: the gold is there AND the visit
   *  still has a purchase left in it. */
  canBuy(offer: ShopOffer): boolean {
    return !this.closed && canAfford(this.state, offer);
  }

  /** What rerolling the shelf costs now, and whether the Dealer's Bell pays. */
  rerollPrice(): { price: number; free: boolean } {
    const free = rerollIsFree(this.state, this.rerollsThisVisit);
    return { price: free ? 0 : rerollCost(this.rerollsThisVisit), free };
  }

  /** Reroll the shelf. False, and nothing changes, when the purse is short. */
  reroll(): boolean {
    const { price, free } = this.rerollPrice();
    if (this.state.gold < price) return false;
    logInput(this.state, "reroll");
    spendGold(this.state, price);
    if (free)
      addItemValue(
        this.state,
        "dealers_bell",
        rerollCost(this.rerollsThisVisit),
      );
    this.rerollsThisVisit += 1;
    this.offers = rerollShopOffers(
      this.state,
      this.state.ownedLedger ? 5 : 3,
      // Keyed by the reroll this is, so the shelf a player paid for is the shelf
      // they get back after a reload — and so paying for a third reroll can
      // never quietly re-deal the second.
      streamFor(
        this.state.seed,
        "shop",
        `${this.state.trial}:${this.rerollsThisVisit}`,
      ),
      this.visitWeights,
      !this.couponFreebieClaimedThisVisit,
    );
    if (this.state.ownedLedger) addItemValue(this.state, "ledger", 2);
    this.pickerOffer = undefined;
    this.pickedIndices = [];
    return true;
  }

  /** Buy and open a pack. Returns its cards, or null — and nothing changes —
   *  when it cannot be opened: sold, the counter closed, the purse short, or a
   *  pack with nothing left to deal. */
  openPack(pack: BoosterOffer): ShopOffer[] | null {
    if (pack.sold || this.openingPack || this.closed) return null;
    const price = boosterPrice(this.state, pack);
    if (this.state.gold < price) return null;
    const choices = openBooster(
      this.state,
      pack,
      this.state.ownedLedger ? 5 : 3,
      // Keyed by which pack of the visit this is, and by the pack itself, so two
      // different packs opened in the same visit cannot deal the same cards.
      streamFor(
        this.state.seed,
        "booster",
        `${this.state.trial}:${this.packsOpenedThisVisit}:${pack.id}`,
      ),
      this.visitWeights,
    );
    if (choices.length === 0) return null;
    logInput(this.state, "pack", this.packs.indexOf(pack), pack.id);
    spendGold(this.state, price);
    pack.sold = true;
    // Counted only once the pack is actually bought: a pack that turned up empty
    // returned above without drawing, and must not shift the next pack's stream.
    this.packsOpenedThisVisit += 1;
    this.openingPack = pack;
    this.openingPackCost = price;
    this.packChoices = choices;
    if (this.state.ownedLedger) addItemValue(this.state, "ledger", 2);
    return choices;
  }

  /** Close an opened pack without taking a card. The pack stays paid for, and
   *  counts as the visit's purchase just as a pick would. */
  skipPack(): boolean {
    if (!this.packChoices || !this.openingPack || this.pickerOffer)
      return false;
    logInput(this.state, "skip");
    this.openingPack.declined = true;
    this.purchasesMade += 1;
    this.closePack();
    return true;
  }

  /** Hold a card that needs a die chosen for it while the player picks. */
  beginPick(offer: ShopOffer): void {
    this.pickedIndices = [];
    this.pickerOffer = offer;
  }

  /** Put the held card back. */
  cancelPick(): void {
    this.pickerOffer = undefined;
    this.pickedIndices = [];
  }

  /**
   * Take a card, off the shelf or out of the open pack, with the die (or dice)
   * it targets. False, and nothing changes, when it cannot be taken: the
   * counter is closed, the purse is short, or the card's effect could not be
   * carried out on those targets.
   */
  buy(
    offer: ShopOffer,
    targetIndex?: number,
    targetIndices?: number[],
  ): boolean {
    const fromPack = !!this.packChoices?.includes(offer);
    if (!fromPack && !this.offers.includes(offer)) return false;
    if (!this.canBuy(offer)) return false;
    const state = this.state;
    const paid = fromPack ? (this.openingPackCost ?? 0) : offer.cost;
    const listPrice = fromPack
      ? (this.openingPack?.cost ?? paid)
      : (offer.listPrice ?? offer.cost);
    // Where the card stood, read before applying it can change anything: the
    // shelf and the pack hand are both restored in this order on a reload.
    const index = fromPack
      ? this.packChoices!.indexOf(offer)
      : this.offers.indexOf(offer);
    // Discount cards bought by this transaction cannot rebate themselves.
    const hadCart = state.hasShoppingCart;
    const hadPawnbroker = state.hasPawnbroker;
    const hadCoupon = state.hasCouponBook && !!offer.freeByCoupon;
    const applied = fromPack
      ? applyBoosterChoice(state, offer, targetIndex, targetIndices)
      : applyOffer(state, offer, targetIndex, targetIndices);
    if (!applied) return false;
    logInput(
      state,
      "buy",
      fromPack ? "pack" : "shelf",
      index,
      offer.id,
      targetIndex ?? null,
      targetIndices ? [...targetIndices] : null,
    );
    recordRunItemPurchase(state, offer.id, paid);
    this.recordSavings(listPrice, hadCart, hadPawnbroker, hadCoupon, fromPack);

    // These cards were priced when the visit opened. A discount card takes
    // effect on the current row immediately, including when it was claimed
    // from a pack.
    if (discountsShopPrices(offer.id)) repriceOffers(state, this.offers);

    this.purchasesMade += 1;
    if (fromPack) {
      this.closePack();
    } else {
      if (offer.freeByCoupon) this.couponFreebieClaimedThisVisit = true;
      this.offers = this.offers.filter((candidate) => candidate !== offer);
    }
    this.pickerOffer = undefined;
    this.pickedIndices = [];
    // Coupon Book affects the rest of the visit in which it is bought: one of
    // the remaining cards becomes free.
    if (offer.id === "coupon_book")
      applyCouponFreebie(state, this.offers, this.couponRng());
    return true;
  }

  /** Leave the shop. Abstinence pays for a visit that took nothing. */
  leave(): void {
    logInput(this.state, "leave");
    leaveShop(this.state, this.purchasesMade > 0);
  }

  private closePack(): void {
    this.packChoices = undefined;
    this.openingPack = undefined;
    this.openingPackCost = undefined;
    this.pickerOffer = undefined;
    this.pickedIndices = [];
  }

  /** The stream a Coupon Book bought mid-visit draws its freebie from. Keyed
   *  by the shelf it lands on (the visit's reroll count) and by how many cards
   *  the visit has taken, which together name the moment it was bought — so a
   *  replay frees the same card the player saw freed. */
  private couponRng(): () => number {
    return streamFor(
      this.state.seed,
      "shop",
      `${this.state.trial}:${this.rerollsThisVisit}:coupon:${this.purchasesMade}`,
    );
  }

  private recordSavings(
    listPrice: number,
    cart: boolean,
    pawnbroker: boolean,
    coupon: boolean,
    fromPack: boolean,
  ): void {
    if (listPrice <= 0) return;
    const state = this.state;
    const undiscounted = Math.ceil(listPrice);
    const afterCart = cart ? Math.ceil(listPrice * 0.75) : undiscounted;
    if (cart) addItemValue(state, "shopping_cart", undiscounted - afterCart);
    if (pawnbroker)
      addItemValue(
        state,
        "pawnbroker",
        Math.max(0, afterCart - Math.max(1, afterCart - 2)),
      );
    // Coupon Book marks loose cards only. A pack pick is free because its pack
    // was paid for, not because Coupon Book waived the chosen card.
    if (coupon && !fromPack)
      addItemValue(
        state,
        "coupon_book",
        Math.max(1, afterCart - (pawnbroker ? 2 : 0)),
      );
  }
}
