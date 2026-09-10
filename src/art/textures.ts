import Phaser from "phaser";
import { COLORS, CSS, DIE_BORDER, SERIF } from "./palette";
import { DPR } from "../renderQuality";
import { DIE_LADDER } from "../systems/Dice";
import type { AfflictionId } from "../systems/Afflictions";
import type { BossModifierId } from "../systems/Boss";

// Square so it stretches evenly onto any viewport aspect ratio via setDisplaySize.
const FELT_SIZE = 1024;

/**
 * Texture pixels baked per *designed* pixel — the unit every builder in this
 * file draws in, and the unit every scene lays out in.
 *
 * Scenes lay out in CSS pixels and every camera magnifies by `DPR` (see
 * `renderQuality`), so art baked one texture pixel to the designed pixel is a
 * `DPR`x upscale by the time it reaches the glass. With the canvas and the text
 * both at device resolution, that made the baked art the softest layer on the
 * table; baking at `DPR` instead puts it back at 1:1.
 *
 * Rounded *up* to a whole number rather than taken as `DPR` itself, for two
 * reasons. The dice atlas packs its frames on a grid of `FACE_CELL * ART_SCALE`
 * and registers integer frame rects, so a fractional cell would sit every face
 * on a half pixel and bleed its neighbours into it. And a whole scale keeps a
 * baked size exactly divisible again, so `artScale` below hands a consumer a
 * display size that is exactly the designed one rather than nearly it. `DPR` is
 * already capped at 3, so this is too.
 */
// Capture Studio can ask the small dice assets for extra source resolution
// without supersampling the entire 1600x900 scene. This keeps close-zoom reel
// faces and baked type labels crisp while leaving normal device memory policy
// entirely governed by DPR. The override is deliberately capped at the same
// ceiling as DPR and is only set by the capture scripts.
const requestedCaptureArtScale = Number(
  new URLSearchParams(window.location.search).get("captureArtScale"),
);
const CAPTURE_ART_SCALE = Number.isFinite(requestedCaptureArtScale)
  ? Phaser.Math.Clamp(Math.ceil(requestedCaptureArtScale), 1, 3)
  : 1;
const ART_SCALE = Math.max(Math.ceil(DPR), CAPTURE_ART_SCALE);

/**
 * What each texture is baked at, and the whole of the decision about which ones
 * are worth the memory — the cost is quadratic, and it only buys anything where
 * the art is drawn at or near its designed size.
 *
 * Listed here: the small, crisp-edged pieces, where a soft edge is the whole
 * problem. Absent, and so baked at 1:
 *
 * - `panel` is 1100x580 and `Callout` is its only consumer, which caps it at
 *   360 layout px wide — 1080 device pixels at DPR 3, against 1100 baked. It
 *   is already at 1:1 and a bump would be 23MB for nothing.
 * - `felt` is 1024² of speckle and vignette stretched over the whole viewport,
 *   and `spark` and `shockwave` are gradients blown up many times their own
 *   size. All three are soft by design; there is no edge in them to sharpen.
 * - The sigils are 512² (and their rings 1024²) across 28 marks and 3 rings —
 *   some 41MB at 1x already. They are drawn at alpha 0.05-0.2 behind everything
 *   else, which is the one place a soft line genuinely does not read.
 */
const BAKE_SCALE: Record<string, number> = {
  card: ART_SCALE,
  plaque: ART_SCALE,
  seal: ART_SCALE,
  btn: ART_SCALE,
  banner: ART_SCALE,
  "pip-gold": ART_SCALE,
  "die-atlas": ART_SCALE,
  ...Object.fromEntries(DIE_LADDER.map((sides) => [`die-${sides}`, ART_SCALE])),
};

function bakeScale(key: string): number {
  return BAKE_SCALE[key] ?? 1;
}

/**
 * The scale the dice atlas can actually be baked at on this device.
 *
 * It is the one texture here big enough to meet a hardware limit: at
 * `ART_SCALE` 3 it is a single 2964px square, against a `MAX_TEXTURE_SIZE`
 * that WebGL2 only guarantees to be 2048. Every GPU that would also report
 * more than four cores (see `DPR`, which is capped at 2 below that) reports
 * 4096 or more in practice — but "in practice" is not something to hand a
 * render target, and overshooting the limit is a blank atlas, not a soft one.
 *
 * Written back into `BAKE_SCALE` so that consumers normalising against the
 * atlas read the scale it was really baked at. Called from `buildDiceAtlas`,
 * which runs at boot before anything displays a face.
 */
function fitAtlasScale(scene: Phaser.Scene, span: number): number {
  const renderer = scene.game.renderer;
  const gl =
    renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer
      ? renderer.gl
      : undefined;
  const max = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : Infinity;
  let scale = bakeScale("die-atlas");
  while (scale > 1 && span * scale > max) scale--;
  BAKE_SCALE["die-atlas"] = scale;
  return scale;
}

/**
 * The object scale that draws `key` at `scale` designed pixels per designed
 * pixel — i.e. the normalisation a consumer owes a texture baked above 1.
 *
 * Phaser 4.2 cannot do this for us. `TextureSource.resolution` exists but is
 * initialised to 1 and read by nothing — `Frame` never consults it — so there
 * is no way to declare "this texture is 3x and its natural size is a third of
 * its pixels". Every consumer that sizes an image off its *native* pixels has
 * to come through here (or size it explicitly with `setDisplaySize`, which is
 * self-normalising and needs nothing).
 */
export function artScale(key: string, scale = 1): number {
  return scale / bakeScale(key);
}

/** `scene.add.image`, drawn at the size the texture was designed at whatever
 *  scale it was baked at. The normalised counterpart of `scene.add.image` for
 *  every consumer that does not go on to call `setDisplaySize`. */
export function artImage(
  scene: Phaser.Scene,
  x: number,
  y: number,
  key: string,
  frame?: string,
): Phaser.GameObjects.Image {
  return scene.add.image(x, y, key, frame).setScale(artScale(key));
}

/** `Image.setScale`, taking the magnification relative to the texture's
 *  designed size rather than its baked pixels. */
export function setArtScale(
  image: Phaser.GameObjects.Image,
  scale: number,
): Phaser.GameObjects.Image {
  return image.setScale(artScale(image.texture.key, scale));
}

/**
 * Bake a Graphics object into its texture.
 *
 * The drawing above is all in designed pixels; this scales it to the pixels the
 * texture is actually baked at. `generateTexture` renders the object through
 * its own transform, so one scale on the Graphics carries the geometry and
 * every line width with it and no drawing code has to know the scale exists.
 */
function bakeGraphics(
  g: Phaser.GameObjects.Graphics,
  key: string,
  width: number,
  height: number,
): void {
  const scale = bakeScale(key);
  g.setScale(scale);
  g.generateTexture(key, width * scale, height * scale);
  g.destroy();
}

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
  buildSigils(scene);
  buildAfflictionSigils(scene);
  buildSigilRings(scene);
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

/** Texture keys for the interchangeable pieces of the ambient sigil. Every
 * variant keeps the same outer/inner ink bounds, so callers can size any pair
 * with the constants above. The original keys stay first for existing uses. */
export const SIGIL_TEXTURE_KEYS = ["sigil", "sigil-2", "sigil-3"] as const;
export const SIGIL_RING_TEXTURE_KEYS = [
  "sigil-ring",
  "sigil-ring-2",
  "sigil-ring-3",
] as const;

/** A fixed inner sigil for each boss. Unlike the ambient variants, these are
 * identities: meeting The Warden again always brings back the same mark. */
export const BOSS_SIGIL_TEXTURE_KEYS: Record<BossModifierId, string> = {
  famine: "sigil-boss-famine",
  drought: "sigil-boss-drought",
  eclipse: "sigil-boss-eclipse",
  silence: "sigil-boss-silence",
  hunger: "sigil-boss-hunger",
  warden: "sigil-boss-warden",
  toll: "sigil-boss-toll",
  hoard: "sigil-boss-hoard",
};

/**
 * A mark for every affliction in the game, boss and curse alike.
 *
 * A boss announces itself with a sigil turning behind the dice; a cursed card
 * is stamped with one behind its copy (see ui/itemCard). Both read from this
 * one table, so a drawback that arrives from either direction wears the same
 * face — which is the whole point of afflictions being one vocabulary.
 *
 * The eight boss ids keep their `sigil-boss-*` keys, since the ambient layer
 * has always asked for them by that name; the drawbacks that were never a boss
 * take `sigil-curse-*`.
 */
export const AFFLICTION_SIGIL_TEXTURE_KEYS: Record<AfflictionId, string> = {
  ...BOSS_SIGIL_TEXTURE_KEYS,
  crunchTime: "sigil-curse-crunch-time",
  bloodPrice: "sigil-curse-blood-price",
  ouroboros: "sigil-curse-ouroboros",
  famishedIdol: "sigil-curse-famished-idol",
  bloat: "sigil-curse-bloat",
  ironDebt: "sigil-curse-iron-debt",
  paupersVow: "sigil-curse-paupers-vow",
  sealedDoors: "sigil-curse-sealed-doors",
  devilsBargain: "sigil-curse-devils-bargain",
  leadenDice: "sigil-curse-leaden-dice",
  locustIdol: "sigil-curse-locust-idol",
  gamblersCurse: "sigil-curse-gamblers-curse",
  reckoning: "sigil-curse-reckoning",
  hairTrigger: "sigil-curse-hair-trigger",
  longNight: "sigil-curse-long-night",
  tollkeeper: "sigil-curse-tollkeeper",
  betrayal: "sigil-curse-betrayal",
};

export function bossSigilTexture(id: BossModifierId): string {
  return BOSS_SIGIL_TEXTURE_KEYS[id];
}

export function afflictionSigilTexture(id: AfflictionId): string {
  return AFFLICTION_SIGIL_TEXTURE_KEYS[id];
}

/** How far the stamped copy of a sigil is blurred, in pixels of the 512-unit
 *  texture — about one pixel once a card has scaled the seal down to its
 *  parchment. Enough to take the mark out of the type's frequency band, not so
 *  much that it stops being a drawing. */
const SIGIL_BLUR_PX = 3;

/**
 * A softened copy of a sigil texture, for the seal stamped on a cursed card.
 *
 * A curse's mark is drawn in the two thin weights `buildAfflictionSigil` allows
 * it, which at card size land within a pixel of the stem width of the serif the
 * copy is set in — so the sharp texture doesn't read as a background at all. It
 * reads as more letterforms, and its rings, running flat and horizontal where
 * they pass a line of text, merge into the words like an underline. Blurring
 * costs the mark none of its presence: it moves it out of the type's frequency
 * band, so the seal reads as ink soaked into the parchment and the copy is the
 * only sharp thing on the card.
 *
 * Softened here, at the card, rather than in `buildAfflictionSigil`: the
 * `sigil-boss-*` half of the table is also the mark turning behind the dice,
 * where the silhouette wants its edge. Blurring the consumer's copy leaves the
 * ambient layer's untouched whichever affliction arrives on a card.
 *
 * The blurred copy is built once per sigil, on first use, and cached under its
 * own key. Falls back to the sharp texture where canvas filters are missing.
 */
export function softenedSigilTexture(scene: Phaser.Scene, key: string): string {
  const softKey = `${key}-soft`;
  if (scene.textures.exists(softKey)) return softKey;
  const source = scene.textures.get(key).getSourceImage();
  if (!(source instanceof HTMLCanvasElement) && !(source instanceof Image))
    return key;
  const soft = scene.textures.createCanvas(
    softKey,
    source.width,
    source.height,
  );
  if (!soft) return key;
  const ctx = soft.getContext();
  if (!("filter" in ctx)) {
    scene.textures.remove(softKey);
    return key;
  }
  ctx.filter = `blur(${SIGIL_BLUR_PX}px)`;
  ctx.drawImage(source, 0, 0);
  soft.refresh();
  return softKey;
}

export function randomSigilTexture(): (typeof SIGIL_TEXTURE_KEYS)[number] {
  return SIGIL_TEXTURE_KEYS[
    Math.floor(Math.random() * SIGIL_TEXTURE_KEYS.length)
  ];
}

export function randomSigilRingTexture(): (typeof SIGIL_RING_TEXTURE_KEYS)[number] {
  return SIGIL_RING_TEXTURE_KEYS[
    Math.floor(Math.random() * SIGIL_RING_TEXTURE_KEYS.length)
  ];
}

/**
 * Soft white dot, the single particle of every burst and the glow halo behind
 * the roll seal. Drawn white so a tint can colour it per use, and with a
 * gradient falloff rather than a hard edge so it also reads as a light source
 * when scaled up far past its own size.
 */
function buildSpark(scene: Phaser.Scene): void {
  const size = 64;
  const tex = scene.textures.createCanvas("spark", size, size);
  if (!tex) return;
  const ctx = tex.getContext();
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.65)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
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
  bakeGraphics(g, "shockwave", 256, 256);
}

/**
 * The Order's sigil: concentric rings, a tick ring, broken arcs, and an
 * inscribed triangle. It sits far behind the dice at a low alpha and turns
 * slowly, brightening and speeding up as the trial's goal comes into reach —
 * a background that reads as a progress meter without asking to be read.
 *
 * Drawn white so the layer can tint it (gold while the trial is going well,
 * red once the last roll arrives short of target).
 */
function buildSigils(scene: Phaser.Scene): void {
  SIGIL_TEXTURE_KEYS.forEach((key, variant) => buildSigil(scene, key, variant));
}

function buildSigil(scene: Phaser.Scene, key: string, variant: number): void {
  const size = 512;
  const c = size / 2;
  const g = scene.add.graphics();

  g.lineStyle(3, 0xffffff, 0.9);
  g.strokeCircle(c, c, 248);
  g.lineStyle(1.5, 0xffffff, 0.6);
  g.strokeCircle(c, c, 232);

  // Tick ring between the two outer circles. Each variant has a different
  // cadence, with longer marks at its major divisions.
  const tickCounts = [36, 48, 30];
  const majorEvery = [9, 6, 5];
  const ticks = tickCounts[variant];
  for (let i = 0; i < ticks; i++) {
    const angle = (Math.PI * 2 * i) / ticks;
    const long = i % majorEvery[variant] === 0;
    const inner = long ? 214 : 224;
    g.lineStyle(long ? 3 : 1.5, 0xffffff, long ? 0.9 : 0.5);
    g.lineBetween(
      c + Math.cos(angle) * inner,
      c + Math.sin(angle) * inner,
      c + Math.cos(angle) * 232,
      c + Math.sin(angle) * 232,
    );
  }

  if (variant === 0) {
    // Broken inner ring: four arcs with gaps on the diagonals.
    strokeBrokenRing(g, c, 168, 4, Math.PI / 4, 0.16);

    const triangle = polygonPoints(c, c, 150, 3, -90);
    g.lineStyle(2, 0xffffff, 0.55);
    g.strokePoints(triangle, true, true);

    g.lineStyle(2, 0xffffff, 0.45);
    g.strokeCircle(c, c, 76);
    g.lineStyle(1.5, 0xffffff, 0.3);
    g.strokeCircle(c, c, 62);
  } else if (variant === 1) {
    // An eight-gated ring around two counter-set squares. Short spokes make
    // this version read like a mechanical compass as it rotates.
    strokeBrokenRing(g, c, 174, 8, 0, 0.1);
    g.lineStyle(2, 0xffffff, 0.58);
    g.strokePoints(polygonPoints(c, c, 148, 4, 45), true, true);
    g.lineStyle(1.5, 0xffffff, 0.42);
    g.strokePoints(polygonPoints(c, c, 104, 4, 0), true, true);
    for (let i = 0; i < 4; i++) {
      const angle = (Math.PI / 2) * i;
      g.lineBetween(
        c + Math.cos(angle) * 104,
        c + Math.sin(angle) * 104,
        c + Math.cos(angle) * 148,
        c + Math.sin(angle) * 148,
      );
    }
    g.lineStyle(2, 0xffffff, 0.42);
    g.strokeCircle(c, c, 48);
    g.fillStyle(0xffffff, 0.5);
    g.fillCircle(c, c, 7);
  } else {
    // A six-gated ring and hexagram give the last version a more ceremonial,
    // star-chart silhouette without changing the texture's measured bounds.
    strokeBrokenRing(g, c, 170, 6, -Math.PI / 6, 0.13);
    g.lineStyle(2, 0xffffff, 0.52);
    g.strokePoints(polygonPoints(c, c, 148, 3, -90), true, true);
    g.strokePoints(polygonPoints(c, c, 148, 3, 90), true, true);
    g.lineStyle(1.5, 0xffffff, 0.38);
    g.strokePoints(polygonPoints(c, c, 72, 6, -90), true, true);
    g.lineStyle(2, 0xffffff, 0.42);
    g.strokeCircle(c, c, 42);
  }

  bakeGraphics(g, key, size, size);
}

/** Affliction marks share the ambient sigils' measured outer rings, but replace
 * the centre with a rule-specific emblem.
 *
 * The two halves of the table are drawn at deliberately different weights. A
 * boss's mark turns behind a whole room of dice at very low opacity, so its
 * silhouette is bold or it is not there at all. A curse's is stamped on a card
 * UNDER the copy the player has to read, where a heavy line or a filled shape
 * reads as a smudge across the words — so every cursed mark is drawn in the two
 * thin weights below and nothing else, with no fills anywhere. */
function buildAfflictionSigils(scene: Phaser.Scene): void {
  (
    Object.entries(AFFLICTION_SIGIL_TEXTURE_KEYS) as [AfflictionId, string][]
  ).forEach(([id, key], index) => buildAfflictionSigil(scene, key, id, index));
}

/** The only two line weights a cursed mark — frame included — is drawn in. */
const CURSE_LINE = 2;
const CURSE_LINE_FAINT = 1.25;
const CURSE_ALPHA = 0.8;
const CURSE_ALPHA_FAINT = 0.5;

function buildAfflictionSigil(
  scene: Phaser.Scene,
  key: string,
  id: AfflictionId,
  index: number,
): void {
  const size = 512;
  const c = size / 2;
  const g = scene.add.graphics();
  // A boss keeps the bold frame it has always turned behind the dice in; every
  // other affliction is a card seal, and takes the thin one.
  const cursed = !(id in BOSS_SIGIL_TEXTURE_KEYS);
  /** The mark's ordinary line, and the one it recedes to. */
  const line = () =>
    cursed
      ? g.lineStyle(CURSE_LINE, 0xffffff, CURSE_ALPHA)
      : g.lineStyle(4, 0xffffff, 0.72);
  const faint = () =>
    cursed
      ? g.lineStyle(CURSE_LINE_FAINT, 0xffffff, CURSE_ALPHA_FAINT)
      : g.lineStyle(3, 0xffffff, 0.5);

  g.lineStyle(cursed ? CURSE_LINE : 3, 0xffffff, cursed ? 0.6 : 0.9);
  g.strokeCircle(c, c, 248);
  g.lineStyle(cursed ? CURSE_LINE_FAINT : 1.5, 0xffffff, cursed ? 0.38 : 0.55);
  g.strokeCircle(c, c, 232);
  const ticks = 32 + (index % 3) * 8;
  for (let i = 0; i < ticks; i++) {
    const angle = (Math.PI * 2 * i) / ticks;
    const major = i % 8 === 0;
    const inner = major ? 208 : 220;
    if (cursed)
      g.lineStyle(
        major ? CURSE_LINE : CURSE_LINE_FAINT,
        0xffffff,
        major ? 0.55 : 0.3,
      );
    else g.lineStyle(major ? 3 : 1.5, 0xffffff, major ? 0.85 : 0.42);
    g.lineBetween(
      c + Math.cos(angle) * inner,
      c + Math.sin(angle) * inner,
      c + Math.cos(angle) * 232,
      c + Math.sin(angle) * 232,
    );
  }
  strokeBrokenRing(
    g,
    c,
    180,
    8,
    Math.PI / 8,
    0.1,
    cursed ? 0.3 : 0.48,
    cursed ? CURSE_LINE_FAINT : 2,
  );
  line();

  switch (id) {
    case "famine":
      // An empty bowl beneath three descending, broken grain stalks.
      g.beginPath();
      g.arc(c, c + 28, 94, 0.12, Math.PI - 0.12, false);
      g.strokePath();
      g.lineBetween(c - 76, c + 56, c + 76, c + 56);
      for (const x of [c - 48, c, c + 48]) {
        g.lineBetween(x, c - 104, x, c - 42);
        g.lineBetween(x - 10, c - 84, x, c - 72);
        g.lineBetween(x + 10, c - 62, x, c - 50);
      }
      break;
    case "drought":
      // A split water drop, cracked before it reaches the basin.
      g.beginPath();
      g.moveTo(c, c - 118);
      g.lineTo(c - 76, c - 10);
      g.lineTo(c - 62, c + 66);
      g.lineTo(c, c + 104);
      g.lineTo(c + 62, c + 66);
      g.lineTo(c + 76, c - 10);
      g.closePath();
      g.strokePath();
      g.lineBetween(c + 12, c - 76, c - 16, c - 8);
      g.lineBetween(c - 16, c - 8, c + 24, c + 18);
      g.lineBetween(c + 24, c + 18, c - 12, c + 88);
      break;
    case "eclipse":
      // A crescent held inside the sun's own disc: the light still standing,
      // and most of it already taken. The crescent's horns point the opposite
      // way to The Long Night's, so the two marks never read as one another.
      g.strokeCircle(c, c, 122);
      faint();
      for (let i = 0; i < 12; i++) {
        const a = (Math.PI * i) / 6;
        g.lineBetween(
          c + Math.cos(a) * 136,
          c + Math.sin(a) * 136,
          c + Math.cos(a) * 166,
          c + Math.sin(a) * 166,
        );
      }
      line();
      // Both arcs meet at the same two horns: the outer swings wide of centre,
      // the inner cuts back across it.
      g.beginPath();
      g.arc(c, c, 84, Math.PI * 1.3, Math.PI * 0.7, false);
      g.strokePath();
      g.beginPath();
      g.arc(c - 45, c, 68, Math.PI * 1.521, Math.PI * 0.479, false);
      g.strokePath();
      break;
    case "silence":
      // A clapperless bell cut through by the boss's binding stroke.
      g.beginPath();
      g.moveTo(c - 82, c + 62);
      g.lineTo(c - 56, c + 26);
      g.lineTo(c - 44, c - 58);
      g.lineTo(c, c - 92);
      g.lineTo(c + 44, c - 58);
      g.lineTo(c + 56, c + 26);
      g.lineTo(c + 82, c + 62);
      g.closePath();
      g.strokePath();
      g.lineBetween(c - 112, c - 104, c + 112, c + 104);
      break;
    case "hunger":
      // A candle burned down to a stub in a tall holder: the rite ends when it
      // does, and it has almost nothing left to give.
      g.beginPath();
      g.moveTo(c, c - 126);
      g.lineTo(c + 24, c - 84);
      g.lineTo(c, c - 58);
      g.lineTo(c - 24, c - 84);
      g.closePath();
      g.strokePath();
      faint();
      g.lineBetween(c, c - 58, c, c - 44);
      line();
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c - 40, c - 44),
          new Phaser.Math.Vector2(c + 40, c - 44),
          new Phaser.Math.Vector2(c + 40, c + 2),
          new Phaser.Math.Vector2(c - 40, c + 2),
        ],
        true,
        true,
      );
      // Wax run down what is left of it.
      faint();
      g.lineBetween(c - 24, c - 28, c - 24, c + 2);
      g.lineBetween(c + 18, c - 20, c + 18, c + 2);
      // The holder, sized for the candle this once was.
      line();
      g.lineBetween(c - 56, c + 2, c + 56, c + 2);
      g.lineBetween(c - 56, c + 2, c - 34, c + 34);
      g.lineBetween(c + 56, c + 2, c + 34, c + 34);
      g.lineBetween(c - 34, c + 34, c + 34, c + 34);
      g.lineBetween(c - 18, c + 34, c - 18, c + 92);
      g.lineBetween(c + 18, c + 34, c + 18, c + 92);
      g.lineBetween(c - 18, c + 92, c - 86, c + 122);
      g.lineBetween(c + 18, c + 92, c + 86, c + 122);
      g.lineBetween(c - 86, c + 122, c + 86, c + 122);
      break;
    case "warden":
      // A barred gate under a peaked lintel.
      g.lineBetween(c - 108, c + 92, c - 108, c - 34);
      g.lineBetween(c + 108, c + 92, c + 108, c - 34);
      g.lineBetween(c - 108, c - 34, c, c - 116);
      g.lineBetween(c, c - 116, c + 108, c - 34);
      for (const x of [c - 66, c - 22, c + 22, c + 66])
        g.lineBetween(x, c - 62, x, c + 92);
      g.lineBetween(c - 124, c + 92, c + 124, c + 92);
      break;
    case "toll":
      // A balance with one pan visibly lower than the other.
      g.lineBetween(c, c - 110, c, c + 96);
      g.lineBetween(c - 108, c - 58, c + 108, c - 38);
      g.lineBetween(c - 84, c - 56, c - 110, c + 34);
      g.lineBetween(c + 84, c - 40, c + 110, c + 72);
      g.beginPath();
      g.arc(c - 110, c + 34, 52, 0, Math.PI, false);
      g.strokePath();
      g.beginPath();
      g.arc(c + 110, c + 72, 52, 0, Math.PI, false);
      g.strokePath();
      g.lineBetween(c - 66, c + 96, c + 66, c + 96);
      break;
    case "hoard":
      // A guarded stack of coins crowned by a closed diamond.
      for (const y of [c + 72, c + 24, c - 24]) {
        g.strokeEllipse(c, y, 170, 42);
        g.lineBetween(c - 85, y, c - 85, y + 34);
        g.lineBetween(c + 85, y, c + 85, y + 34);
      }
      g.strokePoints(polygonPoints(c, c - 92, 46, 4, 45), true, true);
      break;

    // --- Cursed cards ------------------------------------------------------
    case "crunchTime":
      // An hourglass already run out, with only the last grains still falling.
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c - 72, c - 100),
          new Phaser.Math.Vector2(c + 72, c - 100),
          new Phaser.Math.Vector2(c, c),
        ],
        true,
        true,
      );
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c - 72, c + 100),
          new Phaser.Math.Vector2(c + 72, c + 100),
          new Phaser.Math.Vector2(c, c),
        ],
        true,
        true,
      );
      g.lineBetween(c - 94, c - 116, c + 94, c - 116);
      g.lineBetween(c - 94, c + 116, c + 94, c + 116);
      faint();
      g.lineBetween(c, c + 16, c, c + 40);
      g.lineBetween(c, c + 54, c, c + 68);
      break;
    case "bloodPrice":
      // A die split down its face, paying out beneath it.
      g.strokePoints(polygonPoints(c, c - 26, 124, 4, 45), true, true);
      g.lineBetween(c - 22, c - 114, c + 8, c - 52);
      g.lineBetween(c + 8, c - 52, c - 14, c - 16);
      g.lineBetween(c - 14, c - 16, c + 10, c + 62);
      faint();
      for (const x of [c - 52, c, c + 52]) g.strokeCircle(x, c + 104, 13);
      break;
    case "ouroboros":
      // The serpent closing on its own tail — a ring that never quite shuts.
      g.beginPath();
      g.arc(c, c, 104, Math.PI * -0.55, Math.PI * 1.3, false);
      g.strokePath();
      g.strokePoints(
        polygonPoints(
          c + Math.cos(Math.PI * 1.3) * 104,
          c + Math.sin(Math.PI * 1.3) * 104,
          48,
          3,
          214,
        ),
        true,
        true,
      );
      faint();
      g.strokeCircle(
        c + Math.cos(Math.PI * 1.3) * 104 - 6,
        c + Math.sin(Math.PI * 1.3) * 104 - 4,
        9,
      );
      break;
    case "famishedIdol":
      // A pen counted to its brim and shut: no room left above the line.
      g.strokePoints(polygonPoints(c, c, 150, 4, 45), true, true);
      g.lineBetween(c - 106, c - 44, c + 106, c - 44);
      faint();
      for (let row = 0; row < 3; row++)
        for (let col = 0; col < 4; col++)
          g.strokeCircle(c - 66 + col * 44, c - 6 + row * 42, 12);
      break;
    case "bloat":
      // Three squares swelling outward, each straining at the last.
      g.strokePoints(polygonPoints(c, c, 57, 4, 45), true, true);
      g.strokePoints(polygonPoints(c, c, 90, 4, 45), true, true);
      faint();
      g.strokePoints(polygonPoints(c, c, 124, 4, 45), true, true);
      // The arrows press outward from clear of the outermost square, so they
      // read as a swelling rather than as edges of the same box.
      line();
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (Math.PI / 2) * i;
        const tip = 172;
        g.lineBetween(
          c + Math.cos(a) * 134,
          c + Math.sin(a) * 134,
          c + Math.cos(a) * tip,
          c + Math.sin(a) * tip,
        );
        for (const spread of [-0.3, 0.3])
          g.lineBetween(
            c + Math.cos(a) * tip,
            c + Math.sin(a) * tip,
            c + Math.cos(a + spread) * (tip - 26),
            c + Math.sin(a + spread) * (tip - 26),
          );
      }
      break;
    case "ironDebt":
      // A coin struck from the ledger, over a coffer shut for good.
      g.strokeCircle(c, c - 44, 78);
      faint();
      g.strokeCircle(c, c - 44, 60);
      line();
      g.lineBetween(c - 88, c + 32, c + 88, c - 120);
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c - 110, c + 58),
          new Phaser.Math.Vector2(c + 110, c + 58),
          new Phaser.Math.Vector2(c + 110, c + 122),
          new Phaser.Math.Vector2(c - 110, c + 122),
        ],
        true,
        true,
      );
      g.lineBetween(c - 110, c + 84, c + 110, c + 84);
      g.strokePoints(polygonPoints(c, c + 84, 24, 4, 45), true, true);
      break;
    case "paupersVow":
      // A purse cut open at the mouth, everything above the cut already gone.
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c - 76, c - 44),
          new Phaser.Math.Vector2(c + 76, c - 44),
          new Phaser.Math.Vector2(c + 58, c + 96),
          new Phaser.Math.Vector2(c - 58, c + 96),
        ],
        true,
        true,
      );
      g.lineBetween(c - 100, c - 44, c + 100, c - 44);
      faint();
      g.strokeCircle(c - 58, c - 100, 21);
      g.strokeCircle(c + 4, c - 128, 17);
      g.strokeCircle(c + 64, c - 88, 15);
      break;
    case "sealedDoors":
      // Twin doors under an arch, barred and waxed shut.
      g.lineBetween(c - 92, c + 104, c - 92, c - 46);
      g.lineBetween(c + 92, c + 104, c + 92, c - 46);
      g.beginPath();
      g.arc(c, c - 46, 92, Math.PI, 0, false);
      g.strokePath();
      g.lineBetween(c - 114, c + 104, c + 114, c + 104);
      faint();
      g.lineBetween(c, c - 138, c, c + 104);
      line();
      g.lineBetween(c - 114, c + 26, c + 114, c + 26);
      g.strokeCircle(c, c + 26, 23);
      break;
    case "devilsBargain":
      // A writ signed in haste, horned at both shoulders.
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c - 70, c - 70),
          new Phaser.Math.Vector2(c + 70, c - 70),
          new Phaser.Math.Vector2(c + 70, c + 110),
          new Phaser.Math.Vector2(c - 70, c + 110),
        ],
        true,
        true,
      );
      // The horns the writ is signed under: out, up, and hooked back in.
      g.lineBetween(c - 70, c - 70, c - 116, c - 118);
      g.lineBetween(c - 116, c - 118, c - 86, c - 148);
      g.lineBetween(c + 70, c - 70, c + 116, c - 118);
      g.lineBetween(c + 116, c - 118, c + 86, c - 148);
      faint();
      for (const y of [c - 46, c - 14, c + 18])
        g.lineBetween(c - 58, y, c + 58, y);
      line();
      g.lineBetween(c - 58, c + 74, c - 24, c + 50);
      g.lineBetween(c - 24, c + 50, c + 2, c + 82);
      g.lineBetween(c + 2, c + 82, c + 30, c + 48);
      g.lineBetween(c + 30, c + 48, c + 60, c + 76);
      break;
    case "leadenDice":
      // A die with lead sunk into one corner: it will never fall the other way.
      g.strokePoints(polygonPoints(c, c, 148, 4, 45), true, true);
      faint();
      g.lineBetween(c, c - 104, c - 40, c + 52);
      line();
      g.strokeCircle(c - 40, c + 58, 36);
      faint();
      g.strokeCircle(c + 54, c - 54, 14);
      g.strokeCircle(c + 54, c + 4, 14);
      break;
    case "locustIdol":
      // A locust settled on a stripped stalk: nothing grows behind it.
      g.strokeEllipse(c + 4, c + 12, 62, 132);
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c - 26, c - 40),
          new Phaser.Math.Vector2(c - 114, c - 8),
          new Phaser.Math.Vector2(c - 34, c + 64),
        ],
        true,
        true,
      );
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c + 34, c - 40),
          new Phaser.Math.Vector2(c + 122, c - 8),
          new Phaser.Math.Vector2(c + 42, c + 64),
        ],
        true,
        true,
      );
      g.strokeCircle(c + 4, c - 76, 28);
      g.lineBetween(c - 10, c - 96, c - 46, c - 138);
      g.lineBetween(c + 18, c - 96, c + 54, c - 138);
      faint();
      g.lineBetween(c - 118, c + 128, c + 118, c + 128);
      break;
    case "gamblersCurse":
      // A die face come up blank — every pip a hollow where one did not land.
      g.strokePoints(polygonPoints(c, c, 148, 4, 45), true, true);
      faint();
      for (const [dx, dy] of [
        [-56, -56],
        [56, -56],
        [0, 0],
        [-56, 56],
        [56, 56],
      ])
        g.strokeCircle(c + dx, c + dy, 19);
      break;
    case "reckoning":
      // The bar as it was set, and the bar as it now stands: twice the same
      // height, on the same line. Height carries the doubling; the standing bar
      // takes the firmer of the two lines.
      faint();
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c - 118, c + 112),
          new Phaser.Math.Vector2(c - 22, c + 112),
          new Phaser.Math.Vector2(c - 22, c + 16),
          new Phaser.Math.Vector2(c - 118, c + 16),
        ],
        true,
        true,
      );
      line();
      g.strokePoints(
        [
          new Phaser.Math.Vector2(c + 22, c + 112),
          new Phaser.Math.Vector2(c + 118, c + 112),
          new Phaser.Math.Vector2(c + 118, c - 80),
          new Phaser.Math.Vector2(c + 22, c - 80),
        ],
        true,
        true,
      );
      faint();
      g.lineBetween(c - 140, c + 112, c + 140, c + 112);
      break;
    case "hairTrigger":
      // A bow loosed once, its string gone slack behind the shot.
      g.beginPath();
      g.arc(c + 40, c, 116, Math.PI * 0.62, Math.PI * 1.38, false);
      g.strokePath();
      faint();
      g.lineBetween(c - 4, c - 108, c - 24, c - 34);
      g.lineBetween(c - 4, c + 108, c - 28, c + 42);
      line();
      g.lineBetween(c - 12, c, c + 120, c);
      g.lineBetween(c + 120, c, c + 88, c - 24);
      g.lineBetween(c + 120, c, c + 88, c + 24);
      break;
    case "longNight":
      // A crescent whose horns have not closed, over a sky with a second mark.
      g.beginPath();
      g.arc(c, c, 112, Math.PI * 0.3, Math.PI * 1.7, false);
      g.strokePath();
      g.beginPath();
      g.arc(c + 60, c, 91, Math.PI * 0.48, Math.PI * 1.52, false);
      g.strokePath();
      faint();
      for (const [x, y, r] of [
        [c + 118, c - 116, 17],
        [c + 94, c + 128, 13],
      ]) {
        g.lineBetween(x - r, y, x + r, y);
        g.lineBetween(x, y - r, x, y + r);
      }
      break;
    case "tollkeeper":
      // A gate arm lowered across the road, and the coin it wants to lift.
      g.lineBetween(c - 112, c + 112, c - 112, c - 96);
      g.lineBetween(c - 134, c + 112, c - 90, c + 112);
      g.lineBetween(c - 112, c - 66, c + 122, c - 22);
      faint();
      for (let i = 1; i < 5; i++) {
        const t = i / 5;
        const x = c - 112 + t * 234;
        const y = c - 66 + t * 44;
        g.lineBetween(x, y - 14, x, y + 14);
      }
      line();
      g.strokeCircle(c + 34, c + 60, 48);
      faint();
      g.strokeCircle(c + 34, c + 60, 33);
      break;

    // --- Granted by the story ----------------------------------------------
    case "betrayal":
      // A dagger driven through an oath-ring that no longer closes.
      faint();
      g.beginPath();
      g.arc(c, c + 6, 112, Math.PI * 1.18, Math.PI * 0.82, false);
      g.strokePath();
      line();
      g.lineBetween(c - 76, c - 62, c + 76, c - 62);
      g.lineBetween(c - 16, c - 62, c - 16, c - 126);
      g.lineBetween(c + 16, c - 62, c + 16, c - 126);
      g.lineBetween(c - 16, c - 126, c + 16, c - 126);
      g.lineBetween(c - 30, c - 62, c - 14, c + 94);
      g.lineBetween(c + 30, c - 62, c + 14, c + 94);
      g.lineBetween(c - 14, c + 94, c, c + 132);
      g.lineBetween(c + 14, c + 94, c, c + 132);
      break;
  }

  bakeGraphics(g, key, size, size);
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
function buildSigilRings(scene: Phaser.Scene): void {
  SIGIL_RING_TEXTURE_KEYS.forEach((key, variant) =>
    buildSigilRing(scene, key, variant),
  );
}

function buildSigilRing(
  scene: Phaser.Scene,
  key: string,
  variant: number,
): void {
  const size = 1024;
  const c = size / 2;
  const outer = c * SIGIL_RING_OUTER_INK_RADIUS;
  const inner = c * SIGIL_RING_INNER_INK_RADIUS;
  const g = scene.add.graphics();

  g.lineStyle(3, 0xffffff, 0.9);
  g.strokeCircle(c, c, outer);
  g.lineStyle(1.5, 0xffffff, 0.6);
  g.strokeCircle(c, c, outer - 16);

  // Tick ring hung inside the outer pair. Each variant stays denser than the
  // inner sigil while using its own cadence of major divisions.
  const tickCounts = [96, 80, 90];
  const majorEvery = [8, 10, 9];
  const ticks = tickCounts[variant];
  for (let i = 0; i < ticks; i++) {
    const angle = (Math.PI * 2 * i) / ticks;
    const long = i % majorEvery[variant] === 0;
    const from = long ? outer - 46 : outer - 30;
    g.lineStyle(long ? 3 : 1.5, 0xffffff, long ? 0.9 : 0.45);
    g.lineBetween(
      c + Math.cos(angle) * from,
      c + Math.sin(angle) * from,
      c + Math.cos(angle) * (outer - 16),
      c + Math.sin(angle) * (outer - 16),
    );
  }

  // The gated track deliberately uses different symmetries from the inner
  // variants, keeping the two pieces readable as they counter-rotate.
  const arcR = (inner + outer - 46) / 2;
  const segments = [6, 8, 5][variant];
  const gap = [0.1, 0.08, 0.12][variant];
  strokeBrokenRing(g, c, arcR, segments, 0, gap);
  if (variant === 1) {
    strokeBrokenRing(
      g,
      c,
      arcR + 18,
      segments,
      Math.PI / segments,
      gap * 0.8,
      0.42,
    );
  }

  // Lozenges, triangles, and pentagons distinguish the three gate patterns.
  const markerSides = [4, 3, 5][variant];
  const markerRadius = [9, 10, 8][variant];
  g.fillStyle(0xffffff, 0.6);
  for (let i = 0; i < segments; i++) {
    const angle = (Math.PI * 2 * i) / segments;
    const pts = polygonPoints(
      c + Math.cos(angle) * arcR,
      c + Math.sin(angle) * arcR,
      markerRadius,
      markerSides,
      Phaser.Math.RadToDeg(angle) - 90,
    );
    g.fillPoints(pts, true);
  }

  g.lineStyle(2, 0xffffff, 0.5);
  g.strokeCircle(c, c, inner + 14);
  g.lineStyle(1.5, 0xffffff, 0.3);
  g.strokeCircle(c, c, inner);

  bakeGraphics(g, key, size, size);
}

/** Stroke equal arc segments separated by small gates. */
function strokeBrokenRing(
  g: Phaser.GameObjects.Graphics,
  center: number,
  radius: number,
  segments: number,
  offset: number,
  gap: number,
  alpha = 0.7,
  weight = 2,
): void {
  g.lineStyle(weight, 0xffffff, alpha);
  const step = (Math.PI * 2) / segments;
  for (let i = 0; i < segments; i++) {
    g.beginPath();
    g.arc(
      center,
      center,
      radius,
      offset + step * i + gap,
      offset + step * (i + 1) - gap,
      false,
    );
    g.strokePath();
  }
}

/** Dark table felt with speckle noise and a vignette; stretched to fit any viewport. */
function buildFelt(scene: Phaser.Scene): void {
  const size = FELT_SIZE;
  const tex = scene.textures.createCanvas("felt", size, size);
  if (!tex) return;
  const ctx = tex.getContext();

  ctx.fillStyle = "#161226";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const light = Math.random() > 0.5;
    ctx.fillStyle = light ? "rgba(120, 100, 170, 0.05)" : "rgba(0, 0, 0, 0.07)";
    ctx.fillRect(x, y, 1.5, 1.5);
  }

  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.35,
    size / 2,
    size / 2,
    size * 0.7,
  );
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  tex.refresh();
}

const DIE_CENTER = 48;

/** Regular-polygon vertices, pointy-top by default. */
function polygonPoints(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotationDeg = -90,
): Phaser.Math.Vector2[] {
  const pts: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = Phaser.Math.DegToRad(rotationDeg + (360 / sides) * i);
    pts.push(
      new Phaser.Math.Vector2(
        cx + radius * Math.cos(angle),
        cy + radius * Math.sin(angle),
      ),
    );
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

    bakeGraphics(g, `die-${sides}`, 96, 96);
  }
}

function buildPips(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.gold, 1);
  g.fillCircle(6, 6, 5);
  bakeGraphics(g, "pip-gold", 12, 12);
}

/** The cell one baked face or type label occupies, in designed pixels. */
const FACE_CELL = 76;

/** Type sizes the atlas is designed at, in designed pixels. */
const FACE_NUMERAL_PX = 34;
const FACE_LABEL_PX = 13;

/** The cross an inert die wears, in the die's own 96-unit design space: how far
 *  each arm reaches from the die's center, and how thick it is drawn. Sized to
 *  cross the body with a margin inside its rounded corners, and to stay clear of
 *  the `FACE_CELL` the atlas packs it into. */
const STRIKE_REACH = 30;
const STRIKE_WIDTH = 6;

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
function numeralYOffset(
  fontSize: number,
  bold: boolean,
  liftFraction: number,
): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = `${bold ? "bold " : ""}${fontSize}px ${SERIF}`;

  const ref = ctx.measureText("|MÉqgy"); // matches Phaser's TextStyle.testString
  const refAscent = ref.actualBoundingBoxAscent;
  const refDescent = ref.actualBoundingBoxDescent;

  const digits = ctx.measureText("0123456789");
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
  // Along with the faces and labels the atlas carries one frame that is not a
  // face at all: the cross laid over a die an affliction has made inert. It
  // lives here so showing one is a frame swap on a texture every die in the
  // grid is already batching with, rather than a Graphics per struck-out die in
  // a grid that can hold a viewport's worth of them.
  const faces = DIE_LADDER.flatMap((sides) =>
    Array.from({ length: sides }, (_, i) => ({
      name: `face-${sides}-${i + 1}`,
      sides,
      value: i + 1,
    })),
  );
  const labels = DIE_LADDER.map((sides) => ({
    name: `label-d${sides}`,
    sides,
  }));

  const total = faces.length + labels.length + 1; // + the inert strike
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);

  // The render target, the placement grid, the frame rects and the type all
  // move together: `cell` is the one number carrying the bake scale, and every
  // position below is measured in the atlas's own pixels.
  const scale = fitAtlasScale(scene, Math.max(cols, rows) * FACE_CELL);
  const cell = FACE_CELL * scale;

  const rt = scene.add.renderTexture(0, 0, cols * cell, rows * cell);
  rt.setVisible(false);

  const regions: { name: string; x: number; y: number }[] = [];
  const placeAt = (name: string) => {
    const col = regions.length % cols;
    const row = Math.floor(regions.length / cols);
    const x = col * cell;
    const y = row * cell;
    regions.push({ name, x, y });
    return { cx: x + cell / 2, cy: y + cell / 2 };
  };

  // draw() only queues a command referencing the object — it isn't rasterized
  // until render() runs, so every throwaway must survive until then.
  const throwaways: Phaser.GameObjects.GameObject[] = [];

  // `resolution: 1`, against `installHighResolutionText`'s default of `DPR`.
  // That default is for text drawn straight to the screen, where the camera
  // magnifies it; here the glyph is already being rendered at `scale` times its
  // designed size into a target that is one atlas pixel to one texture pixel.
  // Asking for `DPR` on top of that would rasterize each Text at another factor
  // of three and then minify it back down, and a 3:1 bilinear minification with
  // no mipmap samples 4 of every 9 texels — a *worse* face than drawing it 1:1.
  const numeralStyle = {
    fontFamily: SERIF,
    fontSize: `${FACE_NUMERAL_PX * scale}px`,
    color: CSS.ink,
    fontStyle: "bold",
    resolution: 1,
  };
  const numeralOffset = numeralYOffset(FACE_NUMERAL_PX * scale, true, 0.15);
  const numeralOffsetD6 = numeralYOffset(FACE_NUMERAL_PX * scale, true, 0);

  for (const face of faces) {
    const { cx, cy } = placeAt(face.name);
    const offset = face.sides === 6 ? numeralOffsetD6 : numeralOffset;
    const numeral = scene.add
      .text(0, 0, String(face.value), numeralStyle)
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
      .text(0, 0, `d${label.sides}`, {
        fontFamily: SERIF,
        fontSize: `${FACE_LABEL_PX * scale}px`,
        color,
        resolution: 1,
      })
      .setOrigin(0.5);
    rt.draw(text, cx, cy);
    throwaways.push(text);
  }

  {
    const { cx, cy } = placeAt("strike");
    const reach = STRIKE_REACH * scale;
    const strike = scene.add.graphics();
    strike.lineStyle(STRIKE_WIDTH * scale, COLORS.waxRed, 1);
    strike.lineBetween(-reach, -reach, reach, reach);
    strike.lineBetween(reach, -reach, -reach, reach);
    rt.draw(strike, cx, cy);
    throwaways.push(strike);
  }

  rt.render();
  const tex = rt.saveTexture("die-atlas");
  for (const r of regions) tex.add(r.name, 0, r.x, r.y, cell, cell);
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
  bakeGraphics(g, "card", 260, 340);
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
  bakeGraphics(g, "plaque", 250, 58);
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
  bakeGraphics(g, "seal", 170, 170);
}

/** The parchment button's designed size, in layout pixels. Exported because a
 *  caller decorating a button has to measure against the size it was drawn at,
 *  which is no longer the size of its pixels. */
export const BUTTON_WIDTH = 340;
export const BUTTON_HEIGHT = 70;

/** Parchment banner button. */
function buildButton(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.parchment, 1);
  g.fillRoundedRect(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, 10);
  g.lineStyle(3, COLORS.ink, 0.85);
  g.strokeRoundedRect(4, 4, 332, 62, 8);
  bakeGraphics(g, "btn", BUTTON_WIDTH, BUTTON_HEIGHT);
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
  bakeGraphics(g, "panel", 1100, 580);
}

/** Announcement banner strip. */
function buildBanner(scene: Phaser.Scene): void {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.feltDark, 0.92);
  g.fillRect(0, 0, 720, 92);
  g.lineStyle(2, COLORS.gold, 1);
  g.lineBetween(0, 3, 720, 3);
  g.lineBetween(0, 89, 720, 89);
  bakeGraphics(g, "banner", 720, 92);
}
