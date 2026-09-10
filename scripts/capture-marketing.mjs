/* global URL, console, fetch, requestAnimationFrame, setTimeout, window */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const projectRoot = process.cwd();
const outputRoot = path.resolve(
  projectRoot,
  option("out") ?? "art-out/game-captures",
);
const requestedPreset = option("preset");
const requestedFormat = option("format");
const requestedBackdrop = option("backdrop");
const suppliedUrl = option("url");
const port = Number(option("port") ?? 4174);
const baseUrl = suppliedUrl ?? `http://127.0.0.1:${port}`;
let server;

const FORMATS = {
  wide: { width: 1600, height: 900 },
  square: { width: 1200, height: 1200 },
  portrait: { width: 1080, height: 1350 },
  card: { width: 650, height: 850 },
};

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

  const browser = await chromium.launch({ headless: true });
  try {
    const discovery = await browser.newPage({ viewport: FORMATS.wide });
    await discovery.goto(`${baseUrl}/capture.html?clean=1`, {
      waitUntil: "domcontentloaded",
    });
    await discovery.waitForFunction(
      () => window.__captureStudio?.ready === true,
    );
    const presets = await discovery.evaluate(() =>
      window.__captureStudio.presets.map((preset) => ({
        id: preset.id,
        defaultFormat: preset.defaultFormat,
        defaultBackdrop: preset.defaultBackdrop,
      })),
    );
    await discovery.close();

    const chosen = requestedPreset
      ? presets.filter((preset) => preset.id === requestedPreset)
      : presets;
    if (chosen.length === 0) {
      throw new Error(`Unknown capture preset: ${requestedPreset}`);
    }

    for (const preset of chosen) {
      const format = requestedFormat ?? preset.defaultFormat;
      const viewport = FORMATS[format];
      if (!viewport) throw new Error(`Unknown capture format: ${format}`);
      const backdrop = requestedBackdrop ?? preset.defaultBackdrop;
      const url = new URL("capture.html", `${baseUrl}/`);
      url.searchParams.set("clean", "1");
      url.searchParams.set("preset", preset.id);
      url.searchParams.set("format", format);
      url.searchParams.set("backdrop", backdrop);
      if (preset.id === "gameplay-multitude-zoom")
        url.searchParams.set("captureArtScale", "3");

      const page = await browser.newPage({
        viewport,
        deviceScaleFactor: 1,
      });
      await page.goto(url.href, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (id) =>
          window.__captureStudio?.ready === true &&
          window.__captureStudio.preset === id,
        preset.id,
        { timeout: 20_000 },
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );

      const output = path.join(outputRoot, `${preset.id}-${format}.png`);
      await page.locator("#capture-stage canvas").screenshot({
        path: output,
        omitBackground: backdrop === "transparent",
      });
      console.log(`captured ${path.relative(projectRoot, output)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server) server.kill();
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
    if (server?.exitCode !== null) {
      throw new Error(`Capture server exited with code ${server.exitCode}`);
    }
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
