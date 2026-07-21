// LootLocker-backed global leaderboard client.
//
// The game ships as a static HTML5 bundle (itch.io) with no server of our own,
// so a shared leaderboard lives in LootLocker and is reached over plain fetch —
// there is no official LootLocker JS SDK. Players are anonymous: a per-device
// UUID is used both as the LootLocker guest `player_identifier` (to open a
// session with no sign-in) and as the leaderboard `member_id`, so the same
// browser keeps the same identity and we can spot our own rows in the list by a
// direct id match.
//
// The "orderscores" board is a *generic* leaderboard: submissions must carry an
// explicit `member_id`, and entries expose `{ member_id, rank, score, metadata }`
// with no player object — so the display initials ride in `metadata`.
//
// Every network call is wrapped so a backend/network failure never throws into
// gameplay — the feature just goes quiet and the local Hall keeps working.
//
// Dashboard prerequisites (one-time): the game must have the **Guest** login
// platform enabled, and the leaderboard with the configured key must exist.

import type { ShopItemId } from './Items';

const API = 'https://api.lootlocker.io/game';

const GAME_KEY = import.meta.env.VITE_LOOTLOCKER_GAME_KEY;
const LEADERBOARD_KEY = import.meta.env.VITE_LOOTLOCKER_LEADERBOARD_KEY;
const GAME_VERSION = import.meta.env.VITE_LOOTLOCKER_GAME_VERSION ?? '0.1.0';

export const GLOBAL_TOP_N = 100;

const KEY_PLAYER_ID = 'ooo_player_id_v1';
const KEY_INITIALS = 'ooo_initials_v1';
const KEY_PENDING = 'ooo_pending_global_v1';

export interface GlobalScoreRow {
  rank: number;
  score: number;
  name: string; // initials (from metadata), uppercased; may be ''
  isYou: boolean;
}

/** Per-item purchase tally for a run (item id -> times purchased). */
export type Purchases = Partial<Record<ShopItemId, number>>;

export interface PendingSubmission {
  score: number;
  won: boolean;
  purchases: Purchases;
}

/** True only when the LootLocker keys are configured; otherwise the whole
 *  feature is inert (Hall shows an offline message, nothing else changes). */
export function globalScoresEnabled(): boolean {
  return !!GAME_KEY && !!LEADERBOARD_KEY;
}

// --- Local identity (device-scoped, no sign-in) -----------------------------

let ephemeralId: string | null = null;

/** Stable per-device id used as both the LootLocker guest `player_identifier`
 *  and the leaderboard `member_id` (so our own rows are identifiable). */
export function getPlayerId(): string {
  try {
    let id = localStorage.getItem(KEY_PLAYER_ID);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY_PLAYER_ID, id);
    }
    return id;
  } catch {
    // localStorage unavailable — fall back to an ephemeral per-session id.
    if (!ephemeralId) ephemeralId = crypto.randomUUID();
    return ephemeralId;
  }
}

export function getInitials(): string {
  try {
    return localStorage.getItem(KEY_INITIALS) ?? '';
  } catch {
    return '';
  }
}

export function setInitials(initials: string): void {
  try {
    localStorage.setItem(KEY_INITIALS, normalizeInitials(initials));
  } catch {
    // non-fatal
  }
}

/** 1–3 uppercase A–Z letters. Empty string if nothing usable. */
export function normalizeInitials(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3);
}

// --- Pending submission (survives the end-of-run scene transition) ----------

export function queuePendingSubmission(pending: PendingSubmission): void {
  try {
    localStorage.setItem(KEY_PENDING, JSON.stringify(pending));
  } catch {
    // non-fatal
  }
}

export function takePendingSubmission(): PendingSubmission | null {
  try {
    const raw = localStorage.getItem(KEY_PENDING);
    if (!raw) return null;
    localStorage.removeItem(KEY_PENDING);
    return JSON.parse(raw) as PendingSubmission;
  } catch {
    return null;
  }
}

// --- Session handling -------------------------------------------------------

let sessionToken: string | null = null;

async function startGuestSession(): Promise<string | null> {
  try {
    const res = await fetch(`${API}/v2/session/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game_key: GAME_KEY,
        game_version: GAME_VERSION,
        player_identifier: getPlayerId()
      })
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { session_token?: string };
    sessionToken = data.session_token ?? null;
    return sessionToken;
  } catch {
    return null;
  }
}

async function ensureSession(): Promise<string | null> {
  return sessionToken ?? startGuestSession();
}

/** Authed request that transparently re-auths once on 401 (expired token).
 *  Returns null when we can't obtain a session or the network fails. */
async function authed(path: string, init: RequestInit = {}): Promise<Response | null> {
  let token = await ensureSession();
  if (!token) return null;
  const doFetch = (t: string): Promise<Response> =>
    fetch(`${API}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'x-session-token': t, ...(init.headers ?? {}) }
    });
  try {
    let res = await doFetch(token);
    if (res.status === 401) {
      sessionToken = null;
      token = await startGuestSession();
      if (!token) return null;
      res = await doFetch(token);
    }
    return res;
  } catch {
    return null;
  }
}

// --- Public API -------------------------------------------------------------

// LootLocker's generic-leaderboard `metadata` is a single string with a length
// cap (~256 chars). We pack both the display initials and the run's purchase
// tally into a JSON envelope so the board can be mined for player strategies.
const META_MAX = 250;

/** Pack initials + purchases into the one metadata string. Drops the purchases
 *  (keeping the initials) if the envelope would blow the length cap, so an
 *  otherwise-valid submission never fails on size. */
function encodeMeta(initials: string, purchases: Purchases): string {
  const full = JSON.stringify({ i: initials, p: purchases });
  if (full.length <= META_MAX) return full;
  return JSON.stringify({ i: initials });
}

/** Read the display initials back out of a metadata string, tolerating both the
 *  `{ i, p }` envelope and legacy rows where metadata was the bare initials. */
function decodeInitials(meta?: string): string {
  if (!meta) return '';
  try {
    const parsed = JSON.parse(meta) as { i?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.i === 'string') return parsed.i.toUpperCase();
  } catch {
    // legacy row: metadata was the bare initials string
  }
  return meta.toUpperCase();
}

/** Push a score to the global leaderboard under our device member id, packing
 *  the initials (display name) and the run's purchase tally into `metadata`.
 *  Resolves to whether it succeeded; never throws. */
export async function submitScore(score: number, initials: string, purchases: Purchases = {}): Promise<boolean> {
  if (!globalScoresEnabled()) return false;
  const res = await authed(`/leaderboards/${LEADERBOARD_KEY}/submit`, {
    method: 'POST',
    body: JSON.stringify({
      member_id: getPlayerId(),
      score: Math.max(0, Math.floor(score)),
      metadata: encodeMeta(normalizeInitials(initials), purchases)
    })
  });
  return !!res && res.ok;
}

/** Fetch the global top-N. Returns null when disabled or the request fails
 *  (caller distinguishes via `globalScoresEnabled()`). */
export async function fetchTopScores(limit = GLOBAL_TOP_N): Promise<GlobalScoreRow[] | null> {
  if (!globalScoresEnabled()) return null;
  const res = await authed(`/leaderboards/${LEADERBOARD_KEY}/list?count=${limit}`, { method: 'GET' });
  if (!res || !res.ok) return null;
  try {
    const data = (await res.json()) as { items?: LLEntry[] | null };
    const me = getPlayerId();
    return (data.items ?? []).map((e) => toRow(e, me));
  } catch {
    return null;
  }
}

// LootLocker generic-leaderboard entry shape (fields we use).
interface LLEntry {
  rank: number;
  score: number;
  metadata?: string;
  member_id?: string;
}

function toRow(e: LLEntry, me: string): GlobalScoreRow {
  return {
    rank: e.rank,
    score: e.score,
    name: decodeInitials(e.metadata),
    isYou: !!e.member_id && e.member_id === me
  };
}
