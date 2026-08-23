import Phaser from "phaser";
import { CSS, SERIF, COLORS } from "../art/palette";
import type { RarityWeights } from "../config";
import { getRun, RunState } from "../state/RunState";
import { canLoad, canShrink, Die } from "../systems/Dice";
import {
  applyCouponFreebie,
  applyBoosterChoice,
  applyOffer,
  boosterPrice,
  type BoosterOffer,
  canAfford,
  discountOffersForPawnbroker,
  openBooster,
  rerollCost,
  rerollIsFree,
  rerollShopOffers,
  rollBoosterOffers,
  rollShopOffers,
  ShopOffer,
  weightsFor,
} from "../systems/Shop";
import { recordSelection } from "../systems/SaveData";
import {
  advanceTutorial,
  getTutorial,
  TutorialStage,
  TUTORIAL_TEXT,
} from "../systems/Tutorial";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { DieSprite } from "../ui/DieSprite";
import { AmbientLayer } from "../ui/AmbientLayer";
import { addFelt, bannerButton } from "../ui/widgets";
import { showCallout, CalloutHandle } from "../ui/Callout";
import { computeGridPositions, GridArea } from "../ui/gridLayout";
import {
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { buildRunFooterLinks } from "../ui/runFooterLinks";
import { WINDOW_THRESHOLD } from "../ui/windowedGrid";

const CARD_W = 260;
const CARD_H = 340;
const CARD_GAP = 26;
const MIN_READABLE_CARD_SCALE = 0.5;
const DRAG_THRESHOLD = 8; // px of pointer movement before a press counts as a scroll, not a tap
// Focus pose deltas for the compact fan. Kept small so hovering a card does
// not push the fan down into the booster packs below it; the separation comes
// mostly from the horizontal duck and the focused card's scale.
const FOCUS_LIFT = 8; // px the focused card rises
const FOCUS_SCALE = 1.05;

type PointerHandler = (
  pointer: Phaser.Input.Pointer,
  currentlyOver?: Phaser.GameObjects.GameObject[],
) => void;
type WheelHandler = (
  pointer: Phaser.Input.Pointer,
  currentlyOver: unknown,
  dx: number,
  dy: number,
  dz: number,
) => void;

interface PackOrigin {
  x: number;
  y: number;
  width: number;
  height: number;
  source: Phaser.GameObjects.Container;
}

interface CarouselCardEntry {
  offer: ShopOffer;
  card: Phaser.GameObjects.Container;
  baseX: number;
  baseY: number;
  baseRotation: number;
  baseDepth: number;
  baseAlpha: number;
}

interface CarouselLayout {
  viewportX: number;
  contentX: number;
  contentW: number;
  trackX: number;
  cardW: number;
  step: number;
  centerY: number;
  arcStep: number;
}

export class ShopScene extends Phaser.Scene {
  private state!: RunState;
  private offers: ShopOffer[] = [];
  private cardGroup!: Phaser.GameObjects.Container;
  private pickGroup?: Phaser.GameObjects.Container;
  private packGroup?: Phaser.GameObjects.Container;
  private packs: BoosterOffer[] = [];
  private packChoices?: ShopOffer[];
  private openingPack?: BoosterOffer;
  private visitWeights!: RarityWeights;
  // Scrolling cards render through their own camera, clipped to the card
  // area's screen rect — Phaser 4's WebGL renderer doesn't reliably support
  // GameObject masks for content this deep, so a mask here would let cards
  // render past the panel's border.
  private track?: Phaser.GameObjects.Container;
  private carouselCamera?: Phaser.Cameras.Scene2D.Camera;
  private calloutCamera?: Phaser.Cameras.Scene2D.Camera;
  private carouselCards: CarouselCardEntry[] = [];
  private carouselLayout?: CarouselLayout;
  private offerCards = new Map<ShopOffer, Phaser.GameObjects.Container>();
  private carouselDragging = false;
  private focusedCarouselIndex?: number;
  private selectedCarouselIndex?: number;
  private carouselBuyButton?: Phaser.GameObjects.Container;
  private carouselBuyLabel?: Phaser.GameObjects.Text;
  private carouselBuyPlate?: Phaser.GameObjects.Rectangle;
  private purchaseAnimating = false;
  private pendingCarouselPan = 0;
  private dragDistance = 0;
  private carouselInput?: {
    down: PointerHandler;
    move: PointerHandler;
    up: PointerHandler;
    wheel: WheelHandler;
  };
  private pickedIndices: number[] = []; // dice chosen so far for a multi-target offer (Grindstone)
  // Screen rects of the card row and the booster pair, and the live tutorial
  // callout (first-game only). The shop's step lights both bands, since the
  // gold it is talking about buys from either.
  private cardBand?: Phaser.Geom.Rectangle;
  private packBand?: Phaser.Geom.Rectangle;
  private tutorialCallout?: CalloutHandle;
  private purchasesMade = 0;
  private rerollsThisVisit = 0;
  // The cards are dealt onto the table once, when the shop opens. Resizes and
  // the die-picker sub-screen rebuild the same offers, and re-dealing them
  // there would read as a new shop rather than the one already being read.
  private dealt = false;
  // Whether this visit is the one bought by a Boss Trial clear (drives the
  // header note; the odds themselves were already applied by rollShopOffers).
  private boonSpent = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("Shop");
  }

  create(): void {
    this.state = getRun(this.registry);
    this.purchasesMade = 0;
    this.rerollsThisVisit = 0;
    this.dealt = false;
    this.pendingCarouselPan = 0;
    this.purchaseAnimating = false;
    this.visitWeights = { ...weightsFor(this.state) };
    // The boon a Boss Trial clear earns is spent on this one visit's rarity
    // odds, so it is consumed the moment those odds have been rolled against.
    this.boonSpent = this.state.boonNextShop;
    this.offers = rollShopOffers(
      this.state,
      this.state.ownedLedger ? 5 : 3,
      Math.random,
      this.visitWeights,
    );
    this.packs = rollBoosterOffers(this.state, 2, this.boonSpent);
    this.packChoices = undefined;
    this.openingPack = undefined;
    this.state.boonNextShop = false;
    // The scene instance is reused across restarts, but Phaser destroys all
    // non-main cameras on shutdown — these fields would otherwise dangle.
    this.carouselCamera = undefined;
    this.calloutCamera = undefined;

    this.build();
    slideSceneIn(this, this.slideBackdrop);

    const off = onResizeCoalesced(this, () => {
      this.pickGroup = undefined; // drop the shrink-picker sub-screen; back to the offer cards
      this.teardownCarouselInput();
      destroyAllChildren(this);
      this.build();
      if (this.packChoices && this.openingPack) this.showBoosterChoices(false);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardownCarouselInput();
      this.input.setDefaultCursor("default");
    });
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(W / 2, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(0.62, false);

    const titleGlow = this.add
      .image(
        W / 2,
        Math.max(42, H / 2 - Math.min(H - 28, 760) / 2 + 48),
        "spark",
      )
      .setTint(COLORS.glow)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(Math.min(680, W * 0.76), 220)
      .setAlpha(0.18);
    if (fx.motion) {
      const baseScaleX = titleGlow.scaleX;
      this.tweens.add({
        targets: titleGlow,
        alpha: { from: 0.1, to: 0.22 },
        scaleX: { from: baseScaleX * 0.96, to: baseScaleX * 1.04 },
        duration: 2600,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
    this.buildCards();
    const footerLinks = buildRunFooterLinks(this, "Shop");
    this.slideBackdrop = [felt, ambient, titleGlow, ...footerLinks];
    this.dealt = true;
    // The carousel camera must ignore literally everything except `track`
    // (built inside buildCards -> buildCarousel) — otherwise it renders the
    // *entire* scene, unclipped-by-content, into its own small viewport rect.
    this.carouselCamera?.ignore(this.slideBackdrop);
    this.carouselCamera?.ignore(this.cardGroup);
    this.renderShopTutorial();
  }

  /** First-game tutorial: a callout over the loose cards and the boosters,
   *  prompting the player to spend. Both bands are left open so cards stay
   *  selectable and the carousel scrolls; only what surrounds them dims, and
   *  the panel takes whatever room is left over neither. Picking an item ends
   *  the step, but a player who would rather save their gold can dismiss it
   *  with Continue. */
  private renderShopTutorial(): void {
    const t = getTutorial(this.registry);
    if (!t.active || t.stage !== TutorialStage.Shop || !this.cardBand) return;
    const bands = [this.cardBand];
    if (this.packBand) bands.push(this.packBand);
    this.ensureCalloutCamera();
    this.tutorialCallout = showCallout(this, {
      anchor: bands,
      text: TUTORIAL_TEXT[TutorialStage.Shop],
      onContinue: () => this.endShopTutorial(),
      interactiveAnchor: true,
    });
    // Exactly one camera may draw the callout: a second pass would lay another
    // dim over the first and darken the whole screen.
    this.cameras.main.ignore(this.tutorialCallout.objects);
    this.carouselCamera?.ignore(this.tutorialCallout.objects);
  }

  /** A camera that draws the tutorial callout and nothing else, above every
   *  other pass. The carousel has its own camera, added after the main one, so
   *  the cards paint over anything the main camera drew however deep it was —
   *  including the callout. A camera created *after* the carousel's, ignoring
   *  everything already on the display list, gets the callout (built right
   *  after this returns) to itself and lands on top of both.
   *
   *  The flip side of that snapshot is that anything added to the scene later
   *  would also be drawn by this camera, so the callout has to be torn down —
   *  via endShopTutorial or rebuildShop — before any new sub-screen opens. */
  private ensureCalloutCamera(): Phaser.Cameras.Scene2D.Camera {
    this.removeCalloutCamera();
    const cam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    cam.setBackgroundColor();
    this.ignoreDeep(cam, this.children.list);
    this.calloutCamera = cam;
    return cam;
  }

  /** `Camera.ignore` recurses *into* a container and filters its children,
   *  leaving the container itself unfiltered. That renders correctly, but
   *  input hit-testing runs against the container — `setInteractive` was
   *  called on the offer card, not on the parchment inside it — so an
   *  unfiltered card would still be tested against this camera, which has
   *  neither the carousel camera's viewport nor its scroll and so reports
   *  hits nowhere near where the card is drawn. Filter the containers too. */
  private ignoreDeep(
    cam: Phaser.Cameras.Scene2D.Camera,
    objects: readonly Phaser.GameObjects.GameObject[],
  ): void {
    for (const obj of objects) {
      obj.cameraFilter |= cam.id;
      const children = (obj as Phaser.GameObjects.Container).list;
      if (Array.isArray(children)) this.ignoreDeep(cam, children);
    }
  }

  private removeCalloutCamera(): void {
    if (!this.calloutCamera) return;
    this.cameras.remove(this.calloutCamera, true);
    this.calloutCamera = undefined;
  }

  private teardownCarouselInput(): void {
    if (this.carouselInput) {
      this.input.off("pointerdown", this.carouselInput.down);
      this.input.off("pointermove", this.carouselInput.move);
      this.input.off("pointerup", this.carouselInput.up);
      this.input.off("pointerupoutside", this.carouselInput.up);
      this.input.off("wheel", this.carouselInput.wheel);
      this.carouselInput = undefined;
    }
    this.carouselDragging = false;
  }

  /** The carousel camera is destroyed and recreated on every rebuild (the
   *  whole scene wipes and rebuilds on resize) rather than reused, since its
   *  viewport rect changes with the layout. */
  private ensureCarouselCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.carouselCamera) {
      this.cameras.remove(this.carouselCamera, true);
    }
    const cam = this.cameras.add(0, 0, 1, 1);
    cam.setBackgroundColor();
    this.carouselCamera = cam;
    return cam;
  }

  private buildCards(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    this.offerCards.clear();
    this.carouselCards = [];
    this.carouselLayout = undefined;
    this.focusedCarouselIndex = undefined;
    this.selectedCarouselIndex = undefined;
    this.carouselBuyButton = undefined;
    this.carouselBuyLabel = undefined;
    this.carouselBuyPlate = undefined;
    const panelW = Math.min(W - 28, 1180);
    const panelH = Math.min(H - 28, 760);
    const panelTop = H / 2 - panelH / 2;
    const panelBottom = H / 2 + panelH / 2;

    const items: Phaser.GameObjects.GameObject[] = [];
    const narrow = panelW < 650;

    if (isCompactLandscape(W, H)) {
      items.push(
        ...this.buildCompactLandscape(W, H, panelW, panelTop, panelBottom),
      );
      this.finishCardGroup(items);
      return;
    }

    const titleSize = Math.round(
      Phaser.Math.Clamp(Math.min(panelW * 0.066, panelH * 0.06), 20, 40),
    );
    const metaSize = Math.round(
      Phaser.Math.Clamp(Math.min(panelW * 0.032, panelH * 0.033), 13, 19),
    );

    let cursorY = panelTop + Math.max(28, panelH * 0.07);
    const title = this.add
      .text(W / 2, cursorY, "The Shop of the Order", {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        align: "center",
        stroke: "#0d0a12",
        strokeThickness: Math.max(3, Math.round(titleSize * 0.09)),
        wordWrap: { width: panelW * 0.92 },
      })
      .setOrigin(0.5)
      .setShadow(0, 4, "#000000", 10, true, true);
    items.push(title);
    cursorY += title.height / 2 + 10;

    const gold = this.add
      .text(0, cursorY, `${this.state.gold} gold`, {
        fontFamily: SERIF,
        fontSize: `${metaSize}px`,
        color: CSS.goldLight,
        fontStyle: "bold",
      })
      .setOrigin(0, 0);

    const codexLink = this.add
      .text(0, cursorY, "Codex", {
        fontFamily: SERIF,
        fontSize: `${metaSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    codexLink.on("pointerover", () => codexLink.setColor(CSS.goldLight));
    codexLink.on("pointerout", () => codexLink.setColor(CSS.gold));
    codexLink.on("pointerdown", () => {
      audio.click();
      this.scene.launch("Items", { returnTo: "Shop" });
    });
    const metaGap = Phaser.Math.Clamp(panelW * 0.025, 16, 28);
    const metaW = gold.width + metaGap + codexLink.width;
    gold.setX(W / 2 - metaW / 2);
    codexLink.setX(gold.x + gold.width + metaGap);
    items.push(gold, codexLink);
    cursorY += Math.max(gold.height, codexLink.height) + 10;

    const sectionSize = Math.round(Phaser.Math.Clamp(metaSize * 0.78, 10, 14));
    const section = this.add
      .text(W / 2, cursorY + 3, "LOOSE OFFERINGS", {
        fontFamily: SERIF,
        fontSize: `${sectionSize}px`,
        color: CSS.goldLight,
        fontStyle: "bold",
        letterSpacing: 2,
      })
      .setOrigin(0.5, 0);
    const sectionRule = this.add.graphics();
    const ruleGap = Math.min(115, section.width / 2 + 18);
    const ruleHalf = Math.min(panelW * 0.38, W / 2 - 24);
    const sectionY = cursorY + section.height / 2 + 3;
    sectionRule.lineStyle(1, COLORS.gold, 0.45);
    sectionRule.lineBetween(
      W / 2 - ruleHalf,
      sectionY,
      W / 2 - ruleGap,
      sectionY,
    );
    sectionRule.lineBetween(
      W / 2 + ruleGap,
      sectionY,
      W / 2 + ruleHalf,
      sectionY,
    );
    items.push(sectionRule, section);
    cursorY += section.height + 12;

    const availW = panelW * (1072 / 1100) - 28;
    const secondH = narrow
      ? Phaser.Math.Clamp(panelH * 0.36, 190, 270)
      : Phaser.Math.Clamp(panelH * 0.28, 145, 215);
    const secondTop = panelBottom - secondH - 20;
    const areaTop = cursorY;
    const areaBottom = secondTop - 12;
    const availH = Math.max(0, areaBottom - areaTop);

    // Screen rect of the card area, for anchoring the tutorial callout's open
    // "hole".
    this.cardBand = new Phaser.Geom.Rectangle(
      W / 2 - availW / 2,
      areaTop,
      availW,
      availH,
    );

    const grid = this.buildCardGrid(W / 2, areaTop, availW, availH, narrow);
    items.push(...grid.decor);
    items.push(...this.buildSecondRow(W, secondTop, availW, secondH, narrow));

    this.finishCardGroup(items);
  }

  /** Wrap a finished shop layout in `cardGroup`, dealing it in on the build
   *  that opens the visit (resizes and sub-screens rebuild in place). */
  private finishCardGroup(items: Phaser.GameObjects.GameObject[]): void {
    this.cardGroup = this.add.container(0, 0, items);
    if (fx.motion && !this.dealt) {
      this.cardGroup.setAlpha(0).setY(18);
      this.tweens.add({
        targets: this.cardGroup,
        alpha: 1,
        y: 0,
        duration: 360,
        ease: "Cubic.easeOut",
      });
    }
  }

  /** Two-column shop for short landscape viewports: a single header line
   *  across the top, the offer cards taking the full remaining height on the
   *  left, and the boosters plus the run controls stacked in a sidebar on the
   *  right. Nothing here runs on viewports tall enough for the stacked
   *  layout. */
  private buildCompactLandscape(
    W: number,
    H: number,
    panelW: number,
    panelTop: number,
    panelBottom: number,
  ): Phaser.GameObjects.GameObject[] {
    const items: Phaser.GameObjects.GameObject[] = [];
    const panelH = panelBottom - panelTop;
    const left = W / 2 - panelW / 2;
    const right = W / 2 + panelW / 2;

    // Title and the gold/Codex meta share one line, pushed to opposite edges,
    // instead of the three centred header rows the stacked layout uses.
    const titleSize = Math.round(
      Phaser.Math.Clamp(Math.min(panelW * 0.048, panelH * 0.092), 19, 30),
    );
    const metaSize = Math.round(Phaser.Math.Clamp(titleSize * 0.6, 12, 17));
    const headerTop = panelTop + Math.max(6, panelH * 0.02);
    const title = this.add
      .text(left, headerTop, "The Shop of the Order", {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
        stroke: "#0d0a12",
        strokeThickness: Math.max(3, Math.round(titleSize * 0.09)),
      })
      .setOrigin(0, 0)
      .setShadow(0, 3, "#000000", 8, true, true);
    const metaY = headerTop + title.height / 2;
    const codexLink = this.add
      .text(right, metaY, "Codex", {
        fontFamily: SERIF,
        fontSize: `${metaSize}px`,
        color: CSS.gold,
        fontStyle: "bold",
      })
      .setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true });
    codexLink.on("pointerover", () => codexLink.setColor(CSS.goldLight));
    codexLink.on("pointerout", () => codexLink.setColor(CSS.gold));
    codexLink.on("pointerdown", () => {
      audio.click();
      this.scene.launch("Items", { returnTo: "Shop" });
    });
    const metaGap = Phaser.Math.Clamp(panelW * 0.022, 14, 26);
    const gold = this.add
      .text(
        codexLink.x - codexLink.width - metaGap,
        metaY,
        `${this.state.gold} gold`,
        {
          fontFamily: SERIF,
          fontSize: `${metaSize}px`,
          color: CSS.goldLight,
          fontStyle: "bold",
        },
      )
      .setOrigin(1, 0.5);
    const rule = this.add.graphics();
    const ruleY = Math.round(headerTop + title.height + 6);
    rule.lineStyle(1, COLORS.gold, 0.32);
    rule.lineBetween(left, ruleY, right, ruleY);
    items.push(title, gold, codexLink, rule);

    const colGap = Phaser.Math.Clamp(panelW * 0.026, 14, 28);
    const sidebarW = Phaser.Math.Clamp(panelW * 0.29, 186, 250);
    const cardsW = panelW - sidebarW - colGap;
    const contentTop = ruleY + 10;
    const contentBottom = panelBottom - 6;
    const cardsH = Math.max(0, contentBottom - contentTop);

    // Screen rect of the card column, for the tutorial callout's open "hole".
    this.cardBand = new Phaser.Geom.Rectangle(left, contentTop, cardsW, cardsH);
    const grid = this.buildCardGrid(
      left + cardsW / 2,
      contentTop,
      cardsW,
      cardsH,
      false,
      "horizontal",
    );
    items.push(...grid.decor);

    // Inventory/Settings are pinned to the bottom-right corner, which is where
    // the sidebar's last button would otherwise land.
    const sidebarBottom = Math.min(contentBottom, H - 56);
    items.push(
      ...this.buildCompactSidebar(
        right - sidebarW / 2,
        contentTop,
        sidebarW,
        Math.max(0, sidebarBottom - contentTop),
      ),
    );
    return items;
  }

  /** Boosters and run controls stacked in the compact-landscape sidebar. The
   *  packs turn into wide banners rather than card-shaped tiles: two upright
   *  packs sharing a column this narrow would be too small to read. */
  private buildCompactSidebar(
    cx: number,
    top: number,
    w: number,
    h: number,
  ): Phaser.GameObjects.GameObject[] {
    const objects: Phaser.GameObjects.GameObject[] = [];
    const count = this.packs.length;
    const gap = Phaser.Math.Clamp(h * 0.03, 6, 14);
    const free = Math.max(0, h - gap * (count + 1));
    const buttonH = Phaser.Math.Clamp(free * 0.2, 32, 54);
    const controlsH = buttonH * 2 + gap;
    const packH =
      count > 0 ? Math.min((free - buttonH * 2) / count, w * 0.52) : 0;
    const totalH = packH * count + controlsH + gap * count;
    let y = top + Math.max(0, (h - totalH) / 2);

    const packTop = y;
    for (const pack of this.packs) {
      objects.push(this.buildPackTile(pack, cx, y + packH / 2, w, packH, true));
      y += packH + gap;
    }
    // A visit with no packs on offer leaves no band to light, and must clear
    // the one the previous build left behind.
    this.packBand =
      count > 0
        ? new Phaser.Geom.Rectangle(
            cx - w / 2,
            packTop,
            w,
            packH * count + gap * (count - 1),
          )
        : undefined;

    objects.push(this.buildControlTile(cx, y + controlsH / 2, w, controlsH));
    return objects;
  }

  private buildSecondRow(
    W: number,
    top: number,
    width: number,
    height: number,
    narrow: boolean,
  ): Phaser.GameObjects.GameObject[] {
    const objects: Phaser.GameObjects.GameObject[] = [];
    const packGap = Phaser.Math.Clamp(width * 0.018, 10, 18);
    const sectionGap = Phaser.Math.Clamp(width * 0.035, 18, 36);
    const controlsH = narrow
      ? Phaser.Math.Clamp(height * 0.26, 74, 84)
      : height;
    const controlsW = narrow ? width : (width - sectionGap * 2) / 3;
    const packAreaH = narrow ? height - controlsH - sectionGap : height;
    const packAreaW = narrow ? width : width - controlsW - sectionGap;
    // Booster wrappers share the loose-card silhouette. Size them uniformly
    // inside an invisible group instead of stretching them to wide, short
    // tiles. Only `packGap` separates the two packs.
    const packW = Math.min(
      (packAreaW - packGap) / 2,
      packAreaH * (CARD_W / CARD_H),
    );
    const packH = packW * (CARD_H / CARD_W);
    const packGroupW = packW * 2 + packGap;
    // On wide screens, keep the group and controls together. Once their gap
    // reaches 120px, additional width becomes balanced outer margin.
    const controlsGap = Math.min(
      120,
      Math.max(sectionGap, width - packGroupW - controlsW),
    );
    const rowW = packGroupW + controlsGap + controlsW;
    const rowStartX = W / 2 - rowW / 2;
    const packGroupX = narrow ? W / 2 : rowStartX + packGroupW / 2;
    const packGroupY = narrow ? top + packH / 2 : top + height / 2;
    const packTiles: Phaser.GameObjects.Container[] = [];
    for (let i = 0; i < 2; i++) {
      const pack = this.packs[i];
      if (pack) {
        packTiles.push(
          this.buildPackTile(
            pack,
            -packGroupW / 2 + packW / 2 + i * (packW + packGap),
            0,
            packW,
            packH,
          ),
        );
      }
    }
    const packGroup = this.add
      .container(packGroupX, packGroupY, packTiles)
      .setSize(packGroupW, packH);
    objects.push(packGroup);
    // A visit with no packs on offer leaves no band to light, and must clear
    // the one the previous build left behind.
    this.packBand =
      packTiles.length > 0
        ? new Phaser.Geom.Rectangle(
            packGroupX - packGroupW / 2,
            packGroupY - packH / 2,
            packGroupW,
            packH,
          )
        : undefined;

    const controlsX = narrow
      ? W / 2
      : rowStartX + packGroupW + controlsGap + controlsW / 2;
    const controlsY = narrow ? top + height - controlsH / 2 : top + height / 2;
    objects.push(
      this.buildControlTile(controlsX, controlsY, controlsW, controlsH),
    );
    return objects;
  }

  private buildPackTile(
    pack: BoosterOffer,
    x: number,
    y: number,
    w: number,
    h: number,
    banner = false,
  ): Phaser.GameObjects.Container {
    const price = boosterPrice(this.state, pack);
    const affordable = this.state.gold >= price && !pack.sold;
    const bg = this.add
      .rectangle(0, 0, w, h, pack.color, pack.sold ? 0.22 : 0.94)
      .setStrokeStyle(3, pack.sold ? COLORS.inkSoft : COLORS.gold, 0.9);
    const ribs = this.buildPackRibs(w, h, banner);
    const flourish = this.add
      .image(0, 0, "sigil")
      .setDisplaySize(Math.min(w, h) * 0.75, Math.min(w, h) * 0.75)
      .setTint(COLORS.goldLight)
      .setAlpha(0.13);
    const content = banner
      ? this.buildPackBannerText(pack, price, affordable, w, h)
      : this.buildPackCardText(pack, price, affordable, w, h);
    const tile = this.add.container(x, y, [bg, ...ribs, flourish, ...content]);
    tile.setSize(w, h);
    if (affordable) {
      tile.setInteractive({ useHandCursor: true });
      tile.on("pointerover", () => tile.setScale(1.025));
      tile.on("pointerout", () => tile.setScale(1));
      tile.on("pointerdown", () => {
        const center = tile.getWorldTransformMatrix().transformPoint(0, 0);
        this.openPack(pack, {
          x: center.x,
          y: center.y,
          width: w,
          height: h,
          source: tile,
        });
      });
    } else if (!pack.sold) tile.setAlpha(0.58);
    return tile;
  }

  /** Upright wrapper: name, promise and price centred down the pack face. */
  private buildPackCardText(
    pack: BoosterOffer,
    price: number,
    affordable: boolean,
    w: number,
    h: number,
  ): Phaser.GameObjects.GameObject[] {
    const name = this.add
      .text(0, -h * 0.22, pack.sold ? "OPENED" : pack.name, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.09, h * 0.18), 12, 21)}px`,
        color: CSS.ivory,
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: w * 0.9 },
      })
      .setOrigin(0.5);
    const desc = this.add
      .text(0, h * 0.05, pack.sold ? "One card claimed" : pack.desc, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.066, h * 0.12), 10, 15)}px`,
        color: CSS.parchment,
        align: "center",
        wordWrap: { width: w * 0.86 },
      })
      .setOrigin(0.5);
    const cost = this.add
      .text(0, h * 0.34, pack.sold ? "SOLD" : `${price} gold`, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.075, h * 0.14), 11, 17)}px`,
        color: affordable ? CSS.goldLight : CSS.red,
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    return [name, desc, cost];
  }

  /** Landscape wrapper for the compact sidebar: name over promise on the left,
   *  price held against the right crimp. Laid out from measured text heights
   *  rather than fractions of `h`, because a banner only has room for two
   *  lines and a wrapped promise would collide with the name. */
  private buildPackBannerText(
    pack: BoosterOffer,
    price: number,
    affordable: boolean,
    w: number,
    h: number,
  ): Phaser.GameObjects.GameObject[] {
    const padX = Phaser.Math.Clamp(w * 0.07, 10, 22) + w * 0.06;
    const textLeft = -w / 2 + padX;
    const cost = this.add
      .text(w / 2 - padX, 0, pack.sold ? "SOLD" : `${price} gold`, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.09, h * 0.26), 11, 16)}px`,
        color: affordable ? CSS.goldLight : CSS.red,
        fontStyle: "bold",
      })
      .setOrigin(1, 0.5);
    let nameSize = Phaser.Math.Clamp(Math.min(w * 0.105, h * 0.32), 12, 19);
    let descSize = Phaser.Math.Clamp(Math.min(w * 0.058, h * 0.19), 9, 12);
    const name = this.add
      .text(textLeft, 0, pack.sold ? "OPENED" : pack.name, {
        fontFamily: SERIF,
        fontSize: `${nameSize}px`,
        color: CSS.ivory,
        fontStyle: "bold",
        wordWrap: { width: w - padX * 2 },
      })
      .setOrigin(0, 0.5);
    const desc = this.add
      .text(textLeft, 0, pack.sold ? "One card claimed" : pack.desc, {
        fontFamily: SERIF,
        fontSize: `${descSize}px`,
        color: CSS.parchment,
        wordWrap: { width: Math.max(40, w - padX * 2 - cost.width - 10) },
      })
      .setOrigin(0, 0.5);
    const lineGap = 4;

    // A sidebar this short (a handset in landscape) leaves a banner barely
    // taller than one wrapped name, and the overflow would spill across the
    // pack below. Step the type down until the block fits: each step also
    // pulls a wrapped line back up, so one or two are usually enough.
    const maxBlock = h - 8;
    for (
      let step = 0;
      step < 5 && name.height + lineGap + desc.height > maxBlock;
      step++
    ) {
      nameSize = Math.max(10, nameSize * 0.86);
      descSize = Math.max(8, descSize * 0.9);
      name.setFontSize(nameSize);
      desc.setFontSize(descSize);
    }
    // Nothing legible fits both lines — the name and price alone still tell
    // the player what the pack is and what it costs.
    if (name.height + lineGap + desc.height > maxBlock) {
      desc.destroy();
      name.setY(0);
      cost.setY(0);
      return [name, cost];
    }

    const top = -(name.height + lineGap + desc.height) / 2;
    name.setY(top + name.height / 2);
    desc.setY(top + name.height + lineGap + desc.height / 2);
    cost.setY(desc.y);
    return [name, desc, cost];
  }

  /** Crimped foil at both ends gives a booster its sealed-pack silhouette.
   * The ribs are separate from the coloured wrapper so every pack category
   * shares the same manufacturing detail. */
  private buildPackRibs(
    w: number,
    h: number,
    banner = false,
  ): Phaser.GameObjects.GameObject[] {
    // The crimp always runs across the pack's short axis, so a banner is
    // sealed at its left and right ends rather than top and bottom.
    const across = banner ? w : h;
    const along = banner ? h : w;
    const bandT = Phaser.Math.Clamp(across * 0.12, 10, 22);
    const offset = across / 2 - bandT / 2;
    const band = (sign: number) =>
      banner
        ? this.add.rectangle(sign * offset, 0, bandT, h, COLORS.feltDark, 0.3)
        : this.add.rectangle(0, sign * offset, w, bandT, COLORS.feltDark, 0.3);
    const grooves = this.add.graphics();
    grooves.lineStyle(1, COLORS.goldLight, 0.38);
    const spacing = Phaser.Math.Clamp(along / 34, 6, 11);
    for (let at = -along / 2 + spacing; at < along / 2; at += spacing) {
      if (banner) {
        grooves.lineBetween(-w / 2 + 2, at, -w / 2 + bandT - 2, at);
        grooves.lineBetween(w / 2 - bandT + 2, at, w / 2 - 2, at);
      } else {
        grooves.lineBetween(at, -h / 2 + 2, at, -h / 2 + bandT - 2);
        grooves.lineBetween(at, h / 2 - bandT + 2, at, h / 2 - 2);
      }
    }
    grooves.lineStyle(1.5, COLORS.gold, 0.6);
    if (banner) {
      grooves.lineBetween(-w / 2 + bandT, -h / 2, -w / 2 + bandT, h / 2);
      grooves.lineBetween(w / 2 - bandT, -h / 2, w / 2 - bandT, h / 2);
    } else {
      grooves.lineBetween(-w / 2, -h / 2 + bandT, w / 2, -h / 2 + bandT);
      grooves.lineBetween(-w / 2, h / 2 - bandT, w / 2, h / 2 - bandT);
    }
    return [band(-1), band(1), grooves];
  }

  private buildOpeningPack(
    pack: BoosterOffer,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Phaser.GameObjects.Container {
    const bg = this.add
      .rectangle(0, 0, w, h, pack.color, 1)
      .setStrokeStyle(4, COLORS.goldLight, 1);
    const ribs = this.buildPackRibs(w, h);
    const flourish = this.add
      .image(0, 0, "sigil")
      .setDisplaySize(Math.min(w, h) * 0.64, Math.min(w, h) * 0.64)
      .setTint(COLORS.goldLight)
      .setAlpha(0.15);
    const name = this.add
      .text(0, 0, pack.name, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.12, h * 0.09), 18, 30)}px`,
        color: CSS.ivory,
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: w * 0.82 },
      })
      .setOrigin(0.5);
    return this.add
      .container(x, y, [bg, ...ribs, flourish, name])
      .setSize(w, h);
  }

  private buildControlTile(
    x: number,
    y: number,
    w: number,
    h: number,
  ): Phaser.GameObjects.Container {
    const rerollPrice = rerollIsFree(this.state, this.rerollsThisVisit)
      ? 0
      : rerollCost(this.rerollsThisVisit);
    const canReroll = this.state.gold >= rerollPrice;
    const label =
      rerollPrice === 0
        ? "Reroll cards · FREE"
        : `Reroll cards · ${rerollPrice}g`;
    const buttonGap = Math.min(12, h * 0.08);
    const bh = Math.max(30, (h - buttonGap * 3) / 2);
    const make = (
      yy: number,
      text: string,
      enabled: boolean,
      action: () => void,
    ) => {
      const plate = this.add
        .rectangle(0, yy, w * 0.88, bh, COLORS.feltLight, 0.96)
        .setStrokeStyle(2, enabled ? COLORS.gold : COLORS.inkSoft, 0.75);
      const copy = this.add
        .text(0, yy, text, {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(Math.min(w * 0.075, bh * 0.42), 11, 18)}px`,
          color: enabled ? CSS.ivory : CSS.dim,
          fontStyle: "bold",
          align: "center",
          wordWrap: { width: w * 0.82 },
        })
        .setOrigin(0.5);
      if (enabled) {
        plate.setInteractive({ useHandCursor: true });
        plate.on("pointerover", () => plate.setFillStyle(0x30264b));
        plate.on("pointerout", () => plate.setFillStyle(COLORS.feltLight));
        plate.on("pointerdown", action);
      }
      return [plate, copy];
    };
    const topY = -buttonGap / 2 - bh / 2;
    const bottomY = buttonGap / 2 + bh / 2;
    const reroll = make(topY, label, canReroll, () => this.rerollStore());
    const next = make(bottomY, "Continue to Trials", true, () => this.exit());
    return this.add.container(x, y, [...reroll, ...next]).setSize(w, h);
  }

  /**
   * Lay the offer cards out in the available area. Narrow screens always use a
   * single horizontal carousel. Wider screens use the largest fitting grid,
   * and fall back to scrolling when even that would be unreadable: down the
   * page by default, or sideways through the fan carousel when `overflow` is
   * "horizontal" — a short, wide card column has room to scroll one way only.
   */
  private buildCardGrid(
    centerX: number,
    areaTop: number,
    availW: number,
    availH: number,
    narrow: boolean,
    overflow: "vertical" | "horizontal" = "vertical",
  ): { decor: Phaser.GameObjects.GameObject[] } {
    const n = this.offers.length;
    if (n === 0) {
      if (this.carouselCamera) {
        this.cameras.remove(this.carouselCamera, true);
        this.carouselCamera = undefined;
      }
      this.track = undefined;
      return {
        decor: [
          this.add
            .text(
              centerX,
              areaTop + availH / 2,
              "The loose offerings are exhausted.",
              {
                fontFamily: SERIF,
                fontSize: "18px",
                color: CSS.dim,
                fontStyle: "italic",
              },
            )
            .setOrigin(0.5),
        ],
      };
    }

    if (narrow) {
      return {
        decor: this.buildHorizontalCarousel(centerX, areaTop, availW, availH),
      };
    }

    const scaleFor = (cols: number, includeHeight = true) => {
      const rows = Math.ceil(n / cols);
      const unitW = cols * CARD_W + (cols - 1) * CARD_GAP;
      const unitH = rows * CARD_H + (rows - 1) * CARD_GAP;
      return Math.min(availW / unitW, includeHeight ? availH / unitH : 1, 1);
    };
    const candidates = Array.from({ length: n }, (_, i) => i + 1);
    let cols = candidates.reduce((best, candidate) =>
      scaleFor(candidate) > scaleFor(best) ? candidate : best,
    );
    let scale = scaleFor(cols);
    const needsScroll = scale < MIN_READABLE_CARD_SCALE;

    if (needsScroll && overflow === "horizontal") {
      return {
        decor: this.buildHorizontalCarousel(centerX, areaTop, availW, availH),
      };
    }

    if (needsScroll) {
      // Use as many columns as fit at a readable width, ignoring height because
      // the dedicated camera handles vertical overflow.
      cols =
        candidates
          .filter(
            (candidate) =>
              scaleFor(candidate, false) >= MIN_READABLE_CARD_SCALE,
          )
          .pop() ?? 1;
      scale = scaleFor(cols, false);
    }

    const rows = Math.ceil(n / cols);

    const cw = CARD_W * scale;
    const ch = CARD_H * scale;
    const gap = CARD_GAP * scale;
    const gridH = rows * ch + (rows - 1) * gap;
    const cx = centerX;

    // Card centre for index `idx`, with content-top at y=0 and the last,
    // possibly-partial row centered.
    const posFor = (idx: number) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const inRow = row === rows - 1 ? n - (rows - 1) * cols : cols;
      const rowW = inRow * cw + (inRow - 1) * gap;
      return {
        x: cx - rowW / 2 + col * (cw + gap) + cw / 2,
        y: row * (ch + gap) + ch / 2,
      };
    };

    if (needsScroll) {
      return {
        decor: this.buildScrollingGrid(
          centerX,
          areaTop,
          availW,
          availH,
          scale,
          gridH,
          posFor,
        ),
      };
    }

    // Everything fits: place cards centered in the area on the main camera, and
    // drop any carousel camera left over from a previous (scrolling) build.
    if (this.carouselCamera) {
      this.cameras.remove(this.carouselCamera, true);
      this.carouselCamera = undefined;
    }
    this.track = undefined;
    const top = areaTop + (availH - gridH) / 2;
    const decor: Phaser.GameObjects.GameObject[] = [];
    this.offers.forEach((offer, idx) => {
      const p = posFor(idx);
      const card = this.buildCard(p.x, top + p.y, offer, scale, idx, true);
      decor.push(card);
    });
    return { decor };
  }

  /** A one-row carousel for narrow screens. Larger cards overlap in a fan with
   * up to three visible positions, then overflow horizontally through the
   * clipped card camera. */
  private buildHorizontalCarousel(
    centerX: number,
    areaTop: number,
    availW: number,
    availH: number,
  ): Phaser.GameObjects.GameObject[] {
    const paddingX = Phaser.Math.Clamp(availW * 0.045, 12, 24);
    const paddingY = 8;
    const viewportX = centerX - availW / 2;
    const viewportW = availW;
    const contentX = viewportX + paddingX;
    const contentW = viewportW - paddingX * 2;
    const viewportTop = areaTop;
    const viewportH = availH;
    const indicatorH = 10;
    const contentH = Math.max(1, viewportH - paddingY * 2 - indicatorH);
    // At phone widths, 2.5 card widths fit across the viewport: three cards
    // remain visible, but overlap enough to be substantially larger than the
    // old edge-to-edge row.
    const scale = Math.min(contentH / CARD_H, contentW / (CARD_W * 2.5), 0.68);
    const cw = CARD_W * scale;
    const step = (contentW - cw) / 2;
    const trackW = cw + (this.offers.length - 1) * step;
    const overflow = trackW > contentW + 0.5 ? trackW - contentW : 0;

    const trackX = contentX + Math.max(0, (contentW - trackW) / 2);
    const track = this.add.container(trackX, 0);
    const fanCenter = (this.offers.length - 1) / 2;
    const centerY = viewportTop + paddingY + contentH / 2;
    const arcStep = Math.min(5, contentH * 0.018);
    this.carouselLayout = {
      viewportX,
      contentX,
      contentW,
      trackX,
      cardW: cw,
      step,
      centerY,
      arcStep,
    };
    this.offers.forEach((offer, idx) => {
      const distanceFromCenter = idx - fanCenter;
      const angle = Phaser.Math.DegToRad(
        Phaser.Math.Clamp(distanceFromCenter * 5, -10, 10),
      );
      const arcY = Math.abs(distanceFromCenter) * arcStep;
      const depth = this.offers.length - Math.abs(distanceFromCenter);
      // The resting pose, recorded up front: on the shop's first build
      // `buildCard` hands back a card already displaced by its deal-in
      // animation, so `card.y` is not where the card comes to rest.
      const restX = cw / 2 + idx * step;
      const restY = centerY + arcY;
      const card = this.buildCard(
        restX,
        restY,
        offer,
        scale,
        idx,
        false,
        true,
        angle,
      );
      card.setDepth(depth);
      track.add(card);
      this.carouselCards.push({
        offer,
        card,
        baseX: restX,
        baseY: restY,
        baseRotation: angle,
        baseDepth: depth,
        baseAlpha: 1,
      });
    });
    track.sort("depth");
    this.track = track;

    let pan = Phaser.Math.Clamp(this.pendingCarouselPan, 0, overflow);
    this.pendingCarouselPan = 0;
    const cam = this.ensureCarouselCamera();
    cam.setViewport(viewportX, viewportTop, viewportW, viewportH);
    cam.setScroll(viewportX + pan, viewportTop);
    this.cameras.main.ignore(track);

    this.dragDistance = 0;
    this.carouselDragging = false;

    const decor: Phaser.GameObjects.GameObject[] = [];
    let updateThumb = () => {};
    if (overflow > 0) {
      const barY = viewportTop + viewportH - 3;
      const barTrack = this.add.rectangle(
        centerX,
        barY,
        contentW,
        5,
        COLORS.inkSoft,
        0.4,
      );
      const thumbW = Math.max(30, (contentW * contentW) / trackW);
      const thumb = this.add.rectangle(
        contentX + thumbW / 2,
        barY,
        thumbW,
        5,
        COLORS.gold,
        0.9,
      );
      updateThumb = () => {
        thumb.x =
          contentX + thumbW / 2 + (pan / overflow) * (contentW - thumbW);
      };
      decor.push(barTrack, thumb);
    }

    const apply = () => {
      pan = Phaser.Math.Clamp(pan, 0, overflow);
      cam.setScroll(viewportX + pan, viewportTop);
      updateThumb();
      if (
        this.selectedCarouselIndex !== undefined &&
        this.carouselBuyButton?.visible
      ) {
        this.carouselBuyButton.x = this.carouselBuyButtonPosition(
          this.selectedCarouselIndex,
        ).x;
      }
    };

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= viewportX &&
      p.x <= viewportX + viewportW &&
      p.y >= viewportTop &&
      p.y <= viewportTop + viewportH;

    let dragging = false;
    let pressedBuy = false;
    let startPointerX = 0;
    let startPan = 0;

    const onDown: PointerHandler = (p, currentlyOver = []) => {
      pressedBuy = this.overCarouselBuy(p);
      const selectedEntry =
        this.selectedCarouselIndex === undefined
          ? undefined
          : this.carouselCards[this.selectedCarouselIndex];
      const clickedSelection =
        !!selectedEntry &&
        (pressedBuy || currentlyOver.includes(selectedEntry.card));
      if (selectedEntry && !clickedSelection) {
        this.deselectCarouselCard(true);
      }
      // A press on the buy button is a press, never the start of a swipe.
      if (pressedBuy || !inBounds(p)) return;
      dragging = true;
      this.carouselDragging = true;
      startPointerX = p.x;
      startPan = pan;
      this.dragDistance = 0;
    };
    const onMove: PointerHandler = (p) => {
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? "grab" : "default");
        return;
      }
      const dx = p.x - startPointerX;
      this.dragDistance = Math.abs(dx);
      if (this.dragDistance >= DRAG_THRESHOLD) {
        this.deselectCarouselCard(false);
        this.clearCarouselFocus();
      }
      pan = startPan - dx;
      apply();
    };
    const onUp: PointerHandler = (p) => {
      dragging = false;
      this.carouselDragging = false;
      if (pressedBuy && this.overCarouselBuy(p)) this.confirmCarouselPurchase();
      pressedBuy = false;
    };
    const onWheel: WheelHandler = (p, _over, dx, dy) => {
      if (!inBounds(p)) return;
      this.deselectCarouselCard(false);
      this.clearCarouselFocus();
      pan += Math.abs(dx) > Math.abs(dy) ? dx : dy;
      apply();
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.carouselInput = {
      down: onDown,
      move: onMove,
      up: onUp,
      wheel: onWheel,
    };

    decor.push(this.buildCarouselBuyButton());
    apply();
    return decor;
  }

  private buildCarouselBuyButton(): Phaser.GameObjects.Container {
    const width = Phaser.Math.Clamp(
      (this.carouselLayout?.contentW ?? 300) * 0.42,
      108,
      154,
    );
    const height = 34;
    const plate = this.add
      .rectangle(0, 0, width, height, COLORS.feltLight, 0.98)
      .setStrokeStyle(2, COLORS.gold, 0.9)
      .setInteractive({ useHandCursor: true });
    const label = this.add
      .text(0, 0, "BUY", {
        fontFamily: SERIF,
        fontSize: "13px",
        color: CSS.ivory,
        fontStyle: "bold",
        letterSpacing: 1,
      })
      .setOrigin(0.5);
    const button = this.add
      .container(0, 0, [plate, label])
      .setSize(width, height)
      .setAlpha(0)
      .setVisible(false);
    plate.on("pointerover", () => {
      if (this.selectedCarouselIndex !== undefined) {
        plate.setFillStyle(0x30264b, 1);
      }
    });
    plate.on("pointerout", () => plate.setFillStyle(COLORS.feltLight, 0.98));
    // The press itself is handled by the carousel's own pointer handlers, not
    // by this plate — see overCarouselBuy. The plate stays interactive for the
    // hand cursor and the hover fill.
    this.carouselBuyButton = button;
    this.carouselBuyLabel = label;
    this.carouselBuyPlate = plate;
    return button;
  }

  /** Screen-space hit test for the fan's buy button, run from the carousel's
   *  own pointer handlers instead of through Phaser's input system. The button
   *  hangs just below the focused card, which on a short viewport puts it
   *  inside the carousel camera's viewport — and that camera sits above the
   *  main one, so a press there resolves against whichever fanned card happens
   *  to lie under the button (the outer cards are rotated, so a corner often
   *  does) and never reaches the plate. The press then read as a click outside
   *  the selection and dismissed it. */
  private overCarouselBuy(p: Phaser.Input.Pointer): boolean {
    const button = this.carouselBuyButton;
    if (
      !button ||
      !button.visible ||
      this.selectedCarouselIndex === undefined ||
      this.purchaseAnimating
    ) {
      return false;
    }
    return (
      Math.abs(p.x - button.x) <= button.width / 2 &&
      Math.abs(p.y - button.y) <= button.height / 2
    );
  }

  private carouselBuyButtonPosition(index: number): { x: number; y: number } {
    const layout = this.carouselLayout;
    const entry = this.carouselCards[index];
    if (!layout || !entry) return { x: 0, y: 0 };
    const pan = this.carouselCamera
      ? this.carouselCamera.scrollX - layout.viewportX
      : 0;
    const cardH = layout.cardW * (CARD_H / CARD_W);
    // Hang the button off the focused card's actual pose: it rises by
    // FOCUS_LIFT and grows by FOCUS_SCALE, so its bottom edge sits here.
    const focusedBottom = entry.baseY - FOCUS_LIFT + (cardH * FOCUS_SCALE) / 2;
    return {
      x: layout.trackX + entry.baseX - pan,
      y: focusedBottom + 12,
    };
  }

  private selectCarouselCard(index: number): void {
    if (this.purchaseAnimating || !this.carouselCards[index]) return;
    if (this.selectedCarouselIndex === index) {
      this.deselectCarouselCard(false);
      return;
    }

    const reveal = () => {
      const entry = this.carouselCards[index];
      const button = this.carouselBuyButton;
      const label = this.carouselBuyLabel;
      const plate = this.carouselBuyPlate;
      if (!entry || !button || !label || !plate) return;
      this.selectedCarouselIndex = index;
      this.focusCarouselCard(index, true);
      const affordable = canAfford(this.state, entry.offer);
      const price =
        entry.offer.cost === 0 ? "FREE" : `${entry.offer.cost} GOLD`;
      label.setText(affordable ? `BUY · ${price}` : `NEED ${price}`);
      label.setColor(affordable ? CSS.ivory : CSS.red);
      plate.setStrokeStyle(2, affordable ? COLORS.gold : COLORS.waxRed, 0.9);
      const target = this.carouselBuyButtonPosition(index);
      this.tweens.killTweensOf(button);
      button
        .setPosition(target.x, target.y + 7)
        .setAlpha(0)
        .setVisible(true);
      this.tweens.add({
        targets: button,
        y: target.y,
        alpha: 1,
        duration: 150,
        ease: "Cubic.easeOut",
      });
    };

    if (this.selectedCarouselIndex !== undefined) {
      this.selectedCarouselIndex = undefined;
      this.fadeOutCarouselBuyButton(reveal);
    } else {
      reveal();
    }
  }

  private fadeOutCarouselBuyButton(onComplete?: () => void): void {
    const button = this.carouselBuyButton;
    if (!button || !button.visible) {
      onComplete?.();
      return;
    }
    this.tweens.killTweensOf(button);
    this.tweens.add({
      targets: button,
      y: button.y + 7,
      alpha: 0,
      duration: 120,
      ease: "Cubic.easeIn",
      onComplete: () => {
        button.setVisible(false);
        onComplete?.();
      },
    });
  }

  private deselectCarouselCard(clearFocus = true): void {
    if (this.selectedCarouselIndex === undefined) return;
    this.selectedCarouselIndex = undefined;
    this.fadeOutCarouselBuyButton();
    if (clearFocus) this.clearCarouselFocus();
  }

  private confirmCarouselPurchase(): void {
    const index = this.selectedCarouselIndex;
    if (index === undefined || this.purchaseAnimating) return;
    const entry = this.carouselCards[index];
    if (!entry || !canAfford(this.state, entry.offer)) {
      audio.deny();
      return;
    }
    this.selectedCarouselIndex = undefined;
    this.fadeOutCarouselBuyButton();
    this.clearCarouselFocus();
    this.choose(entry.offer);
  }

  /** Bring one fanned card forward while its immediate neighbors slide down
   * and outward, exposing the focused card's full text and silhouette. */
  private focusCarouselCard(index: number, force = false): void {
    if (
      this.purchaseAnimating ||
      (this.carouselDragging && !force) ||
      !this.carouselLayout ||
      this.focusedCarouselIndex === index
    ) {
      return;
    }
    this.focusedCarouselIndex = index;
    const duckX = Phaser.Math.Clamp(this.carouselLayout.cardW * 0.3, 30, 55);
    const duckY = Phaser.Math.Clamp(this.carouselLayout.cardW * 0.03, 3, 6);

    this.carouselCards.forEach((entry, cardIndex) => {
      const distance = cardIndex - index;
      const magnitude = Math.abs(distance);
      const direction = Math.sign(distance);
      this.tweens.killTweensOf(entry.card);
      entry.card.setDepth(distance === 0 ? 1000 : entry.baseDepth);
      this.tweens.add({
        targets: entry.card,
        x: entry.baseX + direction * (magnitude === 1 ? duckX : duckX * 0.4),
        y:
          entry.baseY +
          (distance === 0
            ? -FOCUS_LIFT
            : magnitude === 1
              ? duckY
              : duckY * 0.45),
        rotation:
          distance === 0
            ? 0
            : entry.baseRotation + Phaser.Math.DegToRad(direction * 3),
        scaleX: distance === 0 ? FOCUS_SCALE : 1,
        scaleY: distance === 0 ? FOCUS_SCALE : 1,
        alpha: entry.baseAlpha,
        duration: 150,
        ease: "Cubic.easeOut",
      });
    });
    this.track?.sort("depth");
  }

  private clearCarouselFocus(): void {
    if (this.purchaseAnimating || this.focusedCarouselIndex === undefined)
      return;
    this.focusedCarouselIndex = undefined;
    this.carouselCards.forEach((entry) => {
      this.tweens.killTweensOf(entry.card);
      entry.card.setDepth(entry.baseDepth);
      this.tweens.add({
        targets: entry.card,
        x: entry.baseX,
        y: entry.baseY,
        rotation: entry.baseRotation,
        scaleX: 1,
        scaleY: 1,
        alpha: entry.baseAlpha,
        duration: 130,
        ease: "Cubic.easeOut",
      });
    });
    this.track?.sort("depth");
  }

  /** Lift and dissolve the purchased card, while the cards left in the fan
   * slide into the geometry they will occupy after the shop rebuild. */
  private animateCardPurchase(
    offer: ShopOffer,
    card: Phaser.GameObjects.Container,
    onComplete: () => void,
  ): void {
    if (!fx.motion || this.purchaseAnimating) {
      onComplete();
      return;
    }

    this.purchaseAnimating = true;
    this.teardownCarouselInput();
    this.offerCards.forEach((candidate) => candidate.disableInteractive());
    this.tweens.killTweensOf(card);
    card.setDepth(2000);

    const world = card.getWorldTransformMatrix().transformPoint(0, 0);
    const cam = this.carouselCamera;
    const burstX =
      cam && this.carouselCards.some((entry) => entry.offer === offer)
        ? world.x - cam.scrollX + cam.x
        : world.x;
    const burstY =
      cam && this.carouselCards.some((entry) => entry.offer === offer)
        ? world.y - cam.scrollY + cam.y
        : world.y;
    const burst = fx.burst(this, burstX, burstY, {
      count: 22,
      tint: COLORS.goldLight,
      speed: 230,
      lifespan: 720,
    });
    if (burst && cam) cam.ignore(burst);

    const layout = this.carouselLayout;
    const purchasedInFan = this.carouselCards.some(
      (entry) => entry.offer === offer,
    );
    if (purchasedInFan) this.track?.bringToTop(card);
    if (layout && purchasedInFan) {
      const remaining = this.carouselCards.filter(
        (entry) => entry.offer !== offer,
      );
      const count = remaining.length;
      const trackW = count > 0 ? layout.cardW + (count - 1) * layout.step : 0;
      const trackX =
        layout.contentX + Math.max(0, (layout.contentW - trackW) / 2);
      const overflow = Math.max(0, trackW - layout.contentW);
      const currentPan = cam ? cam.scrollX - layout.viewportX : 0;
      const targetPan = Phaser.Math.Clamp(currentPan, 0, overflow);
      this.pendingCarouselPan = targetPan;
      const fanCenter = (count - 1) / 2;

      remaining.forEach((entry, index) => {
        const distanceFromCenter = index - fanCenter;
        const targetRotation = Phaser.Math.DegToRad(
          Phaser.Math.Clamp(distanceFromCenter * 5, -10, 10),
        );
        const targetDepth = count - Math.abs(distanceFromCenter);
        const targetAlpha = 1;
        this.tweens.killTweensOf(entry.card);
        entry.card.setDepth(targetDepth);
        this.tweens.add({
          targets: entry.card,
          x: trackX - layout.trackX + layout.cardW / 2 + index * layout.step,
          y: layout.centerY + Math.abs(distanceFromCenter) * layout.arcStep,
          rotation: targetRotation,
          scaleX: 1,
          scaleY: 1,
          alpha: targetAlpha,
          duration: 360,
          delay: 60,
          ease: "Cubic.easeInOut",
        });
      });
      this.track?.sort("depth");
      this.track?.bringToTop(card);
      if (cam) {
        this.tweens.add({
          targets: cam,
          scrollX: layout.viewportX + targetPan,
          duration: 360,
          delay: 60,
          ease: "Cubic.easeInOut",
        });
      }
    }

    this.tweens.add({
      targets: card,
      y: card.y - 54,
      rotation: 0,
      scaleX: 1.18,
      scaleY: 1.18,
      alpha: 0,
      duration: 420,
      ease: "Back.easeIn",
      onComplete: () => {
        this.purchaseAnimating = false;
        onComplete();
      },
    });
  }

  /** A vertically scrollable grid of offer cards (drag/swipe, mouse wheel, and a
   *  scrollbar), used only when the cards can't shrink enough to fit the area. */
  private buildScrollingGrid(
    centerX: number,
    areaTop: number,
    availW: number,
    availH: number,
    scale: number,
    gridH: number,
    posFor: (idx: number) => { x: number; y: number },
  ): Phaser.GameObjects.GameObject[] {
    const viewportX = centerX - availW / 2;
    const overflow = Math.max(0, gridH - availH);

    // Cards live in a track container placed at the top of the card area; the
    // camera's vertical scroll pans it. See ensureCarouselCamera for why a
    // dedicated camera (native scissor clipping) is used instead of a mask.
    const track = this.add.container(0, areaTop);
    this.offers.forEach((offer, idx) => {
      const p = posFor(idx);
      // No filters in the carousel: a filtered object renders through its own
      // camera, which sidesteps the scissor rect this one relies on for
      // clipping — a glowing card would bleed past the card area's edges.
      const card = this.buildCard(p.x, p.y, offer, scale, idx, false);
      track.add(card);
    });
    this.track = track;

    // At zoom 1 the camera is a pure passthrough when its scroll matches the
    // viewport's screen position; adding `pan` to scrollY moves content up.
    const cam = this.ensureCarouselCamera();
    cam.setViewport(viewportX, areaTop, availW, availH);
    cam.setScroll(viewportX, areaTop);
    this.cameras.main.ignore(track);

    this.dragDistance = 0;
    let pan = 0;

    const barX = viewportX + availW - 8;
    const barTrack = this.add.rectangle(
      barX,
      areaTop + availH / 2,
      5,
      availH,
      COLORS.inkSoft,
      0.4,
    );
    const thumbH = Math.max(30, (availH * availH) / gridH);
    const thumb = this.add.rectangle(
      barX,
      areaTop + thumbH / 2,
      5,
      thumbH,
      COLORS.gold,
      0.9,
    );
    const updateThumb = () => {
      const progress = overflow > 0 ? pan / overflow : 0;
      thumb.y = areaTop + thumbH / 2 + progress * (availH - thumbH);
    };
    const apply = () => {
      pan = Phaser.Math.Clamp(pan, 0, overflow);
      cam.setScroll(viewportX, areaTop + pan);
      updateThumb();
    };

    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= viewportX &&
      p.x <= viewportX + availW &&
      p.y >= areaTop &&
      p.y <= areaTop + availH;

    let dragging = false;
    let startPointerY = 0;
    let startPan = 0;

    const onDown: PointerHandler = (p) => {
      if (!inBounds(p)) return;
      dragging = true;
      startPointerY = p.y;
      startPan = pan;
      this.dragDistance = 0;
    };
    const onMove: PointerHandler = (p) => {
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? "grab" : "default");
        return;
      }
      const dy = p.y - startPointerY;
      this.dragDistance = Math.abs(dy);
      pan = startPan - dy;
      apply();
    };
    const onUp: PointerHandler = () => {
      dragging = false;
    };
    const onWheel: WheelHandler = (p, _over, dx, dy) => {
      if (!inBounds(p)) return;
      const delta = Math.abs(dy) > Math.abs(dx) ? dy : dx;
      pan += delta;
      apply();
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.carouselInput = {
      down: onDown,
      move: onMove,
      up: onUp,
      wheel: onWheel,
    };

    return [barTrack, thumb];
  }

  private buildCard(
    x: number,
    y: number,
    offer: ShopOffer,
    scale: number,
    index: number,
    allowFilters: boolean,
    compact = false,
    rotation = 0,
  ): Phaser.GameObjects.Container {
    const affordable = canAfford(this.state, offer);
    // Edge metadata (rarity and price) may shrink furthest; description and
    // title retain progressively larger floors for the card's reading order.
    const fontSize = (native: number, minimum: number) => {
      const floor = compact ? Math.round(minimum * 0.55) : minimum;
      return `${Math.max(floor, Math.round(native * scale))}px`;
    };
    const img = this.add.image(0, 0, "card");
    img.setDisplaySize(CARD_W * scale, CARD_H * scale);
    const rarityColor = {
      common: CSS.rarityCommon,
      uncommon: CSS.rarityUncommon,
      rare: CSS.rarityRare,
    }[offer.rarity];
    const rarityLabel = this.add
      .text(0, -148 * scale, offer.rarity.toUpperCase(), {
        fontFamily: SERIF,
        fontSize: fontSize(13, 8),
        color: rarityColor,
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    const name = this.add
      .text(0, -110 * scale, offer.name, {
        fontFamily: SERIF,
        fontSize: fontSize(26, 16),
        color: CSS.ink,
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: 220 * scale },
      })
      .setOrigin(0.5);
    const desc = this.add
      .text(0, -10 * scale, offer.desc, {
        fontFamily: SERIF,
        fontSize: fontSize(19, 12),
        color: CSS.inkSoft,
        align: "center",
        wordWrap: { width: 214 * scale },
      })
      .setOrigin(0.5);
    const costLabel = offer.freeByCoupon
      ? "Coupon Book: Free"
      : offer.cost === 0
        ? "Free"
        : `${offer.cost} gold`;
    const cost = this.add
      .text(0, 128 * scale, costLabel, {
        fontFamily: SERIF,
        fontSize: fontSize(24, 14),
        color: affordable ? CSS.gold : CSS.red,
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    const card = this.add
      .container(x, y, [img, rarityLabel, name, desc, cost])
      .setRotation(rotation);
    card.setSize(img.displayWidth, img.displayHeight);
    this.offerCards.set(offer, card);

    if (compact || affordable) {
      card.setInteractive({ useHandCursor: true });
      // Compact cards select on press and require the separate buy button;
      // selecting immediately pins the hover pose instead of briefly returning
      // to the resting scale before pointer release. Wide layouts retain their
      // direct-card interaction on release.
      let pressedHere = false;
      card.on("pointerover", () => {
        const hoverAllowed =
          !compact ||
          this.selectedCarouselIndex === undefined ||
          this.selectedCarouselIndex === index;
        if (affordable && hoverAllowed) img.setTint(0xfff2c8);
        if (compact && hoverAllowed) this.focusCarouselCard(index);
      });
      card.on("pointerout", () => {
        if (affordable) img.clearTint();
        pressedHere = false;
        if (compact && !this.carouselDragging) {
          if (this.selectedCarouselIndex !== undefined) {
            this.focusCarouselCard(this.selectedCarouselIndex);
          } else {
            this.clearCarouselFocus();
          }
        }
      });
      card.on("pointerdown", () => {
        if (compact) {
          pressedHere = false;
          this.focusCarouselCard(index, true);
          this.selectCarouselCard(index);
        } else {
          pressedHere = affordable;
        }
      });
      card.on("pointerup", () => {
        const activate = pressedHere && this.dragDistance < DRAG_THRESHOLD;
        pressedHere = false;
        if (activate && affordable) this.choose(offer);
      });
    }
    if (!affordable) {
      // Keep the parchment itself opaque so overlapping unavailable cards do
      // not compound container alpha. Tinting the face and softening its copy
      // produces the same dim read without revealing the card underneath.
      img.setTint(0x978e79);
      rarityLabel.setAlpha(0.72);
      name.setAlpha(0.72);
      desc.setAlpha(0.68);
      cost.setAlpha(0.86);
    }

    if (allowFilters && offer.rarity === "rare") this.markRare(img);
    this.dealIn(card, index);
    return card;
  }

  /** Deal the offers onto the table rather than having them appear on it:
   *  each card drops in from below with a slight tilt, staggered along the
   *  row. Runs only on the shop's first build — see `dealt`. */
  private dealIn(card: Phaser.GameObjects.Container, index: number): void {
    if (!fx.on || this.dealt) return;
    const restY = card.y;
    const restRotation = card.rotation;
    // Unaffordable cards rest dimmed, so tween to whatever alpha the card was
    // given rather than assuming 1.
    const restAlpha = card.alpha;
    card.setAlpha(0).setY(restY + 46);
    if (fx.motion) card.setRotation(Phaser.Math.FloatBetween(-0.08, 0.08));
    this.tweens.add({
      targets: card,
      y: restY,
      alpha: restAlpha,
      rotation: restRotation,
      duration: 320,
      delay: index * 70,
      ease: "Cubic.easeOut",
    });
  }

  /** Slow gold pulse around a rare card, so rarity is legible before the
   *  rarity line is read. A filter pass per card is exactly the cost the rich
   *  tier gates — and a shop holds at most one or two rares. */
  private markRare(img: Phaser.GameObjects.Image): void {
    const glow = fx.glow(img, COLORS.goldLight, 0);
    if (!glow) return;
    this.tweens.add({
      targets: glow,
      outerStrength: 5,
      duration: 1600,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private openPack(pack: BoosterOffer, origin: PackOrigin): void {
    if (pack.sold || this.openingPack) return;
    const price = boosterPrice(this.state, pack);
    if (this.state.gold < price) {
      audio.deny();
      return;
    }
    // Buying a pack is spending gold, which is all the shop step asks for.
    // It also has to clear the callout before the pack overlay is built —
    // see ensureCalloutCamera.
    this.endShopTutorial();
    const choices = openBooster(
      this.state,
      pack,
      this.state.ownedLedger ? 5 : 3,
      Math.random,
      this.visitWeights,
    );
    if (choices.length === 0) {
      audio.deny();
      return;
    }
    this.state.gold -= price;
    pack.sold = true;
    this.openingPack = pack;
    this.packChoices = choices;
    audio.buy();
    this.showBoosterChoices(true, origin);
  }

  /** Focus a purchased pack over the shop, break its seal, then flip its free
   * choices into view. Reused without animation after a resize. */
  private showBoosterChoices(animate: boolean, origin?: PackOrigin): void {
    if (!this.packChoices || !this.openingPack) return;
    this.packGroup?.destroy();
    const staged = animate && fx.motion && !!origin;
    if (staged) origin.source.setVisible(false);
    if (!staged) {
      this.cardGroup?.setVisible(false);
      this.track?.setVisible(false);
      if (this.carouselCamera) this.carouselCamera.visible = false;
    }

    const W = this.scale.width;
    const H = this.scale.height;
    const objects: Phaser.GameObjects.GameObject[] = [];
    const shade = this.add
      .rectangle(W / 2, H / 2, W, H, COLORS.feltDark, 0.94)
      .setInteractive();
    if (staged) shade.setAlpha(0);
    objects.push(shade);
    const title = this.add
      .text(
        W / 2,
        Math.max(38, H * 0.07),
        `${this.openingPack.name} · CHOOSE ONE`,
        {
          fontFamily: SERIF,
          fontSize: `${Phaser.Math.Clamp(W * 0.038, 21, 38)}px`,
          color: CSS.goldLight,
          fontStyle: "bold",
          align: "center",
          wordWrap: { width: W - 36 },
        },
      )
      .setOrigin(0.5);
    objects.push(title);

    const n = this.packChoices.length;
    const portrait = H > W * 1.05;
    const cols = portrait ? Math.min(2, n) : n;
    const rows = Math.ceil(n / cols);
    const gap = 14;
    const top = Math.max(78, H * 0.13);
    const bottom = H - 25;
    const scale = Math.min(
      0.78,
      (W - 34) / (cols * CARD_W + (cols - 1) * gap),
      (bottom - top) / (rows * CARD_H + (rows - 1) * gap),
    );
    const cw = CARD_W * scale;
    const ch = CARD_H * scale;
    const scaledGap = gap * scale;
    const gridH = rows * ch + (rows - 1) * scaledGap;
    const gridTop = top + Math.max(0, (bottom - top - gridH) / 2);
    const cards: Phaser.GameObjects.Container[] = [];
    this.packChoices.forEach((offer, index) => {
      const row = Math.floor(index / cols);
      const rowStart = row * cols;
      const rowCount = Math.min(cols, n - rowStart);
      const col = index - rowStart;
      const rowW = rowCount * cw + (rowCount - 1) * scaledGap;
      const x = W / 2 - rowW / 2 + cw / 2 + col * (cw + scaledGap);
      const y = gridTop + ch / 2 + row * (ch + scaledGap);
      const card = this.buildCard(x, y, offer, scale, index, true);
      card.setDepth(102);
      cards.push(card);
      objects.push(card);
    });

    const shellW = Math.min(260, W * 0.48);
    const shellH = Math.min(340, H * 0.55);
    const shell = this.buildOpeningPack(
      this.openingPack,
      W / 2,
      H / 2,
      shellW,
      shellH,
    );
    objects.push(shell);
    this.packGroup = this.add.container(0, 0, objects).setDepth(100);

    if (!staged) {
      shell.destroy();
      cards.forEach((card) => card.setAlpha(1).setScale(1));
      return;
    }

    title.setAlpha(0);
    cards.forEach((card) => {
      card.setAlpha(0).setScale(0.04, 1);
      if (card.input) card.input.enabled = false;
    });
    shell
      .setPosition(origin.x, origin.y)
      .setScale(origin.width / shellW, origin.height / shellH);
    this.tweens.add({
      targets: shade,
      alpha: 0.94,
      duration: 420,
      ease: "Sine.easeInOut",
    });
    if (this.carouselCamera) {
      this.tweens.add({
        targets: this.carouselCamera,
        alpha: 0,
        duration: 320,
        onComplete: () => {
          if (this.carouselCamera) {
            this.carouselCamera.visible = false;
            this.carouselCamera.alpha = 1;
          }
        },
      });
    }
    this.tweens.add({
      targets: shell,
      x: W / 2,
      y: H / 2,
      scaleX: 1,
      scaleY: 1,
      angle: -2,
      duration: 500,
      ease: "Cubic.easeInOut",
      onComplete: () => {
        this.cardGroup?.setVisible(false);
        this.track?.setVisible(false);
        this.tweens.add({
          targets: shell,
          angle: { from: -2, to: 2 },
          duration: 75,
          yoyo: true,
          repeat: 4,
          onComplete: () => {
            fx.burst(this, W / 2, H / 2, {
              count: 48,
              tint: COLORS.goldLight,
              speed: 360,
              lifespan: 900,
            });
            shell.destroy();
            this.tweens.add({ targets: title, alpha: 1, duration: 220 });
            cards.forEach((card, index) => {
              this.tweens.add({
                targets: card,
                alpha: 1,
                scaleX: 1,
                scaleY: 1,
                duration: 330,
                delay: index * 115,
                ease: "Back.easeOut",
                onComplete: () => {
                  if (card.input) card.input.enabled = true;
                },
              });
            });
          },
        });
      },
    });
  }

  /** Close the shop step for good: advancing is what keeps it from coming back
   *  on the next rebuild (a reroll, a resize, the die picker). */
  private endShopTutorial(): void {
    const t = getTutorial(this.registry);
    if (!t.active || t.stage !== TutorialStage.Shop) return;
    advanceTutorial(this.registry);
    this.tutorialCallout?.destroy();
    this.tutorialCallout = undefined;
    this.removeCalloutCamera();
  }

  private choose(offer: ShopOffer): void {
    // Selecting any item satisfies the tutorial's shop step (fires for both
    // direct and target-picking offers, since both funnel through here).
    this.endShopTutorial();
    if (offer.needsTarget) {
      this.enterPickMode(offer);
      return;
    }
    if (this.applyChosenOffer(offer)) {
      this.completeChosenOffer(offer);
    } else {
      audio.deny();
    }
  }

  private applyChosenOffer(
    offer: ShopOffer,
    targetIndex?: number,
    targetIndices?: number[],
  ): boolean {
    return this.packChoices?.includes(offer)
      ? applyBoosterChoice(this.state, offer, targetIndex, targetIndices)
      : applyOffer(this.state, offer, targetIndex, targetIndices);
  }

  private completeChosenOffer(offer: ShopOffer): void {
    // These cards were priced when the visit opened. Pawnbroker takes effect
    // on the current row immediately, including when claimed from a pack.
    if (offer.id === "pawnbroker") {
      discountOffersForPawnbroker(this.offers);
    }

    if (this.packChoices?.includes(offer)) {
      recordSelection(offer.id);
      audio.buy();
      if (offer.id === "coupon_book") {
        applyCouponFreebie(this.state, this.offers);
      }
      this.packChoices = undefined;
      this.openingPack = undefined;
      this.packGroup = undefined;
      this.rebuildShop();
      return;
    }
    this.completePurchase(offer);
  }

  /** Which dice a given offer may target. */
  private eligibleFor(offer: ShopOffer, die: Die): boolean {
    switch (offer.id) {
      case "shrink":
      case "grindstone":
        return canShrink(die);
      case "loaded_die":
        return canLoad(die);
      case "royal_seal":
        return !this.state.royalSealSizes.includes(die.sides);
      default: // twin, wild_face
        return true;
    }
  }

  private promptFor(offer: ShopOffer): string {
    if (offer.targetCount && offer.targetCount > 1) {
      return `Choose die ${this.pickedIndices.length + 1} of ${offer.targetCount} to shrink`;
    }
    switch (offer.id) {
      case "shrink":
        return "Choose a die to shrink";
      case "grindstone":
        return "Choose a die — its whole size shrinks";
      case "twin":
        return "Choose a die — its whole size is duplicated";
      case "loaded_die":
        return "Choose a die — its whole size is loaded";
      case "wild_face":
        return "Choose a die — its whole size turns wild";
      case "royal_seal":
        return "Choose a die — its size receives the Royal Seal";
      default:
        return "Choose a die";
    }
  }

  /** Show the player's grid and let them pick (a) target die/dice. Above
   *  WINDOW_THRESHOLD, one sprite per die is both a rendering problem and
   *  bad UX (scrolling through thousands of identical icons) — dice of the
   *  same type/flags are interchangeable, so pick by group instead. */
  private enterPickMode(offer: ShopOffer): void {
    this.cardGroup.setVisible(false);
    this.track?.setVisible(false);
    this.packGroup?.setVisible(false);
    if (this.carouselCamera) this.carouselCamera.visible = false;
    this.pickedIndices = [];
    this.renderPicker(offer);
  }

  private renderPicker(offer: ShopOffer): void {
    this.pickGroup?.destroy();

    const W = this.scale.width;
    const H = this.scale.height;
    const items: Phaser.GameObjects.GameObject[] = [];
    items.push(
      this.add
        .text(W / 2, H * 0.12, this.promptFor(offer), {
          fontFamily: SERIF,
          fontSize: "34px",
          color: CSS.ink,
          fontStyle: "bold",
        })
        .setOrigin(0.5),
    );

    const area = { x: W * 0.08, y: H * 0.2, width: W * 0.84, height: H * 0.58 };
    const grouped = this.state.dice.length > WINDOW_THRESHOLD;
    // Build the die grid defensively: a throw here must never strand the player
    // in a picker with no way back — the "Back to the Offerings" button below is
    // always added regardless.
    try {
      items.push(
        ...(grouped
          ? this.buildGroupedPicker(offer, area)
          : this.buildIndividualPicker(offer, area)),
      );
    } catch (err) {
      console.error("Failed to build die picker", err);
    }

    items.push(
      bannerButton(
        this,
        W / 2,
        H - Math.min(75, H * 0.1),
        "Back to the Offerings",
        () => {
          this.pickGroup?.destroy();
          this.pickGroup = undefined;
          if (this.packChoices) {
            this.packGroup?.setVisible(true);
          } else {
            this.cardGroup.setVisible(true);
            this.track?.setVisible(true);
            if (this.carouselCamera) this.carouselCamera.visible = true;
          }
        },
      ),
    );

    this.pickGroup = this.add.container(0, 0, items);
  }

  private buildIndividualPicker(
    offer: ShopOffer,
    area: GridArea,
  ): Phaser.GameObjects.GameObject[] {
    const items: Phaser.GameObjects.GameObject[] = [];
    const visible = this.state.dice
      .map((die, i) => ({ die, i }))
      .filter(({ i }) => !this.pickedIndices.includes(i));
    const { scale, positions } = computeGridPositions(
      visible.length,
      area,
      112,
    );

    visible.forEach(({ die, i }, pos) => {
      const sprite = new DieSprite(
        this,
        positions[pos].x,
        positions[pos].y,
        die,
      );
      sprite.setScale(scale);
      sprite.showFace(null);

      if (this.eligibleFor(offer, die)) {
        sprite.setSize(104, 104);
        sprite.setInteractive({ useHandCursor: true });
        sprite.on("pointerover", () => sprite.setScale(scale * 1.12));
        sprite.on("pointerout", () => sprite.setScale(scale));
        sprite.on("pointerdown", () => this.onPick(offer, i));
      } else {
        sprite.setAlpha(0.35);
      }
      items.push(sprite);
    });
    return items;
  }

  /** One representative sprite + count badge per distinct (sides, maxFaceBonus,
   *  loaded, wildFace) combination — grouping on all four flags keeps every
   *  group homogeneous w.r.t. `eligibleFor`, so a group's single representative
   *  always reflects the whole group's eligibility. Picking one targets the
   *  first matching die. */
  private buildGroupedPicker(
    offer: ShopOffer,
    area: GridArea,
  ): Phaser.GameObjects.GameObject[] {
    const entries = this.state.dice
      .groups(this.pickedIndices)
      .sort((a, b) => b.die.sides - a.die.sides);
    const { scale, positions } = computeGridPositions(
      entries.length,
      area,
      112,
    );

    const items: Phaser.GameObjects.GameObject[] = [];
    entries.forEach((group, i) => {
      const { x, y } = positions[i];
      const die = group.die;
      const sprite = new DieSprite(this, x, y, die);
      sprite.setScale(scale);
      sprite.showFace(null);
      items.push(sprite);

      items.push(
        this.add
          .text(x, y + 50 * scale, `×${group.count}`, {
            fontFamily: SERIF,
            fontSize: "15px",
            color: CSS.goldLight,
            fontStyle: "bold",
          })
          .setOrigin(0.5),
      );

      if (this.eligibleFor(offer, die)) {
        sprite.setSize(104, 104);
        sprite.setInteractive({ useHandCursor: true });
        sprite.on("pointerover", () => sprite.setScale(scale * 1.12));
        sprite.on("pointerout", () => sprite.setScale(scale));
        sprite.on("pointerdown", () => this.onPick(offer, group.firstIndex));
      } else {
        sprite.setAlpha(0.35);
      }
    });
    return items;
  }

  private onPick(offer: ShopOffer, index: number): void {
    if (offer.targetCount && offer.targetCount > 1) {
      this.pickedIndices.push(index);
      if (this.pickedIndices.length < offer.targetCount) {
        this.renderPicker(offer);
        return;
      }
      if (this.applyChosenOffer(offer, undefined, this.pickedIndices)) {
        this.completeChosenOffer(offer);
      } else {
        audio.deny();
      }
      return;
    }
    if (this.applyChosenOffer(offer, index)) {
      this.completeChosenOffer(offer);
    } else {
      audio.deny();
    }
  }

  private completePurchase(offer: ShopOffer): void {
    const purchasedCard = this.offerCards.get(offer);
    recordSelection(offer.id);
    audio.buy();
    this.purchasesMade += 1;
    this.offers = this.offers.filter((candidate) => candidate !== offer);

    // Coupon Book affects the rest of the visit in which it is bought: one of
    // the remaining cards becomes free.
    if (offer.id === "coupon_book") applyCouponFreebie(this.state, this.offers);

    // Running the loose-card row dry no longer closes the shop: sealed packs
    // remain separate purchases and the player may still want either one.
    if (purchasedCard && this.pickGroup) {
      this.pickGroup.destroy();
      this.pickGroup = undefined;
      this.cardGroup.setVisible(true);
      this.track?.setVisible(true);
      if (this.carouselCamera) this.carouselCamera.visible = true;
    }
    if (purchasedCard) {
      this.animateCardPurchase(offer, purchasedCard, () => this.rebuildShop());
    } else {
      this.rebuildShop();
    }
  }

  private rerollStore(): void {
    const price = rerollIsFree(this.state, this.rerollsThisVisit)
      ? 0
      : rerollCost(this.rerollsThisVisit);
    if (this.state.gold < price) {
      audio.deny();
      return;
    }
    this.state.gold -= price;
    this.rerollsThisVisit += 1;
    this.pendingCarouselPan = 0;
    audio.click();
    this.offers = rerollShopOffers(
      this.state,
      this.state.ownedLedger ? 5 : 3,
      Math.random,
      this.visitWeights,
    );
    this.rebuildShop();
  }

  private rebuildShop(): void {
    this.tutorialCallout?.destroy();
    this.tutorialCallout = undefined;
    this.removeCalloutCamera();
    this.pickGroup = undefined;
    this.packGroup = undefined;
    this.track = undefined;
    this.teardownCarouselInput();
    destroyAllChildren(this);
    this.build();
  }

  private exit(): void {
    slideSceneOut(
      this,
      () => this.scene.start("TrialOverview"),
      this.slideBackdrop,
    );
  }
}
