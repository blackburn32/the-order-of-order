// Save export and import: every `ooo_` key in one JSON file the player keeps.
//
// For moving to a new device, and for getting a save back after the browser
// clears its storage. The file holds the Hall, the Daily Rite's records,
// unlocks, stats, settings, and the board token — so the global board knows
// the imported device as the same player. It does not hold a run in progress:
// that is finished or abandoned on the device it was started on.

import { Capacitor } from "@capacitor/core";
import { APP_VERSION } from "../buildInfo";
import { flushSaveMirror, mirrored } from "./SaveMirror";

const FORMAT = "the-order-of-order-save";
const FORMAT_VERSION = 1;

interface SaveFile {
  format: typeof FORMAT;
  version: number;
  appVersion: string;
  exportedAt: string;
  data: Record<string, string>;
}

export function buildSaveFile(): string {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !mirrored(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) data[key] = value;
  }
  const file: SaveFile = {
    format: FORMAT,
    version: FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
  return JSON.stringify(file);
}

function fileName(): string {
  return `order-of-order-save-${new Date().toISOString().slice(0, 10)}.json`;
}

/**
 * Hand the player their save. A browser downloads it; the Android app offers
 * the system share sheet (save to Files, Drive, mail it to yourself), and
 * falls back to the clipboard. Resolves to how it went, for the toast.
 */
export async function exportSave(): Promise<
  "downloaded" | "shared" | "copied" | "failed"
> {
  let text: string;
  try {
    text = buildSaveFile();
  } catch {
    return "failed";
  }

  if (Capacitor.isNativePlatform()) {
    try {
      const file = new File([text], fileName(), { type: "application/json" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "The Order of Order save",
        });
        return "shared";
      }
    } catch {
      // fall through to the clipboard
    }
    try {
      await navigator.clipboard.writeText(text);
      return "copied";
    } catch {
      return "failed";
    }
  }

  try {
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return "downloaded";
  } catch {
    return "failed";
  }
}

/** Parse a save file. Null when it is not one this build can read. */
export function readSaveFile(text: string): Record<string, string> | null {
  let parsed: Partial<SaveFile>;
  try {
    parsed = JSON.parse(text) as Partial<SaveFile>;
  } catch {
    return null;
  }
  if (parsed.format !== FORMAT) return null;
  if (typeof parsed.version !== "number" || parsed.version > FORMAT_VERSION)
    return null;
  if (!parsed.data || typeof parsed.data !== "object") return null;
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (mirrored(key) && typeof value === "string") data[key] = value;
  }
  return Object.keys(data).length > 0 ? data : null;
}

/** Ask the player for a save file. Resolves to its text, or null if they
 *  cancelled. */
export function pickSaveFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      file.text().then(done, () => done(null));
    });
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Replace this device's save with the file's, then reload so every system
 * reads it fresh. Keys the file does not have are removed: an import is the
 * file's save, not a merge of two. Resolves false (changing nothing) when the
 * text is not a save file.
 */
export async function importSave(text: string): Promise<boolean> {
  const data = readSaveFile(text);
  if (!data) return false;
  const existing: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && mirrored(key)) existing.push(key);
  }
  for (const key of existing) if (!(key in data)) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(data))
    localStorage.setItem(key, value);
  await flushSaveMirror();
  window.location.reload();
  return true;
}
