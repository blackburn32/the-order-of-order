import { HALL_SIZE } from '../config';

const KEY_SCORES = 'ooo_high_scores_v1';
const KEY_SETTINGS = 'ooo_settings_v1';

export interface HallEntry {
  startedAt: number; // run start, epoch ms
  round: number;     // round reached
  score: number;     // final score
  dice: { sides: number; rollplayer: boolean }[];
}

export interface Settings {
  musicVol: number; // 0..1
  sfxVol: number;   // 0..1
}

export function loadHall(): HallEntry[] {
  try {
    const raw = localStorage.getItem(KEY_SCORES);
    return raw ? (JSON.parse(raw) as HallEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveHallEntry(entry: HallEntry): void {
  const hall = loadHall();
  hall.push(entry);
  hall.sort((a, b) => b.round - a.round || b.score - a.score || b.startedAt - a.startedAt);
  hall.length = Math.min(hall.length, HALL_SIZE);
  try {
    localStorage.setItem(KEY_SCORES, JSON.stringify(hall));
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
        sfxVol: clamp01(parsed.sfxVol ?? 0.7)
      };
    }
  } catch {
    // fall through to defaults
  }
  return { musicVol: 0.5, sfxVol: 0.7 };
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
