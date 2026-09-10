/**
 * Builds the marketing roster's responsive character art.
 *
 * Masters live in `marketing-site/art-src/characters/` as square (1:1) images,
 * ideally 2400x2400. Each one is emitted as WebP at the three widths the
 * roster's `srcset` asks for. The roster is a three-column grid at every
 * breakpoint, so the widest an image ever renders is 371 CSS px — 1113 device
 * pixels on a 3x display, which the largest width covers. The square crop is enforced here rather than
 * trusted: `.character-roster img` is `object-fit: cover`, so a master that is
 * off-ratio would be silently centre-cropped by the browser instead.
 *
 *   node scripts/build-character-art.mjs
 *
 * Pass --allow-upscale to emit the full set from a master smaller than 1200px.
 * That is only for placeholder art; real deliveries should never need it.
 */
/* global console */

import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "marketing-site", "art-src", "characters");
const outDir = path.join(root, "marketing-site", "assets");

/** Must stay in step with the `srcset` widths in `marketing-site/index.html`. */
const WIDTHS = [400, 800, 1200];
const QUALITY = 80;

const allowUpscale = process.argv.includes("--allow-upscale");

if (!existsSync(srcDir)) {
  console.error(`No master directory at ${path.relative(root, srcDir)}`);
  console.error("Drop the square character masters there and re-run.");
  process.exit(1);
}

const masters = (await readdir(srcDir))
  .filter((name) => /\.(png|jpe?g|webp|tiff?)$/i.test(name))
  .sort();

if (masters.length === 0) {
  console.error(`No images found in ${path.relative(root, srcDir)}`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

let failed = false;

for (const name of masters) {
  const stem = path.basename(name, path.extname(name));
  const input = path.join(srcDir, name);
  const { width = 0, height = 0 } = await sharp(input).metadata();

  if (width !== height) {
    console.warn(
      `  ! ${name} is ${width}x${height}, not square — centre-cropping to ${Math.min(width, height)}px`,
    );
  }

  const largest = WIDTHS[WIDTHS.length - 1];
  const shortEdge = Math.min(width, height);
  if (shortEdge < largest && !allowUpscale) {
    console.error(
      `  x ${name} is only ${shortEdge}px on its short edge; needs ${largest}px. ` +
        `Re-export the master, or pass --allow-upscale for placeholder art.`,
    );
    failed = true;
    continue;
  }

  for (const w of WIDTHS) {
    const out = path.join(outDir, `${stem}-${w}.webp`);
    await sharp(input)
      // Square first so every width is an identical crop, then scale.
      .resize(shortEdge, shortEdge, { fit: "cover", position: "centre" })
      .resize(w, w, { fit: "cover" })
      .webp({ quality: QUALITY })
      .toFile(out);
    console.log(`  ${path.relative(root, out)}`);
  }
}

process.exit(failed ? 1 : 0);
