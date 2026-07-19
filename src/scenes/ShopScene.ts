import Phaser from 'phaser';
import { CSS, SERIF, COLORS } from '../art/palette';
import { getRun, RunState } from '../state/RunState';
import { canShrink } from '../systems/Dice';
import { applyOffer, canAfford, rollShopOffers, ShopOffer } from '../systems/Shop';
import { audio } from '../systems/Audio';
import { DieSprite } from '../ui/DieSprite';
import { addFelt, addPanel, bannerButton } from '../ui/widgets';
import { computeGridPositions, GridArea } from '../ui/gridLayout';
import { onResizeCoalesced } from '../ui/layout';
import { WINDOW_THRESHOLD } from '../ui/windowedGrid';

const CARD_W = 260;
const CARD_H = 340;
const CARD_GAP = 26;
const DRAG_THRESHOLD = 8; // px of pointer movement before a press counts as a scroll, not a tap

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (pointer: Phaser.Input.Pointer, currentlyOver: unknown, dx: number, dy: number, dz: number) => void;

export class ShopScene extends Phaser.Scene {
  private state!: RunState;
  private offers: ShopOffer[] = [];
  private cardGroup!: Phaser.GameObjects.Container;
  private pickGroup?: Phaser.GameObjects.Container;
  // The scrollable card row renders through its own camera, clipped to the
  // carousel's screen rect — Phaser 4's WebGL renderer doesn't reliably
  // support GameObject masks for content this deep, so a GeometryMask here
  // (as used previously) lets cards render past the panel's inner border.
  private track?: Phaser.GameObjects.Container;
  private carouselCamera?: Phaser.Cameras.Scene2D.Camera;
  private dragDistance = 0;
  private carouselInput?: { down: PointerHandler; move: PointerHandler; up: PointerHandler; wheel: WheelHandler };

  constructor() {
    super('Shop');
  }

  create(): void {
    this.state = getRun(this.registry);
    this.offers = rollShopOffers(this.state);
    // The scene instance is reused across restarts, but Phaser destroys all
    // non-main cameras on shutdown — this field would otherwise dangle.
    this.carouselCamera = undefined;

    this.build();

    const off = onResizeCoalesced(this, () => {
      this.pickGroup = undefined; // drop the shrink-picker sub-screen; back to the offer cards
      this.teardownCarouselInput();
      this.children.removeAll(true);
      this.build();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardownCarouselInput();
      this.input.setDefaultCursor('default');
    });
  }

  private build(): void {
    const felt = addFelt(this);
    this.buildCards();
    // The carousel camera must ignore literally everything except `track`
    // (built inside buildCards -> buildCarousel) — otherwise it renders the
    // *entire* scene, unclipped-by-content, into its own small viewport rect.
    this.carouselCamera?.ignore(felt);
    this.carouselCamera?.ignore(this.cardGroup);
  }

  private teardownCarouselInput(): void {
    if (this.carouselInput) {
      this.input.off('pointerdown', this.carouselInput.down);
      this.input.off('pointermove', this.carouselInput.move);
      this.input.off('pointerup', this.carouselInput.up);
      this.input.off('pointerupoutside', this.carouselInput.up);
      this.input.off('wheel', this.carouselInput.wheel);
      this.carouselInput = undefined;
    }
  }

  /** The carousel camera is destroyed and recreated on every rebuild (the
   *  whole scene wipes and rebuilds on resize) rather than reused, since its
   *  viewport rect changes with the layout. */
  private ensureCarouselCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.carouselCamera) {
      this.cameras.remove(this.carouselCamera, true);
    }
    const cam = this.cameras.add(0, 0, 1, 1);
    cam.setBackgroundColor(COLORS.parchment);
    this.carouselCamera = cam;
    return cam;
  }

  private buildCards(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const panelW = Math.min(W - 40, 1100);
    const panelH = Math.min(H - 40, 620);
    const panelTop = H / 2 - panelH / 2;
    const panelBottom = H / 2 + panelH / 2;

    const items: Phaser.GameObjects.GameObject[] = [];
    items.push(addPanel(this, W / 2, H / 2, panelW, panelH));

    // Laid out sequentially from the top so nothing overlaps regardless of
    // aspect ratio — a fixed fraction-of-panelH per element can collide once
    // the panel gets tall and narrow (portrait) instead of short and wide.
    const titleSize = Math.round(Phaser.Math.Clamp(Math.min(panelW * 0.075, panelH * 0.07), 20, 40));
    const subtitleSize = Math.round(Phaser.Math.Clamp(Math.min(panelW * 0.032, panelH * 0.033), 13, 19));

    let cursorY = panelTop + Math.max(30, panelH * 0.09);
    const title = this.add
      .text(W / 2, cursorY, 'The Shop of the Order', {
        fontFamily: SERIF,
        fontSize: `${titleSize}px`,
        color: CSS.ink,
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: panelW * 0.92 }
      })
      .setOrigin(0.5);
    items.push(title);
    cursorY += title.height / 2 + subtitleSize + 10;

    const subtitle = this.add
      .text(
        W / 2,
        cursorY,
        `Your score: ${this.state.score} point${this.state.score === 1 ? '' : 's'} — choose one offering`,
        {
          fontFamily: SERIF,
          fontSize: `${subtitleSize}px`,
          color: CSS.inkSoft,
          fontStyle: 'italic',
          align: 'center',
          wordWrap: { width: panelW * 0.92 }
        }
      )
      .setOrigin(0.5);
    items.push(subtitle);
    cursorY += subtitle.height / 2 + 26;

    const buttonH = 70;
    const bottomPad = 26;
    const scrollbarReserve = 46; // room for the scrollbar + hint, whether or not they end up shown
    const availCardH = panelBottom - bottomPad - buttonH / 2 - scrollbarReserve - cursorY;
    const cardScale = Phaser.Math.Clamp(availCardH / CARD_H, 0.4, 1);

    const carouselY = cursorY + (CARD_H * cardScale) / 2;
    const carousel = this.buildCarousel(W, carouselY, cardScale);
    items.push(...carousel.decor);

    const buttonY = Math.min(panelBottom - bottomPad - buttonH / 2, carousel.bottomY + buttonH / 2 + 16);
    items.push(bannerButton(this, W / 2, buttonY, 'Decline the Offerings', () => this.exit()));

    this.cardGroup = this.add.container(0, 0, items);
  }

  /** A horizontally scrollable row of offer cards: drag/swipe, mouse wheel, and a scrollbar. */
  private buildCarousel(
    W: number,
    y: number,
    cardScale: number
  ): { decor: Phaser.GameObjects.GameObject[]; bottomY: number } {
    const cardW = CARD_W * cardScale;
    const cardH = CARD_H * cardScale;
    const gap = CARD_GAP * cardScale;
    const n = this.offers.length;
    const contentW = n * cardW + (n - 1) * gap;

    const viewportMargin = 40;
    const viewportW = Math.min(contentW, W - viewportMargin * 2);
    const viewportH = cardH + 24;
    const viewportX = (W - viewportW) / 2;
    const overflow = Math.max(0, contentW - viewportW);

    const restX = overflow > 0 ? viewportX : viewportX + (viewportW - contentW) / 2;
    const minX = overflow > 0 ? viewportX - overflow : restX;
    const maxX = restX;

    const track = this.add.container(restX, y);
    this.offers.forEach((offer, idx) => {
      const cardX = idx * (cardW + gap) + cardW / 2;
      const card = this.buildCard(cardX, 0, offer);
      card.setScale(cardScale);
      track.add(card);
    });
    this.track = track;

    // Clip cards to the viewport via a dedicated camera (native, always-
    // correct scissor clipping) instead of a GameObject mask. A camera's
    // scroll defaults to (0,0), which shows whatever's at *world* (0,0) —
    // not wherever the viewport rect happens to sit on screen — so without
    // an explicit scroll matching the viewport's own position, the camera
    // shows the wrong slice of the scene entirely. At zoom 1 this is a pure
    // passthrough: scroll = the viewport's own screen position.
    const cam = this.ensureCarouselCamera();
    cam.setViewport(viewportX, y - viewportH / 2, viewportW, viewportH);
    cam.setScroll(viewportX, y - viewportH / 2);
    this.cameras.main.ignore(track);

    const decor: Phaser.GameObjects.GameObject[] = [];
    this.dragDistance = 0;
    let bottomY = y + viewportH / 2;

    if (overflow > 0) {
      const barY = y + viewportH / 2 + 20;
      const barTrack = this.add.rectangle(viewportX + viewportW / 2, barY, viewportW, 5, COLORS.inkSoft, 0.4);
      const thumbW = Math.max(30, (viewportW * viewportW) / contentW);
      const thumb = this.add.rectangle(viewportX + thumbW / 2, barY, thumbW, 5, COLORS.gold, 0.9);
      const updateThumb = () => {
        const progress = (maxX - track.x) / (maxX - minX);
        thumb.x = viewportX + thumbW / 2 + progress * (viewportW - thumbW);
      };

      const inBounds = (p: Phaser.Input.Pointer) =>
        p.x >= viewportX && p.x <= viewportX + viewportW && p.y >= y - viewportH / 2 && p.y <= y + viewportH / 2;

      let dragging = false;
      let startPointerX = 0;
      let startTrackX = 0;

      const onDown: PointerHandler = (p) => {
        if (!inBounds(p)) return;
        dragging = true;
        startPointerX = p.x;
        startTrackX = track.x;
        this.dragDistance = 0;
      };
      const onMove: PointerHandler = (p) => {
        if (!dragging) {
          this.input.setDefaultCursor(inBounds(p) ? 'grab' : 'default');
          return;
        }
        const dx = p.x - startPointerX;
        this.dragDistance = Math.abs(dx);
        track.x = Phaser.Math.Clamp(startTrackX + dx, minX, maxX);
        updateThumb();
      };
      const onUp: PointerHandler = () => {
        dragging = false;
      };
      const onWheel: WheelHandler = (p, _over, dx, dy) => {
        if (!inBounds(p)) return;
        const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        track.x = Phaser.Math.Clamp(track.x - delta, minX, maxX);
        updateThumb();
      };

      this.input.on('pointerdown', onDown);
      this.input.on('pointermove', onMove);
      this.input.on('pointerup', onUp);
      this.input.on('pointerupoutside', onUp);
      this.input.on('wheel', onWheel);
      this.carouselInput = { down: onDown, move: onMove, up: onUp, wheel: onWheel };

      const hint = this.add
        .text(W / 2, barY + 18, 'drag or scroll to see more', {
          fontFamily: SERIF,
          fontSize: '14px',
          color: CSS.dim,
          fontStyle: 'italic'
        })
        .setOrigin(0.5);

      decor.push(barTrack, thumb, hint);
      bottomY = barY + 18 + 10;
    }

    return { decor, bottomY };
  }

  private buildCard(x: number, y: number, offer: ShopOffer): Phaser.GameObjects.Container {
    const affordable = canAfford(this.state, offer);
    const img = this.add.image(0, 0, 'card');
    const name = this.add
      .text(0, -110, offer.name, {
        fontFamily: SERIF,
        fontSize: '26px',
        color: CSS.ink,
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: 220 }
      })
      .setOrigin(0.5);
    const desc = this.add
      .text(0, -10, offer.desc, {
        fontFamily: SERIF,
        fontSize: '19px',
        color: CSS.inkSoft,
        align: 'center',
        wordWrap: { width: 214 }
      })
      .setOrigin(0.5);
    const costLabel = offer.cost === 0 ? 'Free' : `${offer.cost} point${offer.cost > 1 ? 's' : ''}`;
    const cost = this.add
      .text(0, 128, costLabel, {
        fontFamily: SERIF,
        fontSize: '24px',
        color: affordable ? CSS.gold : CSS.red,
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    const card = this.add.container(x, y, [img, name, desc, cost]);
    card.setSize(img.width, img.height);

    if (affordable) {
      card.setInteractive({ useHandCursor: true });
      card.on('pointerover', () => img.setTint(0xfff2c8));
      card.on('pointerout', () => img.clearTint());
      // Buy on release, not press, and only if this wasn't a carousel drag/swipe.
      card.on('pointerup', () => {
        if (this.dragDistance < DRAG_THRESHOLD) this.choose(offer);
      });
    } else {
      card.setAlpha(0.55);
    }
    return card;
  }

  private choose(offer: ShopOffer): void {
    if (offer.needsTarget) {
      this.enterPickMode(offer);
      return;
    }
    if (applyOffer(this.state, offer)) {
      audio.buy();
      this.exit();
    } else {
      audio.deny();
    }
  }

  /** Shrink Die: show the player's grid and let them pick a target. Above
   *  WINDOW_THRESHOLD, one sprite per die is both a rendering problem and
   *  bad UX (scrolling through thousands of identical icons) — dice of the
   *  same type are interchangeable for shrinking, so pick by type instead. */
  private enterPickMode(offer: ShopOffer): void {
    this.cardGroup.setVisible(false);
    this.track?.setVisible(false);
    if (this.carouselCamera) this.carouselCamera.visible = false;

    const W = this.scale.width;
    const H = this.scale.height;
    const items: Phaser.GameObjects.GameObject[] = [];
    items.push(
      this.add
        .text(W / 2, H * 0.12, 'Choose a die to shrink', {
          fontFamily: SERIF,
          fontSize: '34px',
          color: CSS.ink,
          fontStyle: 'bold'
        })
        .setOrigin(0.5)
    );

    const area = { x: W * 0.08, y: H * 0.2, width: W * 0.84, height: H * 0.58 };
    const grouped = this.state.dice.length > WINDOW_THRESHOLD;
    items.push(...(grouped ? this.buildGroupedPicker(offer, area) : this.buildIndividualPicker(offer, area)));

    items.push(
      bannerButton(this, W / 2, H - Math.min(75, H * 0.1), 'Back to the Offerings', () => {
        this.pickGroup?.destroy();
        this.pickGroup = undefined;
        this.cardGroup.setVisible(true);
        this.track?.setVisible(true);
        if (this.carouselCamera) this.carouselCamera.visible = true;
      })
    );

    this.pickGroup = this.add.container(0, 0, items);
  }

  private buildIndividualPicker(offer: ShopOffer, area: GridArea): Phaser.GameObjects.GameObject[] {
    const items: Phaser.GameObjects.GameObject[] = [];
    const { scale, positions } = computeGridPositions(this.state.dice.length, area, 112);

    this.state.dice.forEach((die, i) => {
      const sprite = new DieSprite(this, positions[i].x, positions[i].y, die);
      sprite.setScale(scale);
      sprite.showFace(null);

      if (canShrink(die)) {
        sprite.setSize(104, 104);
        sprite.setInteractive({ useHandCursor: true });
        sprite.on('pointerover', () => sprite.setScale(scale * 1.12));
        sprite.on('pointerout', () => sprite.setScale(scale));
        sprite.on('pointerdown', () => this.applyShrinkAndExit(offer, i));
      } else {
        sprite.setAlpha(0.35);
      }
      items.push(sprite);
    });
    return items;
  }

  /** One representative sprite + count badge per distinct (sides, rollplayer)
   *  combination — at most `DIE_LADDER.length * 2` regardless of how many
   *  dice the player owns. Picking one shrinks the first matching die. */
  private buildGroupedPicker(offer: ShopOffer, area: GridArea): Phaser.GameObjects.GameObject[] {
    interface Group {
      sides: number;
      rollplayer: boolean;
      count: number;
      firstIndex: number;
    }
    const groups = new Map<string, Group>();
    this.state.dice.forEach((die, i) => {
      const key = `${die.sides}-${die.rollplayer}`;
      const g = groups.get(key);
      if (g) {
        g.count += 1;
      } else {
        groups.set(key, { sides: die.sides, rollplayer: die.rollplayer, count: 1, firstIndex: i });
      }
    });

    const entries = [...groups.values()].sort((a, b) => b.sides - a.sides);
    const { scale, positions } = computeGridPositions(entries.length, area, 112);

    const items: Phaser.GameObjects.GameObject[] = [];
    entries.forEach((group, i) => {
      const { x, y } = positions[i];
      const die = this.state.dice[group.firstIndex];
      const sprite = new DieSprite(this, x, y, die);
      sprite.setScale(scale);
      sprite.showFace(null);
      items.push(sprite);

      items.push(
        this.add
          .text(x, y + 50 * scale, `×${group.count}`, {
            fontFamily: SERIF,
            fontSize: '15px',
            color: CSS.goldLight,
            fontStyle: 'bold'
          })
          .setOrigin(0.5)
      );

      if (canShrink(die)) {
        sprite.setSize(104, 104);
        sprite.setInteractive({ useHandCursor: true });
        sprite.on('pointerover', () => sprite.setScale(scale * 1.12));
        sprite.on('pointerout', () => sprite.setScale(scale));
        sprite.on('pointerdown', () => this.applyShrinkAndExit(offer, group.firstIndex));
      } else {
        sprite.setAlpha(0.35);
      }
    });
    return items;
  }

  private applyShrinkAndExit(offer: ShopOffer, index: number): void {
    if (applyOffer(this.state, offer, index)) {
      audio.buy();
      this.exit();
    } else {
      audio.deny();
    }
  }

  private exit(): void {
    this.scene.start('Game');
  }
}
