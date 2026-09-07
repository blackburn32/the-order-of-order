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
// Identity is anonymous and unchanged from before: the device UUID the game
// already keeps in localStorage is the member id here, and also the R2 object
// key. One row and one blob per player, holding their best run, both
// overwritten in place when they beat it — which is what keeps storage growing
// with players rather than with runs.

export interface Env {
  DB: D1Database;
  RUNS: R2Bucket;
  /** Optional shared key. When set, submissions must carry it in
   *  `X-Submit-Key`. Not a real secret — it ships in the game bundle — but it
   *  turns away anything that has not read the client. */
  SUBMIT_KEY?: string;
  MAX_BOARD_SIZE?: string;
  SUBMITS_PER_HOUR?: string;
}

/** Sanity ceiling on a score's decimal length. There is no natural one: an
 *  endless run compounds without bound (a full ladder lands near 80 digits,
 *  1000 rolls near 200, 2500 rolls near 550), which is why the sort key is
 *  (digits, decimal) rather than a fixed-width padding. This is only here to
 *  stop a submission carrying a megabyte of digits. */
const MAX_SCORE_DIGITS = 4096;

/** Cap on one submission's gzipped analysis. The largest run the client can
 *  produce — an endless run held at the 1024-sample history cap — gzips to
 *  around 1 MB, so this is roughly 2x the worst realistic case. */
const MAX_ANALYSIS_BYTES = 2 * 1024 * 1024;

const DEFAULT_BOARD_SIZE = 100;
const HOUR_MS = 60 * 60 * 1000;

/** How long a browser may cache an analysis blob. A blob is immutable for as
 *  long as the row points at it, and is replaced only by that player beating
 *  their own best. */
const ANALYSIS_CACHE_SECONDS = 300;

// --- CORS -------------------------------------------------------------------
//
// Wide open on purpose. The game is served from three origins we do not control
// and cannot enumerate: itch.io's per-project CDN subdomain, the Capacitor
// Android WebView (`https://localhost`), and a local Vite dev server. There is
// no cookie or credential to protect here — every endpoint is anonymous, and
// write access is bounded by the throttle below rather than by origin.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Submit-Key",
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
const INITIALS_RE = /^[A-Z]{0,3}$/;
const SCORE_RE = /^\d+$/;

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
  scoreExact: string;
  scoreLen: number;
  rolls: number;
}

function readSubmission(params: URLSearchParams): Submission | string {
  const memberId = params.get("member") ?? "";
  if (!MEMBER_RE.test(memberId)) return "bad member";

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

  return {
    memberId,
    initials,
    rank,
    trial,
    endless: params.get("endless") === "1" ? 1 : 0,
    scoreExact,
    scoreLen: scoreExact.length,
    rolls,
  };
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

/** Count this submission against the device's hourly allowance. Returns false
 *  when the device has already used it up. */
async function withinRate(env: Env, memberId: string): Promise<boolean> {
  const limit = Number(env.SUBMITS_PER_HOUR ?? "20");
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
    .bind(memberId, window)
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
  score_exact: string;
  rolls: number;
  has_analysis: number;
  created_at: number;
}

async function getTop(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const max = Number(env.MAX_BOARD_SIZE ?? "250");
  const asked = Number(params.get("limit") ?? DEFAULT_BOARD_SIZE);
  const limit = Number.isFinite(asked)
    ? Math.max(1, Math.min(max, Math.floor(asked)))
    : DEFAULT_BOARD_SIZE;

  const { results } = await env.DB.prepare(
    `SELECT member_id, initials, rank, trial, endless, score_exact, rolls,
            has_analysis, created_at
       FROM runs
      ORDER BY rank DESC, score_len DESC, score_exact DESC
      LIMIT ?1`,
  )
    .bind(limit)
    .all<BoardRow>();

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
    score: row.score_exact,
    rolls: row.rolls,
    hasAnalysis: row.has_analysis === 1,
    createdAt: row.created_at,
  }));

  return json({ rows });
}

async function postRun(request: Request, env: Env): Promise<Response> {
  if (env.SUBMIT_KEY && request.headers.get("X-Submit-Key") !== env.SUBMIT_KEY)
    return fail(403, "bad submit key");

  const params = new URL(request.url).searchParams;
  const parsed = readSubmission(params);
  if (typeof parsed === "string") return fail(400, parsed);

  // Refuse an oversized body before reading it, when the client declared one.
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_ANALYSIS_BYTES) return fail(413, "analysis too large");

  if (!(await withinRate(env, parsed.memberId)))
    return fail(429, "too many submissions");

  // Buffered, not streamed: the blob has to be held anyway to decide whether it
  // is worth storing, and 2 MB is nothing against the Worker's memory. It is
  // never parsed or decompressed — these are opaque bytes on the way to R2.
  const analysis = await request.arrayBuffer();
  if (analysis.byteLength > MAX_ANALYSIS_BYTES)
    return fail(413, "analysis too large");

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
    `INSERT INTO runs (member_id, initials, rank, trial, endless,
                       score_exact, score_len, rolls, has_analysis, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(member_id) DO UPDATE SET
       initials = excluded.initials,
       rank = excluded.rank,
       trial = excluded.trial,
       endless = excluded.endless,
       score_exact = excluded.score_exact,
       score_len = excluded.score_len,
       rolls = excluded.rolls,
       has_analysis = excluded.has_analysis,
       created_at = excluded.created_at`,
  )
    .bind(
      parsed.memberId,
      parsed.initials,
      parsed.rank,
      parsed.trial,
      parsed.endless,
      parsed.scoreExact,
      parsed.scoreLen,
      parsed.rolls,
      hasAnalysis ? 1 : 0,
      Date.now(),
    )
    .run();

  return json({ accepted: true, improved: true });
}

async function getAnalysis(memberId: string, env: Env): Promise<Response> {
  if (!MEMBER_RE.test(memberId)) return fail(400, "bad member");

  const object = await env.RUNS.get(memberId);
  if (!object) return fail(404, "no analysis");

  // Served as opaque bytes rather than with `Content-Encoding: gzip`, so the
  // client decompresses explicitly with DecompressionStream. Symmetric with the
  // upload, and it takes no view on what any intermediary might do to a
  // content-encoded response.
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": `public, max-age=${ANALYSIS_CACHE_SECONDS}`,
      ETag: object.httpEtag,
      ...CORS,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "GET" && path === "/v1/health")
      return json({ ok: true });

    if (request.method === "GET" && path === "/v1/top")
      return getTop(request, env);

    if (request.method === "POST" && path === "/v1/runs")
      return postRun(request, env);

    const analysis = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (request.method === "GET" && analysis)
      return getAnalysis(decodeURIComponent(analysis[1]), env);

    return fail(404, "not found");
  },

  /** Sweep throttle rows whose window has passed. The board itself needs no
   *  pruning — one row and one blob per player, both replaced in place. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await env.DB.prepare(`DELETE FROM throttle WHERE window_start < ?1`)
      .bind(Date.now() - 24 * HOUR_MS)
      .run();
  },
};
