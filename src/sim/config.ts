// Editable knobs for the balance simulation. Change `unlockedAtStart` to control
// which items appear in the shop pool during a batch (this is the "list of
// unlocked items you can change before the test"); everything else is a default
// the CLI can override via argv.

import { ITEMS, ShopItemId } from '../systems/Items';

/** Every item that is gated behind an unlock criterion — i.e. everything that is
 *  NOT available from the start of a fresh save. */
export const GATED_ITEM_IDS: ShopItemId[] = ITEMS.filter((it) => it.unlock).map((it) => it.id);

/** Items available from the very first shop of a fresh save (no unlock gate). */
export const BASE_ITEM_IDS: ShopItemId[] = ITEMS.filter((it) => !it.unlock).map((it) => it.id);

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

  /**
   * Cap on the number of dice a run may hold. Grid-growing builds (Double the
   * Fun, Genesis, multiply) grow the dice pool exponentially across a long run,
   * which makes each roll's scoring pass unboundedly expensive. When the pool
   * exceeds this, it is truncated (and the run is flagged `hitDiceCap`).
   *
   * Winning builds overshoot the round target by 100–1000×, so the cap has
   * almost no effect on win/loss or round-reached: validated win rates are flat
   * from cap 2000 down to ~200. It must, however, stay strictly above the
   * largest `diceInGrid` unlock threshold (Double the Fun, > 1000) or that
   * unlock can never trigger and reads as 0% — see MIN_SAFE_DICE_CAP. Default
   * 2000 clears that with margin; raise it for a higher-fidelity (slower) pass.
   */
  maxDice: number;
}

/** The largest `diceInGrid` unlock threshold in the item set. `maxDice` must
 *  exceed this or that unlock's likelihood is measured as an artifactual 0%. */
export const MAX_DICE_IN_GRID_UNLOCK: number = Math.max(
  0,
  ...ITEMS.map((it) => (it.unlock?.kind === 'diceInGrid' ? it.unlock.count : 0))
);

export const DEFAULT_CONFIG: SimConfig = {
  unlockedAtStart: [...GATED_ITEM_IDS],
  runs: 1000,
  seed: 1,
  maxRollsPerRun: 100_000,
  maxDice: 2000
};
