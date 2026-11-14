// The global Hall of High Scores.
//
// What this exists to do that a hosted leaderboard product cannot: carry a
// whole run's analysis alongside its score. A finished run's per-roll timeline
// is 100-300 KB of JSON (~15-45 KB gzipped), which is three orders of magnitude
// past the metadata field of any "submit a score" service. So the score index
// lives in D1 and the analysis blob lives in R2, and a global row opens the
// same analysis screen a local one does.
//
// The client gzips the blob itself and posts it as opaque bytes, with the index
// fields in the query string. That is deliberate: this Worker never parses,
// decompresses or re-serializes the payload, so a submission costs almost no
// CPU and stays well inside the 10 ms the free plan allows. It also cuts the
// upload ~7x, which is the difference that matters on a phone.
//
// Identity is anonymous. Each device keeps a random secret token, sent only in
// the `X-Player-Token` header of its own writes, and the member id is a hash of
// it (see memberIdFor). The board publishes the hash, never the token, so a row
// read off `/v1/top` cannot be used to write as its player — which the bare
// device UUID this board used to key on could. The member id is also the R2
// object key. One row and one blob per player, holding their best run, both
// overwritten in place when they beat it — which is what keeps storage growing
// with players rather than with runs.
//
// Rows written before tokens (keyed by a raw device UUID) stay on the board
// but can no longer be written to by anyone: every write is keyed by a token's
// hash, which a UUID never is.

import { cleanInitials } from "./initials";

export interface Env {
  DB: D1Database;
  RUNS: R2Bucket;
  MAX_BOARD_SIZE?: string;
  /** Submissions allowed per player per hour. */
  SUBMITS_PER_HOUR?: string;
  /** Submissions allowed per IP address per hour, across every player id it
   *  sends — what stops one machine minting tokens to flood the board. */
  SUBMITS_PER_HOUR_PER_IP?: string;
  /** Crash reports accepted per IP address per hour. */
  ERRORS_PER_HOUR_PER_IP?: string;
}

/** Sanity ceiling on a score's decimal length. There is no natural one: an
 *  endless run compounds without bound (a full ladder lands near 80 digits,
 *  1000 rolls near 200, 2500 rolls near 550), which is why the sort key is
 *  (digits, decimal) rather than a fixed-width padding. This is only here to
 *  stop a submission carrying a megabyte of digits. */
const MAX_SCORE_DIGITS = 4096;

/** Hard cap on one submission's analysis. The largest run the client can
 *  produce — an endless run held at the 1024-sample history cap — gzips to
 *  around 1 MB, so this is roughly 2x the worst realistic case. */
const MAX_ANALYSIS_BYTES = 2 * 1024 * 1024;

/** The tighter, per-run cap: a fixed allowance plus so much per roll sample,
 *  with the samples counted up to the history's 1024 cap. A short run can then
 *  store tens of kilobytes rather than two megabytes. */
const ANALYSIS_BASE_BYTES = 64 * 1024;
const ANALYSIS_BYTES_PER_SAMPLE = 2 * 1024;
const HISTORY_SAMPLE_CAP = 1024;

function analysisAllowance(rolls: number): number {
  const samples = Math.min(rolls + 1, HISTORY_SAMPLE_CAP);
  return Math.min(
    MAX_ANALYSIS_BYTES,
    ANALYSIS_BASE_BYTES + samples * ANALYSIS_BYTES_PER_SAMPLE,
  );
}

const DEFAULT_BOARD_SIZE = 100;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How many days of Daily Rite boards are kept before the cron sweeps them,
 *  rows and analysis blobs both. */
const DAILY_KEEP_DAYS = 30;

/** How long a browser may cache an analysis blob. A blob is immutable for as
 *  long as the row points at it, and is replaced only by that player beating
 *  their own best. */
const ANALYSIS_CACHE_SECONDS = 300;

// --- CORS -------------------------------------------------------------------
//
// Wide open on purpose. The game is served from three origins we do not control
// and cannot enumerate: itch.io's per-project CDN subdomain, the Capacitor
// Android WebView (`https://localhost`), and a local Vite dev server. There is
// no cookie to protect here — the one credential, the player token, travels in
// a header the page has to set on purpose — and write access is bounded by the
// throttles below rather than by origin.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Player-Token",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function fail(status: number, error: string): Response {
  return json({ error }, status);
}

// --- Validation -------------------------------------------------------------
//
// Everything below runs against the short index fields only. It cannot prove a
// run happened — no client-submitted leaderboard can — but it does reject the
// shapes that would corrupt the board's ordering or its storage, which is more
// than a hosted service checks for us.

const MEMBER_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const INITIALS_RE = /^[A-Z]{0,3}$/;

// --- Identity ---------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The public member id for a player token: the first 128 bits of its
 *  SHA-256, in hex. The game computes the same value (src/systems/
 *  PlayerIdentity) to find its own row and to show the player their id. */
export async function memberIdFor(token: string): Promise<string> {
  return (await sha256Hex(`ooo-member:v1:${token}`)).slice(0, 32);
}

/** The member id of the request's token, or an error response. */
async function requestMember(request: Request): Promise<string | Response> {
  const token = request.headers.get("X-Player-Token") ?? "";
  if (!TOKEN_RE.test(token))
    return fail(401, "missing or malformed player token");
  return memberIdFor(token);
}

/** The throttle key for the request's address. Hashed with the day so the
 *  table never holds a raw IP, and cannot be joined across days. */
async function ipKey(request: Request, scope: string): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const day = new Date().toISOString().slice(0, 10);
  return `${scope}:${(await sha256Hex(`ip:${day}:${ip}`)).slice(0, 24)}`;
}
const SCORE_RE = /^\d+$/;

/** The novices a run can be played as (see src/systems/Characters). An
 *  allowlist rather than a shape check: this string is written to the board and
 *  read back by clients that will look for its art by name, so an id this build
 *  does not know is one no client can render. A submission carrying one is not
 *  rejected — the run is real and the board should hold it — it is simply
 *  recorded as the default, exactly as a client too old to send one is. */
const CHARACTERS = ["diebert", "melodie", "roland", "dieanne"] as const;
const DEFAULT_CHARACTER = "diebert";

function readCharacter(params: URLSearchParams): string {
  const raw = params.get("character") ?? "";
  return (CHARACTERS as readonly string[]).includes(raw)
    ? raw
    : DEFAULT_CHARACTER;
}

/** Strip leading zeros. The sort key leans on decimal length meaning magnitude,
 *  which only holds for a canonical decimal — "007" must not sort above "42". */
function canonicalScore(raw: string): string {
  const trimmed = raw.replace(/^0+(?=\d)/, "");
  return trimmed === "" ? "0" : trimmed;
}

function intParam(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
): number | null {
  const raw = params.get(name);
  if (raw === null || !/^\d{1,9}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

interface Submission {
  memberId: string;
  initials: string;
  rank: number;
  trial: number;
  endless: number;
  medal: number;
  character: string;
  scoreExact: string;
  scoreLen: number;
  rolls: number;
}

/** The run's goal-tier rank: 0 bronze … 3 legendary for a win, -1 for a loss.
 *  Optional, because a client from before ranks sends none, and that reads as
 *  unranked rather than as a bad submission. */
function readMedal(params: URLSearchParams): number {
  const raw = params.get("medal");
  if (raw === null || !/^-?\d$/.test(raw)) return -1;
  const value = Number(raw);
  return value >= 0 && value <= 3 ? value : -1;
}

function readSubmission(
  params: URLSearchParams,
  memberId: string,
): Submission | string {
  const initials = (params.get("initials") ?? "").toUpperCase();
  if (!INITIALS_RE.test(initials)) return "bad initials";

  // The ceiling is deliberately far above the ten authored ranks: an endless
  // run keeps climbing, and a board that rejected those would quietly lose the
  // best runs anyone plays.
  const rank = intParam(params, "rank", 1, 999);
  if (rank === null) return "bad rank";

  const trial = intParam(params, "trial", 1, 3);
  if (trial === null) return "bad trial";

  const rolls = intParam(params, "rolls", 0, 10_000_000);
  if (rolls === null) return "bad rolls";

  const rawScore = params.get("score") ?? "";
  if (!SCORE_RE.test(rawScore) || rawScore.length > MAX_SCORE_DIGITS)
    return "bad score";
  const scoreExact = canonicalScore(rawScore);

  const submission: Submission = {
    memberId,
    initials: cleanInitials(initials),
    rank,
    trial,
    endless: params.get("endless") === "1" ? 1 : 0,
    medal: readMedal(params),
    character: readCharacter(params),
    scoreExact,
    scoreLen: scoreExact.length,
    rolls,
  };
  return implausible(submission) ?? submission;
}

// --- Plausibility -----------------------------------------------------------
//
// Cheap checks on the index fields alone, against facts about the game that do
// not move with a rebalance. They cannot prove a run happened — only replaying
// its input log can, which is `npm run board:audit` — but they turn away the
// shapes no real client produces, which is most hand-made submissions.

/** The rank whose Boss Trial wins the game (src/config WIN_RANK). */
const WIN_RANK = 10;
/** The most rolls any one trial could plausibly take, counting every roll a
 *  card can add. The authored budgets are 7, 10 and 10. */
const MAX_ROLLS_PER_TRIAL = 100;
/** Score digits allowed for free, and then per roll. A finished ladder lands
 *  near 80 digits over a few hundred rolls; an endless run near 200 digits at
 *  1000 rolls and 550 at 2500. This sits at roughly twice those. */
const FREE_SCORE_DIGITS = 40;
const SCORE_DIGITS_PER_ROLL = 0.5;

function implausible(run: Submission): string | null {
  const won = run.medal >= 0 || run.endless === 1;
  if (won && run.rank < WIN_RANK)
    return "implausible: win before the last rank";
  // Every trial before the one the run reached was cleared, and clearing one
  // takes at least a roll.
  const trialsCleared = (run.rank - 1) * 3 + (run.trial - 1);
  if (run.rolls < trialsCleared) return "implausible: too few rolls";
  if (run.rolls > (trialsCleared + 1) * MAX_ROLLS_PER_TRIAL)
    return "implausible: too many rolls";
  if (run.scoreLen > FREE_SCORE_DIGITS + run.rolls * SCORE_DIGITS_PER_ROLL)
    return "implausible: score too large for its rolls";
  return null;
}

/** Rank first, points as the tiebreak — the ordering the whole game uses.
 *  Returns true when `next` deserves to replace `current`. */
function beats(
  next: { rank: number; scoreExact: string; scoreLen: number },
  current: { rank: number; score_exact: string; score_len: number } | null,
): boolean {
  if (!current) return true;
  if (next.rank !== current.rank) return next.rank > current.rank;
  // Both decimals are canonical, so more digits means a larger number and
  // equal-length values compare correctly as text. Together that is an exact
  // big-integer comparison over values with no upper bound.
  if (next.scoreLen !== current.score_len)
    return next.scoreLen > current.score_len;
  return next.scoreExact > current.score_exact;
}

// --- Throttle ---------------------------------------------------------------

/** Count this request against `key`'s hourly allowance. Returns false when it
 *  has already been used up. `key` is a member id, or an `ip:`-prefixed hash
 *  of an address (see ipKey). */
async function withinRate(
  env: Env,
  key: string,
  limit: number,
): Promise<boolean> {
  const window = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  // One statement: start a fresh window, or increment the live one. The
  // returned count is this submission's position in the window.
  const row = await env.DB.prepare(
    `INSERT INTO throttle (member_id, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(member_id) DO UPDATE SET
       count = CASE WHEN throttle.window_start = ?2 THEN throttle.count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`,
  )
    .bind(key, window)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

// --- Routes -----------------------------------------------------------------

interface BoardRow {
  member_id: string;
  initials: string;
  rank: number;
  trial: number;
  endless: number;
  medal: number;
  character: string;
  score_exact: string;
  rolls: number;
  has_analysis: number;
  created_at: number;
}

function boardLimit(request: Request, env: Env): number {
  const params = new URL(request.url).searchParams;
  const max = Number(env.MAX_BOARD_SIZE ?? "250");
  const asked = Number(params.get("limit") ?? DEFAULT_BOARD_SIZE);
  return Number.isFinite(asked)
    ? Math.max(1, Math.min(max, Math.floor(asked)))
    : DEFAULT_BOARD_SIZE;
}

async function getTop(request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT member_id, initials, rank, trial, endless, medal, character, score_exact,
            rolls, has_analysis, created_at
       FROM runs
      ORDER BY rank DESC, score_len DESC, score_exact DESC
      LIMIT ?1`,
  )
    .bind(boardLimit(request, env))
    .all<BoardRow>();
  return boardResponse(results);
}

function boardResponse(results: BoardRow[] | undefined): Response {
  // Board position is assigned here rather than stored: it is a property of the
  // query, not of the run, so a row can never carry a position that someone
  // else's submission has since invalidated.
  const rows = (results ?? []).map((row, i) => ({
    position: i + 1,
    memberId: row.member_id,
    initials: row.initials,
    rank: row.rank,
    trial: row.trial,
    endless: row.endless === 1,
    medal: row.medal,
    character: row.character,
    score: row.score_exact,
    rolls: row.rolls,
    hasAnalysis: row.has_analysis === 1,
    createdAt: row.created_at,
  }));

  return json({ rows });
}

/** The checks every submission passes before either board looks at it: the
 *  token, the index fields, the declared size, both throttles, and the body. */
async function readPost(
  request: Request,
  env: Env,
): Promise<{ parsed: Submission; analysis: ArrayBuffer } | Response> {
  const memberId = await requestMember(request);
  if (memberId instanceof Response) return memberId;

  const params = new URL(request.url).searchParams;
  const parsed = readSubmission(params, memberId);
  if (typeof parsed === "string") return fail(400, parsed);

  // Refuse an oversized body before reading it, when the client declared one.
  const allowance = analysisAllowance(parsed.rolls);
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > allowance) return fail(413, "analysis too large");

  // The address first: a flood from one machine is refused before it costs a
  // row per minted token.
  const perIp = Number(env.SUBMITS_PER_HOUR_PER_IP ?? "60");
  if (!(await withinRate(env, await ipKey(request, "ip"), perIp)))
    return fail(429, "too many submissions");
  const perMember = Number(env.SUBMITS_PER_HOUR ?? "20");
  if (!(await withinRate(env, parsed.memberId, perMember)))
    return fail(429, "too many submissions");

  // Buffered, not streamed: the blob has to be held anyway to decide whether it
  // is worth storing, and 2 MB is nothing against the Worker's memory. It is
  // never parsed or decompressed — these are opaque bytes on the way to R2.
  const analysis = await request.arrayBuffer();
  if (analysis.byteLength > allowance) return fail(413, "analysis too large");
  if (!looksLikeAnalysis(analysis)) return fail(400, "bad analysis");
  return { parsed, analysis };
}

/** Whether a body is shaped like the game's analysis: gzip, or (from a browser
 *  without CompressionStream) a JSON object. Enough to keep the bucket from
 *  holding arbitrary files under this domain; an empty body is a run with no
 *  timeline, which is allowed. */
function looksLikeAnalysis(body: ArrayBuffer): boolean {
  if (body.byteLength === 0) return true;
  const head = new Uint8Array(body, 0, Math.min(2, body.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) return true;
  return head[0] === 0x7b; // "{"
}

async function postRun(request: Request, env: Env): Promise<Response> {
  const read = await readPost(request, env);
  if (read instanceof Response) return read;
  const { parsed, analysis } = read;

  const current = await env.DB.prepare(
    `SELECT rank, score_exact, score_len FROM runs WHERE member_id = ?1`,
  )
    .bind(parsed.memberId)
    .first<{ rank: number; score_exact: string; score_len: number }>();

  // A run that does not beat the player's own best changes nothing. Reported as
  // a success with `improved: false` — the submission was well-formed and the
  // player has nothing to fix.
  if (!beats(parsed, current)) return json({ accepted: true, improved: false });

  // R2 before D1. The blob is keyed by member id, so this overwrites the
  // player's previous analysis in place; writing it first means the row is
  // never left pointing at an analysis that failed to store. The reverse order
  // can leave a row promising a blob that is not there.
  const hasAnalysis = analysis.byteLength > 0;
  if (hasAnalysis) {
    await env.RUNS.put(parsed.memberId, analysis, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  }

  await env.DB.prepare(
    `INSERT INTO runs (member_id, initials, rank, trial, endless, character,
                       score_exact, score_len, rolls, has_analysis, created_at,
                       medal)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(member_id) DO UPDATE SET
       initials = excluded.initials,
       rank = excluded.rank,
       trial = excluded.trial,
       endless = excluded.endless,
       character = excluded.character,
       score_exact = excluded.score_exact,
       score_len = excluded.score_len,
       rolls = excluded.rolls,
       has_analysis = excluded.has_analysis,
       created_at = excluded.created_at,
       medal = excluded.medal`,
  )
    .bind(
      parsed.memberId,
      parsed.initials,
      parsed.rank,
      parsed.trial,
      parsed.endless,
      parsed.character,
      parsed.scoreExact,
      parsed.scoreLen,
      parsed.rolls,
      hasAnalysis ? 1 : 0,
      Date.now(),
      parsed.medal,
    )
    .run();

  return json({ accepted: true, improved: true });
}

async function getAnalysis(
  memberId: string,
  env: Env,
  day?: string,
): Promise<Response> {
  if (!MEMBER_RE.test(memberId)) return fail(400, "bad member");

  const object = await env.RUNS.get(day ? dailyKey(day, memberId) : memberId);
  if (!object) return fail(404, "no analysis");

  // Served as opaque bytes rather than with `Content-Encoding: gzip`, so the
  // client decompresses explicitly with DecompressionStream. Symmetric with the
  // upload, and it takes no view on what any intermediary might do to a
  // content-encoded response.
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": `public, max-age=${ANALYSIS_CACHE_SECONDS}`,
      // Never rendered: whatever a blob holds, a browser that opens the URL
      // directly downloads it rather than sniffing it into a page.
      "Content-Disposition": "attachment",
      "X-Content-Type-Options": "nosniff",
      ETag: object.httpEtag,
      ...CORS,
    },
  });
}

// --- The Daily Rite ---------------------------------------------------------
//
// One board per UTC day, for the run every player shares that day (see the
// game's src/systems/Daily.ts — the day's seed and rules are derived from the
// date on the client, so this side only needs to know which day a run is for).
//
// The two boards differ in one rule. The global board keeps each player's BEST
// run; a daily board keeps their FIRST. A day's seed fixes every roll, so a
// second run of it is played with the answers, and the game offers only one
// attempt a day — the board holds it to that rather than rewarding whoever
// clears their storage and tries again.
//
// Daily blobs live in the same bucket as the global ones, under
// `daily/<day>/<member>`, which cannot collide with a bare member id.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dailyKey(day: string, memberId: string): string {
  return `daily/${day}/${memberId}`;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whether `day` is a real calendar date. */
function isDay(day: string): boolean {
  const m = DAY_RE.exec(day);
  if (!m) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && utcDay(date.getTime()) === day;
}

/** Whether a run for `day` may still be submitted. A run begun just before
 *  midnight is finished after it, and a resumed one can be finished later
 *  still, so yesterday and the day before stay open; a date ahead of the
 *  server's tomorrow is a clock that cannot be trusted. */
function acceptsDay(day: string, now = Date.now()): boolean {
  if (!isDay(day)) return false;
  const start = Date.parse(`${day}T00:00:00Z`);
  return (
    start >= Date.parse(`${utcDay(now - 2 * DAY_MS)}T00:00:00Z`) &&
    start <= Date.parse(`${utcDay(now + DAY_MS)}T00:00:00Z`)
  );
}

async function getDailyTop(
  request: Request,
  env: Env,
  day: string,
): Promise<Response> {
  if (!isDay(day)) return fail(400, "bad day");
  const { results } = await env.DB.prepare(
    `SELECT member_id, initials, rank, trial, endless, medal, character, score_exact,
            rolls, has_analysis, created_at
       FROM daily_runs
      WHERE day = ?1
      ORDER BY rank DESC, score_len DESC, score_exact DESC
      LIMIT ?2`,
  )
    .bind(day, boardLimit(request, env))
    .all<BoardRow>();
  return boardResponse(results);
}

async function postDailyRun(
  request: Request,
  env: Env,
  day: string,
): Promise<Response> {
  if (!acceptsDay(day)) return fail(400, "bad day");
  const read = await readPost(request, env);
  if (read instanceof Response) return read;
  const { parsed, analysis } = read;

  // The first run stands. Checked before the blob is written, so a second
  // submission cannot overwrite the first run's analysis either.
  const existing = await env.DB.prepare(
    `SELECT 1 AS found FROM daily_runs WHERE day = ?1 AND member_id = ?2`,
  )
    .bind(day, parsed.memberId)
    .first<{ found: number }>();
  if (existing) return json({ accepted: true, improved: false });

  const hasAnalysis = analysis.byteLength > 0;
  if (hasAnalysis) {
    await env.RUNS.put(dailyKey(day, parsed.memberId), analysis, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  }

  // DO NOTHING rather than an upsert: two submissions racing past the check
  // above still leave the first row standing.
  const result = await env.DB.prepare(
    `INSERT INTO daily_runs (day, member_id, initials, rank, trial, endless,
                             character, score_exact, score_len, rolls,
                             has_analysis, created_at, medal)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(day, member_id) DO NOTHING`,
  )
    .bind(
      day,
      parsed.memberId,
      parsed.initials,
      parsed.rank,
      parsed.trial,
      parsed.endless,
      parsed.character,
      parsed.scoreExact,
      parsed.scoreLen,
      parsed.rolls,
      hasAnalysis ? 1 : 0,
      Date.now(),
      parsed.medal,
    )
    .run();

  return json({ accepted: true, improved: (result.meta.changes ?? 0) > 0 });
}

// --- Deleting a player -------------------------------------------------------
//
// `DELETE /v1/players/me` removes everything the board holds for the token's
// player: their global row, every daily row, and the analysis blobs behind
// them. The game offers it in Settings; the privacy policy offers the same by
// email, against the member id Settings shows, for a player who has lost the
// device (an operator runs `npm run player:delete` for those).

async function deletePlayer(request: Request, env: Env): Promise<Response> {
  const memberId = await requestMember(request);
  if (memberId instanceof Response) return memberId;
  if (!(await withinRate(env, await ipKey(request, "del"), 30)))
    return fail(429, "too many requests");
  const removed = await removeMember(env, memberId);
  return json({ deleted: true, ...removed });
}

export async function removeMember(
  env: Env,
  memberId: string,
): Promise<{ runs: number; dailyRuns: number }> {
  const { results } = await env.DB.prepare(
    `SELECT day FROM daily_runs WHERE member_id = ?1`,
  )
    .bind(memberId)
    .all<{ day: string }>();
  const keys = [
    memberId,
    ...(results ?? []).map((row) => dailyKey(row.day, memberId)),
  ];
  // Blobs first, so a row is never left pointing at nothing; R2 deletes of a
  // missing key are no-ops.
  await env.RUNS.delete(keys);
  const [runs, daily] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM runs WHERE member_id = ?1`).bind(memberId),
    env.DB.prepare(`DELETE FROM daily_runs WHERE member_id = ?1`).bind(
      memberId,
    ),
    env.DB.prepare(`DELETE FROM throttle WHERE member_id = ?1`).bind(memberId),
  ]);
  return {
    runs: runs.meta.changes ?? 0,
    dailyRuns: daily.meta.changes ?? 0,
  };
}

// --- Crash reports ----------------------------------------------------------
//
// `POST /v1/errors` takes one uncaught error from the game (src/systems/
// CrashReports): its message, stack, where it happened, and the build. No
// player id rides with it. Reports are folded by fingerprint (build + message
// + top of stack), so a crash a thousand players hit is one row with a count,
// and rows unseen for ERROR_KEEP_DAYS are swept by the cron.

const ERROR_KEEP_DAYS = 30;
const MAX_ERROR_BODY = 8 * 1024;
const MAX_ERROR_ROWS = 5000;

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

async function postError(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_ERROR_BODY) return fail(413, "report too large");
  const perIp = Number(env.ERRORS_PER_HOUR_PER_IP ?? "30");
  if (!(await withinRate(env, await ipKey(request, "err"), perIp)))
    return fail(429, "too many reports");

  const text = await request.text();
  if (text.length > MAX_ERROR_BODY) return fail(413, "report too large");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fail(400, "bad report");
  }
  const message = clip(body.message, 500);
  if (!message) return fail(400, "bad report");
  const stack = clip(body.stack, 4000);
  const build = clip(body.build, 64);
  const version = clip(body.version, 32);
  const platform = clip(body.platform, 32);
  const scene = clip(body.scene, 64);
  const agent = clip(request.headers.get("User-Agent"), 300);
  const fingerprint = (
    await sha256Hex(`${build}\n${message}\n${stack.split("\n", 3).join("\n")}`)
  ).slice(0, 32);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO errors (fingerprint, build, version, platform, scene, message,
                         stack, user_agent, first_seen, last_seen, count)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1)
     ON CONFLICT(fingerprint) DO UPDATE SET
       last_seen = excluded.last_seen,
       count = errors.count + 1`,
  )
    .bind(
      fingerprint,
      build,
      version,
      platform,
      scene,
      message,
      stack,
      agent,
      now,
    )
    .run();
  return json({ ok: true });
}

async function sweepErrors(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM errors WHERE last_seen < ?1`)
    .bind(Date.now() - ERROR_KEEP_DAYS * DAY_MS)
    .run();
  await env.DB.prepare(
    `DELETE FROM errors WHERE fingerprint NOT IN
       (SELECT fingerprint FROM errors ORDER BY last_seen DESC LIMIT ?1)`,
  )
    .bind(MAX_ERROR_ROWS)
    .run();
}

/** Drop the daily boards older than DAILY_KEEP_DAYS, blobs first so a row is
 *  never left pointing at nothing. */
async function sweepDaily(env: Env): Promise<void> {
  const cutoff = utcDay(Date.now() - DAILY_KEEP_DAYS * DAY_MS);
  const { results } = await env.DB.prepare(
    `SELECT day, member_id FROM daily_runs
      WHERE day < ?1 AND has_analysis = 1
      LIMIT 1000`,
  )
    .bind(cutoff)
    .all<{ day: string; member_id: string }>();
  const keys = (results ?? []).map((row) => dailyKey(row.day, row.member_id));
  if (keys.length > 0) await env.RUNS.delete(keys);
  await env.DB.prepare(`DELETE FROM daily_runs WHERE day < ?1`)
    .bind(cutoff)
    .run();
}

// --- Schema -----------------------------------------------------------------
//
// The tables are brought up to date by the Worker itself, once per isolate,
// rather than trusting that every migration was run before every deploy. A
// deploy that reads a column the live database lacks fails every request, and
// the board was down that way once: the `medal` column shipped in the code
// before migrations/0001 ran. Every statement here is a no-op on a current
// database, so the check costs one PRAGMA per cold start.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
     member_id    TEXT PRIMARY KEY,
     initials     TEXT NOT NULL,
     rank         INTEGER NOT NULL,
     trial        INTEGER NOT NULL,
     endless      INTEGER NOT NULL,
     character    TEXT NOT NULL DEFAULT 'diebert',
     medal        INTEGER NOT NULL DEFAULT -1,
     score_exact  TEXT NOT NULL,
     score_len    INTEGER NOT NULL,
     rolls        INTEGER NOT NULL,
     has_analysis INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS runs_board
     ON runs (rank DESC, score_len DESC, score_exact DESC)`,
  `CREATE TABLE IF NOT EXISTS daily_runs (
     day          TEXT NOT NULL,
     member_id    TEXT NOT NULL,
     initials     TEXT NOT NULL,
     rank         INTEGER NOT NULL,
     trial        INTEGER NOT NULL,
     endless      INTEGER NOT NULL,
     character    TEXT NOT NULL DEFAULT 'diebert',
     medal        INTEGER NOT NULL DEFAULT -1,
     score_exact  TEXT NOT NULL,
     score_len    INTEGER NOT NULL,
     rolls        INTEGER NOT NULL,
     has_analysis INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL,
     PRIMARY KEY (day, member_id)
   )`,
  `CREATE INDEX IF NOT EXISTS daily_runs_board
     ON daily_runs (day, rank DESC, score_len DESC, score_exact DESC)`,
  `CREATE TABLE IF NOT EXISTS throttle (
     member_id    TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count        INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS errors (
     fingerprint  TEXT PRIMARY KEY,
     build        TEXT NOT NULL,
     version      TEXT NOT NULL,
     platform     TEXT NOT NULL,
     scene        TEXT NOT NULL,
     message      TEXT NOT NULL,
     stack        TEXT NOT NULL,
     user_agent   TEXT NOT NULL,
     first_seen   INTEGER NOT NULL,
     last_seen    INTEGER NOT NULL,
     count        INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS errors_recent ON errors (last_seen DESC)`,
];

/** Columns added to `runs` after it first shipped. `CREATE TABLE IF NOT
 *  EXISTS` skips a table that already exists, so these need their own ALTER. */
const RUNS_ADDED_COLUMNS: Record<string, string> = {
  character: `TEXT NOT NULL DEFAULT 'diebert'`,
  medal: `INTEGER NOT NULL DEFAULT -1`,
};

let schemaReady: Promise<void> | null = null;

function ensureSchema(env: Env): Promise<void> {
  schemaReady ??= migrate(env).catch((err) => {
    schemaReady = null; // try again on the next request
    throw err;
  });
  return schemaReady;
}

async function migrate(env: Env): Promise<void> {
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  const { results } = await env.DB.prepare(`PRAGMA table_info(runs)`).all<{
    name: string;
  }>();
  const have = new Set((results ?? []).map((col) => col.name));
  for (const [name, type] of Object.entries(RUNS_ADDED_COLUMNS)) {
    if (have.has(name)) continue;
    try {
      await env.DB.prepare(`ALTER TABLE runs ADD COLUMN ${name} ${type}`).run();
    } catch (err) {
      // Another isolate added it between our PRAGMA and this ALTER.
      if (!String(err).includes("duplicate column")) throw err;
    }
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (request.method === "GET" && path === "/v1/health")
    return json({ ok: true });

  if (request.method === "GET" && path === "/v1/top")
    return getTop(request, env);

  if (request.method === "POST" && path === "/v1/runs")
    return postRun(request, env);

  if (request.method === "DELETE" && path === "/v1/players/me")
    return deletePlayer(request, env);

  if (request.method === "POST" && path === "/v1/errors")
    return postError(request, env);

  const analysis = /^\/v1\/runs\/([^/]+)$/.exec(path);
  if (request.method === "GET" && analysis)
    return getAnalysis(decodeURIComponent(analysis[1]), env);

  const daily = /^\/v1\/daily\/([^/]+)\/(top|runs)(?:\/([^/]+))?$/.exec(path);
  if (daily) {
    const [, day, route, member] = daily;
    if (request.method === "GET" && route === "top" && !member)
      return getDailyTop(request, env, day);
    if (request.method === "POST" && route === "runs" && !member)
      return postDailyRun(request, env, day);
    if (request.method === "GET" && route === "runs" && member) {
      if (!isDay(day)) return fail(400, "bad day");
      return getAnalysis(decodeURIComponent(member), env, day);
    }
  }

  return fail(404, "not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });

    // Anything that throws below would otherwise become Cloudflare's own 500
    // page, which carries no CORS headers, so the browser reports a CORS
    // block and hides the real error. Answer with our own 500 instead, which
    // keeps the headers and names the failure in the Worker's logs.
    try {
      await ensureSchema(env);
      return await route(request, env);
    } catch (err) {
      console.error(`${request.method} ${new URL(request.url).pathname}`, err);
      return fail(500, "internal error");
    }
  },

  /** Sweep throttle rows whose window has passed, and daily boards past
   *  keeping. The global board itself needs no pruning — one row and one blob
   *  per player, both replaced in place. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await env.DB.prepare(`DELETE FROM throttle WHERE window_start < ?1`)
      .bind(Date.now() - 24 * HOUR_MS)
      .run();
    await sweepDaily(env);
    await sweepErrors(env);
  },
};
