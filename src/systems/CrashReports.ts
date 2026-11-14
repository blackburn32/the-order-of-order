// A small crash beacon: uncaught errors go to the leaderboard Worker's
// `/v1/errors` (worker/src/index.ts, "Crash reports"), which folds repeats of
// one crash into a count. Read them with `npm run errors` in worker/.
//
// What a report holds: the error's message and stack, the scene on screen, the
// build and version, and which platform (web, itch, android). No player id,
// initials, or save data rides with it. The privacy policy says so, and the
// player can turn it off in Settings.
//
// Capped per session, so a crash in a render loop sends a handful of reports,
// not one a frame.

import { API } from "./GlobalScores";
import { APP_VERSION, BUILD_SHA } from "../buildInfo";
import { GOLD_BORDER, PHONE_BUILD } from "../buildFlags";
import { loadSettings } from "./SaveData";

const MAX_REPORTS_PER_SESSION = 5;
let sent = 0;
const seen = new Set<string>();

function platform(): string {
  if (PHONE_BUILD) return "android";
  if (GOLD_BORDER) return "itch";
  return "web";
}

/** The scenes on screen, for a hint at where it happened. */
function activeScenes(): string {
  try {
    return window.__game?.scene
      .getScenes(true)
      .map((scene) => scene.scene.key)
      .join(",");
  } catch {
    return "";
  }
}

function enabled(): boolean {
  if (!API) return false;
  try {
    return loadSettings().crashReports !== false;
  } catch {
    return true;
  }
}

export function reportError(error: unknown, source: string): void {
  if (sent >= MAX_REPORTS_PER_SESSION || !enabled()) return;
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : String(error));
  const message = `${source}: ${err.name}: ${err.message}`.slice(0, 500);
  if (seen.has(message)) return;
  seen.add(message);
  sent += 1;

  const body = JSON.stringify({
    message,
    stack: (err.stack ?? "").slice(0, 4000),
    build: BUILD_SHA,
    version: APP_VERSION,
    platform: platform(),
    scene: activeScenes(),
  });
  try {
    // sendBeacon survives the page going away, which is exactly when a fatal
    // error tends to be followed by the player closing the tab.
    const blob = new Blob([body], { type: "text/plain" });
    if (navigator.sendBeacon?.(`${API}/v1/errors`, blob)) return;
  } catch {
    // fall through to fetch
  }
  void fetch(`${API}/v1/errors`, {
    method: "POST",
    body,
    keepalive: true,
    headers: { "Content-Type": "text/plain" },
  }).catch(() => undefined);
}

export function installCrashReports(): void {
  window.addEventListener("error", (event) => {
    // A failed <script>/<img> load arrives here with no error object; those
    // are not crashes of ours.
    if (!event.error && !event.message) return;
    reportError(event.error ?? event.message, "error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError(event.reason, "unhandledrejection");
  });
}
