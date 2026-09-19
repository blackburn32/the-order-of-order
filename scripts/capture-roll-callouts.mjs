/* global Buffer, HTMLCanvasElement, URL, console, document, fetch, requestAnimationFrame, setTimeout, window */

// Records the roll-callout presets (src/capture/rollCallouts.ts) as GIFs.
//
//   node scripts/capture-roll-callouts.mjs
//   node scripts/capture-roll-callouts.mjs --preset roll-callout-hundred
//   node scripts/capture-roll-callouts.mjs --width 1280 --fps 25
//   node scripts/capture-roll-callouts.mjs --stills 4   (also a PNG every 4th frame)
//   node scripts/capture-roll-callouts.mjs --sheet 6    (a contact sheet of every 6th)
//   node scripts/capture-roll-callouts.mjs --format portrait   (a 9:16 phone; files get -portrait)
//
// Same approach as capture-marketing-motion.mjs: the studio's game clock is
// taken off the browser and stepped here at 60Hz, so a slow machine makes the
// capture slower, never the clip. Every `60 / fps`th step is drawn into a
// downscaled canvas and handed to gifenc inside the page; only the finished GIF
// crosses back. Output lands in art-out/roll-callouts/<preset>.gif.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const PRESETS = [
  "roll-callout-few",
  "roll-callout-twenty",
  "roll-callout-hundred",
  "roll-callout-multitude",
  "roll-callout-skip",
  "roll-callout-goal",
  "roll-callout-first-roll",
];

const projectRoot = process.cwd();
const outputRoot = path.resolve(
  projectRoot,
  option("out") ?? "art-out/roll-callouts",
);
const requestedPreset = option("preset");
const suppliedUrl = option("url");
const port = Number(option("port") ?? 4175);
const baseUrl = suppliedUrl ?? `http://127.0.0.1:${port}`;
const fps = Number(option("fps") ?? 15);
/** Also save every Nth frame as a PNG beside the GIF, for reviewing a take. */
const stillsEvery = Number(option("stills") ?? 0);
/** Also tile every Nth frame into one contact-sheet PNG per clip. */
const sheetEvery = Number(option("sheet") ?? 0);
const format = option("format") ?? "wide";
/** Phaser's 2D renderer gives complete frames (see below) and is what the
 *  published clips are taken with; --renderer webgl is for reviewing the
 *  effects that only the rich tier draws, such as particle bursts. */
const renderer = option("renderer") ?? "canvas";
/** The clean studio fills the browser, so the frame is the viewport's shape. */
const VIEWPORTS = {
  wide: { width: 1600, height: 900 },
  portrait: { width: 720, height: 1280 },
};
const viewport = VIEWPORTS[format];
if (!viewport) throw new Error(`Unknown format: ${format}`);
/** Output names carry the frame when it is not the default landscape one. */
const suffix =
  (format === "wide" ? "" : `-${format}`) +
  (renderer === "canvas" ? "" : `-${renderer}`);
const width = Number(option("width") ?? (format === "wide" ? 800 : 480));
/** Palette size per frame. The felt's gradients are most of a frame's bytes, and
 *  128 colours keeps the text crisp at roughly two thirds of 256's size. */
const colors = Number(option("colors") ?? 128);
/** The game is stepped at the rate it was written against; see the motion
 *  recorder for why a 20fps capture must not step at 20. */
const RENDER_FPS = 60;
/** Stillness recorded before the reel's first press. */
const LEAD_IN_MS = 300;
let server;

try {
  await mkdir(outputRoot, { recursive: true });
  if (!suppliedUrl) {
    const captureUrl = `${baseUrl}/capture.html`;
    if (await captureServerAvailable(captureUrl)) {
      console.log(`reusing Capture Studio at ${baseUrl}`);
    } else {
      server = spawn(
        process.execPath,
        [
          "node_modules/vite/bin/vite.js",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--strictPort",
        ],
        { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      server.stdout.on("data", (chunk) => process.stdout.write(chunk));
      server.stderr.on("data", (chunk) => process.stderr.write(chunk));
      await waitForServer(captureUrl);
    }
  }

  const presets = requestedPreset
    ? PRESETS.filter((id) => id === requestedPreset)
    : PRESETS;
  if (presets.length === 0)
    throw new Error(`Unknown roll-callout preset: ${requestedPreset}`);

  const browser = await launchRecorder();
  try {
    for (const id of presets) {
      const page = await browser.newPage({ viewport });
      page.on("pageerror", (error) => console.error(`[${id}] ${error}`));
      const url = new URL("capture.html", `${baseUrl}/`);
      url.searchParams.set("clean", "1");
      url.searchParams.set("preset", id);
      url.searchParams.set("format", format);
      // Complete frames: see the motion recorder on WebGL backbuffer reads.
      url.searchParams.set("renderer", renderer);
      await page.goto(url.href, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (preset) =>
          window.__captureStudio?.ready === true &&
          window.__captureStudio.preset === preset,
        id,
        { timeout: 60_000 },
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const durationMs = await page.evaluate(
        () => window.__captureStudio.playDurationMs,
      );

      const take = await page.evaluate(recordGif, {
        durationMs,
        fps,
        width,
        leadInMs: LEAD_IN_MS,
        stepsPerFrame: Math.max(1, Math.round(RENDER_FPS / fps)),
        stillsEvery,
        sheetEvery,
        colors,
      });
      const script = await page.evaluate(() => window.__captureStudio.script);
      if (script?.error)
        throw new Error(
          `${id}: ${script.error} (after ${script.log.length} beats)`,
        );

      const output = path.join(outputRoot, `${id}${suffix}.gif`);
      const bytes = Buffer.from(take.data, "base64");
      await writeFile(output, bytes);
      if (take.stills.length > 0) {
        const dir = path.join(outputRoot, `${id}${suffix}-stills`);
        await mkdir(dir, { recursive: true });
        for (const still of take.stills)
          await writeFile(
            path.join(dir, `${String(still.frame).padStart(4, "0")}.png`),
            Buffer.from(still.data.split(",")[1], "base64"),
          );
      }
      if (take.sheet)
        await writeFile(
          path.join(outputRoot, `${id}${suffix}-sheet.png`),
          Buffer.from(take.sheet.split(",")[1], "base64"),
        );
      console.log(
        `captured ${path.relative(projectRoot, output)} (${take.frames} frames, ` +
          `${(take.frames / fps).toFixed(1)}s, ${take.width}x${take.height}, ` +
          `${(bytes.length / 1024 / 1024).toFixed(1)} MB)`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server) server.kill();
}

/** Run one take inside the page: step the clock, draw each kept frame into a
 *  downscaled canvas, quantize it and append it to the GIF. */
async function recordGif({
  durationMs,
  fps,
  width,
  leadInMs,
  stepsPerFrame,
  stillsEvery,
  sheetEvery,
  colors,
}) {
  const { GIFEncoder, quantize, applyPalette } =
    await import("/node_modules/gifenc/dist/gifenc.esm.js");
  const source = document.querySelector("#capture-stage canvas");
  if (!(source instanceof HTMLCanvasElement))
    throw new Error("Capture canvas was not found");
  const studio = window.__captureStudio;
  const frameMs = 1000 / fps;
  const stepMs = frameMs / stepsPerFrame;
  const height = Math.round((width * source.height) / source.width);
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingQuality = "high";

  const gif = GIFEncoder();
  let frames = 0;
  const stills = [];
  const sheetTiles = [];
  const advance = () => {
    for (let step = 0; step < stepsPerFrame; step++)
      studio.stepManualClock(stepMs);
    context.clearRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    if (stillsEvery > 0 && frames % stillsEvery === 0)
      stills.push({ frame: frames, data: scratch.toDataURL("image/png") });
    if (sheetEvery > 0 && frames % sheetEvery === 0) {
      const tile = document.createElement("canvas");
      tile.width = Math.round(width / 2);
      tile.height = Math.round(height / 2);
      tile.getContext("2d").drawImage(scratch, 0, 0, tile.width, tile.height);
      sheetTiles.push({ frame: frames, tile });
    }
    const { data } = context.getImageData(0, 0, width, height);
    const palette = quantize(data, colors, { format: "rgb444" });
    const index = applyPalette(data, palette, "rgb444");
    gif.writeFrame(index, width, height, {
      palette,
      delay: Math.round(frameMs),
    });
    frames += 1;
  };

  studio.beginManualClock();
  try {
    const lead = Math.round(leadInMs / frameMs);
    for (let i = 0; i < lead; i++) advance();
    studio.play();
    const cap = Math.ceil(((durationMs ?? 8000) + 5000) / frameMs);
    for (let i = 0; i < cap; i++) {
      const progress = studio.script;
      if (progress && (progress.done || progress.error)) break;
      advance();
      // Let the page breathe so a long take never trips the renderer watchdog.
      if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    studio.endManualClock();
  }
  gif.finish();

  let sheet = null;
  if (sheetTiles.length > 0) {
    const columns = 4;
    const { width: tw, height: th } = sheetTiles[0].tile;
    const canvas = document.createElement("canvas");
    canvas.width = tw * columns;
    canvas.height = th * Math.ceil(sheetTiles.length / columns);
    const sheetContext = canvas.getContext("2d");
    sheetContext.font = "bold 16px sans-serif";
    sheetTiles.forEach(({ frame, tile }, index) => {
      const tx = (index % columns) * tw;
      const ty = Math.floor(index / columns) * th;
      sheetContext.drawImage(tile, tx, ty);
      sheetContext.fillStyle = "#000";
      sheetContext.fillRect(tx, ty, 54, 20);
      sheetContext.fillStyle = "#ff0";
      sheetContext.fillText(String(frame), tx + 4, ty + 16);
    });
    sheet = canvas.toDataURL("image/png");
  }

  const bytes = gif.bytes();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { data: window.btoa(binary), frames, width, height, stills, sheet };
}

async function launchRecorder() {
  try {
    return await chromium.launch({ headless: true, channel: "chromium" });
  } catch {
    return chromium.launch({ headless: true });
  }
}

function option(name) {
  const equals = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(equals));
  if (inline) return inline.slice(equals.length);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function waitForServer(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null)
      throw new Error(`Capture server exited with code ${server.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function captureServerAvailable(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const html = await response.text();
    return html.includes("/src/capture/main.ts");
  } catch {
    return false;
  }
}
