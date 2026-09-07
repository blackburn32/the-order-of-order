// Client for the global leaderboard Worker (see worker/).
//
// The game ships as a static bundle (itch.io) or a Capacitor WebView with no
// server of its own, so the shared board lives in a small Cloudflare Worker
// reached over plain fetch. Players are anonymous: a per-device UUID is the
// member id, so the same browser keeps the same identity and we can spot our
// own row by a direct id match.
//
// The point of this backend over a hosted leaderboard product is fidelity. A
// finished run's per-roll timeline is 100-300 KB of JSON — three orders of
// magnitude past the ~250-character metadata field the previous backend gave
// us, which is why a global row used to show approximate per-item shares and no
// curves at all. Here the whole analysis goes up gzipped alongside the score,
// and a global row opens exactly the screen a local one does.
//
// Two consequences worth knowing:
//   - Rank and points are separate columns server-side, so there is no longer
//     one sortable integer to pack them into. The wire-ordinal packing this
//     file used to depend on is gone.
//   - Scores ride as decimal strings end to end, so a bigint past 2^53 is never
//     narrowed through Number.
//
// Every network call is wrapped so a backend/network failure never throws into
// gameplay — the feature just goes quiet and the local Hall keeps working.

import type { HallEntry } from "./SaveData";
import {
  hydrateRollHistory,
  serializeRollHistory,
  type RollSample,
  type SerializedRollSample,
} from "./RunHistory";

const API = (import.meta.env.VITE_LEADERBOARD_API ?? "").replace(/\/+$/, "");
const SUBMIT_KEY = import.meta.env.VITE_LEADERBOARD_SUBMIT_KEY ?? "";

export const GLOBAL_TOP_N = 100;

const KEY_PLAYER_ID = "ooo_player_id_v1";
const KEY_INITIALS = "ooo_initials_v1";
const KEY_PENDING = "ooo_pending_global_v2";

/** How long to wait on any one call before giving up. The board is a nicety;
 *  it must never leave a scene sitting on a spinner. */
const TIMEOUT_MS = 12_000;

/** One row of the global board. `position` is where it sits on the board;
 *  `runRank` is the rank the run reached, which is what the board sorts by. */
export interface GlobalScoreRow {
  /** Board position (1-based). Named `rank` for the Hall's column, which has
   *  printed it under that heading since the board existed. */
  rank: number;
  runRank: number; // the rank the run reached
  trial: number; // trial within that rank (1..3)
  endless: boolean;
  score: bigint; // total points, the tiebreak
  name: string; // initials, uppercased; may be ''
  isYou: boolean;
  /** Opaque handle for `fetchRunAnalysis`. */
  memberId: string;
  rolls: number;
  /** Whether an analysis blob was stored with this row. False only for rows
   *  submitted from a browser without CompressionStream, or from the dev panel. */
  hasAnalysis: boolean;
}

/** Per-item point attribution for a run (see systems/ItemPoints). Number-valued
 *  at this boundary because it feeds the analysis screen's bars. */
export type PointMap = Record<string, number>;

/** Everything the board stores about one finished run. Built from a Hall entry
 *  by `submissionFromHallEntry` — the Hall is the record of truth, and this is
 *  a projection of it rather than a second copy. */
export interface RunSubmission {
  score: bigint;
  rank: number;
  trial: number;
  endless: boolean;
  rolls: number;
  dicePoints: Record<string, bigint>;
  itemPoints: Record<string, bigint>;
  history: readonly RollSample[];
}

/** What a global row's analysis unpacks into — the same shape the local Hall
 *  hands the analysis screen. */
export interface GlobalRunAnalysis {
  dicePoints: PointMap;
  itemPoints: PointMap;
  history: RollSample[];
  rolls: number;
}

/** True only when the API base is configured; otherwise the whole feature is
 *  inert (Hall shows an offline message, nothing else changes). */
export function globalScoresEnabled(): boolean {
  return API.length > 0;
}

// --- Local identity (device-scoped, no sign-in) -----------------------------

let ephemeralId: string | null = null;

/** Stable per-device id, used as the board's `member_id`. */
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
    return localStorage.getItem(KEY_INITIALS) ?? "";
  } catch {
    return "";
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
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
}

// --- Pending submission (survives the end-of-run scene transition) ----------

/** What the end-of-run scene hands the initials prompt. Only the run's Hall key
 *  and the few fields the prompt actually displays: the analysis itself is read
 *  back out of the Hall at submit time rather than copied into a second
 *  localStorage key, which for a long run would be another 300 KB. */
export interface PendingSubmission {
  /** `HallEntry.startedAt` — identifies the run's Hall entry. */
  startedAt: number;
  score: bigint;
  rank: number;
  trial: number;
  won: boolean;
  endless: boolean;
}

export function queuePendingSubmission(pending: PendingSubmission): void {
  try {
    localStorage.setItem(
      KEY_PENDING,
      JSON.stringify({ ...pending, score: pending.score.toString() }),
    );
  } catch {
    // non-fatal
  }
}

export function takePendingSubmission(): PendingSubmission | null {
  try {
    const raw = localStorage.getItem(KEY_PENDING);
    if (!raw) return null;
    localStorage.removeItem(KEY_PENDING);
    const parsed = JSON.parse(raw) as Omit<PendingSubmission, "score"> & {
      score: string | number;
    };
    if (!Number.isFinite(parsed.startedAt)) return null;
    return { ...parsed, score: BigInt(parsed.score) };
  } catch {
    return null;
  }
}

// --- The analysis blob ------------------------------------------------------

/** Envelope version. Bumped only if the blob's own shape changes — the roll
 *  samples inside carry their own backward compatibility (see RunHistory). */
const BLOB_VERSION = 1;

interface AnalysisBlob {
  v: number;
  /** Decimal strings: per-item totals pass Number.MAX_SAFE_INTEGER in a long
   *  run just as the run total does. */
  dice: Record<string, string>;
  item: Record<string, string>;
  rolls: number;
  history: SerializedRollSample[];
}

function encodeAnalysis(run: RunSubmission): string {
  const decimals = (m: Record<string, bigint>): Record<string, string> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()]));
  const blob: AnalysisBlob = {
    v: BLOB_VERSION,
    dice: decimals(run.dicePoints),
    item: decimals(run.itemPoints),
    rolls: run.rolls,
    history: serializeRollHistory(run.history),
  };
  return JSON.stringify(blob);
}

/** Untrusted input: this came off the network. Anything malformed degrades to
 *  "no analysis" rather than throwing — `hydrateRollHistory` already treats a
 *  bad timeline that way, and the point maps get the same treatment. */
function decodeAnalysis(text: string): GlobalRunAnalysis | null {
  let parsed: Partial<AnalysisBlob>;
  try {
    parsed = JSON.parse(text) as Partial<AnalysisBlob>;
  } catch {
    return null;
  }
  if (parsed.v !== BLOB_VERSION) return null;
  const history = hydrateRollHistory(parsed.history);
  return {
    dicePoints: numberMap(parsed.dice),
    itemPoints: numberMap(parsed.item),
    history,
    rolls: Number.isFinite(parsed.rolls)
      ? Number(parsed.rolls)
      : Math.max(0, history.length - 1),
  };
}

function numberMap(value: unknown): PointMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: PointMap = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
    // Number, not bigint: the analysis screen sizes bars with it. Values past
    // ~9e15 lose low-order digits, which is invisible in a bar chart.
    out[id] = Number(raw);
  }
  return out;
}

// Gzip's magic number. Blobs are stored as opaque bytes, so the reader sniffs
// these rather than trusting a header — which also lets a browser without
// CompressionStream submit an uncompressed blob that everyone else can still
// read.
const GZIP_MAGIC = [0x1f, 0x8b];

function canCompress(): boolean {
  return typeof CompressionStream !== "undefined";
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const view = new Uint8Array(bytes);
  const compressed =
    view.length >= 2 && view[0] === GZIP_MAGIC[0] && view[1] === GZIP_MAGIC[1];
  if (!compressed) return new TextDecoder().decode(view);
  const stream = new Blob([view])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// --- Transport --------------------------------------------------------------

/** Fetch with a timeout, returning null for anything that is not a usable
 *  response. Never throws. */
async function call(
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(SUBMIT_KEY ? { "X-Submit-Key": SUBMIT_KEY } : {}),
        ...(init.headers ?? {}),
      },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Public API -------------------------------------------------------------

/** Project a Hall entry onto what the board stores. The Hall is where a
 *  finished run actually lives; this is the one place that knows how to read it
 *  as a submission. */
export function submissionFromHallEntry(entry: HallEntry): RunSubmission {
  return {
    score: entry.score,
    rank: entry.rank,
    trial: entry.trial,
    endless: !!entry.endless,
    rolls: entry.rolls ?? Math.max(0, (entry.history?.length ?? 1) - 1),
    dicePoints: entry.dicePoints ?? {},
    itemPoints: entry.itemPoints ?? {},
    history: entry.history ?? [],
  };
}

/**
 * Push a run to the global board: the score and ladder position as query
 * fields, the gzipped analysis as the request body.
 *
 * The compression happens here rather than server-side for two reasons — it
 * cuts the upload roughly sevenfold, which is what a phone on a slow connection
 * notices, and it keeps the Worker from having to spend CPU on a payload it
 * otherwise never needs to look at.
 *
 * Resolves to whether it succeeded; never throws.
 */
export async function submitRun(
  run: RunSubmission,
  initials: string,
): Promise<boolean> {
  if (!globalScoresEnabled()) return false;

  const params = new URLSearchParams({
    member: getPlayerId(),
    initials: normalizeInitials(initials),
    rank: String(Math.max(1, Math.floor(run.rank))),
    trial: String(Math.min(3, Math.max(1, Math.floor(run.trial)))),
    endless: run.endless ? "1" : "0",
    score: (run.score < 0n ? 0n : run.score).toString(),
    rolls: String(Math.max(0, Math.floor(run.rolls))),
  });

  // A browser without CompressionStream still gets its score on the board; it
  // just posts the blob uncompressed, which readers detect by the missing gzip
  // magic. Only the upload size suffers, and only for that player.
  let body: Uint8Array | string = "";
  if (run.history.length > 0) {
    const text = encodeAnalysis(run);
    try {
      body = canCompress() ? await gzip(text) : text;
    } catch {
      body = text;
    }
  }

  const res = await call(`/v1/runs?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: body as BodyInit,
  });
  return res !== null;
}

/** Fetch the global top-N. Returns null when disabled or the request fails
 *  (caller distinguishes via `globalScoresEnabled()`). */
export async function fetchTopScores(
  limit = GLOBAL_TOP_N,
): Promise<GlobalScoreRow[] | null> {
  if (!globalScoresEnabled()) return null;
  const res = await call(`/v1/top?limit=${limit}`, { method: "GET" });
  if (!res) return null;
  try {
    const data = (await res.json()) as { rows?: unknown };
    if (!Array.isArray(data.rows)) return null;
    const me = getPlayerId();
    return data.rows
      .map((row) => toRow(row, me))
      .filter((row): row is GlobalScoreRow => row !== null);
  } catch {
    return null;
  }
}

/** Fetch one global row's full run analysis. Returns null when the row has no
 *  stored analysis or the request fails; the caller keeps the board usable
 *  either way. */
export async function fetchRunAnalysis(
  memberId: string,
): Promise<GlobalRunAnalysis | null> {
  if (!globalScoresEnabled()) return null;
  const res = await call(`/v1/runs/${encodeURIComponent(memberId)}`, {
    method: "GET",
  });
  if (!res) return null;
  try {
    return decodeAnalysis(await gunzip(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

interface WireRow {
  position?: unknown;
  memberId?: unknown;
  initials?: unknown;
  rank?: unknown;
  trial?: unknown;
  endless?: unknown;
  score?: unknown;
  rolls?: unknown;
  hasAnalysis?: unknown;
}

function toRow(raw: unknown, me: string): GlobalScoreRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as WireRow;
  const position = Number(row.position);
  const runRank = Number(row.rank);
  if (!Number.isFinite(position) || !Number.isFinite(runRank) || runRank <= 0)
    return null;
  if (typeof row.score !== "string" || !/^\d+$/.test(row.score)) return null;
  const memberId = typeof row.memberId === "string" ? row.memberId : "";
  return {
    rank: position,
    runRank,
    trial: Number.isFinite(Number(row.trial)) ? Number(row.trial) : 1,
    endless: row.endless === true,
    score: BigInt(row.score),
    name: typeof row.initials === "string" ? row.initials.toUpperCase() : "",
    isYou: memberId !== "" && memberId === me,
    memberId,
    rolls: Number.isFinite(Number(row.rolls)) ? Number(row.rolls) : 0,
    hasAnalysis: row.hasAnalysis === true,
  };
}
