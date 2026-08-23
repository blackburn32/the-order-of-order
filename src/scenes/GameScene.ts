import Phaser from "phaser";
import { rankOf, trialInRank } from "../config";
import { COLORS, CSS, SERIF } from "../art/palette";
import { getRun, type RunState } from "../state/RunState";
import type { Die } from "../systems/Dice";
import type { ShopItemId } from "../systems/Items";
import { activeBoss, goalFor } from "../systems/Boss";
import {
  resolveRoll,
  resolveTrialEnd,
  trialComplete,
  trialRollTarget,
} from "../sim/engine";
import { scoringNumbersFor } from "../systems/Boss";
import { audio } from "../systems/Audio";
import { fx } from "../systems/Effects";
import { evaluateAndUnlock } from "../systems/SaveData";
import { finalizeRun } from "../systems/RunEnd";
import { AmbientLayer } from "../ui/AmbientLayer";
import { DieSprite } from "../ui/DieSprite";
import { DiceSummaryCard } from "../ui/DiceSummaryCard";
import { formatScore } from "../ui/formatScore";
import { addFelt, floatText, BannerStack } from "../ui/widgets";
import { showCallout, CalloutHandle } from "../ui/Callout";
import {
  advanceTutorial,
  getTutorial,
  tutorialBlocksScore,
  tutorialForcesRoll,
  TutorialStage,
  TUTORIAL_TEXT,
} from "../systems/Tutorial";
import {
  isCompactLandscape,
  isPortrait,
  onResizeCoalesced,
} from "../ui/layout";
import { GridArea } from "../ui/gridLayout";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import { buildRunFooterLinks } from "../ui/runFooterLinks";
import {
  clampZoom,
  computeVisibleDiceCards,
  computeWindowedView,
  fitGridZoom,
  GridFocus,
  gridDetailLevel,
  GridDetailLevel,
  VisibleDiceCard,
  Viewport,
} from "../ui/windowedGrid";

// The HUD strip. Adding an entry here is all it takes: computeLayout sizes the
// cells proportionally by `weight`, and buildHud/makePlaque draw them. RANK
// shows "rank-trial" (2-3 is the Boss Trial of rank 2) so the ladder position
// fits one narrow cell instead of needing two.
const HUD_STATS = [
  { key: "roll", label: "ROLLS", weight: 0.9, color: CSS.ivory },
  { key: "rank", label: "RANK", weight: 0.8, color: CSS.goldLight },
  { key: "target", label: "GOAL", weight: 1.15, color: CSS.parchment },
  { key: "score", label: "SCORE", weight: 1.3, color: CSS.goldLight },
  { key: "gold", label: "GOLD", weight: 0.75, color: CSS.gold },
] as const;
type HudStatKey = (typeof HUD_STATS)[number]["key"];
const SEAL_RADIUS = 85; // half of the 170x170 seal texture

/** Pixels the felt bleeds past the viewport, so a camera shake never drags a
 *  bare edge into frame. */
const FELT_OVERSCAN = 16;

/** A roll worth this fraction of the trial's goal is a "big" one: it earns a
 *  shake and a spark burst rather than passing quietly. */
const BIG_SCORE_FRACTION = 0.08;

/** Felt tint at an empty score, at the trial's goal, and on a final roll that
 *  arrived short of it. The scene warms as the target
 *  comes into reach and goes cold and bloody when the trial is about to be
 *  lost — the same signal the sigil carries, spread across the whole table. */
const TENSION_FELT_TINT = {
  idle: 0xffffff,
  met: 0xffe6bd,
  danger: 0xffb8b8,
};

/** Halo opacity behind the roll seal, at rest and under the cursor. */
const SEAL_HALO_IDLE = 0.16;
const SEAL_HALO_HOVER = 0.32;

/** How far apart the top and bottom rows of dice land, in ms. */
const SETTLE_RIPPLE_MS = 140;

/** Keep roll feedback bounded even when a modifier hits the whole grid. */
const MAX_PULSED_DICE = 64;
const MAX_INDIVIDUAL_SETTLE_DICE = 100;

/** Select evenly across an index-ordered list instead of clustering feedback
 *  at the start of the grid. Returns the original list when it fits the cap. */
function evenlySample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const sampled: T[] = [];
  const stride = items.length / limit;
  for (let i = 0; i < limit; i++) sampled.push(items[Math.floor(i * stride)]);
  return sampled;
}

/** Blend two packed RGB colours. */
function blendColor(from: number, to: number, t: number): number {
  const mix = Phaser.Display.Color.Interpolate.ColorWithColor(
    Phaser.Display.Color.IntegerToColor(from),
    Phaser.Display.Color.IntegerToColor(to),
    100,
    Phaser.Math.Clamp(t, 0, 1) * 100,
  );
  return Phaser.Display.Color.GetColor(mix.r, mix.g, mix.b);
}

interface HudCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  hud: Record<HudStatKey, HudCell>;
  footer: { numbersY: number; settingsY: number };
  grid: GridArea;
  /** Seal centre, plus the scale the seal art is drawn at — the compact
   *  landscape rail is narrower than the 170px texture. */
  button: { x: number; y: number; scale: number };
}

export class GameScene extends Phaser.Scene {
  private state!: RunState;
  // Keyed by index into state.dice. Only indices inside the current viewport
  // have sprites, so rendering cost stays bounded at every grid size.
  private sprites!: Map<number, DieSprite>;
  private cards!: Map<string, DiceSummaryCard>;
  private cardRegions!: Map<string, VisibleDiceCard>;
  private cardDataDirty = false;
  private gridContainer!: Phaser.GameObjects.Container;
  // Only created once the grid goes windowed: a second camera whose viewport
  // is clipped to the grid area (native scissor clipping) and whose own
  // scroll/zoom drives pan/zoom, instead of a GameObject mask — Phaser 4's
  // WebGL renderer doesn't reliably support masking a container this deep.
  private gridCamera?: Phaser.Cameras.Scene2D.Camera;
  // Only created alongside the grid camera: a transparent full-screen camera
  // stacked above it, so popups (banners, float-ups) land on top of dice drawn
  // by the grid camera's later render pass. See overlay().
  private overlayCamera?: Phaser.Cameras.Scene2D.Camera;
  // Vertically-stacked announcement banners (unlocks, boss, trial end) so that
  // several firing at once never overlap — see BannerStack.
  private banners!: BannerStack;
  private viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
  private gridDetail: GridDetailLevel = "full";
  private gridCount = -1;
  // True while the player is at the grid's fully zoomed-out / fit-to-grid
  // position. In that state grid growth may lower the zoom automatically.
  // Once the player zooms in, count changes preserve their chosen zoom.
  private followsFitZoom = true;
  private lastFitZoom = 1;
  // Set for one syncGrid() when the room has moved under the dice: the block
  // is re-centred on the sigil instead of keeping a scroll measured against
  // the old layout. A zoomed-in player owns their scroll, so it stays unset.
  private recenterOnSigil = false;
  private layout!: Layout;
  // Everything that ISN'T a die sprite (felt, HUD, roll button): cheap to
  // destroy and rebuild wholesale on resize, unlike the (potentially huge)
  // dice grid, which is repositioned in place instead — see handleResize().
  private chrome!: Phaser.GameObjects.Container;
  private rolling = false;
  private tumbling = false;
  private tumbleEvent?: Phaser.Time.TimerEvent;
  // Scene clock reading when the current tumble began, so the per-frame wobble
  // is a function of elapsed time rather than of how many frames have gone by.
  private tumbleStartedAt = 0;
  private settleTimer?: Phaser.Time.TimerEvent;
  private effectTimer?: Phaser.Time.TimerEvent;
  private finishEffects?: (skipHold: boolean) => void;
  private pendingAdvance?: Phaser.Time.TimerEvent;
  private hudRank!: Phaser.GameObjects.Text;
  private hudGold!: Phaser.GameObjects.Text;
  private hudRoll!: Phaser.GameObjects.Text;
  private hudScore!: Phaser.GameObjects.Text;
  private hudTarget!: Phaser.GameObjects.Text;
  private hudNumbers!: Phaser.GameObjects.Text;
  private runFooterLinks: Phaser.GameObjects.Text[] = [];
  private hudScorePlaque!: Phaser.GameObjects.Container;
  // The score the HUD is currently *showing*, which lags state.score while a
  // count-up runs. Reset (not tweened) whenever the HUD is rebuilt.
  private shownScore = 0n;
  private scoreTween?: Phaser.Time.TimerEvent;
  private feltImage!: Phaser.GameObjects.Image;
  // Sigil + motes behind the dice. Only built when effects are on; every use
  // is optional-chained rather than guarded again at the call site.
  private ambient?: AmbientLayer;
  private sealImage!: Phaser.GameObjects.Image;
  // Base scale of the seal art for the current layout. Every press/hover/idle
  // scale is a multiple of this, so the compact-landscape rail's smaller seal
  // still animates by the same proportions. buildChrome runs before the new
  // layout is committed to `this.layout`, so it lives in its own field.
  private sealScale = 1;
  private sealHalo?: Phaser.GameObjects.Image;
  private sealBreathe?: Phaser.Tweens.Tween;
  // The live tutorial callout, if any — re-anchored to fresh HUD objects on
  // every rebuild (see renderTutorial). Only present during the first game.
  private tutorialCallout?: CalloutHandle;
  // The Boss tutorial step waits out the "presides" banner, which the callout's
  // dim would otherwise bury (the banner sits below it).
  private bossCalloutHeld = true;
  // Unlocks still persist at the moment their criterion is met, but their
  // presentation waits for TrialResults so the roll itself stays readable.
  private trialUnlocks: ShopItemId[] = [];

  constructor() {
    super("Game");
  }

  create(): void {
    this.state = getRun(this.registry);
    this.rolling = false;
    this.tumbling = false;
    this.tumbleEvent = undefined;
    this.settleTimer = undefined;
    this.effectTimer = undefined;
    this.finishEffects = undefined;
    this.pendingAdvance = undefined;
    this.sprites = new Map();
    this.cards = new Map();
    this.cardRegions = new Map();
    this.cardDataDirty = false;
    this.viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
    this.gridDetail = "full";
    this.gridCount = -1;
    this.followsFitZoom = true;
    this.lastFitZoom = 1;
    this.recenterOnSigil = false;
    // The scene instance is reused across restarts, but Phaser destroys all
    // non-main cameras on shutdown — these fields would otherwise dangle.
    this.gridCamera = undefined;
    this.overlayCamera = undefined;
    // Phaser destroyed the previous run's display list on shutdown; drop the
    // stale handle before buildAmbient() would try to destroy it a second time.
    this.ambient = undefined;
    this.shownScore = this.state.score;
    this.scoreTween = undefined;
    this.sealBreathe = undefined;
    this.trialUnlocks = [];
    this.bossCalloutHeld = true;
    this.gridContainer = this.add.container(0, 0);
    // Recreated each build: routes new banners through the overlay camera so
    // they composite above the windowed grid, just like other popups.
    this.banners = new BannerStack(this, (objs) => this.overlay(objs));

    this.build();
    slideSceneIn(this, this.transitionBackdrop());

    this.renderTutorial();

    // The shop now runs AFTER the trial resolves, so returning from it always
    // lands on a fresh trial — there is nothing left to finish here. The one
    // case that still needs handling is a trial that is somehow already complete
    // on entry (a dev-panel jump), which would otherwise wait for a roll the
    // player has no reason to make.
    if (trialComplete(this.state)) {
      this.rolling = true;
      this.resolveEndOfTrial();
    } else {
      this.announceBoss();
    }

    const offResize = onResizeCoalesced(this, () => this.handleResize());
    const offInput = this.wireGridInput();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      offResize();
      offInput();
    });
  }

  /**
   * Advance the dice wobble. Driven per frame rather than from the 70ms tumble
   * tick that swaps the faces: at that rate the rotation moved in visible
   * steps, and stepping between angles reads as stuttering however small the
   * steps are. One sine per visible die is cheap, and the windowed grid caps
   * how many of those there can ever be.
   */
  override update(time: number): void {
    if (!this.tumbling || !fx.motion) return;
    const elapsed = (time - this.tumbleStartedAt) / 1000;
    for (const sprite of this.sprites.values()) sprite.tumbleTo(elapsed);
  }

  /** A resize mid-tumble would leave the flicker loop pointing at stale
   *  sprites, and would silently drop that roll's score — so resolve it
   *  first. The dice grid itself is never destroyed here — only the felt/HUD
   *  "chrome" is rebuilt; sprites are just repositioned (or, above
   *  and re-windowed) to the new layout. */
  private handleResize(): void {
    if (this.tumbling) {
      this.tumbleEvent?.remove();
      this.settleTimer?.remove();
      this.settleRoll(0, false);
    }

    const layout = this.computeLayout();
    this.buildChrome(layout);
    // A resize moves the sigil as well as the grid viewport, so a fit-zoomed
    // block has to be re-centred on it — clamping the old scroll into the new
    // bounds would leave the dice sitting off the sigil until the next win.
    this.recenterOnSigil = this.followsFitZoom;
    this.syncGrid(layout);
    // Extra cameras don't track the Scale Manager — keep the full-screen
    // overlay camera matched to the new size so popups stay centered.
    this.overlayCamera?.setSize(this.scale.width, this.scale.height);
    // The HUD objects were just destroyed+recreated — re-anchor any callout.
    this.renderTutorial();
  }

  // ---- tutorial ------------------------------------------------------------

  /** (Re)draw the callout for the current tutorial stage against the live HUD,
   *  or clear it if the tutorial is inactive or on a non-Game stage. Idempotent
   *  — safe to call after any layout change or HUD update. */
  private renderTutorial(): void {
    this.tutorialCallout?.destroy();
    this.tutorialCallout = undefined;

    const t = getTutorial(this.registry);
    if (!t.active) return;

    const plaqueRect = (key: HudStatKey) => {
      const c = this.layout.hud[key];
      return new Phaser.Geom.Rectangle(c.x - c.w / 2, c.y - c.h / 2, c.w, c.h);
    };
    const advance = () => {
      advanceTutorial(this.registry);
      this.renderTutorial();
    };

    let anchor: Phaser.Geom.Rectangle;
    let onContinue: (() => void) | undefined;
    let interactiveAnchor = false;

    // Only where the callout points and what dismisses it are decided here;
    // the copy comes from the shared script, keyed off the same stage.
    const stage = t.stage;
    switch (stage) {
      case TutorialStage.Score:
        anchor = plaqueRect("score");
        onContinue = advance;
        break;
      case TutorialStage.Roll: {
        const r = SEAL_RADIUS * this.layout.button.scale;
        anchor = new Phaser.Geom.Rectangle(
          this.layout.button.x - r,
          this.layout.button.y - r,
          r * 2,
          r * 2,
        );
        interactiveAnchor = true; // the roll press itself advances the tutorial
        break;
      }
      case TutorialStage.Viewport:
        anchor = new Phaser.Geom.Rectangle(
          this.layout.grid.x,
          this.layout.grid.y,
          this.layout.grid.width,
          this.layout.grid.height,
        );
        onContinue = advance;
        break;
      case TutorialStage.Goal:
        anchor = plaqueRect("target");
        onContinue = advance;
        break;
      case TutorialStage.Rolls:
        anchor = plaqueRect("roll");
        onContinue = advance;
        break;
      case TutorialStage.Rank:
        anchor = plaqueRect("rank");
        onContinue = advance;
        break;
      case TutorialStage.Boss:
        // Nothing to point at until a Boss Trial is actually running, and
        // nothing to read while its banner is still on screen.
        if (this.bossCalloutHeld || !activeBoss(this.state)) return;
        anchor = plaqueRect("target");
        onContinue = advance;
        break;
      default:
        // Route, Results and Shop steps belong to their own scenes.
        return;
    }

    this.tutorialCallout = showCallout(this, {
      anchor,
      text: TUTORIAL_TEXT[stage],
      onContinue,
      interactiveAnchor,
    });
    // If the grid has gone windowed, route the callout through the overlay
    // camera so the grid camera's later dice pass cannot cover it.
    this.overlay(this.tutorialCallout.objects);
  }

  private build(): void {
    const layout = this.computeLayout();
    this.buildChrome(layout);
    this.syncGrid(layout);
  }

  // ---- layout ----------------------------------------------------------------

  private computeLayout(): Layout {
    const W = this.scale.width;
    const H = this.scale.height;
    const margin = 16;
    const portrait = isPortrait(this);
    // Too short to stack the grid above the seal: the two sit side by side
    // instead, seal on the right. See the compact branch below.
    const compact = isCompactLandscape(W, H);
    const footerH = portrait ? 64 : 40;

    // One compact strip at every width. The score gets the broadest plaque,
    // then the goal; the ladder position needs the least room. Capping
    // the strip keeps the four stats visually grouped on wide monitors, while
    // proportional gaps and type let the same composition collapse on phones.
    const hudMargin = Phaser.Math.Clamp(W * 0.015, 4, 12);
    const hudWidth = Math.min(600, W - hudMargin * 2);
    const gapX = Phaser.Math.Clamp(W * 0.012, 4, 10);
    // Height is only ever the binding constraint on a short landscape
    // viewport; everywhere else this is the same W-driven strip as before.
    const cellH = Phaser.Math.Clamp(Math.min(W * 0.19, H * 0.2), 54, 76);
    const cellsWidth = hudWidth - gapX * (HUD_STATS.length - 1);
    const totalWeight = HUD_STATS.reduce((sum, stat) => sum + stat.weight, 0);
    const hudY = hudMargin + cellH / 2;
    let cursorX = (W - hudWidth) / 2;
    const hud = {} as Record<HudStatKey, HudCell>;

    for (const stat of HUD_STATS) {
      const w = (cellsWidth * stat.weight) / totalWeight;
      hud[stat.key] = { x: cursorX + w / 2, y: hudY, w, h: cellH };
      cursorX += w + gapX;
    }
    const hudBottom = hudMargin + cellH;

    // Sacred numbers stay bottom-left, Inventory/Settings bottom-right, in
    // every orientation — portrait just reserves a taller footer so the
    // (potentially wrapping) sacred-numbers text clears the two links.
    const footer = {
      numbersY: portrait ? H - 27 : H - footerH + 10,
      settingsY: portrait ? H - 16 : H - footerH + 10,
    };

    const gridTop = hudBottom + (compact ? 10 : 16);

    if (compact) {
      // Seal in a rail down the right edge, dice filling everything left of
      // it. Stacking them would leave the grid a band a couple of dice tall.
      const railW = Phaser.Math.Clamp(W * 0.2, 132, 200);
      const railLeft = W - railW;
      const gridBottom = H - footerH - 4;
      // The rail also has to clear the Inventory/Settings links, which sit
      // above the footer baseline in the same corner.
      const railBottom = H - footerH - 28;
      const sealSize = Math.min(railW - 12, railBottom - gridTop - 12);
      const scale = Phaser.Math.Clamp(sealSize / (SEAL_RADIUS * 2), 0.5, 1);

      return {
        hud,
        footer,
        grid: {
          x: margin,
          y: gridTop,
          width: Math.max(80, railLeft - 12 - margin),
          height: Math.max(60, gridBottom - gridTop),
        },
        button: {
          x: railLeft + railW / 2,
          y: (gridTop + railBottom) / 2,
          scale,
        },
      };
    }

    const button = { x: W / 2, y: H - footerH - SEAL_RADIUS - 14, scale: 1 };
    const gridBottom = button.y - SEAL_RADIUS - 16;

    return {
      hud,
      footer,
      grid: {
        x: portrait ? margin : W * 0.06,
        y: gridTop,
        width: portrait ? W - margin * 2 : W * 0.88,
        height: Math.max(60, gridBottom - gridTop),
      },
      button,
    };
  }

  // ---- chrome: felt + HUD + roll button -------------------------------------

  private buildChrome(layout: Layout): void {
    // Everything below is about to be destroyed and rebuilt, so drop the
    // tweens that write to it — a count-up left running would keep setting
    // text on a destroyed HUD object, and the score simply snaps instead.
    this.scoreTween?.remove();
    this.scoreTween = undefined;
    this.shownScore = this.state.score;
    this.stopSealBreathe();

    // Ambient is part of chrome for draw order, but survives HUD rebuilds so
    // its rotation and any transition morph remain continuous across resize.
    if (this.ambient && this.chrome) this.chrome.remove(this.ambient);
    this.chrome?.destroy();

    const items: Phaser.GameObjects.GameObject[] = [];
    this.feltImage = addFelt(this, fx.on ? FELT_OVERSCAN : 0);
    items.push(this.feltImage);
    if (!this.ambient) this.buildAmbient();
    if (this.ambient) {
      this.ambient.setPosition(this.scale.width / 2, this.scale.height / 2);
      this.ambient.setScale(1);
      this.ambient.setArea(this.scale.width, this.scale.height);
      items.push(this.ambient);
    }
    items.push(...this.buildHud(layout));
    items.push(...this.buildRollButton(layout));

    this.chrome = this.add.container(0, 0, items);
    // A fresh container always lands on top of the display list — but the
    // felt background inside it needs to stay behind the (untouched) dice.
    this.children.sendToBack(this.chrome);
    // The grid and overlay cameras (if any) never draw chrome — the previous
    // chrome reference they were ignoring is gone, so point them at the new one.
    this.gridCamera?.ignore(this.chrome);
    this.overlayCamera?.ignore(this.chrome);
  }

  private buildHud(layout: Layout): Phaser.GameObjects.GameObject[] {
    const W = this.scale.width;
    const items: Phaser.GameObjects.GameObject[] = [];

    const plaques = HUD_STATS.map((stat) => {
      const plaque = this.makePlaque(
        layout.hud[stat.key],
        stat.label,
        stat.color,
      );
      items.push(plaque.container);
      return [stat.key, plaque] as const;
    });
    const plaqueByKey = Object.fromEntries(plaques) as Record<
      HudStatKey,
      (typeof plaques)[number][1]
    >;
    this.hudRank = plaqueByKey.rank.value;
    this.hudGold = plaqueByKey.gold.value;
    this.hudRoll = plaqueByKey.roll.value;
    this.hudScore = plaqueByKey.score.value;
    this.hudTarget = plaqueByKey.target.value;
    this.hudScorePlaque = plaqueByKey.score.container;

    const { numbersY } = layout.footer;
    // Sacred numbers pinned bottom-left; Inventory (upper) and Settings (lower)
    // pinned bottom-right. The left text wraps within the half-width gap so it
    // never runs under the right-hand links on narrow portrait screens.
    this.hudNumbers = this.add
      .text(24, numbersY, "", {
        fontFamily: SERIF,
        fontSize: "15px",
        color: CSS.dim,
        fontStyle: "italic",
        wordWrap: { width: W * 0.5 },
      })
      .setOrigin(0, 0.5);
    this.runFooterLinks = buildRunFooterLinks(this, "Game");
    items.push(this.hudNumbers, ...this.runFooterLinks);

    this.updateHud();
    return items;
  }

  private makePlaque(
    cell: HudCell,
    label: string,
    valueColor: string,
  ): {
    container: Phaser.GameObjects.Container;
    label: Phaser.GameObjects.Text;
    value: Phaser.GameObjects.Text;
  } {
    const { x, y, w, h } = cell;
    const heightScale = h / 62;
    const widthScale = Phaser.Math.Clamp(w / 92, 0.68, 1);
    const fontScale = Math.min(heightScale, widthScale);
    const container = this.add.container(x, y);
    const image = this.add.image(0, 0, "plaque").setDisplaySize(w, h);
    // Derive the badge position from its bottom inset. This guarantees the
    // outer plaque contains it even at the minimum phone-sized HUD height.
    const valuePillHeight = h * 0.5 - 4;
    const valuePillBottomPadding = Math.max(14, h * 0.18);
    const valuePillY = h / 2 - valuePillBottomPadding - valuePillHeight / 2;
    const valuePill = this.add.graphics().setPosition(0, valuePillY);
    const labelText = this.add
      .text(0, -h * 0.31, label, {
        fontFamily: SERIF,
        fontSize: `${Phaser.Math.Clamp(13 * fontScale, 9, 13)}px`,
        color: CSS.dim,
        fontStyle: "bold",
        letterSpacing: Math.max(0, Math.round(fontScale)),
      })
      .setOrigin(0.5);
    const valueFontSize = Phaser.Math.Clamp(25 * fontScale, 17, 25);
    const value = this.add
      .text(0, valuePillY - 1, "", {
        fontFamily: SERIF,
        fontSize: `${valueFontSize}px`,
        color: valueColor,
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setData("hudMaxWidth", Math.max(20, w - 28))
      .setData("hudFontSize", valueFontSize)
      .setData("hudPill", valuePill)
      .setData("hudPillHeight", valuePillHeight)
      .setData("hudPillWidth", Math.max(28, w - 18));
    container.add([image, valuePill, labelText, value]);
    return { container, label: labelText, value };
  }

  /** Set a plaque value at its preferred size, shrinking only when a very
   *  large score or goal would otherwise spill into the neighbouring card. */
  private setHudValue(text: Phaser.GameObjects.Text, value: string): void {
    text
      .setScale(1)
      .setFontSize(text.getData("hudFontSize") as number)
      .setText(value);
    const maxWidth = text.getData("hudMaxWidth") as number;
    if (text.width > maxWidth) text.setScale(maxWidth / text.width);

    const pill = text.getData("hudPill") as Phaser.GameObjects.Graphics;
    const pillHeight = text.getData("hudPillHeight") as number;
    const pillWidth = text.getData("hudPillWidth") as number;
    pill.clear();
    pill.fillStyle(COLORS.feltLight, 1);
    pill.fillRoundedRect(
      -pillWidth / 2,
      -pillHeight / 2,
      pillWidth,
      pillHeight,
      Math.min(9, pillHeight / 2),
    );
  }

  private updateHud(): void {
    const s = this.state;
    this.setHudValue(
      this.hudRank,
      `${rankOf(s.trial)}-${trialInRank(s.trial)}`,
    );
    this.setHudValue(this.hudRoll, `${s.roll}/${trialRollTarget(s)}`);
    this.setScoreDisplay(s.score);
    this.setHudValue(this.hudTarget, formatScore(goalFor(s)));
    this.setHudValue(this.hudGold, String(s.gold));

    // The Silence cuts the scoring numbers back to 1s, so the footer has to read
    // them through the same accessor the scorer does or it would lie about what
    // scores this trial.
    const numbers = scoringNumbersFor(s);
    const extras =
      s.extraPoints > 0 ? `  ·  +${s.extraPoints} bonus per scoring die` : "";
    this.hudNumbers.setText(`Sacred numbers: ${numbers.join(", ")}${extras}`);

    this.updateTension();
  }

  /**
   * Ease the displayed score toward its real value and punch the plaque on the
   * way up. The score is the trial in one number, so it's worth watching it
   * climb rather than finding it already arrived. `fx.countUp` snaps when
   * effects are off, and `shownScore` is reset to match on every HUD rebuild,
   * so both of those paths land here as a plain `setText`.
   */
  private setScoreDisplay(score: bigint): void {
    if (score === this.shownScore) {
      this.setHudValue(this.hudScore, formatScore(score));
      return;
    }
    const rising = score > this.shownScore;
    this.scoreTween?.remove();
    this.scoreTween = fx.countUp(
      this,
      this.shownScore,
      score,
      rising ? 480 : 240,
      (value) => this.setHudValue(this.hudScore, formatScore(value)),
    );
    this.shownScore = score;
    if (rising) fx.punch(this, this.hudScorePlaque, 1.09, 120);
  }

  /**
   * Colour the table by how the trial is going: the felt warms toward gold as
   * the score closes on the goal, and goes cold and bloody once the last roll
   * arrives with the goal still out of reach. The sigil reads the same two
   * numbers — see AmbientLayer.
   */
  private updateTension(): void {
    if (!fx.on) return;
    const s = this.state;
    const goal = goalFor(s);
    const progress = goal > 0n ? Number(s.score) / Number(goal) : 0;
    const danger = trialRollTarget(s) - s.roll <= 1 && s.score < goal;
    const t = Phaser.Math.Clamp(progress, 0, 1);

    this.ambient?.setProgress(t, danger);
    this.feltImage?.setTint(
      danger
        ? TENSION_FELT_TINT.danger
        : blendColor(TENSION_FELT_TINT.idle, TENSION_FELT_TINT.met, t),
    );
  }

  // ---- dice grid -----------------------------------------------------------

  /** Where the dice block centres itself: the middle of the sigil, which
   *  belongs to the room rather than to the grid viewport (whose own centre
   *  sits higher, between the HUD and the roll button). A lone die therefore
   *  lands dead centre in the turning sigil, and the square block grows out
   *  from that same point as dice are won. Without a sigil to line up with,
   *  the middle of the room is still the point the room is composed around. */
  private gridFocus(): GridFocus {
    if (this.ambient) return { x: this.ambient.x, y: this.ambient.y };
    return { x: this.scale.width / 2, y: this.scale.height / 2 };
  }

  /** Build the full-room sigil and motes. It joins the felt in main-scene
   * chrome, while the transparent grid camera composites dice over it. */
  private buildAmbient(): void {
    this.ambient?.destroy();
    this.ambient = undefined;
    if (!fx.on) return;

    this.ambient = new AmbientLayer(this, { ring: true });
  }

  /** Reconciles the live sprite pool against the current scroll/zoom window,
   *  creating sprites for newly-visible indices, destroying ones that
   *  scrolled out, and repositioning the rest.
   *  Used for the initial build, resize, and every pan/zoom step. */
  private syncGrid(layout: Layout): void {
    this.layout = layout;
    const n = this.state.dice.length;
    const firstLayout = this.gridCount < 0;
    const countChanged = n !== this.gridCount;
    const focus = this.gridFocus();
    const fitZoom = fitGridZoom(n, layout.grid, focus);
    if (firstLayout || this.followsFitZoom) this.viewport.zoom = fitZoom;
    this.lastFitZoom = fitZoom;

    let view = computeWindowedView(n, layout.grid, this.viewport, focus);
    const recenter =
      firstLayout ||
      this.recenterOnSigil ||
      (countChanged && this.followsFitZoom);
    this.recenterOnSigil = false;
    if (recenter) {
      this.viewport.scrollX = view.homeScrollX;
      this.viewport.scrollY = view.homeScrollY;
      view = computeWindowedView(n, layout.grid, this.viewport, focus);
    }
    if (countChanged) this.gridCount = n;
    this.viewport.scrollX = view.scrollX;
    this.viewport.scrollY = view.scrollY;
    const visible = view.visible;
    const scale = view.scale;
    this.gridDetail = gridDetailLevel(view.equivalentDice, this.gridDetail);

    const cam = this.ensureGridCamera();
    cam.setViewport(
      layout.grid.x,
      layout.grid.y,
      layout.grid.width,
      layout.grid.height,
    );
    cam.setZoom(view.zoom);
    // Phaser's Camera.scrollX/Y is the world position at the viewport's
    // CENTER, offset by half the *unzoomed* viewport size — not the world
    // position at its top-left edge (which is what `view.scrollX/Y`
    // means, and what the edge-clamping in computeWindowedView is written
    // against). The two only coincide at zoom=1; convert here.
    const halfW = layout.grid.width / 2;
    const halfH = layout.grid.height / 2;
    cam.setScroll(
      view.scrollX + halfW * (1 / view.zoom - 1),
      view.scrollY + halfH * (1 / view.zoom - 1),
    );

    if (this.gridDetail === "cards") {
      for (const sprite of this.sprites.values()) sprite.destroy();
      this.sprites.clear();

      const regions = computeVisibleDiceCards(n, view);
      const refreshCardData = countChanged || this.cardDataDirty;
      const visibleKeys = new Set(regions.map((region) => region.key));
      for (const [key, card] of this.cards) {
        if (!visibleKeys.has(key)) {
          card.destroy();
          this.cards.delete(key);
          this.cardRegions.delete(key);
        }
      }
      for (const region of regions) {
        let card = this.cards.get(region.key);
        if (!card) {
          const summary = this.state.dice.summarizeRegion(region.region);
          card = new DiceSummaryCard(
            this,
            region.x,
            region.y,
            summary,
            region.width,
            region.height,
            view.zoom,
          );
          this.gridContainer.add(card);
          this.cards.set(region.key, card);
          this.cameras.main.ignore(card);
          this.overlayCamera?.ignore(card);
        } else {
          if (refreshCardData) {
            card.setSummary(this.state.dice.summarizeRegion(region.region));
            // Camera.ignore snapshots a container's current descendants. A
            // composition change can add a new die-type row, so refresh those
            // snapshots only when card data actually changed.
            this.cameras.main.ignore(card);
            this.overlayCamera?.ignore(card);
          }
          card.setLayout(region.width, region.height, view.zoom);
        }
        card.setPosition(region.x, region.y);
        this.cardRegions.set(region.key, region);
      }
      this.cardDataDirty = false;
    } else {
      for (const card of this.cards.values()) card.destroy();
      this.cards.clear();
      this.cardRegions.clear();
      this.cardDataDirty = false;

      const visibleIndices = new Set(visible.map((v) => v.index));
      for (const [index, sprite] of this.sprites) {
        if (!visibleIndices.has(index)) {
          sprite.destroy();
          this.sprites.delete(index);
        }
      }

      for (const { index, x, y } of visible) {
        let sprite = this.sprites.get(index);
        if (!sprite) {
          const die = this.state.dice.dieAt(index);
          if (!die) continue;
          sprite = new DieSprite(this, x, y, die);
          this.gridContainer.add(sprite);
          this.sprites.set(index, sprite);
          // Camera.ignore() only snapshots a Container's *current* children, so
          // Each sprite opts out of the main and overlay cameras individually as
          // it is created; it renders only through the clipped grid camera.
          this.cameras.main.ignore(sprite);
          this.overlayCamera?.ignore(sprite);
        } else {
          sprite.clearPulse();
          const die = this.state.dice.dieAt(index);
          if (die) sprite.die = die;
          // The die at this index may have changed size in place (Whetstone /
          // Refinement shrink) — resync the body/label/face texture, which a
          // reposition alone would leave stale until the scene is rebuilt.
          sprite.refreshType();
        }
        sprite.setPosition(x, y);
        sprite.setScale(scale);
      }
    }
  }

  /** Creates the dedicated grid camera on first layout. Its viewport provides
   *  native clipping, while its scroll/zoom drive pan and zoom. */
  private ensureGridCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.gridCamera) return this.gridCamera;
    this.gridCamera = this.cameras.add(0, 0, 1, 1);
    // The viewport clips and transforms dice only; the full-scene felt and
    // sigil remain visible through it as one continuous room.
    this.gridCamera.setBackgroundColor("rgba(0,0,0,0)");
    this.gridCamera.ignore(this.chrome);
    return this.gridCamera;
  }

  /** Lazily creates the transparent overlay camera the first time a popup is
   *  shown while windowed. It's added after the grid camera so loose popup
   *  children render above the dice without redrawing chrome or the grid at
   *  the wrong scroll/zoom. */
  private ensureOverlayCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.overlayCamera) return this.overlayCamera;
    const cam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    cam.ignore(this.chrome);
    cam.ignore(this.gridContainer);
    this.overlayCamera = cam;
    return cam;
  }

  /** Popups (score float-ups, trial banners) are loose scene children, not
   *  part of chrome or the grid. Once windowed, route them through a dedicated
   *  overlay camera so the grid camera's later dice pass cannot cover them. */
  private overlay<T extends Phaser.GameObjects.GameObject>(
    objOrList: T | T[],
  ): T | T[] {
    if (!this.gridCamera) return objOrList;
    this.ensureOverlayCamera();
    this.cameras.main.ignore(objOrList);
    this.gridCamera.ignore(objOrList);
    return objOrList;
  }

  /** Convert a die's grid-world position into screen coordinates for popups
   * rendered by the unscrolled overlay camera. */
  private dieScreenPosition(sprite: DieSprite): { x: number; y: number } {
    const cam = this.gridCamera;
    if (!cam) return { x: sprite.x, y: sprite.y };
    return {
      x: cam.x + (sprite.x - cam.worldView.x) * cam.zoom,
      y: cam.y + (sprite.y - cam.worldView.y) * cam.zoom,
    };
  }

  /** Identify dice added by an automatic passive after the grid has been
   *  re-laid. Foundry and Genesis otherwise change the grid silently; Double
   *  the Fun already identifies the parent die that triggered each copy, and
   *  shop additions are the direct result of the player's selection. */
  private cueCreatedDice(
    count: number,
    source: "foundry" | "genesis" | "brick_mold",
    label: string,
    borderColor: number,
    textColor: string,
  ): void {
    if (
      count <= 0 ||
      this.gridDetail === "noEffects" ||
      this.gridDetail === "cards"
    )
      return;

    const showText = this.gridDetail === "full";
    // In list mode, taking the last source-matching dice selects the copies that
    // were just appended. Bucket mode merges indistinguishable dice into their
    // existing source bucket, so the last visible matches are the closest
    // faithful representation of the newly added count.
    const created = [...this.sprites]
      .filter(([index]) => this.state.dice.dieAt(index)?.source === source)
      .slice(-count);
    for (const [, sprite] of evenlySample(created, MAX_PULSED_DICE)) {
      sprite.pulseEffects([borderColor]);
      if (!showText) continue;
      const pos = this.dieScreenPosition(sprite);
      this.overlay(floatText(this, pos.x, pos.y - 40, label, textColor, 18));
    }
  }

  /** Drag-to-pan, wheel-to-zoom, and two-finger pinch-to-zoom over the grid. */
  private wireGridInput(): () => void {
    // Phaser starts a single touch pointer, which can never describe a pinch.
    // `pointersTotal` counts only touch pointers (the mouse has its own), and
    // the list lives on the game-wide manager, surviving scene restarts — so
    // top it up to two only while it is still short.
    const touchPointers = this.input.manager.pointersTotal;
    if (touchPointers < 2) this.input.addPointer(2 - touchPointers);

    let dragging = false;
    let start = { x: 0, y: 0, scrollX: 0, scrollY: 0 };
    // Live touches that began inside the grid, keyed by pointer id. A second
    // one promotes the drag into a pinch, and lifting one demotes it back.
    const touches = new Map<number, { x: number; y: number }>();
    // Set for the duration of a pinch: the starting finger separation and
    // zoom, plus the grid-world point under the starting midpoint, which the
    // gesture keeps pinned under the fingers as they move and spread.
    let pinch: {
      distance: number;
      zoom: number;
      worldX: number;
      worldY: number;
    } | null = null;

    const inBounds = (p: Phaser.Input.Pointer) => {
      const a = this.layout.grid;
      return (
        p.x >= a.x &&
        p.x <= a.x + a.width &&
        p.y >= a.y &&
        p.y <= a.y + a.height
      );
    };

    /** The grid-world point currently drawn under a screen position. */
    const worldAt = (x: number, y: number) => {
      const area = this.layout.grid;
      return {
        x: this.viewport.scrollX + (x - area.x) / this.viewport.zoom,
        y: this.viewport.scrollY + (y - area.y) / this.viewport.zoom,
      };
    };

    /** Re-zoom while keeping `world` under the screen position `anchor`. */
    const zoomAround = (
      zoom: number,
      anchor: { x: number; y: number },
      world: { x: number; y: number },
    ) => {
      const area = this.layout.grid;
      this.viewport.zoom = clampZoom(zoom, area);
      // Re-enable auto-fit only when the player has returned to the current
      // fully zoomed-out position. Any zoomed-in position is user-owned and
      // must survive later dice additions/removals.
      this.followsFitZoom =
        Math.abs(this.viewport.zoom - this.lastFitZoom) < 0.0001;
      this.viewport.scrollX =
        world.x - (anchor.x - area.x) / this.viewport.zoom;
      this.viewport.scrollY =
        world.y - (anchor.y - area.y) / this.viewport.zoom;
      this.syncGrid(this.layout);
    };

    const pinchSpan = () => {
      const [a, b] = [...touches.values()];
      return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        // A hard floor keeps the ratio finite when two fingers land on nearly
        // the same pixel, which would otherwise divide the zoom by ~zero.
        distance: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
      };
    };

    const beginDrag = (x: number, y: number) => {
      dragging = true;
      start = {
        x,
        y,
        scrollX: this.viewport.scrollX,
        scrollY: this.viewport.scrollY,
      };
    };

    const onDown = (p: Phaser.Input.Pointer) => {
      if (!inBounds(p)) return;
      // Extra fingers beyond the two driving the pinch are ignored rather than
      // allowed to redefine the gesture mid-flight.
      if (p.wasTouch && touches.size < 2) {
        touches.set(p.id, { x: p.x, y: p.y });
        if (touches.size === 2) {
          const span = pinchSpan();
          const world = worldAt(span.x, span.y);
          dragging = false;
          pinch = {
            distance: span.distance,
            zoom: this.viewport.zoom,
            worldX: world.x,
            worldY: world.y,
          };
          return;
        }
      }
      beginDrag(p.x, p.y);
    };
    const onMove = (p: Phaser.Input.Pointer) => {
      const touch = touches.get(p.id);
      if (touch) {
        touch.x = p.x;
        touch.y = p.y;
      }
      if (pinch && touches.size === 2) {
        const span = pinchSpan();
        // The midpoint doubles as the pan anchor, so a pinch that also slides
        // across the screen drags the grid with it.
        zoomAround((pinch.zoom * span.distance) / pinch.distance, span, {
          x: pinch.worldX,
          y: pinch.worldY,
        });
        return;
      }
      if (!dragging) {
        this.input.setDefaultCursor(inBounds(p) ? "grab" : "default");
        return;
      }
      // A screen-pixel drag covers more virtual ground the further zoomed out we are.
      this.viewport.scrollX =
        start.scrollX - (p.x - start.x) / this.viewport.zoom;
      this.viewport.scrollY =
        start.scrollY - (p.y - start.y) / this.viewport.zoom;
      this.syncGrid(this.layout);
    };
    const onUp = (p: Phaser.Input.Pointer) => {
      touches.delete(p.id);
      dragging = false;
      if (!pinch) return;
      pinch = null;
      // One finger still down: hand the gesture back to it as a fresh drag, so
      // lifting the other finger doesn't jump the grid to a stale origin.
      const [remaining] = [...touches.values()];
      if (remaining) beginDrag(remaining.x, remaining.y);
    };
    const onWheel = (
      p: Phaser.Input.Pointer,
      _over: unknown,
      _dx: number,
      dy: number,
    ) => {
      if (!inBounds(p)) return;
      const area = this.layout.grid;

      // Keep the same point of the grid centered through the zoom change.
      const center = {
        x: area.x + area.width / 2,
        y: area.y + area.height / 2,
      };
      // Multiplicative wheel steps remain useful at the tiny zoom values needed
      // to fit grids containing hundreds of thousands of dice.
      zoomAround(
        this.viewport.zoom * Math.exp(-dy * 0.0015),
        center,
        worldAt(center.x, center.y),
      );
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);

    return () => {
      this.input.off("pointerdown", onDown);
      this.input.off("pointermove", onMove);
      this.input.off("pointerup", onUp);
      this.input.off("pointerupoutside", onUp);
      this.input.off("wheel", onWheel);
      this.input.setDefaultCursor("default");
    };
  }

  // ---- roll button ---------------------------------------------------------

  private buildRollButton(layout: Layout): Phaser.GameObjects.GameObject[] {
    const { x, y, scale } = layout.button;
    this.sealScale = scale;
    const items: Phaser.GameObjects.GameObject[] = [];

    // Warm halo under the wax. The seal is the one thing the player has to
    // press, and a dark disc on a dark table doesn't say so on its own.
    this.sealHalo = undefined;
    if (fx.on) {
      this.sealHalo = this.add
        .image(x, y, "spark")
        .setDisplaySize(SEAL_RADIUS * 5 * scale, SEAL_RADIUS * 5 * scale)
        .setTint(COLORS.glow)
        .setAlpha(SEAL_HALO_IDLE)
        .setBlendMode(Phaser.BlendModes.ADD);
      items.push(this.sealHalo);
    }

    this.sealImage = this.add.image(x, y, "seal").setScale(scale);
    const label = this.add
      .text(x, y - 3 * scale, "ROLL", {
        fontFamily: SERIF,
        fontSize: `${Math.round(34 * scale)}px`,
        color: CSS.parchment,
        fontStyle: "bold",
        letterSpacing: 3,
      })
      .setOrigin(0.5)
      .setShadow(0, 2, "#000000", 4, false, true);

    this.sealImage.setInteractive({ useHandCursor: true });
    this.sealImage.on("pointerover", () => {
      if (this.rolling) return;
      // Hover owns the seal's scale for as long as it lasts, so the idle pulse
      // has to let go of it rather than fight for the same property.
      this.stopSealBreathe();
      this.sealImage.setScale(this.sealScale * 1.06);
      this.setHaloAlpha(SEAL_HALO_HOVER);
    });
    this.sealImage.on("pointerout", () => {
      this.sealImage.setScale(this.sealScale);
      this.setHaloAlpha(SEAL_HALO_IDLE);
      this.startSealBreathe();
    });
    this.sealImage.on("pointerdown", () => this.onRoll());
    label.setDepth(1);

    items.push(this.sealImage, label);
    this.startSealBreathe();
    return items;
  }

  /** Slow pulse on the seal while it waits to be pressed — the only thing on
   *  the screen that moves when the game is idle, which is the point. */
  private startSealBreathe(): void {
    if (!fx.motion) return;
    this.sealBreathe?.remove();
    this.sealImage.setScale(this.sealScale);
    this.sealBreathe = this.tweens.add({
      targets: this.sealImage,
      scaleX: this.sealScale * 1.035,
      scaleY: this.sealScale * 1.035,
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private stopSealBreathe(): void {
    this.sealBreathe?.remove();
    this.sealBreathe = undefined;
  }

  private setHaloAlpha(alpha: number): void {
    if (!this.sealHalo) return;
    this.tweens.killTweensOf(this.sealHalo);
    this.tweens.add({ targets: this.sealHalo, alpha, duration: 200 });
  }

  // ---- roll flow -----------------------------------------------------------

  private onRoll(): void {
    this.stopSealBreathe();
    this.sealImage.setScale(this.sealScale * 0.96);
    this.time.delayedCall(120, () => {
      this.sealImage.setScale(this.sealScale);
      this.startSealBreathe();
    });
    const press = fx.shockwave(
      this,
      this.layout.button.x,
      this.layout.button.y,
      SEAL_RADIUS * this.sealScale,
      COLORS.glow,
      460,
    );
    if (press) this.overlay(press);

    // Tutorial "Roll" step: pressing the seal advances it. Clear the callout for
    // the roll; the viewport step appears once the roll settles.
    const t = getTutorial(this.registry);
    if (t.active && t.stage === TutorialStage.Roll) {
      advanceTutorial(this.registry);
      this.tutorialCallout?.destroy();
      this.tutorialCallout = undefined;
    }

    if (this.tumbling) {
      // Mid-tumble: skip the flicker and resolve the roll now.
      this.interruptRoll();
      return;
    }

    if (this.finishEffects) {
      // Effects are still presenting and the grown grid has not been laid out
      // yet. Complete that work now and flow straight into the next roll.
      this.effectTimer?.remove();
      this.effectTimer = undefined;
      const finish = this.finishEffects;
      this.finishEffects = undefined;
      finish(true);
      return;
    }

    if (this.pendingAdvance) {
      // Mid-hold (post-settle, waiting to decide what's next): skip the wait
      // and advance right now — a click should never just do nothing.
      this.pendingAdvance.remove();
      this.pendingAdvance = undefined;
      this.afterRoll(true);
      return;
    }

    if (!this.rolling) this.startRoll();
  }

  private startRoll(): void {
    this.rolling = true;
    this.tumbling = true;

    // Each die picks its own rocking motion for this roll; `update()` advances
    // all of them per frame from this timestamp.
    this.tumbleStartedAt = this.time.now;
    if (fx.motion) {
      for (const sprite of this.sprites.values()) sprite.beginTumble();
    }

    audio.roll(this.state.dice.length);
    // A tutorial run is not allowed to end on a cold streak: once a trial has
    // only as many rolls left as it still needs points, those rolls come up 1
    // on every die (see tutorialForcesRoll).
    const forced = tutorialForcesRoll(this.registry, this.state);
    const rollDice = () =>
      this.state.dice.roll(
        forced ? () => 0 : Math.random,
        scoringNumbersFor(this.state),
        this.state.royalSealSizes,
      );
    rollDice();
    // ...and its opening roll is not allowed to be a hot one either: clearing
    // the Lesser Trial immediately would skip the steps that come after the
    // seal (see tutorialBlocksScore). Re-roll until nothing scores, bounded so
    // a grid where every face scores can never hang the turn.
    if (!forced && tutorialBlocksScore(this.registry, this.state)) {
      for (
        let attempt = 0;
        attempt < 32 && this.state.dice.agg().scoringCount > 0;
        attempt++
      )
        rollDice();
    }

    // Tumble animation: flicker visible dice or one representative die per
    // summary row, then settle on the real rolled values.
    this.tumbleEvent = this.time.addEvent({
      delay: 70,
      repeat: 6,
      callback: () => {
        for (const sprite of this.sprites.values()) {
          sprite.showFace(1 + Math.floor(Math.random() * sprite.die.sides));
        }
        for (const card of this.cards.values()) card.animateFaces();
      },
    });
    this.settleTimer = this.time.delayedCall(70 * 7 + 40, () =>
      this.settleRoll(700, false),
    );
  }

  /** Skip the rest of the tumble, resolve the roll now, then queue a fast re-roll. */
  private interruptRoll(): void {
    this.tumbleEvent?.remove();
    this.settleTimer?.remove();
    this.settleRoll(200, true);
  }

  private settleRoll(holdMs: number, autoReroll: boolean): void {
    this.tumbling = false;
    const s = this.state;
    const showPerDieCallouts = fx.on && this.gridDetail === "full";
    const showPerDieEffects =
      fx.on && (this.gridDetail === "full" || this.gridDetail === "noCallouts");
    const settleIndividually =
      fx.motion && this.sprites.size <= MAX_INDIVIDUAL_SETTLE_DICE;
    // Dice land as a ripple down the grid rather than snapping flat together,
    // so the roll reads as coming to rest. Measured over the visible sprites
    // only — the windowed grid never holds more than a viewport's worth.
    let topY = Infinity;
    let bottomY = -Infinity;
    if (settleIndividually) {
      for (const sprite of this.sprites.values()) {
        topY = Math.min(topY, sprite.y);
        bottomY = Math.max(bottomY, sprite.y);
      }
    }
    const rippleSpan = Math.max(1, bottomY - topY);

    for (const [index, sprite] of this.sprites) {
      const die = s.dice.dieAt(index);
      if (!die) continue;
      sprite.die = die;
      sprite.refreshType();
      sprite.showFace(die.value);
      if (settleIndividually) {
        sprite.settle(((sprite.y - topY) / rippleSpan) * SETTLE_RIPPLE_MS);
      } else {
        sprite.snapSettled();
      }
    }
    if (fx.motion && !settleIndividually && this.sprites.size > 0) {
      // Hundreds of independent landing tweens are visually indistinguishable
      // at this scale. One restrained grid impact keeps the cue at constant cost.
      fx.shakeObject(this, this.gridContainer, 180, 2);
    }
    for (const [key, card] of this.cards) {
      const region = this.cardRegions.get(key);
      if (region) card.setSummary(s.dice.summarizeRegion(region.region));
    }

    // Keep the settled visible faces independent of post-score growth/shrinking.
    // Bucket mode deliberately has no global per-die index arrays; this viewport-
    // sized snapshot lets us reconstruct only the indicators the player can see.
    const rolledVisible = new Map<number, Die>();
    if (showPerDieEffects) {
      for (const [index, sprite] of this.sprites)
        rolledVisible.set(index, { ...sprite.die });
    }

    // Growing the pool relays out the grid and clears in-flight pulses. Show
    // which 5s and 6s triggered Double the Fun before their copies appear.
    const doubleTheFunHits =
      showPerDieEffects && s.hasDoubleTheFun
        ? [...rolledVisible]
            .filter(([, die]) => die.value === 5 || die.value === 6)
            .map(([index]) => index)
        : [];

    // Score the roll and grow the grid (Genesis / Double the Fun) — all state
    // mutation lives in the shared engine so the sim can't drift from the game.
    const { result, spawnedCount, spawnedBySource, shrunk } = resolveRoll(s);
    if (shrunk.length > 0) this.cardDataDirty = true;

    // The engine already appended any spawned dice to s.dice and may have shrunk
    // some (Whetstone); re-lay the grid first — before any flashing — so pulses
    // land on the refreshed, correctly-sized sprites rather than being wiped by
    // the relayout's clearPulse. This also flips to windowed rendering once the
    // count changes.

    // Collect every modifier that fired on each die so its border can flash
    // them together, split into equal arcs (e.g. half gold / half green). The
    // modifier order (scoring, Extra Point, Keen Edge, Snake Eyes, Jackpot,
    // Windfall, Momentum) sets the arc order.
    if (showPerDieEffects) {
      const dieColors = new Map<number, number[]>();
      const bigDice = new Set<number>();
      const addColor = (i: number, color: number): boolean => {
        // List-mode modifiers can contain every die in the pool. Only retain
        // live sprites so an off-screen hit cannot consume the pulse budget.
        if (!this.sprites.has(i)) return false;
        const list = dieColors.get(i) ?? [];
        list.push(color);
        dieColors.set(i, list);
        return true;
      };
      const visibleHits = (id: string): number[] => {
        const hits: number[] = [];
        for (const [index, die] of rolledVisible) {
          const windfall =
            die.maxFaceBonus > 0 && !die.loaded && die.value === die.sides;
          const royalSeal =
            s.royalSealSizes.includes(die.sides) &&
            die.value === die.sides &&
            !die.wildFace &&
            !s.scoringNumbers.includes(die.value) &&
            !windfall;
          const scoring =
            die.wildFace ||
            s.scoringNumbers.includes(die.value) ||
            windfall ||
            royalSeal;
          const hit =
            id === "scoring" || id === "extraPoint"
              ? scoring
              : id === "keenEdge"
                ? scoring && die.sides === 1
                : id === "snakeEyes"
                  ? (s.dice.agg().valueCounts.get(die.value) ?? 0) >= 2
                  : id === "jackpot"
                    ? (s.dice.agg().valueCounts.get(die.value) ?? 0) >= 3
                    : id === "windfall"
                      ? windfall
                      : id === "royalSeal"
                        ? royalSeal
                        : id === "luckySeven"
                          ? String(die.value).includes("7")
                          : false;
          if (hit) hits.push(index);
        }
        return hits;
      };
      const hitsByModifier = new Map(
        result.modifiers.map((mod) => [
          mod,
          mod.dice.length > 0 ? mod.dice : visibleHits(mod.id),
        ]),
      );
      for (const mod of result.modifiers) {
        for (const i of hitsByModifier.get(mod) ?? []) {
          if (addColor(i, mod.color) && mod.bigPulse) bigDice.add(i);
        }
      }
      for (const i of doubleTheFunHits) {
        if (addColor(i, COLORS.rarityUncommon)) bigDice.add(i);
      }
      for (const i of shrunk) addColor(i, COLORS.glowSteel);
      // Sample by grid index rather than taking the first hits, spreading the
      // feedback across the viewport while keeping Graphics/tween cost fixed.
      const pulseCandidates = [...dieColors].sort(([a], [b]) => a - b);
      for (const [i, colors] of evenlySample(
        pulseCandidates,
        MAX_PULSED_DICE,
      )) {
        this.sprites.get(i)?.pulseEffects(colors, bigDice.has(i));
      }

      const floatRows = new Map<number, number>();
      const dieFloat = (
        i: number,
        text: string,
        color: string,
        size: number,
      ) => {
        const sprite = this.sprites.get(i);
        if (!sprite) return;
        const pos = this.dieScreenPosition(sprite);
        const row = floatRows.get(i) ?? 0;
        floatRows.set(i, row + 1);
        this.overlay(
          floatText(this, pos.x, pos.y - 40 - row * 26, text, color, size),
        );
      };

      if (showPerDieCallouts) {
        // Keep the per-die Windfall callout text-only; its actual point
        // contribution is shown with the aggregate effect breakdown below.
        for (const mod of result.modifiers) {
          if (mod.float !== "perDie") continue;
          const label = mod.name.toUpperCase();
          for (const i of hitsByModifier.get(mod) ?? []) {
            const sprite = this.sprites.get(i);
            if (!sprite) continue;
            dieFloat(i, label, CSS.goldLight, 24);
          }
        }
        for (const i of doubleTheFunHits)
          dieFloat(i, "DOUBLE THE FUN", CSS.rarityUncommon, 18);
        for (const i of shrunk) dieFloat(i, "WHETSTONE", CSS.steel, 18);
      }
    }

    if (result.points > 0) {
      audio.score(Number(result.points > 100n ? 100n : result.points));
      this.overlay(
        floatText(
          this,
          this.scale.width / 2,
          150,
          `+${formatScore(result.points)}`,
          CSS.goldLight,
          42,
        ),
      );
      this.celebrateRoll(result.points);
      const listedEffects = result.modifiers.filter(
        (mod) => mod.float === "aggregate" || Boolean(mod.mult),
      );
      let floatY = 195;
      const floatStep = Math.min(
        45,
        Math.max(
          20,
          (this.scale.height - floatY - 24) /
            Math.max(1, listedEffects.length - 1),
        ),
      );
      const effectFontSize = floatStep < 32 ? 18 : 22;
      for (const mod of listedEffects) {
        // Multipliers show their marginal contribution to the final total.
        // Windfall may also have made an otherwise non-scoring top face score;
        // include that base point after every other active multiplier.
        const addedPoints = mod.mult
          ? result.points -
            result.points / mod.mult +
            (mod.displayPoints ?? 0n) * (result.multiplier / mod.mult)
          : (mod.displayPoints ?? mod.points);
        this.overlay(
          floatText(
            this,
            this.scale.width / 2,
            floatY,
            `${mod.name.toUpperCase()} +${formatScore(addedPoints)}`,
            CSS.goldLight,
            effectFontSize,
          ),
        );
        floatY += 45;
      }
    } else {
      audio.dud();
    }

    // Whetstone: flash a steel border on and float a label over each die it
    // just filed down, plus a grind cue. Runs after syncGrid so the refreshed
    // (smaller) sprite is what pulses.
    if (shrunk.length > 0) audio.shrink();

    const finishRoll = (skipHold: boolean) => {
      this.effectTimer = undefined;
      this.finishEffects = undefined;
      if (spawnedCount > 0 || shrunk.length > 0) {
        this.syncGrid(this.layout);
        // Genesis is the only roll-time creator without an existing per-die
        // cue. Double the Fun labels the die that caused each duplication.
        this.cueCreatedDice(
          spawnedBySource.genesis,
          "genesis",
          "GENESIS",
          COLORS.rarityRare,
          CSS.rarityRare,
        );
        this.cueCreatedDice(
          spawnedBySource.brickMold,
          "brick_mold",
          "BRICK MOLD",
          COLORS.rarityUncommon,
          CSS.rarityUncommon,
        );
      }
      this.checkUnlocks();
      this.updateHud();
      // Surface the next tutorial step (e.g. "Viewport" after the first roll).
      this.renderTutorial();
      if (skipHold) {
        this.afterRoll(true);
        return;
      }
      this.pendingAdvance = this.time.delayedCall(holdMs, () => {
        this.pendingAdvance = undefined;
        this.afterRoll(autoReroll);
      });
    };

    if (spawnedCount > 0 || shrunk.length > 0) {
      this.finishEffects = finishRoll;
      this.effectTimer = this.time.delayedCall(420, () => finishRoll(false));
    } else finishRoll(false);
  }

  /**
   * Shake and spark in proportion to what the roll was worth. Points are
   * weighed against the trial's own goal rather than against an absolute
   * number, because both grow by orders of magnitude across a run — a hundred
   * points is the whole trial at rank 1 and a rounding error at rank 5, and
   * only the fraction says which.
   *
   * Below `BIG_SCORE_FRACTION` the roll passes quietly: an impact on every
   * scoring roll would make all of them feel like nothing.
   */
  private celebrateRoll(points: bigint): void {
    if (!fx.on) return;
    const goal = goalFor(this.state);
    const share = goal > 0n ? Number(points) / Number(goal) : 0;
    if (share < BIG_SCORE_FRACTION) return;

    const strength = Math.min(1, share);
    const duration = 140 + 180 * strength;
    fx.shakeCamera(this.cameras.main, duration, 0.002 + 0.006 * strength);
    // The dice are drawn by a camera whose scroll is recomputed on every
    // relayout, so they're displaced by their container instead — see
    // Effects.shakeObject.
    fx.shakeObject(this, this.gridContainer, duration, 4 + 12 * strength);

    const burst = fx.burst(this, this.scale.width / 2, 150, {
      count: 12 + Math.round(28 * strength),
      tint: COLORS.glow,
      speed: 180 + 220 * strength,
    });
    if (burst) this.overlay(burst);
  }

  /** Evaluate persistent unlock criteria against the current run, announcing
   *  anything newly earned. No-ops cheaply once everything is unlocked. */
  private checkUnlocks(): void {
    for (const id of evaluateAndUnlock(this.state)) {
      if (!this.trialUnlocks.includes(id)) this.trialUnlocks.push(id);
    }
  }

  /**
   * The visual punctuation on a trial ending. Each outcome gets its own
   * colour and weight so the three read apart before the banner text has been
   * read: gold and open for a win, a warm sweep for surviving, a red lurch for
   * a run ending.
   */
  private punctuate(outcome: "victory" | "gameOver" | "advanced"): void {
    if (!fx.on) return;
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    if (outcome === "gameOver") {
      fx.shakeCamera(this.cameras.main, 460, 0.012);
      fx.shakeObject(this, this.gridContainer, 460, 16);
      return;
    }

    const gold = outcome === "victory" ? COLORS.goldLight : COLORS.gold;
    const ring = fx.shockwave(
      this,
      cx,
      cy,
      Math.min(this.scale.width, this.scale.height) * 0.35,
      gold,
      outcome === "victory" ? 900 : 620,
    );
    if (ring) this.overlay(ring);

    const burst = fx.burst(this, cx, cy, {
      count: outcome === "victory" ? 80 : 30,
      tint: gold,
      speed: outcome === "victory" ? 520 : 300,
      lifespan: outcome === "victory" ? 1500 : 800,
      gravityY: 180,
    });
    if (burst) this.overlay(burst);
  }

  private afterRoll(autoReroll: boolean): void {
    const s = this.state;

    // The shop no longer interrupts a trial — it sits between them — so the only
    // question left after a roll is whether the trial is over.
    if (trialComplete(s)) {
      this.resolveEndOfTrial();
      return;
    }

    if (autoReroll) {
      this.startRoll();
    } else {
      this.rolling = false;
    }
  }

  /** Announce the Boss Trial's modifier as the trial opens, so the player knows
   *  what they are fighting before they spend a roll finding out. */
  private announceBoss(): void {
    const boss = activeBoss(this.state);
    if (!boss) return;
    const holdMs = 1600;
    this.banners.push(`${boss.name} presides`, { holdMs, detail: boss.desc });
    // The Boss tutorial step waits for the banner it would otherwise dim.
    if (getTutorial(this.registry).active) {
      this.time.delayedCall(holdMs + 500, () => {
        this.bossCalloutHeld = false;
        this.renderTutorial();
      });
    }
  }

  /** Resolve the end of a trial (win/lose/advance) with the matching audio,
   *  result presentation, and scene transition. Assumes
   *  `trialComplete(state)`. */
  private resolveEndOfTrial(): void {
    const s = this.state;
    // The engine decides win/lose/advance, pays out the gold and runs the
    // trial-start passives on advance; the scene handles audio, banners, and
    // scene transitions around it.
    const outcome = resolveTrialEnd(s);
    if (outcome.phase === "victory") {
      audio.victory();
      this.punctuate("victory");
      this.checkUnlocks();
      this.time.delayedCall(700, () =>
        slideSceneOut(
          this,
          () =>
            this.scene.start("TrialResults", {
              outcome,
              unlocked: this.trialUnlocks,
            }),
          this.transitionBackdrop(),
        ),
      );
      return;
    }
    if (outcome.phase === "gameOver") {
      audio.gameOver();
      this.punctuate("gameOver");
      finalizeRun(s);
      this.time.delayedCall(900, () =>
        slideSceneOut(
          this,
          () => this.scene.start("GameOver", { unlocked: this.trialUnlocks }),
          this.transitionBackdrop(),
        ),
      );
      return;
    }

    audio.trialUp();
    this.punctuate("advanced");
    this.checkUnlocks();
    this.time.delayedCall(700, () => {
      this.updateHud();
      slideSceneOut(
        this,
        () =>
          this.scene.start("TrialResults", {
            outcome,
            unlocked: this.trialUnlocks,
          }),
        this.transitionBackdrop(),
      );
    });
  }

  private transitionBackdrop(): Phaser.GameObjects.GameObject[] {
    const background: Phaser.GameObjects.GameObject[] = [
      this.feltImage,
      ...this.runFooterLinks,
    ];
    if (this.ambient) background.push(this.ambient);
    return background;
  }
}
