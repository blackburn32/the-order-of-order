// Editable knobs for the balance simulation. Change `unlockedAtStart` to control
// which items appear in the shop pool during a batch (this is the "list of
// unlocked items you can change before the test"); everything else is a default
// the CLI can override via argv.

import { ITEMS, ShopItemId } from "../systems/Items";

/** Every item that is gated behind an unlock criterion — i.e. everything that is
 *  NOT available from the start of a fresh save. */
export const GATED_ITEM_IDS: ShopItemId[] = ITEMS.filter((it) => it.unlock).map(
  (it) => it.id,
);

/** Items available from the very first shop of a fresh save (no unlock gate). */
export const BASE_ITEM_IDS: ShopItemId[] = ITEMS.filter((it) => !it.unlock).map(
  (it) => it.id,
);

/** The two meta-progression states compared by the main balance report. */
export const UNLOCK_POOLS = {
  none: [] as ShopItemId[],
  all: [...GATED_ITEM_IDS],
} as const;

export interface SimConfig {
  /**
   * Which gated items count as already-unlocked for the shop pool during the
   * batch. `loadProgress().unlocked` is seeded from this, so `availableIds` in
   * Shop.ts offers exactly these (plus the always-available base items).
   *
   * Default: every gated item (the "all items unlocked" balancing baseline).
   * Edit this to a subset to test a narrower pool, e.g.:
   *   unlockedAtStart: []                         // base items only
   *   unlockedAtStart: ['dividend', 'momentum']   // base + two candidates
   *
   * NOTE: this only affects what the shop *offers*. The unlock-likelihood
   * tracker measures every gated item's criterion regardless of this list, so
   * you always get "how often would a player unlock X" for the full roster.
   */
  unlockedAtStart: ShopItemId[];

  /** Runs per strategy. */
  runs: number;

  /** Base RNG seed; run i of a strategy uses a seed derived from this. */
  seed: number;

  /** Safety cap on total rolls per run, in case a build could loop forever. */
  maxRollsPerRun: number;

  /** Simulate on Hard Mode: higher survival targets + pricier shop. Off by
   *  default so the main balance batch measures normal difficulty. */
  hardMode?: boolean;
}

export const DEFAULT_CONFIG: SimConfig = {
  unlockedAtStart: [...GATED_ITEM_IDS],
  runs: 1000,
  seed: 1,
  maxRollsPerRun: 100_000,
  hardMode: false,
};
