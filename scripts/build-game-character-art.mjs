/**
 * Builds the in-game roster art for the character selection screen.
 *
 * Distinct from `build-character-art.mjs`, which bakes the MARKETING cards:
 * that script composites each character onto the parchment card blank and emits
 * three widths for the site's `srcset`. The game draws its own card — the same
 * 260x340 parchment every item card uses — so what it needs is the character
 * ALONE, trimmed and transparent, at one size the card can inset it into.
 *
 * Reads the raw transparent PNGs in `images/characters/` (2400x2400, ~500 KB
 * each) and writes `<name>-game.webp` beside them at ART_SIZE. That is the file
 * BootScene loads; the PNGs stay as the masters and never ship.
 *
 *   node scripts/build-game-character-art.mjs
 *
 * The output is committed, like the marketing bake's, so an ordinary build never
 * needs sharp.
 */
/* global console */

import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "images", "characters");

/**
 * Longest edge of the emitted art, in pixels.
 *
 * The card is 260x340 and the art is inset into roughly its upper two thirds,
 * so the widest it is ever drawn is about 230 CSS px — and this screen draws its
 * cards at up to MAX_CHOICE_SCALE, not above it. 512 covers that at a 2x device
 * pixel ratio with room to spare, and the selection screen is the only place the
 * art appears.
 */
const ART_SIZE = 512;
const QUALITY = 82;
/** Alpha above which a pixel counts toward the character's bounds. */
const ALPHA_THRESHOLD = 128;

if (!existsSync(dir)) {
  console.error(`Missing ${path.relative(root, dir)}`);
  process.exit(1);
}

/** Bounding box of the pixels whose alpha clears ALPHA_THRESHOLD, or null. */
async function visibleBounds(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] < ALPHA_THRESHOLD) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

const masters = (await readdir(dir))
  .filter((name) => /\.png$/i.test(name))
  .sort();

if (masters.length === 0) {
  console.error(`No character PNGs in ${path.relative(root, dir)}`);
  process.exit(1);
}

for (const name of masters) {
  const source = path.join(dir, name);
  const bounds = await visibleBounds(source);
  if (!bounds) {
    console.error(`${name}: no visible pixels`);
    process.exit(1);
  }
  const out = path.join(dir, `${path.basename(name, ".png")}-game.webp`);
  // Trimmed to the character, then fitted inside a square so every card can
  // inset its art the same way without knowing one character is broader or
  // shorter than another.
  const webp = await sharp(source)
    .extract(bounds)
    .resize(ART_SIZE, ART_SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: QUALITY })
    .toBuffer();
  await writeFile(out, webp);
  console.log(
    `${path.relative(root, out)}  ${bounds.width}x${bounds.height} -> ${ART_SIZE}px, ${(webp.length / 1024).toFixed(0)} KB`,
  );
}
