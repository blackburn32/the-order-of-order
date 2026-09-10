/* global Buffer, HTMLCanvasElement, URL, VideoEncoder, VideoFrame, btoa, console, document, fetch, requestAnimationFrame, setTimeout, window */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { muxWebm } from "./webm.mjs";

const projectRoot = process.cwd();
const outputRoot = path.resolve(
  projectRoot,
  option("out") ?? "art-out/game-captures",
);
const requestedPreset = option("preset");
const suppliedUrl = option("url");
const port = Number(option("port") ?? 4174);
const baseUrl = suppliedUrl ?? `http://127.0.0.1:${port}`;
let server;

// `durationMs` is the fallback for a preset whose `play()` starts an open-ended
// animation. A scripted preset publishes its own length as `playDurationMs`, so
// the pacing lives with the script instead of drifting from it here.
//
// `fps` is the clip's frame rate, and — because the studio's clock is stepped by
// this script rather than by the browser (see `beginManualClock`) — it is also
// exactly how often the game is rendered. Every rendered frame is encoded and no
// frame is a repeat, so 30 is genuinely smooth here in a way that 60 sampled off
// a page in real time never was.
//
// `bitrate` is a flat VP8 target, so it is close to what the file will cost per
// second whatever the clip is doing — WebCodecs offers a constant-quality mode
// for VP9 and AV1 but not for VP8, and VP8 is what the site's oldest supported
// browsers can play. What it mostly buys is the opening frame: VP8 sizes its
// first keyframe from the per-frame budget, and a 1600x900 keyframe of this grid
// opens soft below about 3 Mbps — the die-size labels and the footer turn to
// mush, then sharpen over the following frames, which on a looping clip reads as
// a fade-in every time it comes round. 3.5 Mbps opens sharp; the shop reel's
// shelf is larger, flatter artwork and holds up on a little less.
//
// `leadInMs` is the stillness in front of the reel. On a loop it is watched
// back-to-back with the reel's closing rest, and the pair of them should add up
// to about one of the reel's own between-roll pauses, or the loop point reads as
// the clip stopping rather than coming round.
const CLIPS = [
  {
    id: "shop-loop",
    durationMs: 11_000,
    fps: 30,
    bitrate: 3_000_000,
    leadInMs: 600,
  },
  {
    id: "gameplay-grid-growth",
    durationMs: 10_800,
    fps: 30,
    bitrate: 3_500_000,
    leadInMs: 600,
  },
  {
    id: "gameplay-late-grid",
    durationMs: 4400,
    fps: 30,
    bitrate: 3_500_000,
    leadInMs: 200,
  },
  {
    id: "gameplay-multitude-zoom",
    durationMs: 17_500,
    fps: 30,
    bitrate: 3_500_000,
    leadInMs: 300,
    // The reel begins at the game's maximum camera zoom. Bake dice faces and
    // labels at 3x so that magnification has real source detail to reveal.
    captureArtScale: 3,
  },
];

/** How often to force a keyframe. VP8 would otherwise emit one and then coast,
 *  leaving a player with nowhere to resume from and this muxer with a single
 *  enormous cluster. */
const KEYFRAME_SECONDS = 2;

/** The rate the game is stepped at while a clip is recorded, whatever the clip's
 *  own frame rate. The game is full of timers whose delays are not multiples of
 *  a frame — the tumble flickers a die every 70ms — and a timer can only fire on
 *  a step, so stepping at the clip's 30fps would round that flicker up to 100ms
 *  and play the game's own animation slower than it runs. Stepping at the rate
 *  the game was written against and keeping every second frame samples a 60fps
 *  animation at 30, which is what a 30fps capture is supposed to be. */
const RENDER_FPS = 60;

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

  const clips = requestedPreset
    ? CLIPS.filter((clip) => clip.id === requestedPreset)
    : CLIPS;
  if (clips.length === 0)
    throw new Error(`Unknown motion preset: ${requestedPreset}`);

  // Playwright's default headless build is the headless shell, which has no GPU
  // and rasterizes on the CPU: it renders the 168-die grid at about half the
  // rate Chromium's own headless mode does. Nothing is dropped either way now
  // that the clock is ours — a slow page only makes the capture take longer —
  // but the fast browser is used when it is there.
  const browser = await launchRecorder();
  try {
    for (const clip of clips) {
      const page = await browser.newPage({
        viewport: { width: 1600, height: 900 },
      });
      const url = new URL("capture.html", `${baseUrl}/`);
      url.searchParams.set("clean", "1");
      url.searchParams.set("preset", clip.id);
      url.searchParams.set("format", "wide");
      if (clip.captureArtScale)
        url.searchParams.set("captureArtScale", String(clip.captureArtScale));
      // Chromium can expose partially cleared triangles when a frame is taken
      // from Phaser's WebGL backbuffer. Motion captures use Phaser's 2D renderer
      // so every captured frame is complete.
      url.searchParams.set("renderer", "canvas");
      await page.goto(url.href, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (id) =>
          window.__captureStudio?.ready === true &&
          window.__captureStudio.preset === id,
        clip.id,
        { timeout: 20_000 },
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const scriptedMs = await page.evaluate(
        () => window.__captureStudio.playDurationMs,
      );
      const durationMs = scriptedMs ?? clip.durationMs;

      const take = await page.evaluate(recordTake, {
        durationMs,
        scripted: scriptedMs !== null,
        fps: clip.fps,
        bitrate: Number(option("bitrate") ?? clip.bitrate),
        leadInMs: clip.leadInMs,
        keyframeEvery: clip.fps * KEYFRAME_SECONDS,
        stepsPerFrame: Math.max(1, Math.round(RENDER_FPS / clip.fps)),
      });
      // A beat the shop refused would otherwise ship as a clip that merely looks
      // wrong; the script records the failure instead of interrupting the take.
      const script = await page.evaluate(() => window.__captureStudio.script);
      if (script?.error)
        throw new Error(
          `${clip.id}: ${script.error} (after ${script.log.length} beats)`,
        );

      const payload = Buffer.from(take.data, "base64");
      let offset = 0;
      const frames = take.frames.map((frame) => {
        const data = payload.subarray(offset, offset + frame.size);
        offset += frame.size;
        return { key: frame.key, timestampUs: frame.timestampUs, data };
      });
      const output = path.join(outputRoot, `${clip.id}.webm`);
      await writeFile(
        output,
        muxWebm({
          width: take.width,
          height: take.height,
          fps: clip.fps,
          frames,
        }),
      );
      const pacing = scriptedMs === null ? "fixed" : "scripted";
      console.log(
        `captured ${path.relative(projectRoot, output)} (${frames.length} frames, ` +
          `${(frames.length / clip.fps).toFixed(1)}s ${pacing}, ${clip.fps}fps)`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server) server.kill();
}

/** Run one take inside the page: step the studio's clock a frame at a time,
 *  encode the frame that step drew, and hand the encoded stream back for muxing.
 *
 *  Nothing here waits on a wall clock. The reels, GameScene and ShopScene all
 *  run on Phaser's clock, which this drives, so a take is the same clip whatever
 *  the machine does with it — and a frame is never dropped for being late. */
async function recordTake({
  durationMs,
  scripted,
  fps,
  bitrate,
  leadInMs,
  keyframeEvery,
  stepsPerFrame,
}) {
  const canvas = document.querySelector("#capture-stage canvas");
  if (!(canvas instanceof HTMLCanvasElement))
    throw new Error("Capture canvas was not found");
  const studio = window.__captureStudio;
  const frameMs = 1000 / fps;
  const frameUs = 1_000_000 / fps;
  const stepMs = frameMs / stepsPerFrame;

  const frames = [];
  const payloads = [];
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({
        key: chunk.type === "key",
        timestampUs: chunk.timestamp,
        size: data.length,
      });
      payloads.push(data);
    },
    error: (error) => {
      throw error;
    },
  });
  encoder.configure({
    codec: "vp8",
    width: canvas.width,
    height: canvas.height,
    bitrate,
    framerate: fps,
    // The clip is assembled after the fact, so the encoder is free to take the
    // time a better-looking frame costs.
    latencyMode: "quality",
  });

  let index = 0;
  const advance = async (keyFrame = index % keyframeEvery === 0) => {
    for (let step = 0; step < stepsPerFrame; step++)
      studio.stepManualClock(stepMs);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(index * frameUs),
      duration: Math.round(frameUs),
    });
    encoder.encode(frame, { keyFrame });
    frame.close();
    index += 1;
    // Encoding runs ahead of nothing: let it drain rather than queueing the
    // whole reel and asking the tab for the memory to hold it.
    while (encoder.encodeQueueSize > 4)
      await new Promise((resolve) => setTimeout(resolve, 1));
  };

  studio.beginManualClock();
  try {
    const leadFrames = Math.round(leadInMs / frameMs);
    for (let i = 0; i < leadFrames; i++) await advance();
    studio.play();
    if (scripted) {
      // The published length is an estimate the reel rounds up on: it runs until
      // the script says it is finished, and the cap is only here so a script
      // that stalls cannot record forever.
      const cap = Math.ceil((durationMs + 5000) / frameMs);
      for (let i = 0; i < cap; i++) {
        const progress = studio.script;
        if (progress && (progress.done || progress.error)) break;
        await advance();
      }
    } else {
      const total = Math.round(durationMs / frameMs);
      for (let i = 0; i < total; i++) await advance();
    }
    // The clip's last frame is the one a loop cuts back from, and its first is a
    // keyframe. Ending on a keyframe too means the two frames either side of the
    // seam are both encoded from scratch: VP8 otherwise leaves a faint ghost of
    // whatever last moved — the roll's score floats, here — smeared over a
    // static grid for as long as it takes the next keyframe to arrive, and the
    // seam wipes it away in one visible step.
    await advance(true);
  } finally {
    studio.endManualClock();
  }
  await encoder.flush();
  encoder.close();

  let total = 0;
  for (const payload of payloads) total += payload.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const payload of payloads) {
    joined.set(payload, offset);
    offset += payload.length;
  }
  let binary = "";
  for (let i = 0; i < joined.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, joined.subarray(i, i + 0x8000));
  return {
    width: canvas.width,
    height: canvas.height,
    frames,
    data: btoa(binary),
  };
}

async function launchRecorder() {
  try {
    return await chromium.launch({ headless: true, channel: "chromium" });
  } catch (error) {
    console.warn(
      `chromium channel unavailable (${firstLine(error.message)}); ` +
        "falling back to the headless shell — run `npx playwright install chromium` " +
        "to capture faster",
    );
    return chromium.launch({ headless: true });
  }
}

function firstLine(message) {
  return String(message).split(/\r?\n/)[0].trim();
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
