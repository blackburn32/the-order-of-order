// Node has no `localStorage`, which SaveData.ts uses for meta-progression, and
// no reproducible RNG. This installs a minimal in-memory localStorage for the
// game's meta-progression APIs and swaps in a seeded PRNG so the
// whole batch is deterministic — including the handful of effects (e.g.
// Whetstone's `shrinkRandom`) that call Math.random directly and can't take an
// injected rng.

import { ShopItemId } from '../systems/Items';

const KEY_PROGRESS = 'ooo_progress_v1';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

/** mulberry32 — tiny, fast, well-distributed 32-bit PRNG for reproducible runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Install the in-memory localStorage and seed the unlocked-items progress.
 *  Safe to call once per process. */
export function installStorage(unlockedAtStart: ShopItemId[]): void {
  const storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  storage.setItem(
    KEY_PROGRESS,
    JSON.stringify({ unlocked: unlockedAtStart, selectionCounts: {}, gamesCompleted: 0 })
  );
}

/** Point global Math.random at a seeded PRNG so the entire run is reproducible.
 *  Returns the generator so callers can also thread it explicitly where an rng
 *  parameter is accepted (rollAll, rollShopOffers). */
export function seedGlobalRandom(seed: number): () => number {
  const rng = mulberry32(seed);
  Math.random = rng;
  return rng;
}
