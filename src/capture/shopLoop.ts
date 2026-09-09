import Phaser from "phaser";
import type { RarityWeights } from "../config";
import { getRun, type RunState } from "../state/RunState";
import type { BoosterOffer, ShopOffer } from "../systems/Shop";
import { cameraOrigin } from "../ui/camera";
import type { CaptureCursorScene } from "./CaptureCursor";
import { installShopFixture } from "./presets";

/** The ShopScene members the reel drives.
 *
 *  The studio reaches past `private` rather than widening the scene's own API:
 *  every beat below presses the object a player would press, so the scene keeps
 *  sole ownership of the shop's motion and the reel stays a script rather than a
 *  second implementation of the shop. */
interface ShopSceneInternals extends Phaser.Scene {
  state: RunState;
  offers: ShopOffer[];
  packs: BoosterOffer[];
  packChoices?: ShopOffer[];
  openingPack?: BoosterOffer;
  openingPackCost?: number;
  packFan?: unknown;
  packBand?: Phaser.Geom.Rectangle;
  offerCards: Map<ShopOffer, Phaser.GameObjects.Container>;
  carouselCards: { offer: ShopOffer; card: Phaser.GameObjects.Container }[];
  carouselCamera?: Phaser.Cameras.Scene2D.Camera;
  visitWeights: RarityWeights;
  boonSpent: boolean;
  couponFreebieClaimedThisVisit: boolean;
  purchasesMade: number;
  rerollsThisVisit: number;
  packsOpenedThisVisit: number;
  purchaseAnimating: boolean;
  pickerOffer?: ShopOffer;
  pickedIndices: number[];
  choose(offer: ShopOffer): void;
  onPick(offer: ShopOffer, index: number): void;
  rebuildShop(): void;
  saveCheckpoint(): void;
}

/** Where a beat's press lands, and what hovering and pressing there do. */
interface ShopTarget {
  x: number;
  y: number;
  /** Light the control the way arriving over it would. Every press rebuilds the
   *  shop, which takes the hovered object with it, so nothing has to be put
   *  back afterwards. */
  hover(): void;
  press(): void;
}

interface ShopBeat {
  /** Shown in the studio's status line and in the recorder's log. */
  label: string;
  /** How long the pointer takes to reach this beat's target. Set per beat
   *  rather than derived from the distance so the clip's total length stays a
   *  fixed, published number — see `SHOP_LOOP_DURATION_MS`. */
  travelMs: number;
  /** How long to hold after the press — long enough for the motion it starts to
   *  finish, plus time to read what it left on the table. */
  holdMs: number;
  aim(shop: ShopSceneInternals, game: Phaser.Game): ShopTarget;
}

/** The pointer settles before it clicks — long enough for the control it has
 *  arrived over to light up. Arriving and pressing on the same frame reads as a
 *  teleport rather than a hand. */
const SETTLE_MS = 200;

/** One shop visit, performed as five phases that return the shelf — and the
 *  pointer — to where they found them, so the clip can loop. */
const SHOP_LOOP: readonly ShopBeat[] = [
  { label: "buy the first card", travelMs: 560, holdMs: 620, aim: aimAtCard },
  { label: "buy a second card", travelMs: 340, holdMs: 620, aim: aimAtCard },
  { label: "reroll the shelf", travelMs: 480, holdMs: 700, aim: aimAtReroll },
  // The staged pack opening — the pack's flight, its seal, then the choices
  // flipping up one after another — runs about 1.8s of its own; the rest of the
  // hold, plus the next beat's travel, is time to read all three cards.
  { label: "open a booster", travelMs: 540, holdMs: 2400, aim: aimAtPack },
  {
    label: "take a card from the pack",
    travelMs: 360,
    holdMs: 620,
    aim: aimAtPackChoice,
  },
  { label: "buy another card", travelMs: 320, holdMs: 700, aim: aimAtCard },
  // A second reroll closes the loop: it re-stages the visit's opening shelf, and
  // leaves the pointer resting on the reroll button it started on, so the clip's
  // last frame is its first. The purse jumps back with it, which is the one seam
  // a looping shop reel cannot hide.
  {
    label: "reroll into the opening shelf",
    travelMs: 540,
    holdMs: 900,
    aim: aimAtRestage,
  },
];

/** Total wall-clock the reel needs, so the recorder does not carry a second,
 *  drifting copy of the pacing. */
export const SHOP_LOOP_DURATION_MS = SHOP_LOOP.reduce(
  (total, beat) => total + beat.travelMs + SETTLE_MS + beat.holdMs,
  0,
);

export interface ShopLoopProgress {
  readonly log: readonly string[];
  readonly error: string | null;
  readonly done: boolean;
}

let progress: { log: string[]; error: string | null; done: boolean } = {
  log: [],
  error: null,
  done: false,
};
/** Restarting a preset abandons any reel still running against the old shop. */
let generation = 0;

export function shopLoopProgress(): ShopLoopProgress {
  return progress;
}

export function resetShopLoop(): void {
  generation += 1;
  progress = { log: [], error: null, done: false };
}

/** Rest the pointer where the reel will leave it, before anything is recorded:
 *  the loop only closes if the clip opens on the pose it ends in. */
export function parkShopCursor(game: Phaser.Game): void {
  const shop = shopScene(game);
  const cursor = cursorScene(game);
  if (!shop || !cursor) return;
  const rest = rerollControl(shop);
  if (rest) cursor.park(rest.x, rest.y);
}

/** Perform the reel against the live ShopScene. A failed beat is recorded rather
 *  than thrown: the recorder is already sampling the canvas by the time this
 *  runs, so it has to be reported after the clip instead of interrupting it. */
export async function playShopLoop(
  game: Phaser.Game,
  onBeat?: (label: string) => void,
): Promise<void> {
  const mine = ++generation;
  progress = { log: [], error: null, done: false };
  const shop = shopScene(game);
  const cursor = cursorScene(game);
  if (!shop || !cursor) {
    progress.error = "the Shop scene and its cursor are not both running";
    return;
  }

  for (const beat of SHOP_LOOP) {
    if (generation !== mine) return;
    onBeat?.(beat.label);
    try {
      const target = beat.aim(shop, game);
      await cursor.moveTo(target.x, target.y, beat.travelMs);
      if (generation !== mine) return;
      target.hover();
      await hold(shop, SETTLE_MS);
      if (generation !== mine) return;
      cursor.press();
      target.press();
    } catch (error) {
      progress.error = `${beat.label}: ${describe(error)}`;
      return;
    }
    progress.log.push(beat.label);
    await hold(shop, beat.holdMs);
  }
  progress.done = true;
}

/** Wait on the scene's own clock, so the script and the tweens it is pacing
 *  against cannot drift apart. */
function hold(shop: ShopSceneInternals, ms: number): Promise<void> {
  return new Promise((resolve) => {
    shop.time.delayedCall(ms, resolve);
  });
}

function shopScene(game: Phaser.Game): ShopSceneInternals | null {
  return game.scene.getScene("Shop") as ShopSceneInternals | null;
}

function cursorScene(game: Phaser.Game): CaptureCursorScene | null {
  return game.scene.getScene("CaptureCursor") as CaptureCursorScene | null;
}

/** Press the leftmost card the shop would actually let a player take:
 *  affordable, and not one that sends them off to the die picker. */
function aimAtCard(shop: ShopSceneInternals): ShopTarget {
  const offer = shop.offers.find(
    (candidate) => !candidate.needsTarget && candidate.cost <= shop.state.gold,
  );
  if (!offer) throw new Error("no directly affordable card on the shelf");
  return cardTarget(shop, offer);
}

/** Take a choice out of the opened pack, preferring one that resolves on the
 *  spot. A pack of nothing but targeted cards is legal, so fall back to the die
 *  picker's first target rather than stalling the reel. */
function aimAtPackChoice(shop: ShopSceneInternals): ShopTarget {
  const choices = shop.packChoices;
  if (!choices?.length) throw new Error("the pack has no choices open");
  const direct = choices.find((choice) => !choice.needsTarget);
  if (direct) return cardTarget(shop, direct);
  const targeted = choices[0];
  const target = cardTarget(shop, targeted);
  return {
    ...target,
    press: () => {
      shop.choose(targeted);
      shop.onPick(targeted, 0);
    },
  };
}

/** Both the shelf cards and a pack's choices are built by the same method and
 *  registered in the same map, so one lookup serves either. */
function cardTarget(shop: ShopSceneInternals, offer: ShopOffer): ShopTarget {
  const card = shop.offerCards.get(offer);
  if (!card) throw new Error(`no card is drawn for ${offer.id}`);
  const at = screenPointOf(shop, card);
  return {
    x: at.x,
    y: at.y,
    // The card's own handler wants the pointer, to tell a hover from the first
    // half of a tap; the studio's pointer has never touched anything.
    hover: () => card.emit("pointerover", shop.input.activePointer),
    press: () => shop.choose(offer),
  };
}

/** Press the first sealed pack. Going through the tile's own handler is what
 *  earns the staged opening — the flight, the seal, the burst — because that
 *  animation is posed from the tile's screen rect. */
function aimAtPack(shop: ShopSceneInternals): ShopTarget {
  const band = shop.packBand;
  if (!band) throw new Error("this visit is offering no booster packs");
  // The band covers the pair; its left half centres on the first pack.
  const x = band.x + band.width * 0.25;
  const y = band.centerY;
  const tile = pressableAt(shop, x, y);
  if (!tile) throw new Error("no affordable pack tile inside the booster band");
  return {
    x,
    y,
    hover: () => tile.emit("pointerover"),
    press: () => tile.emit("pointerdown"),
  };
}

function aimAtReroll(shop: ShopSceneInternals): ShopTarget {
  const control = rerollControl(shop);
  if (!control) throw new Error("the reroll button is not on the counter");
  const before = shop.rerollsThisVisit;
  return {
    ...control,
    press: () => {
      control.press();
      if (shop.rerollsThisVisit === before)
        throw new Error("the reroll was refused (not enough gold?)");
    },
  };
}

/** The closing reroll. Its press re-stages the visit exactly as it opened: the
 *  same purse, the same three cards, both packs sealed again.
 *
 *  The fixture is deterministic, so re-installing it deals the identical shelf;
 *  adopting it in place rather than restarting the scene keeps the entrance
 *  slide and the one-time card deal out of the loop point, leaving the reel's
 *  last frame indistinguishable from its first. */
function aimAtRestage(shop: ShopSceneInternals, game: Phaser.Game): ShopTarget {
  const control = rerollControl(shop);
  if (!control) throw new Error("the reroll button is not on the counter");
  return {
    ...control,
    press: () => {
      const checkpoint = installShopFixture(game);
      shop.state = getRun(game.registry);
      shop.visitWeights = { ...checkpoint.visitWeights };
      shop.boonSpent = checkpoint.boonSpent;
      shop.offers = checkpoint.offers.map((offer) => ({ ...offer }));
      shop.packs = checkpoint.packs.map((pack) => ({ ...pack }));
      shop.packChoices = undefined;
      shop.openingPack = undefined;
      shop.openingPackCost = undefined;
      shop.packFan = undefined;
      shop.pickerOffer = undefined;
      shop.pickedIndices = [];
      shop.purchasesMade = 0;
      shop.rerollsThisVisit = 0;
      shop.packsOpenedThisVisit = 0;
      shop.couponFreebieClaimedThisVisit = false;
      shop.purchaseAnimating = false;
      shop.saveCheckpoint();
      shop.rebuildShop();
    },
  };
}

/** The reroll plate, found through the label printed on it. The two run
 *  controls are otherwise identical rectangles, and the copy is the only thing
 *  in the scene that says which is which. */
function rerollControl(shop: ShopSceneInternals): ShopTarget | undefined {
  const label = findText(shop, (text) => text.startsWith("Reroll"));
  if (!label) return undefined;
  const at = screenPointOf(shop, label);
  const plate = pressableAt(shop, at.x, at.y);
  if (!plate) return undefined;
  return {
    x: at.x,
    y: at.y,
    hover: () => plate.emit("pointerover"),
    press: () => plate.emit("pointerdown"),
  };
}

/** Where an object sits on the recorded canvas.
 *
 *  Cards in the fan carousel are drawn by a camera of their own, so their world
 *  position has to come back through that camera's scroll and viewport origin —
 *  the same conversion `animateCardPurchase` makes for its purchase burst. */
function screenPointOf(
  shop: ShopSceneInternals,
  object: Phaser.GameObjects.Container | Phaser.GameObjects.Text,
): { x: number; y: number } {
  const world = object.getWorldTransformMatrix().transformPoint(0, 0);
  const cam = shop.carouselCamera;
  const inCarousel = shop.carouselCards.some((entry) => entry.card === object);
  if (!cam || !inCarousel) return { x: world.x, y: world.y };
  const origin = cameraOrigin(cam);
  return {
    x: world.x - cam.scrollX + origin.x,
    y: world.y - cam.scrollY + origin.y,
  };
}

/** The smallest pressable thing drawn over this point — the most specific one,
 *  so a tile wins over the group that holds it. */
function pressableAt(
  shop: ShopSceneInternals,
  x: number,
  y: number,
): Phaser.GameObjects.GameObject | undefined {
  let best: Phaser.GameObjects.GameObject | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  const visit = (objects: Phaser.GameObjects.GameObject[]): void => {
    for (const object of objects) {
      const bounds = boundsOf(object);
      if (
        object.input &&
        bounds &&
        Phaser.Geom.Rectangle.Contains(bounds, x, y)
      ) {
        const area = bounds.width * bounds.height;
        if (area < bestArea) {
          best = object;
          bestArea = area;
        }
      }
      const children = (object as Phaser.GameObjects.Container).list;
      if (Array.isArray(children)) visit(children);
    }
  };
  visit(shop.children.list);
  return best;
}

function boundsOf(
  object: Phaser.GameObjects.GameObject,
): Phaser.Geom.Rectangle | undefined {
  const measured = object as { getBounds?: () => Phaser.Geom.Rectangle };
  return typeof measured.getBounds === "function"
    ? measured.getBounds()
    : undefined;
}

function findText(
  shop: ShopSceneInternals,
  matches: (text: string) => boolean,
): Phaser.GameObjects.Text | undefined {
  let found: Phaser.GameObjects.Text | undefined;
  const visit = (objects: Phaser.GameObjects.GameObject[]): void => {
    for (const object of objects) {
      if (found) return;
      if (object instanceof Phaser.GameObjects.Text && matches(object.text)) {
        found = object;
        return;
      }
      const children = (object as Phaser.GameObjects.Container).list;
      if (Array.isArray(children)) visit(children);
    }
  };
  visit(shop.children.list);
  return found;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
