import { HALL_SIZE } from "../config";
import type { RunState } from "../state/RunState";
import type { DiceStack } from "./DicePool";
import { windfallFactor } from "./Dice";
import { ITEMS, meetsCriterion, ShopItemId } from "./Items";

const KEY_SCORES = "ooo_high_scores_v1";
const KEY_SETTINGS = "ooo_settings_v1";
const KEY_PROGRESS = "ooo_progress_v1";

export interface HallEntry {
  startedAt: number; // run start, epoch ms
  round: number; // round reached
  score: bigint; // total points accumulated across the whole run
  won: boolean; // true if the run cleared all rounds (victory)
  hard?: boolean; // true if the run was played on Hard Mode
  dice: DiceStack[];
  // Per-item point attribution for the run (see systems/ItemPoints). Optional so
  // pre-existing entries load fine; the Hall's analysis button is hidden when
  // absent. Full fidelity locally (no size cap).
  dicePoints?: Record<string, bigint>;
  itemPoints?: Record<string, bigint>;
}

export interface Settings {
  musicVol: number; // 0..1
  sfxVol: number; // 0..1
  showIntro: boolean; // play the 3-page intro when a run starts from the menu
  showTutorial: boolean; // play the first-game callout tutorial; self-disables after one run
  hardMode: boolean; // play the next run on Hard Mode (only settable once unlocked)
}

export function loadHall(): HallEntry[] {
  try {
    const raw = localStorage.getItem(KEY_SCORES);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return parsed.map((entry) => ({
      startedAt: Number(entry.startedAt),
      round: Number(entry.round),
      score: BigInt((entry.score as string | number | undefined) ?? 0),
      won: Boolean(entry.won),
      hard: Boolean(entry.hard),
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
    }));
  } catch {
    return [];
  }
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

export function saveHallEntry(entry: HallEntry): void {
  const hall = loadHall();
  hall.push(entry);
  hall.sort((a, b) =>
    a.score === b.score
      ? b.round - a.round || b.startedAt - a.startedAt
      : a.score > b.score
        ? -1
        : 1,
  );
  hall.length = Math.min(hall.length, HALL_SIZE);
  try {
    localStorage.setItem(
      KEY_SCORES,
      JSON.stringify(hall, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
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
        hardMode: parsed.hardMode ?? false,
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
    hardMode: false,
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

/** True once the player has ever cleared all rounds. Gates the Hard Mode
 *  unlock — derived from the Hall rather than a dedicated flag. */
export function hasBeatenGame(): boolean {
  return loadHall().some((entry) => entry.won);
}

export function recordGameCompleted(): void {
  const progress = loadProgress();
  progress.gamesCompleted += 1;
  saveProgress(progress);
}

/** End the current run: record it in the Hall of High Scores and bump the
 *  games-completed tally. Shared by the natural win/lose endings and the
 *  mid-run Abandon Run option. Returns whether this run set a new local best
 *  score, so callers can decide whether to offer it to the global leaderboard.
 *  (The check is made before the entry is saved, comparing against the prior
 *  top score.) */
export function recordRunEnd(
  state: RunState,
  won: boolean,
): { personalBest: boolean } {
  const personalBest = state.totalScore > (loadHall()[0]?.score ?? -1n);
  saveHallEntry({
    startedAt: state.startedAt,
    round: state.round,
    score: state.totalScore,
    won,
    hard: state.hardMode,
    dice: state.dice.summarize(),
    dicePoints: { ...state.dicePoints },
    itemPoints: { ...state.itemPoints },
  });
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
  try {
    localStorage.removeItem(KEY_PROGRESS);
    localStorage.removeItem(KEY_SCORES);
    // Relock Hard Mode: the reset wipes the Hall (so hasBeatenGame() is false
    // again), and Hard Mode must default back to off so a later re-unlock starts
    // disabled. Other settings (audio, intro, tutorial) are intentionally kept.
    const settings = loadSettings();
    if (settings.hardMode) {
      settings.hardMode = false;
      saveSettings(settings);
    }
  } catch {
    // non-fatal
  }
}
