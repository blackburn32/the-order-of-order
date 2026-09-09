import { HALL_SIZE, rankOf, trialInRank } from "../config";
import type { RunState } from "../state/RunState";
import { clearActiveRun } from "./ActiveRunPersistence";
import type { DiceStack } from "./DicePool";
import { windfallFactor } from "./Dice";
import { ITEMS, meetsCriterion, ShopItemId } from "./Items";
import { isSeed } from "./Rng";
import {
  hydrateRollHistory,
  serializeRollHistory,
  type RollSample,
} from "./RunHistory";
import { recordItemAnalysisRun, resetItemAnalysis } from "./ItemAnalytics";
import { recordPlayerStatsRun, resetPlayerStats } from "./PlayerStats";

// Bumped to v2 for the ranks/trials/gold restructure. Runs recorded under the
// v1 keys measured a different game (ten flat rounds, score-as-currency, Hard
// Mode) and cannot be ranked against v2 runs, so those keys are simply never
// read again — no migration, and the old data is left in place rather than
// deleted in case a player ever wants to go looking for it.
const KEY_SCORES = "ooo_high_scores_v2";
const KEY_SETTINGS = "ooo_settings_v2";
const KEY_PROGRESS = "ooo_progress_v2";

/** Schema stamp on every Hall entry written by this version. Entries without
 *  it are dropped on load. */
export const HALL_SCHEMA = 2;

export interface HallEntry {
  schema: number; // HALL_SCHEMA; anything else is discarded on load
  startedAt: number; // run start, epoch ms
  rank: number; // rank reached — the PRIMARY ranking key
  trial: number; // trial reached within that rank (1..3)
  score: bigint; // total points accumulated across the whole run; the tiebreak
  won: boolean; // true if the run cleared the final rank
  endless?: boolean; // true if the run continued past the final rank
  goldEarned?: number; // lifetime gold earned during the run
  dice: DiceStack[];
  // Per-item point attribution for the run (see systems/ItemPoints). Optional so
  // pre-existing entries load fine; the Hall's analysis button is hidden when
  // absent. Full fidelity locally (no size cap).
  dicePoints?: Record<string, bigint>;
  itemPoints?: Record<string, bigint>;
  // The run's per-roll timeline (see systems/RunHistory), for the analysis
  // screen's score and dice-pool curves. Optional for the same reason the point
  // maps are: entries recorded before it existed still load, and simply chart
  // nothing. `rolls` is the run's true roll count, which the timeline only
  // matches one-for-one until a very long run thins it.
  history?: RollSample[];
  rolls?: number;
  // What it would take to play this run again — on this machine or anyone
  // else's. `seed` fixes every roll, shop shelf and boss the run met (see
  // systems/Rng); `unlocks` is the snapshot of owned cards the run's shop was
  // drawing from, which is the other half of the answer and the half that
  // differs between players. Both optional: entries recorded before seeds
  // existed still load, and simply cannot be replayed.
  seed?: number;
  unlocks?: ShopItemId[];
  // The third thing a replay needs, and the one that is not a property of the
  // seed at all: whether the run was played under the tutorial, and which of its
  // rolls the tutorial rigged (see RunState.forcedRolls).
  tutorialArmed?: boolean;
  forcedRolls?: string[];
}

export interface Settings {
  musicVol: number; // 0..1
  sfxVol: number; // 0..1
  showIntro: boolean; // play the 3-page intro when a run starts from the menu
  showTutorial: boolean; // play the first-game callout tutorial; self-disables after one run
  // Master switch for every non-essential visual flourish (see systems/Effects).
  // On by default; how much it actually turns on is capped by the device's
  // effect tier and the OS reduce-motion preference.
  visualEffects: boolean;
}

const itemIds: ReadonlySet<string> = new Set(ITEMS.map((item) => item.id));

export function loadHall(): HallEntry[] {
  try {
    const raw = localStorage.getItem(KEY_SCORES);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return parsed
      .filter((entry) => Number(entry.schema) === HALL_SCHEMA)
      .map((entry) => ({
        schema: HALL_SCHEMA,
        startedAt: Number(entry.startedAt),
        rank: Number(entry.rank),
        trial: Number(entry.trial),
        score: BigInt((entry.score as string | number | undefined) ?? 0),
        won: Boolean(entry.won),
        endless: Boolean(entry.endless),
        goldEarned: Number(entry.goldEarned ?? 0),
        dice: (Array.isArray(entry.dice) ? entry.dice : []).map((rawDie) => {
          const d = rawDie as Partial<DiceStack>;
          return {
            sides: d.sides ?? 6,
            // Older hall entries stored this as a boolean. Resolve it from the
            // die's then-current size once, while new entries persist ×2/×4.
            maxFaceBonus: windfallFactor(
              d.maxFaceBonus as number | boolean | undefined,
              d.sides ?? 6,
            ),
            loaded: d.loaded ?? false,
            wildFace: d.wildFace ?? false,
            source: d.source ?? "starter",
            count: d.count ?? 1,
          } as DiceStack;
        }),
        dicePoints: bigintMap(entry.dicePoints),
        itemPoints: bigintMap(entry.itemPoints),
        history: hydrateRollHistory(entry.history),
        rolls: Number(entry.rolls ?? 0),
        seed: isSeed(entry.seed) ? entry.seed : undefined,
        unlocks: knownItemIds(entry.unlocks),
        tutorialArmed: Boolean(entry.tutorialArmed),
        forcedRolls: rollKeys(entry.forcedRolls),
      }));
  } catch {
    return [];
  }
}

/** Rigged-roll keys as read back off storage, or off another player's shared
 *  run. Anything not shaped like `trial:roll` is dropped rather than trusted. */
function rollKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (key): key is string => typeof key === "string" && /^\d+:\d+$/.test(key),
  );
}

/** The unlock snapshot as read back off storage — or off another player's
 *  shared run, which is why unknown ids are dropped rather than trusted. An id
 *  this build has never heard of cannot be offered by its shop anyway, and a
 *  replay is better off honest about the cards it can actually deal. */
function knownItemIds(value: unknown): ShopItemId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (id): id is ShopItemId => typeof id === "string" && itemIds.has(id),
  );
}

function bigintMap(value: unknown): Record<string, bigint> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, amount]) => [
      key,
      BigInt(amount as string | number),
    ]),
  );
}

/** Rank reached first, points as the tiebreak, then the trial within the rank,
 *  then recency. Getting further is the achievement; the score only separates
 *  runs that got equally far. */
export function compareHallEntries(a: HallEntry, b: HallEntry): number {
  if (a.rank !== b.rank) return b.rank - a.rank;
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  return b.trial - a.trial || b.startedAt - a.startedAt;
}

export function saveHallEntry(entry: HallEntry): void {
  const hall = loadHall();
  hall.push(entry);
  hall.sort(compareHallEntries);
  hall.length = Math.min(hall.length, HALL_SIZE);
  try {
    localStorage.setItem(
      KEY_SCORES,
      JSON.stringify(
        // Hundreds of roll samples per entry, times the whole Hall, is the one
        // part of this payload big enough to care about: they go out under the
        // shared short-key form rather than one verbose object per roll.
        hall.map((e) => ({
          ...e,
          history: serializeRollHistory(e.history ?? []),
        })),
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      ),
    );
  } catch {
    // storage full or unavailable — the run just isn't recorded
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        musicVol: clamp01(parsed.musicVol ?? 0.5),
        sfxVol: clamp01(parsed.sfxVol ?? 0.7),
        showIntro: parsed.showIntro ?? true,
        showTutorial: parsed.showTutorial ?? true,
        visualEffects: parsed.visualEffects ?? true,
      };
    }
  } catch {
    // fall through to defaults
  }
  return {
    musicVol: 0.5,
    sfxVol: 0.7,
    showIntro: true,
    showTutorial: true,
    visualEffects: true,
  };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
  } catch {
    // non-fatal
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Meta-progression: item unlocks, lifetime shop-selection counts, and a
// games-completed tally. Unlike RunState (ephemeral, in Phaser's registry),
// this persists across runs. Items with no `unlock` criterion are available
// from the start; the ids stored here are only the criterion-gated ones the
// player has since earned.
// ---------------------------------------------------------------------------

export interface Progress {
  unlocked: ShopItemId[]; // criterion-gated ids earned so far
  selectionCounts: Partial<Record<ShopItemId, number>>; // lifetime shop picks per item
  gamesCompleted: number; // wins + losses
}

function defaultProgress(): Progress {
  return { unlocked: [], selectionCounts: {}, gamesCompleted: 0 };
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY_PROGRESS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Progress>;
      return {
        unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked : [],
        selectionCounts: parsed.selectionCounts ?? {},
        gamesCompleted: parsed.gamesCompleted ?? 0,
      };
    }
  } catch {
    // fall through to defaults
  }
  return defaultProgress();
}

export function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(KEY_PROGRESS, JSON.stringify(progress));
  } catch {
    // non-fatal — progress just isn't recorded
  }
}

export function isUnlocked(id: ShopItemId): boolean {
  return loadProgress().unlocked.includes(id);
}

export function getSelectionCount(id: ShopItemId): number {
  return loadProgress().selectionCounts[id] ?? 0;
}

/** Add ids to the unlocked set (deduped) and persist. */
export function unlockItems(ids: ShopItemId[]): void {
  if (ids.length === 0) return;
  const progress = loadProgress();
  let changed = false;
  for (const id of ids) {
    if (!progress.unlocked.includes(id)) {
      progress.unlocked.push(id);
      changed = true;
    }
  }
  if (changed) saveProgress(progress);
}

/** Bump the lifetime shop-selection count for an item. Called from the shop UI
 *  (not `applyOffer`) so dev-panel grants don't inflate gallery counts. */
export function recordSelection(id: ShopItemId): void {
  const progress = loadProgress();
  progress.selectionCounts[id] = (progress.selectionCounts[id] ?? 0) + 1;
  saveProgress(progress);
}

/** True once the player has ever cleared the final rank. Derived from the Hall
 *  rather than a dedicated flag. */
export function hasBeatenGame(): boolean {
  return loadHall().some((entry) => entry.won);
}

export function recordGameCompleted(): void {
  const progress = loadProgress();
  progress.gamesCompleted += 1;
  saveProgress(progress);
}

/** End the current run: record it in the Hall of High Scores and bump the
 *  games-completed tally. Shared by the victory stop choice, natural losses,
 *  and the mid-run Abandon Run option. Returns whether this run set a new local best
 *  score, so callers can decide whether to offer it to the global leaderboard.
 *  (The check is made before the entry is saved, comparing against the prior
 *  top score.) */
export function recordRunEnd(
  state: RunState,
  won: boolean,
): { personalBest: boolean } {
  const entry: HallEntry = {
    schema: HALL_SCHEMA,
    startedAt: state.startedAt,
    rank: rankOf(state.trial),
    trial: trialInRank(state.trial),
    score: state.totalScore,
    won,
    endless: state.endless,
    goldEarned: state.goldEarned,
    dice: state.dice.summarize(),
    dicePoints: { ...state.dicePoints },
    itemPoints: { ...state.itemPoints },
    history: state.rollHistory.map((sample) => ({
      ...sample,
      pointsByItem: sample.pointsByItem
        ? { ...sample.pointsByItem }
        : undefined,
      diceByItem: sample.diceByItem ? { ...sample.diceByItem } : undefined,
      valueByItem: sample.valueByItem ? { ...sample.valueByItem } : undefined,
    })),
    rolls: state.rollsTaken,
    seed: state.seed,
    // The run-start snapshot, not today's unlocks: what the shop could offer is
    // frozen when a run begins, so this is the list a replay has to be given.
    unlocks: [...state.shopUnlocks],
    tutorialArmed: state.tutorialArmed,
    forcedRolls: [...state.forcedRolls],
  };
  // "Personal best" now means beating the top of the Hall on its own terms —
  // rank first, score second — not merely out-scoring it.
  const best = loadHall()[0];
  const personalBest = !best || compareHallEntries(entry, best) < 0;
  recordItemAnalysisRun(state, won);
  recordPlayerStatsRun(state, won);
  saveHallEntry(entry);
  recordGameCompleted();
  return { personalBest };
}

/** Evaluate every criterion-gated item against the current run and unlock any
 *  newly-satisfied ones. Returns the ids unlocked by this call (empty if none)
 *  so the caller can announce them. */
export function evaluateAndUnlock(state: RunState): ShopItemId[] {
  const progress = loadProgress();
  const newlyUnlocked: ShopItemId[] = [];
  for (const item of ITEMS) {
    if (!item.unlock) continue;
    if (progress.unlocked.includes(item.id)) continue;
    if (meetsCriterion(item.unlock, state)) newlyUnlocked.push(item.id);
  }
  if (newlyUnlocked.length > 0) {
    progress.unlocked.push(...newlyUnlocked);
    saveProgress(progress);
  }
  return newlyUnlocked;
}

/** Full fresh start: wipe unlocks/counts/games-completed AND the Hall of High
 *  Scores. Audio settings are intentionally left untouched. */
export function resetAllProgress(): void {
  clearActiveRun();
  resetItemAnalysis();
  resetPlayerStats();
  try {
    localStorage.removeItem(KEY_PROGRESS);
    localStorage.removeItem(KEY_SCORES);
  } catch {
    // non-fatal
  }
}
