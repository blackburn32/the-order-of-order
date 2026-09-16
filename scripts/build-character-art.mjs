/**
 * Builds the marketing roster's responsive character art.
 *
 * Characters live in `marketing-site/art-src/characters/` as transparent PNGs,
 * ideally 2400x2400. Each one is baked onto the shared parchment card at
 * `marketing-site/art-src/card-blank.png` and emitted as WebP at the three
 * widths the roster's `srcset` asks for.
 *
 * The bake trims the character to its visible pixels, scales it to CHAR_HEIGHT,
 * and centres it horizontally with its top at CHAR_TOP, so every character's
 * feet land on the same floor line. Beneath it goes a soft floor shadow: a
 * blurred ellipse at a fixed height whose width follows the character's.
 *
 * The roster is a three-column grid at every breakpoint, so the widest an image
 * ever renders is 371 CSS px — 1113 device pixels on a 3x display, which the
 * largest width covers. `.character-roster img.card-art` rounds its corners to
 * match the card's frame.
 *
 *   node scripts/build-character-art.mjs
 *
 * Pass --allow-upscale to bake a character whose visible height is below
 * CHAR_HEIGHT. That is only for placeholder art; real deliveries should never
 * need it.
 */
/* global console */

import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artDir = path.join(root, "marketing-site", "art-src");
const srcDir = path.join(artDir, "characters");
const cardPath = path.join(artDir, "card-blank.png");
const outDir = path.join(root, "marketing-site", "assets");

/** Must stay in step with the `srcset` widths in `marketing-site/index.html`. */
const WIDTHS = [400, 800, 1200];
const QUALITY = 80;

/** Where a character sits on the 2400px card; its bottom edge is the floor. */
const CHAR_HEIGHT = 1780;
const CHAR_TOP = 290;
/** Widest a character can be before it crosses the card's inset line. */
const CHAR_MAX_WIDTH = 2000;
/** Alpha above which a pixel counts toward the character's bounds. */
const ALPHA_THRESHOLD = 128;

/**
 * The floor shadow, in 2400px card space. Measured off the first two
 * hand-finished cards: its centre and height stay put while its half-width is
 * SHADOW_WIDTH_RATIO of the character's width.
 */
const SHADOW_CENTRE_Y = 2040;
const SHADOW_WIDTH_RATIO = 0.34;
const SHADOW_RADIUS_Y = 60;
const SHADOW_BLUR = 29;
const SHADOW_OPACITY = 0.24;

const allowUpscale = process.argv.includes("--allow-upscale");

for (const [dir, hint] of [
  [srcDir, "Drop the transparent character PNGs there and re-run."],
  [cardPath, "The blank card is required to bake characters onto."],
]) {
  if (!existsSync(dir)) {
    console.error(`Missing ${path.relative(root, dir)}`);
    console.error(hint);
    process.exit(1);
  }
}

const masters = (await readdir(srcDir))
  .filter((name) => /\.(png|webp|tiff?)$/i.test(name))
  .sort();

if (masters.length === 0) {
  console.error(`No images found in ${path.relative(root, srcDir)}`);
  process.exit(1);
}

const card = sharp(cardPath);
const { width: cardSize = 0, height: cardHeight = 0 } = await card.metadata();
if (cardSize !== cardHeight) {
  console.error(
    `card-blank.png must be square; it is ${cardSize}x${cardHeight}`,
  );
  process.exit(1);
}
const cardPng = await card.png().toBuffer();

/** Bounding box of the pixels whose alpha clears ALPHA_THRESHOLD, or null. */
async function visibleBounds(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > ALPHA_THRESHOLD) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** A card-sized transparent layer holding the floor shadow for one character. */
function floorShadow(charWidth) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cardSize}" height="${cardSize}">` +
    `<ellipse cx="${cardSize / 2}" cy="${SHADOW_CENTRE_Y}" rx="${(SHADOW_WIDTH_RATIO * charWidth).toFixed(2)}" ` +
    `ry="${SHADOW_RADIUS_Y}" fill="#000" fill-opacity="${SHADOW_OPACITY}"/></svg>`;
  return sharp(Buffer.from(svg)).blur(SHADOW_BLUR).png().toBuffer();
}

await mkdir(outDir, { recursive: true });

let failed = false;

for (const name of masters) {
  const stem = path.basename(name, path.extname(name));
  const input = path.join(srcDir, name);
  const { width = 0, height = 0 } = await sharp(input).metadata();
  const bounds = await visibleBounds(input);

  if (!bounds || (bounds.width === width && bounds.height === height)) {
    console.error(
      `  x ${name} has no transparent background to trim; export it as a transparent PNG.`,
    );
    failed = true;
    continue;
  }

  if (bounds.height < CHAR_HEIGHT && !allowUpscale) {
    console.error(
      `  x ${name} is only ${bounds.height}px tall once trimmed; needs ${CHAR_HEIGHT}px. ` +
        `Re-export the art, or pass --allow-upscale for placeholder art.`,
    );
    failed = true;
    continue;
  }

  const scaledWidth = Math.round(bounds.width * (CHAR_HEIGHT / bounds.height));
  if (scaledWidth > CHAR_MAX_WIDTH) {
    console.warn(
      `  ! ${name} is ${scaledWidth}px wide on the card — it will cross the frame's inset line`,
    );
  }

  const character = await sharp(input)
    .extract(bounds)
    .resize(scaledWidth, CHAR_HEIGHT, { kernel: "lanczos3" })
    .png()
    .toBuffer();
  const baked = await sharp(cardPng)
    .composite([
      { input: await floorShadow(scaledWidth), left: 0, top: 0 },
      {
        input: character,
        left: Math.round(cardSize / 2 - scaledWidth / 2),
        top: CHAR_TOP,
      },
    ])
    .png()
    .toBuffer();

  for (const w of WIDTHS) {
    const out = path.join(outDir, `${stem}-${w}.webp`);
    await sharp(baked)
      .resize(w, w, { fit: "cover" })
      .webp({ quality: QUALITY })
      .toFile(out);
    console.log(`  ${path.relative(root, out)}`);
  }
}

process.exit(failed ? 1 : 0);
