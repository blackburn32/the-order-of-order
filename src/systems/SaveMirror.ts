// A second copy of every save on the phone, in Capacitor Preferences.
//
// Everything the game keeps between sessions lives in localStorage under an
// `ooo_` key. A WebView's localStorage is the browser's to evict, and iOS in
// particular does, so on a native build each write is also mirrored into
// Preferences (the platform's own key-value store, which the OS does not clear
// on its own), and at boot any key the WebView has lost is put back from it.
// The active run already keeps its own native copy (ActiveRunPersistence), with
// tombstones of its own, under a key outside the `ooo_` prefix, so it is left
// out here.
//
// The mirror hooks Storage.setItem/removeItem rather than every call site, so a
// save added later is covered without anyone remembering to.

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const PREFIX = "ooo_";
/** The Preferences key that lists every mirrored key, since Preferences.keys()
 *  would also return the active run's and anything a plugin keeps there. */
const INDEX_KEY = "ooo-mirror-index";

export function mirrored(key: string): boolean {
  return key.startsWith(PREFIX);
}

let queue: Promise<unknown> = Promise.resolve();
const pending = new Map<string, string | null>();
let scheduled = false;

function flushSoon(): void {
  if (scheduled) return;
  scheduled = true;
  // Coalesced: a Hall write can be a few hundred KB, and one scene often writes
  // the same key several times in a frame.
  setTimeout(() => {
    scheduled = false;
    const batch = [...pending];
    pending.clear();
    queue = queue
      .then(async () => {
        for (const [key, value] of batch) {
          if (value === null) await Preferences.remove({ key });
          else await Preferences.set({ key, value });
        }
        await Preferences.set({
          key: INDEX_KEY,
          value: JSON.stringify(localKeys()),
        });
      })
      .catch(() => undefined);
  }, 50);
}

function localKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && mirrored(key)) keys.push(key);
    }
  } catch {
    // storage unavailable
  }
  return keys;
}

/** Wait for every mirrored write so far to land. Called before a reload. */
export async function flushSaveMirror(): Promise<void> {
  if (pending.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  await queue;
}

/**
 * On a native build: restore any key the WebView lost from Preferences, then
 * mirror every later write. Run before Phaser boots, so no scene reads storage
 * before it has been restored. Elsewhere it does nothing.
 */
export async function installSaveMirror(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const index = await Preferences.get({ key: INDEX_KEY });
    const keys: unknown = index.value ? JSON.parse(index.value) : [];
    if (Array.isArray(keys)) {
      for (const key of keys) {
        if (typeof key !== "string" || !mirrored(key)) continue;
        if (localStorage.getItem(key) !== null) continue;
        const { value } = await Preferences.get({ key });
        if (value !== null) localStorage.setItem(key, value);
      }
    }
  } catch {
    // Preferences unreadable: the WebView's copy is all there is.
  }

  const proto = Storage.prototype;
  const setItem = proto.setItem;
  const removeItem = proto.removeItem;
  const clear = proto.clear;
  proto.setItem = function (this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    if (this === localStorage && mirrored(key)) {
      pending.set(key, String(value));
      flushSoon();
    }
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    if (this === localStorage && mirrored(key)) {
      pending.set(key, null);
      flushSoon();
    }
  };
  proto.clear = function (this: Storage) {
    const keys = this === localStorage ? localKeys() : [];
    clear.call(this);
    for (const key of keys) pending.set(key, null);
    if (keys.length) flushSoon();
  };

  // Mirror what is there now, so a device upgrading to this build is covered
  // before its next write.
  for (const key of localKeys()) {
    const value = localStorage.getItem(key);
    if (value !== null) pending.set(key, value);
  }
  flushSoon();
}
