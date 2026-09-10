import Phaser from "phaser";
import { buildTextures } from "../art/textures";
import { installHiDpi, installHighResolutionText } from "../renderQuality";
import { GameScene } from "../scenes/GameScene";
import { ShopScene } from "../scenes/ShopScene";
import { fx } from "../systems/Effects";
import { CaptureCursorScene } from "./CaptureCursor";
import { CaptureScene } from "./CaptureScene";
import {
  DICE_ZOOM_DURATION_MS,
  diceZoomProgress,
  playDiceZoomReel,
  prepareDiceZoom,
  resetDiceZoomReel,
} from "./diceZoomReel";
import {
  playRollReel,
  resetRollReel,
  rollReelDuration,
  rollReelProgress,
  GRID_GROWTH_REEL,
  LATE_GRID_REEL,
  type RollReelConfig,
  type RollReelProgress,
} from "./rollReel";
import {
  parkShopCursor,
  playShopLoop,
  resetShopLoop,
  shopLoopProgress,
  SHOP_LOOP_DURATION_MS,
  type ShopLoopProgress,
} from "./shopLoop";
import {
  CAPTURE_PRESETS,
  capturePreset,
  captureScript,
  installGameplayFixture,
  installShopFixture,
  type CaptureBackdrop,
  type CaptureFormat,
  type CapturePresetDefinition,
  type CapturePresetId,
} from "./presets";

interface CaptureStudioApi {
  readonly ready: boolean;
  readonly preset: CapturePresetId;
  readonly presets: typeof CAPTURE_PRESETS;
  /** How long this preset's `play()` performance runs, for a recorder that
   *  would otherwise keep its own copy of the pacing. Null when the preset
   *  starts an open-ended animation instead of a script. */
  readonly playDurationMs: number | null;
  /** What the current scripted performance has done, and what went wrong if a
   *  beat could not be played — see `shopLoop.ts` and `rollReel.ts`. */
  readonly script: ShopLoopProgress | RollReelProgress | null;
  render(presetId: CapturePresetId, backdrop?: CaptureBackdrop): void;
  play(): void;
  download(): void;
  /** Take the game clock off the browser's animation frame so a recorder can
   *  advance it a frame at a time. See `beginManualClock`. */
  beginManualClock(): void;
  /** Advance the game by exactly `deltaMs` and render it, synchronously. */
  stepManualClock(deltaMs: number): void;
  /** Give the clock back to the browser. */
  endManualClock(): void;
}

declare global {
  interface Window {
    __captureStudio: CaptureStudioApi;
  }
}

/** The reel each roll-driving script names, so the studio and the recorder read
 *  its pacing from one place. */
const ROLL_REELS: Record<string, RollReelConfig> = {
  "grid-growth": GRID_GROWTH_REEL,
  "late-grid": LATE_GRID_REEL,
};

function rollReelFor(preset: CapturePresetDefinition): RollReelConfig | null {
  const script = captureScript(preset);
  return script ? (ROLL_REELS[script] ?? null) : null;
}

const params = new URLSearchParams(window.location.search);
const captureRenderer =
  params.get("renderer") === "canvas" ? Phaser.CANVAS : Phaser.WEBGL;
let currentPreset = capturePreset(params.get("preset"));
let currentBackdrop =
  parseBackdrop(params.get("backdrop")) ?? currentPreset.defaultBackdrop;
let currentFormat =
  parseFormat(params.get("format")) ?? currentPreset.defaultFormat;
let ready = false;

const stage = requiredElement<HTMLDivElement>("capture-stage");
const presetSelect = requiredElement<HTMLSelectElement>("capture-preset");
const formatSelect = requiredElement<HTMLSelectElement>("capture-format");
const backdropSelect = requiredElement<HTMLSelectElement>("capture-backdrop");
const restartButton = requiredElement<HTMLButtonElement>("capture-restart");
const playButton = requiredElement<HTMLButtonElement>("capture-play");
const downloadButton = requiredElement<HTMLButtonElement>("capture-download");
const cleanButton = requiredElement<HTMLButtonElement>("capture-clean");
const status = requiredElement<HTMLSpanElement>("capture-status");
const size = requiredElement<HTMLElement>("capture-size");

for (const preset of CAPTURE_PRESETS) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.label;
  presetSelect.appendChild(option);
}

const clean = params.get("clean") === "1";
document.documentElement.classList.toggle("capture-clean", clean);
document.body.classList.toggle("capture-clean", clean);
presetSelect.value = currentPreset.id;
formatSelect.value = currentFormat;
backdropSelect.value = currentBackdrop;
applyFormat(currentFormat, false);

installHighResolutionText();

class CaptureBootScene extends Phaser.Scene {
  constructor() {
    super("CaptureBoot");
  }

  create(): void {
    buildTextures(this);
    fx.init(this.game.renderer.type, true);
    // Defer until Phaser's constructor has returned and `game` below is bound.
    this.time.delayedCall(0, () =>
      window.dispatchEvent(new Event("capture-studio-booted")),
    );
  }
}

window.addEventListener(
  "capture-studio-booted",
  () => {
    game.events.on("capture-content-ready", (presetId: CapturePresetId) => {
      if (presetId !== currentPreset.id) return;
      ready = true;
      status.textContent = "Ready to capture";
      downloadButton.disabled = false;
      updateSize();
    });
    renderCurrentPreset();
  },
  { once: true },
);

const game = new Phaser.Game({
  type: captureRenderer,
  parent: "capture-stage",
  transparent: true,
  backgroundColor: "rgba(0,0,0,0)",
  antialias: true,
  antialiasGL: true,
  pixelArt: false,
  roundPixels: true,
  render: { preserveDrawingBuffer: true },
  scale: {
    // The studio controls the parent rectangle directly as its selected frame
    // changes. NONE lets `scale.resize` adopt that exact rectangle instead of
    // RESIZE immediately restoring the parent's previously measured size.
    mode: Phaser.Scale.NONE,
    width: Math.max(1, stage.clientWidth),
    height: Math.max(1, stage.clientHeight),
  },
  // The cursor scene is listed last so it renders over everything the preset it
  // is pointing at draws, the booster overlay included.
  scene: [
    CaptureBootScene,
    CaptureScene,
    GameScene,
    ShopScene,
    CaptureCursorScene,
  ],
});
installHiDpi(game);

function renderCurrentPreset(): void {
  ready = false;
  resetShopLoop();
  resetRollReel();
  resetDiceZoomReel();
  status.textContent = "Rendering…";
  downloadButton.disabled = true;
  playButton.disabled = currentPreset.kind === "stage";
  backdropSelect.disabled = currentPreset.kind === "gameplay";

  game.scene.stop("Game");
  game.scene.stop("Shop");
  game.scene.stop("CaptureStudio");
  game.scene.stop("CaptureBoot");
  game.scene.stop("CaptureCursor");

  if (currentPreset.kind === "gameplay") {
    installGameplayFixture(game, currentPreset.id);
    game.scene.start("Game");
    window.setTimeout(() => {
      if (captureScript(currentPreset) === "dice-zoom") prepareDiceZoom(game);
      game.events.once(Phaser.Core.Events.POST_RENDER, () => {
        game.events.emit("capture-content-ready", currentPreset.id);
      });
    }, currentPreset.readyDelayMs ?? 700);
  } else if (currentPreset.kind === "shop") {
    const checkpoint = installShopFixture(game);
    game.scene.start("Shop", checkpoint);
    game.scene.start("CaptureCursor");
    window.setTimeout(() => {
      // Rest the pointer on the reel's closing target before anything is
      // captured, so the still and the clip's first frame both carry the pose
      // the reel ends in.
      parkShopCursor(game);
      game.events.once(Phaser.Core.Events.POST_RENDER, () => {
        game.events.emit("capture-content-ready", currentPreset.id);
      });
    }, currentPreset.readyDelayMs ?? 900);
  } else {
    game.scene.start("CaptureStudio", {
      presetId: currentPreset.id,
      backdrop: currentBackdrop,
    });
  }

  syncUrl();
}

function applyFormat(format: CaptureFormat, rerender = true): void {
  currentFormat = format;
  stage.dataset.format = format;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!game) return;
      game.scale.resize(
        Math.max(1, stage.clientWidth),
        Math.max(1, stage.clientHeight),
      );
      if (rerender) renderCurrentPreset();
      updateSize();
    });
  });
}

function downloadPng(): void {
  if (!ready) return;
  const canvas = game.canvas;
  canvas.toBlob((blob) => {
    if (!blob) {
      status.textContent =
        "PNG export failed; use the automated capture script.";
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentPreset.id}-${currentFormat}.png`;
    link.click();
    URL.revokeObjectURL(url);
    status.textContent = `Downloaded ${link.download}`;
  }, "image/png");
}

function openCleanPreview(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("clean", "1");
  url.searchParams.set("preset", currentPreset.id);
  url.searchParams.set("format", currentFormat);
  url.searchParams.set("backdrop", currentBackdrop);
  window.open(url, "_blank", "noopener,noreferrer");
}

function playCurrentPreset(): void {
  if (!ready) return;
  if (captureScript(currentPreset) === "dice-zoom") {
    void playDiceZoomReel(game, (label) => {
      status.textContent = label;
    }).then(() => {
      const { error } = diceZoomProgress();
      status.textContent = error ? `Zoom reel failed — ${error}` : "Reel done";
    });
    return;
  }
  const reel = rollReelFor(currentPreset);
  if (reel) {
    void playRollReel(game, reel, (label) => {
      status.textContent = label;
    }).then(() => {
      const { error } = rollReelProgress();
      status.textContent = error ? `Roll reel failed — ${error}` : "Reel done";
    });
    return;
  }
  if (currentPreset.kind === "gameplay") {
    const scene = game.scene.getScene("Game") as unknown as {
      onRoll(): void;
    };
    scene.onRoll();
    return;
  }
  if (currentPreset.kind === "shop") {
    void playShopLoop(game, (label) => {
      status.textContent = label;
    }).then(() => {
      const { error } = shopLoopProgress();
      status.textContent = error ? `Shop reel failed — ${error}` : "Reel done";
    });
  }
}

// A recorder cannot keep up with this page in real time: sampling the canvas at
// 30fps and handing each frame to a software encoder, Chromium delivers about
// half the frames it was asked for and drops whatever is still queued when the
// recording stops — a clip that judders and loses its closing beat. Nothing in
// the studio reads a wall clock (the reels, GameScene and ShopScene all run on
// Phaser's), so the recorder can drive the clock itself: step the game one frame
// interval, capture the frame that step drew, and only then step again. The
// encoder sets the pace, the reel's pacing is exact rather than approximate, and
// the clip's frame count is decided rather than measured.
let manualNow = 0;

function beginManualClock(): void {
  game.loop.raf.stop();
  // Phaser averages recent deltas to ride out a browser's jitter. There is no
  // jitter to ride out here, and the average would put a frame's animation a
  // little behind the timestamp the recorder gives it.
  game.loop.smoothStep = false;
  manualNow = game.loop.now;
}

/** Phaser's TweenManager is the one part of the engine that does not take its
 *  delta from the game step: it reads `Date.now()` itself (see
 *  `TweenManager.getDelta`). Left alone under a stepped clock, every timer would
 *  run on the recorder's clock while every tween ran on the wall's — the reel
 *  would finish its beats while the score floats it left behind were still a
 *  third of the way through fading. Each active scene's manager is handed the
 *  step's delta instead, every step, so scenes that start mid-reel are covered
 *  too. */
function driveTweens(deltaMs: number | null): void {
  for (const scene of game.scene.getScenes(true)) {
    const manager = scene.tweens as unknown as { getDelta?: () => number };
    if (deltaMs === null) delete manager.getDelta;
    else manager.getDelta = () => deltaMs;
  }
}

function stepManualClock(deltaMs: number): void {
  manualNow += deltaMs;
  driveTweens(deltaMs);
  game.loop.step(manualNow);
}

function endManualClock(): void {
  driveTweens(null);
  game.loop.smoothStep = true;
  game.loop.raf.start(
    game.loop.step.bind(game.loop),
    game.loop.forceSetTimeOut,
    1000 / 60,
  );
}

function syncUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("preset", currentPreset.id);
  url.searchParams.set("format", currentFormat);
  url.searchParams.set("backdrop", currentBackdrop);
  history.replaceState(null, "", url);
}

function updateSize(): void {
  if (!game) return;
  size.textContent = `${game.scale.width} × ${game.scale.height} CSS px · DPR ${window.devicePixelRatio.toFixed(2)}`;
}

presetSelect.addEventListener("change", () => {
  currentPreset = capturePreset(presetSelect.value);
  currentBackdrop = currentPreset.defaultBackdrop;
  backdropSelect.value = currentBackdrop;
  formatSelect.value = currentPreset.defaultFormat;
  applyFormat(currentPreset.defaultFormat);
});

formatSelect.addEventListener("change", () => {
  applyFormat(formatSelect.value as CaptureFormat);
});

backdropSelect.addEventListener("change", () => {
  currentBackdrop = backdropSelect.value as CaptureBackdrop;
  renderCurrentPreset();
});

restartButton.addEventListener("click", renderCurrentPreset);
playButton.addEventListener("click", playCurrentPreset);
downloadButton.addEventListener("click", downloadPng);
cleanButton.addEventListener("click", openCleanPreview);

window.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  if (event.key.toLowerCase() === "r") renderCurrentPreset();
  if (event.key.toLowerCase() === "p") downloadPng();
});

let resizeFrame = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    game.scale.resize(
      Math.max(1, stage.clientWidth),
      Math.max(1, stage.clientHeight),
    );
    renderCurrentPreset();
  });
});

window.__captureStudio = {
  get ready() {
    return ready;
  },
  get preset() {
    return currentPreset.id;
  },
  presets: CAPTURE_PRESETS,
  get playDurationMs() {
    if (captureScript(currentPreset) === "shop-loop")
      return SHOP_LOOP_DURATION_MS;
    if (captureScript(currentPreset) === "dice-zoom")
      return DICE_ZOOM_DURATION_MS;
    const reel = rollReelFor(currentPreset);
    return reel ? rollReelDuration(reel) : null;
  },
  get script() {
    if (captureScript(currentPreset) === "shop-loop") return shopLoopProgress();
    if (captureScript(currentPreset) === "dice-zoom") return diceZoomProgress();
    return rollReelFor(currentPreset) ? rollReelProgress() : null;
  },
  render(presetId, backdrop) {
    currentPreset = capturePreset(presetId);
    currentBackdrop = backdrop ?? currentPreset.defaultBackdrop;
    presetSelect.value = currentPreset.id;
    backdropSelect.value = currentBackdrop;
    renderCurrentPreset();
  },
  play: playCurrentPreset,
  download: downloadPng,
  beginManualClock,
  stepManualClock,
  endManualClock,
};

function parseBackdrop(value: string | null): CaptureBackdrop | null {
  return value === "felt" || value === "parchment" || value === "transparent"
    ? value
    : null;
}

function parseFormat(value: string | null): CaptureFormat | null {
  return value === "wide" ||
    value === "square" ||
    value === "portrait" ||
    value === "card"
    ? value
    : null;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing capture studio element #${id}`);
  return element as T;
}
