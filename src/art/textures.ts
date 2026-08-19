import Phaser from 'phaser';
import { COLORS, CSS, DIE_BORDER, SERIF } from './palette';
import { DIE_LADDER } from '../systems/Dice';

// Square so it stretches evenly onto any viewport aspect ratio via setDisplaySize.
const FELT_SIZE = 1024;

/** Build every texture the game uses. Called once from BootScene. */
export function buildTextures(scene: Phaser.Scene): void {
  buildFelt(scene);
  buildDice(scene);
  buildPips(scene);
  buildDiceAtlas(scene);
  buildCard(scene);
  buildPlaque(scene);
  buildSeal(scene);
  buildButton(scene);
  buildPanel(scene);
  buildBanner(scene);
  buildSpark(scene);
  buildShockwave(scene);
  buildSigil(scene);
  buildSigilRing(scene);
}

/**
 * Where each sigil texture's ink actually stops, as a fraction of half the
 * texture's width — i.e. of the radius its display size implies. Nothing is
 * drawn out to the very edge (a stroke centred on the boundary would clip), so
 * a caller that needs the *drawn* radius, or that needs to leave a measured gap
 * between the two rings, can't just halve the display size. `AmbientLayer`
 * sizes the pair off these.
 */
export const SIGIL_INK_RADIUS = 248 / 256;
export const SIGIL_RING_INNER_INK_RADIUS = 384 / 512;
export const SIGIL_RING_OUTER_INK_RADIUS = 500 / 512;

/**
 * Soft white dot, the single particle of every burst and the glow halo behind
 * the roll seal. Drawn white so a tint can colour it per use, and with a
 * gradient falloff rather than a hard edge so it also reads as a light source
 * when scaled up far past its own size.
 */
function buildSpark(scene: Phaser.Scene): void {
  const size = 64;
  const tex = scene.textures.createCanvas('spark', size, size);
  if (!tex) return;
  const ctx = tex.getContext();
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.65)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  tex.refresh();
}

/** Expanding ring for impact cues. White, for tinting at the call site. */
function buildShockwave(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.lineStyle(6, 0xffffff, 1);
  g.strokeCircle(128, 128, 118);
  g.lineStyle(2, 0xffffff, 0.45);
  g.strokeCircle(128, 128, 106);
  g.generateTexture('shockwave', 256, 256);
  g.destroy();
}

/**
 * The Order's sigil: concentric rings, a tick ring, broken arcs, and an
 * inscribed triangle. It sits far behind the dice at a low alpha and turns
 * slowly, brightening and speeding up as the round's target comes into reach —
 * a background that reads as a progress meter without asking to be read.
 *
 * Drawn white so the layer can tint it (gold while the round is going well,
 * red once the last roll arrives short of target).
 */
function buildSigil(scene: Phaser.Scene): void {
  const size = 512;
  const c = size / 2;
  const g = scene.add.graphics();

  g.lineStyle(3, 0xffffff, 0.9);
  g.strokeCircle(c, c, 248);
  g.lineStyle(1.5, 0xffffff, 0.6);
  g.strokeCircle(c, c, 232);

  // Tick ring between the two outer circles, long marks on the quarters.
  const TICKS = 36;
  for (let i = 0; i < TICKS; i++) {
    const angle = (Math.PI * 2 * i) / TICKS;
    const long = i % 9 === 0;
    const inner = long ? 214 : 224;
    g.lineStyle(long ? 3 : 1.5, 0xffffff, long ? 0.9 : 0.5);
    g.lineBetween(
      c + Math.cos(angle) * inner,
      c + Math.sin(angle) * inner,
      c + Math.cos(angle) * 232,
      c + Math.sin(angle) * 232
    );
  }

  // Broken inner ring: four arcs with gaps on the diagonals.
  g.lineStyle(2, 0xffffff, 0.7);
  for (let i = 0; i < 4; i++) {
    const start = Math.PI / 4 + (Math.PI / 2) * i + 0.16;
    const end = Math.PI / 4 + (Math.PI / 2) * (i + 1) - 0.16;
    g.beginPath();
    g.arc(c, c, 168, start, end, false);
    g.strokePath();
  }

  const triangle = polygonPoints(c, c, 150, 3, -90);
  g.lineStyle(2, 0xffffff, 0.55);
  g.strokePoints(triangle, true, true);

  g.lineStyle(2, 0xffffff, 0.45);
  g.strokeCircle(c, c, 76);
  g.lineStyle(1.5, 0xffffff, 0.3);
  g.strokeCircle(c, c, 62);

  g.generateTexture('sigil', size, size);
  g.destroy();
}

/**
 * The sigil's outer ring: the same vocabulary — paired circles, a tick ring,
 * broken arcs — arranged as a band rather than a disc, so it reads as a
 * "donut" enclosing the sigil proper with clear felt between the two. Drawn on
 * a wider canvas than `sigil` because all of its ink lives in the outermost
 * quarter of the radius, which would be a handful of pixels at 512.
 *
 * Everything inside `SIGIL_RING_INNER_INK_RADIUS` is deliberately empty: that
 * hollow is what the inner sigil is centred in. White, for tinting.
 */
function buildSigilRing(scene: Phaser.Scene): void {
  const size = 1024;
  const c = size / 2;
  const outer = c * SIGIL_RING_OUTER_INK_RADIUS;
  const inner = c * SIGIL_RING_INNER_INK_RADIUS;
  const g = scene.add.graphics();

  g.lineStyle(3, 0xffffff, 0.9);
  g.strokeCircle(c, c, outer);
  g.lineStyle(1.5, 0xffffff, 0.6);
  g.strokeCircle(c, c, outer - 16);

  // Tick ring hung inside the outer pair. Denser than the inner sigil's (the
  // circumference is roughly twice as long, so the same 36 would read as a
  // sparse dotted line), with a long mark every eighth — twelve of them, the
  // hour marks of a clock face.
  const TICKS = 96;
  for (let i = 0; i < TICKS; i++) {
    const angle = (Math.PI * 2 * i) / TICKS;
    const long = i % 8 === 0;
    const from = long ? outer - 46 : outer - 30;
    g.lineStyle(long ? 3 : 1.5, 0xffffff, long ? 0.9 : 0.45);
    g.lineBetween(
      c + Math.cos(angle) * from,
      c + Math.sin(angle) * from,
      c + Math.cos(angle) * (outer - 16),
      c + Math.sin(angle) * (outer - 16)
    );
  }

  // Broken ring of six arcs. The inner sigil breaks its arcs on the diagonals,
  // so this one's gaps are offset to the twelve/two/four o'clock spokes — the
  // two rings never line their gaps up as they counter-rotate past each other.
  const arcR = (inner + outer - 46) / 2;
  g.lineStyle(2, 0xffffff, 0.7);
  for (let i = 0; i < 6; i++) {
    const start = (Math.PI / 3) * i + 0.1;
    const end = (Math.PI / 3) * (i + 1) - 0.1;
    g.beginPath();
    g.arc(c, c, arcR, start, end, false);
    g.strokePath();
  }

  // A lozenge in each gap, the same broken-rule mark the menu's masthead uses.
  g.fillStyle(0xffffff, 0.6);
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const pts = polygonPoints(c + Math.cos(angle) * arcR, c + Math.sin(angle) * arcR, 9, 4, 0);
    g.fillPoints(pts, true);
  }

  g.lineStyle(2, 0xffffff, 0.5);
  g.strokeCircle(c, c, inner + 14);
  g.lineStyle(1.5, 0xffffff, 0.3);
  g.strokeCircle(c, c, inner);

  g.generateTexture('sigil-ring', size, size);
  g.destroy();
}

/** Dark table felt with speckle noise and a vignette; stretched to fit any viewport. */
function buildFelt(scene: Phaser.Scene): void {
  const size = FELT_SIZE;
  const tex = scene.textures.createCanvas('felt', size, size);
  if (!tex) return;
  const ctx = tex.getContext();

  ctx.fillStyle = '#161226';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const light = Math.random() > 0.5;
    ctx.fillStyle = light ? 'rgba(120, 100, 170, 0.05)' : 'rgba(0, 0, 0, 0.07)';
    ctx.fillRect(x, y, 1.5, 1.5);
  }

  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.35, size / 2, size / 2, size * 0.7);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  tex.refresh();
}

const DIE_CENTER = 48;

/** Regular-polygon vertices, pointy-top by default. */
function polygonPoints(cx: number, cy: number, radius: number, sides: number, rotationDeg = -90): Phaser.Math.Vector2[] {
  const pts: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = Phaser.Math.DegToRad(rotationDeg + (360 / sides) * i);
    pts.push(new Phaser.Math.Vector2(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)));
  }
  return pts;
}

/**
 * One 96×96 ivory body per die type, shaped by side count so the grid reads
 * at a glance: d1/d2 coin, d4 triangle, d6 square, d8/d10 octagon, d20+ hex.
 */
function buildDice(scene: Phaser.Scene): void {
  for (const sides of DIE_LADDER) {
    const g = scene.add.graphics();
    const border = DIE_BORDER[sides];
    const cx = DIE_CENTER;

    if (sides <= 2) {
      // Coin: sits a touch high so the "d1"/"d2" label below has clear air.
      const scy = 42;
      g.fillStyle(COLORS.ivory, 1);
      g.fillCircle(cx, scy, 36);
      g.fillStyle(0xffffff, 0.1);
      g.fillEllipse(cx - 9, scy - 12, 26, 15);
      g.lineStyle(5, border, 1);
      g.strokeCircle(cx, scy, 33.5);
    } else if (sides === 4) {
      // Point-up triangle, flat base, so the label sits clear beneath it.
      const pts = polygonPoints(cx, 44, 46, 3, -90);
      g.fillStyle(COLORS.ivory, 1);
      g.fillPoints(pts, true);
      g.fillStyle(0xffffff, 0.1);
      g.fillEllipse(cx - 8, 34, 24, 14);
      g.lineStyle(5, border, 1);
      g.strokePoints(pts, true, true);
    } else if (sides === 6) {
      g.fillStyle(COLORS.ivory, 1);
      g.fillRoundedRect(0, 0, 96, 96, 18);
      g.fillStyle(0x000000, 0.08);
      g.fillRoundedRect(6, 58, 84, 32, { tl: 0, tr: 0, bl: 14, br: 14 });
      g.lineStyle(5, border, 1);
      g.strokeRoundedRect(2.5, 2.5, 91, 91, 16);
    } else if (sides === 8 || sides === 10) {
      const pts = polygonPoints(cx, 40, 40, 8, -90 - 22.5);
      g.fillStyle(COLORS.ivory, 1);
      g.fillPoints(pts, true);
      g.fillStyle(0xffffff, 0.1);
      g.fillEllipse(cx - 9, 28, 24, 14);
      g.lineStyle(5, border, 1);
      g.strokePoints(pts, true, true);
    } else {
      // d20+: flat-top/flat-bottom hex, the classic "d20 icon" silhouette.
      const pts = polygonPoints(cx, 40, 43, 6, 0);
      g.fillStyle(COLORS.ivory, 1);
      g.fillPoints(pts, true);
      g.fillStyle(0xffffff, 0.1);
      g.fillEllipse(cx - 9, 28, 24, 14);
      g.lineStyle(5, border, 1);
      g.strokePoints(pts, true, true);
    }

    g.generateTexture(`die-${sides}`, 96, 96);
    g.destroy();
  }
}

function buildPips(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.gold, 1);
  g.fillCircle(6, 6, 5);
  g.generateTexture('pip-gold', 12, 12);
  g.destroy();
}

const FACE_CELL = 76;

/**
 * Phaser sizes a Text object's canvas from a fixed reference string
 * (`TextStyle.testString`, `"|MÉqgy"`) via `actualBoundingBoxAscent/Descent`,
 * not the string actually being rendered — so a digit-only glyph (no
 * descenders, and usually a shorter ascent than "É") ends up ink-off-center
 * within that canvas, and `setOrigin(0.5)` only centers the *canvas*, not
 * the glyph. Measure both against the real font to compute the exact draw
 * offset that lands the glyph's own ink at the target point, instead of
 * guessing a fixed pixel nudge.
 */
function numeralYOffset(fontSize: number, bold: boolean, liftFraction: number): number {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = `${bold ? 'bold ' : ''}${fontSize}px ${SERIF}`;

  const ref = ctx.measureText('|MÉqgy'); // matches Phaser's TextStyle.testString
  const refAscent = ref.actualBoundingBoxAscent;
  const refDescent = ref.actualBoundingBoxDescent;

  const digits = ctx.measureText('0123456789');
  const digitAscent = digits.actualBoundingBoxAscent;
  const digitDescent = digits.actualBoundingBoxDescent;

  const canvasCenter = (refAscent + refDescent) / 2;
  const glyphCenter = refAscent - (digitAscent - digitDescent) / 2;
  const inkCenteringOffset = canvasCenter - glyphCenter;

  // Ink-centering alone still read as slightly low — nudge further up by a
  // fraction of the digit's own rendered height for a more pleasing (if not
  // strictly mathematical) center.
  const numberHeight = digitAscent + digitDescent;
  const opticalLift = numberHeight * liftFraction;

  return inkCenteringOffset - opticalLift;
}

/**
 * Bakes every die face (a numeral) and every "dN" type label into one shared
 * texture at boot, so `DieSprite.showFace()` never has to create or destroy
 * a GameObject to display a new face — it just swaps which frame of this
 * atlas it points at. Without this, a die's face was rebuilt from scratch on
 * every tumble tick of every roll, which is what made large dice grids crawl.
 */
function buildDiceAtlas(scene: Phaser.Scene): void {
  const faces = DIE_LADDER.flatMap((sides) =>
    Array.from({ length: sides }, (_, i) => ({ name: `face-${sides}-${i + 1}`, sides, value: i + 1 }))
  );
  const labels = DIE_LADDER.map((sides) => ({ name: `label-d${sides}`, sides }));

  const total = faces.length + labels.length;
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);

  const rt = scene.add.renderTexture(0, 0, cols * FACE_CELL, rows * FACE_CELL);
  rt.setVisible(false);

  const regions: { name: string; x: number; y: number }[] = [];
  const placeAt = (name: string) => {
    const col = regions.length % cols;
    const row = Math.floor(regions.length / cols);
    const x = col * FACE_CELL;
    const y = row * FACE_CELL;
    regions.push({ name, x, y });
    return { cx: x + FACE_CELL / 2, cy: y + FACE_CELL / 2 };
  };

  // draw() only queues a command referencing the object — it isn't rasterized
  // until render() runs, so every throwaway Text must survive until then.
  const throwaways: Phaser.GameObjects.Text[] = [];

  const numeralOffset = numeralYOffset(34, true, 0.15);
  const numeralOffsetD6 = numeralYOffset(34, true, 0);

  for (const face of faces) {
    const { cx, cy } = placeAt(face.name);
    const offset = face.sides === 6 ? numeralOffsetD6 : numeralOffset;
    const numeral = scene.add
      .text(0, 0, String(face.value), { fontFamily: SERIF, fontSize: '34px', color: CSS.ink, fontStyle: 'bold' })
      .setOrigin(0.5);
    rt.draw(numeral, cx, cy + offset);
    throwaways.push(numeral);
  }

  for (const label of labels) {
    const { cx, cy } = placeAt(label.name);
    // The d6 label sits inside the light ivory die body, so dark soft ink reads
    // well. Every other die puts its label below the shape on the dark felt,
    // where that same ink is nearly invisible — use a light parchment tone there.
    const color = label.sides === 6 ? CSS.inkSoft : CSS.parchment;
    const text = scene.add
      .text(0, 0, `d${label.sides}`, { fontFamily: SERIF, fontSize: '13px', color })
      .setOrigin(0.5);
    rt.draw(text, cx, cy);
    throwaways.push(text);
  }

  rt.render();
  const tex = rt.saveTexture('die-atlas');
  for (const r of regions) tex.add(r.name, 0, r.x, r.y, FACE_CELL, FACE_CELL);
  for (const t of throwaways) t.destroy();
  rt.destroy();
}

/** Parchment shop card with a gold double border. */
function buildCard(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.parchment, 1);
  g.fillRoundedRect(0, 0, 260, 340, 14);
  g.lineStyle(4, COLORS.gold, 1);
  g.strokeRoundedRect(2, 2, 256, 336, 12);
  g.lineStyle(2, COLORS.inkSoft, 0.6);
  g.strokeRoundedRect(10, 10, 240, 320, 8);
  g.generateTexture('card', 260, 340);
  g.destroy();
}

/** Small dark plaque for HUD stats. */
function buildPlaque(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  // Heavy lower edge and inset face give the HUD the compact, tactile stack
  // of game counters used as the reference, translated into our felt and gold.
  g.fillStyle(COLORS.feltDark, 0.7);
  g.fillRoundedRect(0, 4, 250, 54, 10);
  g.fillStyle(COLORS.feltDark, 0.98);
  g.fillRoundedRect(3, 1, 244, 53, 8);
  g.lineStyle(2, COLORS.gold, 0.75);
  g.strokeRoundedRect(5, 3, 240, 49, 7);
  g.generateTexture('plaque', 250, 58);
  g.destroy();
}

/** Wax-seal roll button. */
function buildSeal(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.waxRedDark, 1);
  g.fillCircle(85, 85, 82);
  g.fillStyle(COLORS.waxRed, 1);
  g.fillCircle(85, 82, 74);
  g.lineStyle(3, COLORS.waxRedDark, 0.8);
  g.strokeCircle(85, 82, 58);
  g.fillStyle(0xffffff, 0.12);
  g.fillEllipse(65, 52, 62, 30);
  g.generateTexture('seal', 170, 170);
  g.destroy();
}

/** Parchment banner button. */
function buildButton(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.parchment, 1);
  g.fillRoundedRect(0, 0, 340, 70, 10);
  g.lineStyle(3, COLORS.ink, 0.85);
  g.strokeRoundedRect(4, 4, 332, 62, 8);
  g.generateTexture('btn', 340, 70);
  g.destroy();
}

/** Large parchment panel (shop, hall, settings). */
function buildPanel(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.parchment, 1);
  g.fillRoundedRect(0, 0, 1100, 580, 18);
  g.lineStyle(5, COLORS.gold, 1);
  g.strokeRoundedRect(3, 3, 1094, 574, 15);
  g.lineStyle(2, COLORS.inkSoft, 0.5);
  g.strokeRoundedRect(14, 14, 1072, 552, 10);
  g.generateTexture('panel', 1100, 580);
  g.destroy();
}

/** Announcement banner strip. */
function buildBanner(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.feltDark, 0.92);
  g.fillRect(0, 0, 720, 92);
  g.lineStyle(2, COLORS.gold, 1);
  g.lineBetween(0, 3, 720, 3);
  g.lineBetween(0, 89, 720, 89);
  g.generateTexture('banner', 720, 92);
  g.destroy();
}
